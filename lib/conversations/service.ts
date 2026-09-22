/**
 * Conversation service — resolving, listing and marking conversations read.
 *
 * SCOPE: direct (one-to-one) conversations from Phase 5, and group creation and membership from
 * Phase 6. The listing and read-marker functions were written against the generic membership
 * model in Phase 5 and did not change for groups — which is the point of rule 2 below.
 *
 * Three rules this module exists to hold in one place:
 *
 * 1. **One direct conversation per pair.** `Conversation.directKey` — the two user ids sorted
 *    and joined — carries a unique index, so the *database* enforces it. Two browsers clicking
 *    at the same instant race into the same key and one of them loses; the loser reads the
 *    winner's row rather than creating a second conversation.
 *
 * 2. **`joinedAt` bounds everything (D-03).** Previews and unread counts are computed inside the
 *    caller's visible window, not over the whole conversation, exactly as message queries are.
 *    For a direct conversation both members join at creation so the window is the whole history,
 *    and the filter is applied anyway. That is why adding groups needed no change here: a member
 *    added to a group today has today's `joinedAt`, and the same clause that was a no-op for
 *    direct conversations now hides everything said before they arrived.
 *
 * 3. **Identity is never resolved by name.** Every function here takes user ids. A display name
 *    is a label (D-02); two people may share one, and no lookup in this file accepts one.
 */

import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '../../prisma/generated/client';
import { Prisma } from '../../prisma/generated/client';
import { findActiveMembership, type ActiveMembership } from '../authz/membership';
import { writeSystemMessage } from '../messages/service';

/** Prisma's unique-constraint violation. */
const UNIQUE_VIOLATION = 'P2002';

export type ConversationFailure =
  | 'USER_NOT_FOUND'
  | 'SELF_CONVERSATION'
  | 'NOT_A_MEMBER'
  | 'MESSAGE_NOT_FOUND'
  /* Group management (Phase 6). */
  | 'NOT_A_GROUP'
  | 'NOT_AN_OWNER'
  | 'INVALID_GROUP_NAME'
  | 'NO_MEMBERS'
  | 'TOO_MANY_MEMBERS'
  | 'MEMBER_NOT_FOUND';

export class ConversationError extends Error {
  readonly reason: ConversationFailure;

  constructor(reason: ConversationFailure, message: string) {
    super(message);
    this.name = 'ConversationError';
    this.reason = reason;
  }
}

/** The sorted-pair key that makes "at most one direct conversation per pair" a constraint. */
export function directKeyFor(userIdA: string, userIdB: string): string {
  return [userIdA, userIdB].sort().join(':');
}

export interface MessagePreview {
  id: string;
  senderId: string | null;
  type: 'TEXT' | 'FILE' | 'SYSTEM';
  body: string | null;
  createdAt: Date;
  /** The filename when the newest visible message is a file, so the sidebar can name it. */
  attachmentFilename: string | null;
}

export interface ConversationSummary {
  id: string;
  type: 'DIRECT' | 'GROUP';
  name: string | null;
  createdAt: Date;
  lastMessageAt: Date | null;
  members: {
    userId: string;
    role: 'OWNER' | 'MEMBER';
    joinedAt: Date;
    /**
     * The member's read watermark — DIRECT conversations only, null in groups (Batch 1.3).
     *
     * Withheld in groups on purpose: every member's watermark handed to every member would make
     * per-member read status computable by anybody, which `GET /api/messages/:id/info` restricts
     * to the sender.
     */
    lastReadAt: Date | null;
  }[];
  /** The newest message inside the caller's visible window, for the sidebar preview. */
  lastMessage: MessagePreview | null;
  unreadCount: number;
}

const previewSelection = {
  id: true,
  senderId: true,
  type: true,
  body: true,
  createdAt: true,
  // Only the name. The preview is a line of text in a list, and nothing else about the file
  // belongs in a response that is sent for every conversation on every load.
  attachment: { select: { originalFilename: true } },
} as const;

