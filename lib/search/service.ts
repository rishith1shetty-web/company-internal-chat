/**
 * Global search across people, groups, messages and filenames (Batch 1.6).
 *
 * THE ONLY INTERESTING THING ABOUT THIS MODULE IS WHAT IT REFUSES TO RETURN. Search is the one
 * feature that reads across every conversation at once, so it is the one place where a missing
 * predicate does not produce a visible bug — it produces a quiet disclosure. A member who joined
 * a group last week must not be able to type a word and find what was said in it last year, and
 * they must not be able to find it by filename either.
 *
 * SO THE VISIBLE WINDOW IS NOT RE-DERIVED HERE. It is the same window `listMessages` applies to
 * ordinary history reads (lib/messages/service.ts), generalised from one conversation to all of
 * them:
 *
 *     conversation the caller is an ACTIVE member of   (leftAt IS NULL)
 *   ∧ createdAt >= that membership's joinedAt          (D-03, per conversation)
 *   ∧ not hidden by this caller                        (MessageHide, delete-for-me)
 *   ∧ not a delete-for-everyone tombstone
 *
 * The memberships come from `listActiveMemberships`, which is the module that already enforces
 * `leftAt IS NULL` for socket room joins. Nothing here re-implements that rule, because a second
 * implementation of an authorization rule is a second chance to get it wrong — and the weaker of
 * two rules is the one that decides.
 *
 * NOTE THE SHAPE OF THE D-03 FILTER. `joinedAt` is PER CONVERSATION, so this cannot be one
 * `createdAt >= x` over a list of conversation ids: that would apply one person's earliest join
 * time to every group they are in, and hand them history from before they joined the others. It
 * is therefore an OR of (conversationId, joinedAt) pairs — one branch per membership, each
 * carrying its own boundary.
 *
 * EVERYTHING IS FILTERED IN SQL. Nothing is fetched and then narrowed in JavaScript, and nothing
 * is narrowed in the browser: a result the caller may not see is never read out of PostgreSQL at
 * all. Every query is bounded by `take`, so no request can return an unbounded set.
 *
 * The matching itself is deliberately ordinary — a case-insensitive substring, which Prisma
 * compiles to a parameterised `ILIKE`. No search server, no index infrastructure, no ranking
 * model. At production scale (448 messages, 18 attachments) that is the correct amount of
 * machinery, and docs/ records what to reach for if that stops being true.
 */

import { listActiveMemberships, type ActiveMembership } from '../authz/membership';
import { listDirectory } from '../users/directory';
import type { Prisma, PrismaClient } from '../../prisma/generated/client';

/**
 * Shortest query that is allowed to reach the database.
 *
 * One character matches most of the corpus and answers nothing, while costing a full scan per
 * keystroke. Two is the point at which a query starts to mean something — and it is short enough
 * for the initials and short surnames people actually type.
 */
export const SEARCH_MIN_QUERY_LENGTH = 2;

/**
 * Longest query accepted. Beyond this it is a paste or an attempt, not a search term, and the
 * request is refused rather than run.
 */
export const SEARCH_MAX_QUERY_LENGTH = 64;

/**
 * Results per category, per request.
 *
 * Ten is enough to show that matches exist and to contain the obvious one, and small enough that
 * four categories still fit on a screen without becoming a second inbox to read. There is no
 * "load more" in this version, deliberately: a search that needs paging is usually a search that
 * needs refining, and the counts below say when that is the case.
 */
export const SEARCH_CATEGORY_LIMIT = 10;

/**
 * Escapes the characters `LIKE`/`ILIKE` treats as wildcards.
 *
 * WHY THIS IS NEEDED EVEN THOUGH THE QUERY IS PARAMETERISED. Prisma's `contains` compiles to
 * `ILIKE '%' || $1 || '%'` with the term bound as a parameter, so no SQL can be injected through
 * it — `'; DROP TABLE …` is matched as the literal characters it is. But the term still lands
 * INSIDE a pattern, and `%` and `_` keep their pattern meaning there. Without this, a search for
 * `%` matches every message the caller can see, and `_____` matches every five-character one:
 * not a disclosure, since the authorization filters are untouched, but a cheap way to enumerate a
 * whole visible corpus and to force a full scan on every keystroke.
 *
 * It is also simply more correct. Somebody searching for "50% off" means the percent sign.
 *
 * Backslash first, or it would escape the escapes added after it. PostgreSQL's default `LIKE`
 * escape character is the backslash, so no `ESCAPE` clause is needed — which matters, because
 * Prisma's `contains` gives nowhere to put one.
 */
