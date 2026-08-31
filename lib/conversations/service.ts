/**
 * Conversation service — resolving, listing and marking conversations read.
 *
 * PHASE 5 SCOPE: direct (one-to-one) conversations. Group creation and management is Phase 6;
 * nothing here creates a `GROUP` row. The listing and read-marker functions are already written
 * against the generic membership model, so Phase 6 adds group creation rather than rewriting
 * this module.
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
 *    but the filter is applied anyway — a rule that is only applied where it currently matters
 *    is a rule that will be missed in Phase 6.
 *
 * 3. **Identity is never resolved by name.** Every function here takes user ids. A display name
 *    is a label (D-02); two people may share one, and no lookup in this file accepts one.
 */

import type { PrismaClient } from '../../prisma/generated/client';
import { Prisma } from '../../prisma/generated/client';
import { findActiveMembership } from '../authz/membership';

/** Prisma's unique-constraint violation. */
const UNIQUE_VIOLATION = 'P2002';

export type ConversationFailure =
  | 'USER_NOT_FOUND'
  | 'SELF_CONVERSATION'
  | 'NOT_A_MEMBER'
  | 'MESSAGE_NOT_FOUND';

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
}

export interface ConversationSummary {
  id: string;
  type: 'DIRECT' | 'GROUP';
  name: string | null;
  createdAt: Date;
  lastMessageAt: Date | null;
  members: { userId: string; role: 'OWNER' | 'MEMBER'; joinedAt: Date }[];
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
            select: { userId: true, role: true, joinedAt: true },
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
    if (message) previews.set(conversationId, message);
  }
  return previews;
}

/**
 * Unread counts for every conversation, in one grouped query.
 *
 * Unread means: inside the caller's visible window, newer than their read marker, and not sent
 * by the caller. A message with no sender (a `SYSTEM` message) counts as unread, which is what
 * Prisma's `not` filter does with nulls and what the interface should show.
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

export interface ReadMarkerResult {
  conversationId: string;
  lastReadMessageId: string;
  lastReadAt: Date;
  unreadCount: number;
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
  };
}