/**
 * Finds the direct conversation between two users, creating it only if it does not exist.
 *
 * The caller is `currentUserId`, derived from the session. `otherUserId` is the only thing the
 * browser supplies, and it names a person to talk to — never a conversation to join and never a
 * membership to assume. The resulting conversation always contains the caller, so this cannot be
 * used to manufacture access to somebody else's conversation.
 */
export async function resolveDirectConversation(
  db: PrismaClient,
  currentUserId: string,
  otherUserId: string,
): Promise<{ conversationId: string; created: boolean }> {
  if (otherUserId === currentUserId) {
    throw new ConversationError(
      'SELF_CONVERSATION',
      'You cannot start a conversation with yourself.',
    );
  }

  // The other party must be a real, active user. Checked by id: a display name would not do,
  // because names are not unique (D-02).
  const other = await db.user.findUnique({
    where: { id: otherUserId },
    select: { id: true, isActive: true },
  });

  if (!other || !other.isActive) {
    throw new ConversationError('USER_NOT_FOUND', 'That colleague is no longer available.');
  }

  const directKey = directKeyFor(currentUserId, otherUserId);

  const existing = await db.conversation.findUnique({
    where: { directKey },
    select: { id: true },
  });

  if (existing) {
    return {
      conversationId: await assertCallerIsMember(db, currentUserId, existing.id),
      created: false,
    };
  }

  try {
    const conversation = await db.conversation.create({
      data: {
        type: 'DIRECT',
        directKey,
        createdById: currentUserId,
        // Both members join at creation, so a direct conversation has no join-window gap: each
        // participant can see the conversation's entire history.
        members: { create: [{ userId: currentUserId }, { userId: otherUserId }] },
      },
      select: { id: true },
    });

    return { conversationId: conversation.id, created: true };
  } catch (error) {
    // The race: another request created the same pair between the read above and this insert.
    // The unique index caught it, and the correct answer is the row that now exists.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION) {
      const winner = await db.conversation.findUnique({
        where: { directKey },
        select: { id: true },
      });

      if (winner) {
        return {
          conversationId: await assertCallerIsMember(db, currentUserId, winner.id),
          created: false,
        };
      }
    }

    throw error;
  }
}

/**
 * Defensive: an existing direct conversation must still list the caller as an active member.
 *
 * Nothing in v1 sets `leftAt` on a direct conversation, so this should never fire. It is here
 * because returning a conversation id without re-checking membership would make this function
 * the one place in the application that hands out an id it did not authorize.
 */
async function assertCallerIsMember(
  db: PrismaClient,
  userId: string,
  conversationId: string,
): Promise<string> {
  const membership = await findActiveMembership(db, userId, conversationId);
  if (!membership) {
    throw new ConversationError('NOT_A_MEMBER', 'You do not have access to this conversation.');
  }
  return conversationId;
}

/**
 * Every conversation the caller is an active member of, newest activity first.
 *
 * The membership filter is the query itself — there is no "fetch all, filter later" step that a
 * later edit could drop. A conversation the caller is not a member of is not reachable here at
 * any point.
 */
