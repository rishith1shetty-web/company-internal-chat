/**
 * Conversation membership authorization.
 *
 * The single place that answers "may this user act in this conversation?". Every socket handler
 * and, from Phase 5, every route handler goes through here. Keeping it in one module means the
 * two rules below cannot be applied inconsistently between the HTTP and socket entry points —
 * which is exactly how access-control bugs appear in an application with two front doors.
 *
 * Two rules, both easy to get wrong, both stated in docs/02-database.md:
 *
 * 1. **`leftAt IS NULL`.** A membership row is kept when someone leaves or is removed, so that
 *    history stays attributable. Testing that the row merely exists would let a removed member
 *    keep reading the conversation. Described in the schema as the most likely place for an
 *    access-control bug here.
 *
 * 2. **`joinedAt` bounds visible history (D-03).** A group member sees only messages sent at or
 *    after they joined. This module returns `joinedAt` with every successful check so callers
 *    cannot forget it — a caller that only asks "is this person a member?" has already lost the
 *    information it needs to filter correctly.
 */

import type { ConversationType, PrismaClient } from '../../prisma/generated/client';

/** A confirmed, currently-active membership. Produced only by a database check. */
export interface ActiveMembership {
  conversationId: string;
  userId: string;
  conversationType: ConversationType;
  /**
   * The start of this member's visible history window (D-03). Every message query, preview,
   * unread count and — from Phase 7 — file download must filter on `createdAt >= joinedAt`.
   */
  joinedAt: Date;
  role: 'OWNER' | 'MEMBER';
}

/**
 * Returns the caller's active membership of a conversation, or null.
 *
 * Null means "not authorized" for every purpose: not a member, removed, or the conversation does
 * not exist. Callers must not distinguish between those cases in anything they send to the
 * browser — telling an outsider that a conversation id exists is itself a disclosure.
 */
export async function findActiveMembership(
  db: PrismaClient,
  userId: string,
  conversationId: string,
): Promise<ActiveMembership | null> {
  // Uses the (userId, conversationId) index that exists for exactly this query.
  const membership = await db.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
    select: {
      conversationId: true,
      userId: true,
      joinedAt: true,
      leftAt: true,
      role: true,
      conversation: { select: { type: true } },
    },
  });

  // Rule 1: the row exists for a removed member too.
  if (!membership || membership.leftAt !== null) return null;

  return {
    conversationId: membership.conversationId,
    userId: membership.userId,
    conversationType: membership.conversation.type,
    joinedAt: membership.joinedAt,
    role: membership.role,
  };
}

/**
 * All conversations the user is currently an active member of.
 *
 * Used at connection time to decide which rooms a socket may join. The set is derived from the
 * database every time a socket connects; it is never carried over from a previous connection and
 * never taken from the client.
 */
export async function listActiveMemberships(
  db: PrismaClient,
  userId: string,
): Promise<ActiveMembership[]> {
  const memberships = await db.conversationMember.findMany({
    where: { userId, leftAt: null },
    select: {
      conversationId: true,
      userId: true,
      joinedAt: true,
      role: true,
      conversation: { select: { type: true } },
    },
  });

  return memberships.map((membership) => ({
    conversationId: membership.conversationId,
    userId: membership.userId,
    conversationType: membership.conversation.type,
    joinedAt: membership.joinedAt,
    role: membership.role,
  }));
}

/**
 * The other active members of a conversation, for presence and delivery decisions.
 * Excludes the caller.
 */
export async function listOtherActiveMemberIds(
  db: PrismaClient,
  conversationId: string,
  excludeUserId: string,
): Promise<string[]> {
  const members = await db.conversationMember.findMany({
    where: { conversationId, leftAt: null, userId: { not: excludeUserId } },
    select: { userId: true },
  });

  return members.map((member) => member.userId);
}

/**
 * Every user who shares at least one active conversation with this user.
 *
 * These are the people entitled to be told that this user came online or went offline. Presence
 * is not broadcast beyond them: someone with no conversation in common has no business being
 * notified (CLAUDE.md §10, "avoid broadcasting sensitive data to users who are not members").
 */
export async function listPresencePeerIds(db: PrismaClient, userId: string): Promise<string[]> {
  const rows = await db.conversationMember.findMany({
    where: {
      leftAt: null,
      userId: { not: userId },
      conversation: { members: { some: { userId, leftAt: null } } },
    },
    select: { userId: true },
    distinct: ['userId'],
  });

  return rows.map((row) => row.userId);
}