export function escapeLikePattern(term: string): string {
  return term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export interface SearchPerson {
  id: string;
  displayName: string;
  lastSeenAt: Date;
}

export interface SearchGroup {
  conversationId: string;
  name: string;
  memberCount: number;
}

export interface SearchMessage {
  id: string;
  conversationId: string;
  conversationType: 'DIRECT' | 'GROUP';
  /** The group's name, or null for a direct conversation — the browser titles those itself. */
  conversationName: string | null;
  senderId: string | null;
  senderName: string | null;
  /** The message's CURRENT text. An edit is searched as it now reads; no history is kept. */
  body: string;
  createdAt: Date;
}

export interface SearchFile {
  attachmentId: string;
  messageId: string;
  conversationId: string;
  conversationType: 'DIRECT' | 'GROUP';
  conversationName: string | null;
  filename: string;
  senderId: string | null;
  senderName: string | null;
  createdAt: Date;
}

export interface SearchResults {
  people: SearchPerson[];
  groups: SearchGroup[];
  messages: SearchMessage[];
  files: SearchFile[];
}

/** Nothing found, and nothing asked of the database. The short-circuit for a too-short query. */
export function emptySearchResults(): SearchResults {
  return { people: [], groups: [], messages: [], files: [] };
}

/**
 * Trims and bounds a raw query string.
 *
 * Returns null when the query must not be run at all — empty, whitespace, or shorter than the
 * minimum. The caller returns empty results for that rather than an error, because "you have not
 * typed enough yet" is a normal state of a search box and not a failure.
 */
export function normalizeSearchQuery(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;

  const trimmed = raw.trim();
  if (trimmed.length < SEARCH_MIN_QUERY_LENGTH) return null;

  return trimmed;
}

/**
 * The caller's visible message window, as a Prisma filter.
 *
 * This is THE security boundary of the feature, and it is built once and reused by both the
 * message search and the file search so the two cannot diverge. A file is reachable exactly when
 * the message that carries it is reachable — the rule the schema spells out for downloads, where
 * stopping at `conversationId` would let a newly added member pull every file ever shared.
 *
 * Returns null when the caller is in no conversation at all, which is a real state for a
 * just-enrolled employee. The caller then skips both queries entirely rather than sending
 * `OR: []` to PostgreSQL — an empty OR matches NOTHING in Prisma, but relying on that would be
 * relying on a detail of the query builder for an access-control outcome.
 */
function visibleMessageFilter(
  memberships: readonly ActiveMembership[],
  userId: string,
): Prisma.MessageWhereInput | null {
  if (memberships.length === 0) return null;

  return {
    // One branch per membership: each conversation carries its OWN D-03 boundary (see above).
    OR: memberships.map((membership) => ({
      conversationId: membership.conversationId,
      createdAt: { gte: membership.joinedAt },
    })),
    /*
     * Delete-for-everyone. `body` is already cleared by the tombstone, so a deleted message could
     * not match a text query anyway — but a FILE result is found by filename, not by body, and
     * would otherwise survive its own deletion. Stated once here, for both.
     */
    deletedAt: null,
    /*
     * Delete-for-me, filtered in SQL exactly as `listMessages` does it. Filtering afterwards in
     * JavaScript would silently shorten a page of results and let the limit disagree with what
     * was actually returned.
     */
    hiddenFor: { none: { userId } },
    /*
     * System messages are excluded from search, which is narrower than ordinary history rather
     * than wider. "X added Y to the group" is a record of an event, not something an employee is
     * looking for, and the text is assembled from people's names — so including it would turn a
     * name search into a membership-history report.
     */
    type: { not: 'SYSTEM' },
  };
}

/**
 * Searches everything the caller is allowed to see.
 *
 * The query is a plain substring. `mode: 'insensitive'` compiles to `ILIKE` with the term as a
 * BOUND PARAMETER — it is never concatenated into SQL, here or anywhere below.
 */
export async function searchEverything(
  db: PrismaClient,
  userId: string,
  rawQuery: string,
): Promise<SearchResults> {
  const query = normalizeSearchQuery(rawQuery);
  if (query === null) return emptySearchResults();

  /*
   * Authorization first, and from the database — never from anything the browser sent. Every
   * query below is scoped by what this returns.
   */
  const memberships = await listActiveMemberships(db, userId);
  const window = visibleMessageFilter(memberships, userId);

  /*
   * The term as it goes into an ILIKE pattern. `query` itself is still what the caller typed and
   * is what gets echoed back to them; only the matching uses the escaped form.
   */
  const pattern = escapeLikePattern(query);

  const [people, groups, messages, files] = await Promise.all([
    searchPeople(db, userId, query),
    searchGroups(db, userId, pattern),
    window === null ? [] : searchMessages(db, pattern, window),
    window === null ? [] : searchFiles(db, pattern, window),
  ]);

  return { people, groups, messages, files };
}

/**
 * Colleagues whose display name matches.
 *
 * Reuses the directory the New-chat picker already uses, so search offers exactly the people that
 * flow offers — self excluded, retired names excluded — and cannot drift into a second, more
 * generous list of who exists.
 *
 * D-02 still holds: the name FILTERS, it never identifies. Every row carries its own id, and two
 * colleagues with the same name are two rows.
 *
 * THE TERM IS PASSED UNESCAPED HERE, unlike the three categories below, and that is deliberate:
 * this is the directory's own matching, shared with the New-chat picker, and giving search a
 * different rule would make the two disagree about who exists. Wildcards cost nothing here —
 * `GET /api/users` already returns the whole directory to any signed-in employee when no term is
 * given, so a `%` that matched everyone would reveal exactly what is already available. The
 * message and file categories are different, which is why they escape.
 */
async function searchPeople(
  db: PrismaClient,
  userId: string,
  query: string,
): Promise<SearchPerson[]> {
  return listDirectory(db, userId, { search: query, limit: SEARCH_CATEGORY_LIMIT });
}

/**
 * Groups the caller is currently in, by group name.
 *
 * The membership predicate is written into the query itself rather than applied to a list of ids
 * fetched earlier: the rule and the read are then the same statement, and there is no window in
 * which a stale id list could outlive the membership it came from.
 */
async function searchGroups(
  db: PrismaClient,
  userId: string,
  query: string,
): Promise<SearchGroup[]> {
  const rows = await db.conversation.findMany({
    where: {
      type: 'GROUP',
      name: { contains: query, mode: 'insensitive' },
      // Active membership, both halves of it. `leftAt: null` is the half that is easy to forget.
      members: { some: { userId, leftAt: null } },
    },
    select: {
      id: true,
      name: true,
      _count: { select: { members: { where: { leftAt: null } } } },
    },
    orderBy: [{ lastMessageAt: 'desc' }, { id: 'asc' }],
    take: SEARCH_CATEGORY_LIMIT,
  });

  return rows.map((row) => ({
    conversationId: row.id,
    // `name` is nullable in the schema (direct conversations have none); a GROUP always has one.
    name: row.name ?? '',
    memberCount: row._count.members,
  }));
}

/** Message text and file captions, inside the caller's visible window. */
async function searchMessages(
  db: PrismaClient,
  query: string,
  window: Prisma.MessageWhereInput,
): Promise<SearchMessage[]> {
  const rows = await db.message.findMany({
    where: {
      ...window,
      // The CURRENT body. Editing rewrites this column in place and keeps no history, so there is
      // no older text that search could expose.
      body: { contains: query, mode: 'insensitive' },
    },
    select: {
      id: true,
      conversationId: true,
      senderId: true,
      body: true,
      createdAt: true,
      sender: { select: { displayName: true } },
      conversation: { select: { type: true, name: true } },
    },
    // Newest first: in a chat application the recent match is nearly always the wanted one.
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: SEARCH_CATEGORY_LIMIT,
  });

  return rows.map((row) => ({
    id: row.id,
    conversationId: row.conversationId,
    conversationType: row.conversation.type,
    conversationName: row.conversation.name,
    senderId: row.senderId,
    senderName: row.sender?.displayName ?? null,
    body: row.body ?? '',
    createdAt: row.createdAt,
  }));
}

/**
 * Attachments by FILENAME ONLY.
 *
 * Nothing reads the file itself: no PDF text, no document contents, no image, no archive, no OCR.
 * That is a scope decision and also a cost one — the bytes live outside the database, and opening
 * them to answer a keystroke is the kind of work that turns a search box into an outage.
 *
 * Reachability is delegated to the owning MESSAGE through the same `window`, which is what makes
 * a file exactly as visible as the message that carries it and no more. An attachment with no
 * message — an upload that never completed — matches nothing, because `message: { is: … }`
 * requires the relation to exist.
 */
async function searchFiles(
  db: PrismaClient,
  query: string,
  window: Prisma.MessageWhereInput,
): Promise<SearchFile[]> {
  const rows = await db.attachment.findMany({
    where: {
      originalFilename: { contains: query, mode: 'insensitive' },
      /*
       * Delete-for-everyone removes the bytes and marks the row DELETED, keeping it so a download
       * can be refused deliberately rather than by absence. A filename whose file no longer
       * exists is not a search result.
       */
      status: { not: 'DELETED' },
      message: { is: window },
    },
    select: {
      id: true,
      conversationId: true,
      originalFilename: true,
      createdAt: true,
      message: {
        select: {
          id: true,
          senderId: true,
          sender: { select: { displayName: true } },
          conversation: { select: { type: true, name: true } },
        },
      },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: SEARCH_CATEGORY_LIMIT,
  });

  return rows.flatMap((row) => {
    // Narrowing only: the `message: { is: … }` filter already guarantees this is present.
    if (!row.message) return [];

    return [
      {
        attachmentId: row.id,
        messageId: row.message.id,
        conversationId: row.conversationId,
        conversationType: row.message.conversation.type,
        conversationName: row.message.conversation.name,
        filename: row.originalFilename,
        senderId: row.message.senderId,
        senderName: row.message.sender?.displayName ?? null,
        createdAt: row.createdAt,
      },
    ];
  });
}