export async function listConversationsForUser(
  db: PrismaClient,
  userId: string,
): Promise<ConversationSummary[]> {
  const memberships = await db.conversationMember.findMany({
    where: { userId, leftAt: null },
    select: {
      joinedAt: true,
      lastReadAt: true,
      conversation: {
        select: {
          id: true,
          type: true,
          name: true,
          createdAt: true,
          lastMessageAt: true,
          members: {
            where: { leftAt: null },
            select: { userId: true, role: true, joinedAt: true, lastReadAt: true },
          },
        },
      },
    },
    orderBy: [{ conversation: { lastMessageAt: 'desc' } }, { conversation: { createdAt: 'desc' } }],
  });

  if (memberships.length === 0) return [];

  const [previews, unread] = await Promise.all([
    loadPreviews(db, memberships),
    countUnread(db, userId, memberships),
  ]);

  return memberships.map(({ conversation }) => ({
    id: conversation.id,
    type: conversation.type,
    name: conversation.name,
    createdAt: conversation.createdAt,
    lastMessageAt: conversation.lastMessageAt,
    members: conversation.members.map((member) => ({
      userId: member.userId,
      role: member.role,
      joinedAt: member.joinedAt,
      // The gate. A group's watermarks never leave the server through this route.
      lastReadAt: conversation.type === 'DIRECT' ? member.lastReadAt : null,
    })),
    lastMessage: previews.get(conversation.id) ?? null,
    unreadCount: unread.get(conversation.id) ?? 0,
  }));
}

type MembershipRow = {
  joinedAt: Date;
  lastReadAt: Date | null;
  conversation: { id: string };
};

/**
 * The newest visible message per conversation.
 *
 * One indexed query per conversation, run concurrently. A single query returning the latest row
 * per group needs either `DISTINCT ON` in raw SQL or an in-memory de-duplication over the whole
 * message history; both are worse here than a handful of primary-key-ordered index seeks against
 * `(conversationId, createdAt DESC, id DESC)` for the tens of conversations a person has.
 */
async function loadPreviews(
  db: PrismaClient,
  memberships: readonly MembershipRow[],
): Promise<Map<string, MessagePreview>> {
  const entries = await Promise.all(
    memberships.map(async ({ conversation, joinedAt }) => {
      const message = await db.message.findFirst({
        // D-03: the preview is computed inside the caller's window, so a newly added member
        // never sees older content through the sidebar.
        where: { conversationId: conversation.id, createdAt: { gte: joinedAt } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: previewSelection,
      });

      return [conversation.id, message] as const;
    }),
  );

  const previews = new Map<string, MessagePreview>();
  for (const [conversationId, message] of entries) {
    if (!message) continue;
    const { attachment, ...preview } = message;
    previews.set(conversationId, {
      ...preview,
      attachmentFilename: attachment?.originalFilename ?? null,
    });
  }
  return previews;
}

/**
 * Unread counts for every conversation, in one grouped query.
 *
 * Unread means: inside the caller's visible window, newer than their read marker, and sent by
 * somebody else.
 *
 * `SYSTEM` messages do NOT raise the badge, and that is deliberate rather than incidental.
 * `senderId: { not: userId }` compiles to `senderId <> $1`, which is NULL — and therefore false —
 * for a server-written message, so they are excluded. It is also the behaviour to want: a badge
 * says somebody has said something to you, and "Alice added Bob" has not. Without it, creating a
 * group would put an unread marker on every member's sidebar, including the creator's.
 *
 * The group still surfaces, because the event moves `lastMessageAt` and sorts the conversation to
 * the top of the list.
 */
async function countUnread(
  db: PrismaClient,
  userId: string,
  memberships: readonly MembershipRow[],
): Promise<Map<string, number>> {
  const clauses = memberships.map(({ conversation, joinedAt, lastReadAt }) => ({
    conversationId: conversation.id,
    // A read marker can only ever be set to a message the member could see, so it is always at
    // or after `joinedAt`; when it is absent the whole visible window is unread.
    createdAt: lastReadAt ? { gt: lastReadAt } : { gte: joinedAt },
  }));

  const grouped = await db.message.groupBy({
    by: ['conversationId'],
    where: { OR: clauses, senderId: { not: userId } },
    _count: { _all: true },
  });

  const counts = new Map<string, number>();
  for (const row of grouped) counts.set(row.conversationId, row._count._all);
  return counts;
}

/**
 * Who should hear that somebody read, and whether the watermark may travel with it (Batch 1.3).
 *
 * A separate call rather than extra fields on `markConversationRead`, and made only when the
 * marker actually moved — which is the uncommon path. Re-opening a conversation already read to
 * the end asks nothing extra of the database.
 */
export async function readAnnouncementFor(
  db: PrismaClient,
  conversationId: string,
): Promise<{ type: 'DIRECT' | 'GROUP'; audienceIds: string[] }> {
  const conversation = await db.conversation.findUnique({
    where: { id: conversationId },
    select: { type: true, members: { where: { leftAt: null }, select: { userId: true } } },
  });

  if (!conversation) return { type: 'GROUP', audienceIds: [] };

  return {
    type: conversation.type,
    audienceIds: conversation.members.map((member) => member.userId),
  };
}

export interface ReadMarkerResult {
  conversationId: string;
  lastReadMessageId: string;
  lastReadAt: Date;
  unreadCount: number;
  /**
   * True when this call actually advanced the marker (Batch 1.3).
   *
   * The caller announces a read only when something changed. Opening a conversation you have
   * already read to the end is a no-op, and broadcasting it would put a steady trickle of events
   * on the wire that tell nobody anything.
   */
  moved: boolean;
}

/**
 * Moves the caller's read marker up to a message they have actually seen.
 *
 * The message id is supplied by the browser and is therefore checked, not trusted: it must be a
 * message of *this* conversation and inside the caller's visible window. A marker is only ever
 * moved forward, so an out-of-order request from a second tab cannot resurrect a badge.
 */
export async function markConversationRead(
  db: PrismaClient,
  userId: string,
  conversationId: string,
  messageId: string,
): Promise<ReadMarkerResult> {
  const membership = await findActiveMembership(db, userId, conversationId);
  if (!membership) {
    throw new ConversationError('NOT_A_MEMBER', 'You do not have access to this conversation.');
  }

  const message = await db.message.findFirst({
    where: {
      id: messageId,
      // Both conditions matter: the id must belong to this conversation, and it must be inside
      // the window. Without the first, a marker could be set from another conversation's id.
      conversationId,
      createdAt: { gte: membership.joinedAt },
    },
    select: { id: true, createdAt: true },
  });

  if (!message) {
    throw new ConversationError('MESSAGE_NOT_FOUND', 'That message is not in this conversation.');
  }

  const current = await db.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
    select: { lastReadAt: true, lastReadMessageId: true },
  });

  const alreadyPastIt =
    current?.lastReadAt !== null &&
    current?.lastReadAt !== undefined &&
    current.lastReadAt >= message.createdAt;

  if (!alreadyPastIt) {
    await db.conversationMember.update({
      where: { conversationId_userId: { conversationId, userId } },
      data: { lastReadMessageId: message.id, lastReadAt: message.createdAt },
    });
  }

  const effectiveReadAt = alreadyPastIt ? (current.lastReadAt as Date) : message.createdAt;

  const unreadCount = await db.message.count({
    where: {
      conversationId,
      createdAt: { gt: effectiveReadAt },
      senderId: { not: userId },
    },
  });

  return {
    conversationId,
    lastReadMessageId: alreadyPastIt
      ? (current.lastReadMessageId ?? message.id)
      : message.id,
    lastReadAt: effectiveReadAt,
    unreadCount,
    moved: !alreadyPastIt,
  };
}

/* --------------------------------------------------------------------------------------------- */
/* Groups (Phase 6)                                                                                */
/* --------------------------------------------------------------------------------------------- */

/**
 * Group name ceiling. Matches `Conversation.name varchar(120)`, so a name that fits here fits the
 * column — the database is not left to reject what the service should have.
 */
export const MAX_GROUP_NAME_LENGTH = 120;

/**
 * Ceiling on how many people one request may add.
 *
 * Not a policy about group size — it bounds the work a single request can ask for, so a crafted
 * `memberIds` array cannot turn one POST into ten thousand inserts.
 */
export const MAX_GROUP_MEMBERS = 100;

/** Control characters, stripped from a group name before it is stored. */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/g;

/**
 * Validates and normalises a group name.
 *
 * Trimmed, whitespace-collapsed, control characters removed: a name is rendered in the sidebar
 * and in the conversation header, and a newline or a control character there is a display defect
 * rather than anything anybody typed on purpose.
 */
export function normaliseGroupName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ConversationError('INVALID_GROUP_NAME', 'Give the group a name.');
  }

  const cleaned = value.replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim();

  if (cleaned.length === 0) {
    throw new ConversationError('INVALID_GROUP_NAME', 'Give the group a name.');
  }
  if (cleaned.length > MAX_GROUP_NAME_LENGTH) {
    throw new ConversationError(
      'INVALID_GROUP_NAME',
      `A group name may be at most ${MAX_GROUP_NAME_LENGTH} characters.`,
    );
  }

  return cleaned;
}

/**
 * The people to act on, as ids, with the actor removed and duplicates collapsed.
 *
 * Duplicate ids in a request are not an error and are not a route to two memberships:
 * `[bob, bob, bob]` is the same request as `[bob]`. The unique index on
 * `(conversationId, userId)` would catch it regardless; collapsing here means the caller gets the
 * result they meant instead of a constraint violation.
 */
function distinctTargets(memberIds: readonly unknown[], excludeUserId: string): string[] {
  const ids = new Set<string>();
  for (const value of memberIds) {
    if (typeof value === 'string' && value !== excludeUserId) ids.add(value);
  }
  return [...ids];
}

/**
 * Confirms that every id names a real, active user.
 *
 * By id, never by name: two colleagues may be called the same thing (D-02), so a name could not
 * identify which of them was meant even if the API accepted one.
 */
async function requireActiveUsers(db: PrismaClient, userIds: readonly string[]): Promise<void> {
  if (userIds.length === 0) return;

  const found = await db.user.findMany({
    where: { id: { in: [...userIds] }, isActive: true },
    select: { id: true },
  });

  if (found.length !== userIds.length) {
    // Which id was wrong is deliberately not said: the caller supplied them, and confirming
    // which ones exist would make this endpoint a user-id oracle.
    throw new ConversationError(
      'USER_NOT_FOUND',
      'One of those colleagues is no longer available.',
    );
  }
}

/** The actor's own membership of a conversation that must be a group. */
async function requireGroupMembership(
  db: PrismaClient,
  userId: string,
  conversationId: string,
): Promise<ActiveMembership> {
  const membership = await findActiveMembership(db, userId, conversationId);

  // Same answer for "not a member" and "no such conversation", as everywhere else.
  if (!membership) {
    throw new ConversationError('NOT_A_MEMBER', 'You do not have access to this conversation.');
  }
  if (membership.conversationType !== 'GROUP') {
    throw new ConversationError(
      'NOT_A_GROUP',
      'Members can only be changed in a group conversation.',
    );
  }

  return membership;
}

/**
 * Group operations take their timestamp from a row PostgreSQL stamped, never from `new Date()`
 * and never from a raw `SELECT now()`.
 *
 * The difference is a security one. Every `createdAt` in this schema defaults to
 * `CURRENT_TIMESTAMP`, so message times come from the database's clock, and D-03 compares
 * `joinedAt` against them. Two ways of producing that join time were tried, and both are wrong:
 *
 *   - `new Date()` is the application's clock. On a server whose time runs even slightly ahead of
 *     the database's, a member added "now" is given a join time BEFORE messages that already
 *     exist, and sees history they are not entitled to.
 *
 *   - `SELECT now()` through `$queryRaw` is worse, and silently so. Prisma's raw path renders a
 *     `timestamptz` in the database session's zone and hands it back as though it were UTC, so on
 *     a server whose session is not UTC it is out by the whole offset — four hours, on the machine
 *     this was found on. That is four hours of a group's history handed to somebody who has just
 *     joined. Nothing about the value looks wrong until it is compared with another one.
 *
 * What is used instead: each of these operations already writes a `SYSTEM` message recording what
 * happened. That row is written FIRST, its `createdAt` filled in by the column default — the
 * database's own transaction timestamp — and read back through Prisma's ordinary model mapping,
 * which round-trips a `timestamptz` correctly. The membership rows are then stamped with exactly
 * that value.
 *
 * Two things fall out of it. The clocks cannot disagree, because only one of them is consulted.
 * And a new member's `joinedAt` is exactly the timestamp of the message announcing them, so the
 * `createdAt >= joinedAt` window admits the event that added them and nothing before it.
 */

export interface CreateGroupInput {
  /** Server-derived, from the session. The creator is always a member and always the owner. */
  creatorId: string;
  name: unknown;
  /** The other employees to add, by id. The creator's own id is ignored if it appears. */
  memberIds: readonly unknown[];
}

export interface GroupChangeResult {
  conversationId: string;
  /** Everyone who is now an active member — the audience entitled to hear about the change. */
  memberIds: string[];
  /** Users who have just stopped being members, so their sockets leave the room. */
  removedIds: string[];
}

/**
 * Creates a group conversation.
 *
 * The creator is a member by construction and is its `OWNER`; neither is taken from the request.
 * There is no `createdById`, no `role` and no `joinedAt` a browser can supply — an API accepting
 * any of the three would let a caller create a group they are not in, or make somebody else its
 * owner.
 *
 * The membership rows and the `SYSTEM` message recording the creation are written in one
 * transaction and share one timestamp, so every founding member's `joinedAt` is exactly the
 * moment the group's timeline begins and all of them can see it.
 */
export async function createGroupConversation(
  db: PrismaClient,
  input: CreateGroupInput,
): Promise<GroupChangeResult> {
  const name = normaliseGroupName(input.name);
  const targets = distinctTargets(input.memberIds, input.creatorId);

  if (targets.length === 0) {
    throw new ConversationError('NO_MEMBERS', 'Add at least one other colleague to the group.');
  }
  if (targets.length > MAX_GROUP_MEMBERS) {
    throw new ConversationError(
      'TOO_MANY_MEMBERS',
      `A group may be created with at most ${MAX_GROUP_MEMBERS} other members.`,
    );
  }

  await requireActiveUsers(db, targets);

  const conversationId = await db.$transaction(async (tx) => {
    const conversation = await tx.conversation.create({
      data: {
        type: 'GROUP',
        name,
        createdById: input.creatorId,
        // `directKey` stays null: it is the one-conversation-per-pair constraint for direct
        // conversations, and two groups containing the same people are two different groups.
      },
      select: { id: true },
    });

    // Stamped by the database, and it becomes the group's zero hour.
    const opened = await writeSystemMessage(tx, {
      conversationId: conversation.id,
      body: `${name} was created.`,
      clientMessageId: randomUUID(),
    });

    await tx.conversationMember.createMany({
      data: [
        {
          conversationId: conversation.id,
          userId: input.creatorId,
          role: 'OWNER',
          joinedAt: opened.createdAt,
        },
        ...targets.map((userId) => ({
          conversationId: conversation.id,
          userId,
          role: 'MEMBER' as const,
          joinedAt: opened.createdAt,
        })),
      ],
    });

    return conversation.id;
  });

  return { conversationId, memberIds: [input.creatorId, ...targets], removedIds: [] };
}

export interface AddMembersInput {
  /** Server-derived. Must already be an active member of the group. */
  actorId: string;
  conversationId: string;
  userIds: readonly unknown[];
}

/**
 * Adds employees to an existing group.
 *
 * Authorization (Q-05b, option (a)): any active member may add. That is the documented
 * recommendation, and it is the rule with the fewest surprises — the alternative makes an owner
 * on holiday a bottleneck for a team that needs somebody in the conversation.
 *
 * **`joinedAt` is set to now, and it is the whole security story of this function.** A member
 * added today gets today's join time, so every query bounded by `createdAt >= joinedAt` —
 * history, previews, unread counts, and the file downloads of Phase 7 — excludes everything said
 * before. Nothing is deleted to achieve it: the older messages stay exactly where they are, and
 * stay readable by the members who were present for them (D-03).
 *
 * Re-adding somebody who previously left resets `joinedAt` to now and clears their read marker,
 * so their window restarts from this moment rather than resuming where it stopped (Q-17).
 */
export async function addGroupMembers(
  db: PrismaClient,
  input: AddMembersInput,
): Promise<GroupChangeResult> {
  const membership = await requireGroupMembership(db, input.actorId, input.conversationId);
  const requested = distinctTargets(input.userIds, input.actorId);

  if (requested.length === 0) {
    throw new ConversationError('NO_MEMBERS', 'Choose at least one colleague to add.');
  }
  if (requested.length > MAX_GROUP_MEMBERS) {
    throw new ConversationError(
      'TOO_MANY_MEMBERS',
      `At most ${MAX_GROUP_MEMBERS} colleagues can be added at once.`,
    );
  }

  const existing = await db.conversationMember.findMany({
    where: { conversationId: membership.conversationId, userId: { in: requested } },
    select: { userId: true, leftAt: true },
  });

  const alreadyIn = new Set(
    existing.filter((row) => row.leftAt === null).map((row) => row.userId),
  );

  /*
   * Somebody already in the group is skipped, not rejected.
   *
   * Two people adding the same colleague at the same moment is an ordinary race, and the second
   * one has got what they asked for. Re-adding a current member would reset their `joinedAt` and
   * silently hide history they can currently read — a far worse outcome than doing nothing.
   */
  const targets = requested.filter((userId) => !alreadyIn.has(userId));

  if (targets.length === 0) {
    const current = await listActiveMemberIds(db, membership.conversationId);
    return { conversationId: membership.conversationId, memberIds: current, removedIds: [] };
  }

  await requireActiveUsers(db, targets);

  const [actor, added] = await Promise.all([
    db.user.findUnique({ where: { id: input.actorId }, select: { displayName: true } }),
    db.user.findMany({ where: { id: { in: targets } }, select: { id: true, displayName: true } }),
  ]);

  await db.$transaction(async (tx) => {
    /*
     * The event is written first so the database stamps it, and its timestamp becomes every new
     * member's `joinedAt`. That ordering is what makes the two values identical rather than
     * merely close, so the people just added can see the message that added them — and nothing
     * that came before it.
     */
    const event = await writeSystemMessage(tx, {
      conversationId: membership.conversationId,
      body: `${actor?.displayName ?? 'Someone'} added ${formatNameList(
        targets.map((id) => added.find((user) => user.id === id)?.displayName ?? 'someone'),
      )}.`,
      clientMessageId: randomUUID(),
    });

    for (const userId of targets) {
      await tx.conversationMember.upsert({
        where: { conversationId_userId: { conversationId: membership.conversationId, userId } },
        create: {
          conversationId: membership.conversationId,
          userId,
          role: 'MEMBER',
          joinedAt: event.createdAt,
        },
        /*
         * The re-add path. `joinedAt` moves forward and the read marker is cleared: a marker
         * pointing at a message from before this join would suppress the unread count for
         * messages they can now see, and would sit outside their own visible window.
         */
        update: {
          joinedAt: event.createdAt,
          leftAt: null,
          lastReadMessageId: null,
          lastReadAt: null,
        },
      });
    }
  });

  const memberIds = await listActiveMemberIds(db, membership.conversationId);
  return { conversationId: membership.conversationId, memberIds, removedIds: [] };
}

export interface RemoveMemberInput {
  /** Server-derived. */
  actorId: string;
  conversationId: string;
  /** Who to remove. Equal to `actorId` when somebody is leaving of their own accord. */
  targetUserId: string;
}

/**
 * Removes a member from a group, or leaves one.
 *
 * Authorization (Q-05b, option (a)): anybody may leave; only an `OWNER` may remove somebody
 * else. Leaving needs no permission, because it takes access away rather than granting it.
 *
 * The membership row is NOT deleted — `leftAt` is set. That preserves the record of who was
 * present when, which is why every authorization check in this application tests `leftAt IS
 * NULL` rather than the row's existence. Messages the person wrote stay in the conversation and
 * stay attributed to them.
 *
 * If the last owner leaves, ownership passes to the longest-standing remaining member. Without
 * that a group would quietly become unmanageable — nobody able to remove anyone, and no way back
 * short of direct SQL.
 */
export async function removeGroupMember(
  db: PrismaClient,
  input: RemoveMemberInput,
): Promise<GroupChangeResult> {
  const membership = await requireGroupMembership(db, input.actorId, input.conversationId);
  const leaving = input.targetUserId === input.actorId;

  if (!leaving && membership.role !== 'OWNER') {
    throw new ConversationError(
      'NOT_AN_OWNER',
      'Only the group owner can remove someone from the group.',
    );
  }

  const target = await db.conversationMember.findUnique({
    where: {
      conversationId_userId: {
        conversationId: membership.conversationId,
        userId: input.targetUserId,
      },
    },
    select: { userId: true, role: true, leftAt: true },
  });

  if (!target || target.leftAt !== null) {
    throw new ConversationError('MEMBER_NOT_FOUND', 'That person is not in this group.');
  }

  const [actor, removed] = await Promise.all([
    db.user.findUnique({ where: { id: input.actorId }, select: { displayName: true } }),
    db.user.findUnique({ where: { id: input.targetUserId }, select: { displayName: true } }),
  ]);

  await db.$transaction(async (tx) => {
    const event = await writeSystemMessage(tx, {
      conversationId: membership.conversationId,
      body: leaving
        ? `${actor?.displayName ?? 'Someone'} left the group.`
        : `${actor?.displayName ?? 'Someone'} removed ${removed?.displayName ?? 'someone'}.`,
      clientMessageId: randomUUID(),
    });

    await tx.conversationMember.update({
      where: {
        conversationId_userId: {
          conversationId: membership.conversationId,
          userId: input.targetUserId,
        },
      },
      // Stamped from the event, so "when did they leave" and "which message says so" agree.
      data: { leftAt: event.createdAt },
    });

    // Ownership succession, so a group is never left with nobody able to manage it.
    if (target.role === 'OWNER') {
      const remainingOwners = await tx.conversationMember.count({
        where: { conversationId: membership.conversationId, leftAt: null, role: 'OWNER' },
      });

      if (remainingOwners === 0) {
        const successor = await tx.conversationMember.findFirst({
          where: { conversationId: membership.conversationId, leftAt: null },
          orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
          select: { id: true },
        });

        if (successor) {
          await tx.conversationMember.update({
            where: { id: successor.id },
            data: { role: 'OWNER' },
          });
        }
      }
    }
  });

  const memberIds = await listActiveMemberIds(db, membership.conversationId);
  return {
    conversationId: membership.conversationId,
    memberIds,
    removedIds: [input.targetUserId],
  };
}

/** The active membership of a conversation, as ids: the audience for a change notification. */
async function listActiveMemberIds(db: PrismaClient, conversationId: string): Promise<string[]> {
  const members = await db.conversationMember.findMany({
    where: { conversationId, leftAt: null },
    select: { userId: true },
  });
  return members.map((member) => member.userId);
}

/** "Ann", "Ann and Bo", "Ann, Bo and Cai" — for the system message that records a change. */
function formatNameList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? 'someone';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
