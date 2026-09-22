/**
 * Who has read a message (Batch 1.3).
 *
 * NO NEW TABLE AND NO MIGRATION. The question "has user X read message Y?" is already answerable
 * from the read marker the application has kept since Phase 5, and this module is the place that
 * asks it properly rather than a new place that stores the same fact twice.
 *
 * ── THE EXISTING MODEL, and exactly what it can and cannot say ──────────────────────────────
 *
 * `ConversationMember.lastReadAt` is a WATERMARK IN MESSAGE TIME. `markConversationRead` sets it
 * to the `createdAt` of the furthest message the member has seen:
 *
 *     data: { lastReadMessageId: message.id, lastReadAt: message.createdAt }
 *
 * It is never set to the wall clock, and it only ever moves forward. Two consequences follow, and
 * the whole design of this feature rests on them:
 *
 *   1. **"Read?" is answerable.** `lastReadAt >= message.createdAt` means the member's marker has
 *      reached or passed that message. This is the EXACT COMPLEMENT of the unread count, which
 *      counts `createdAt > lastReadAt` — so a message this module calls read is precisely one the
 *      badge does not count, and the two can never disagree.
 *
 *   2. **"When did they read it?" is NOT answerable.** `lastReadAt` is a message's timestamp, not
 *      a reading moment. Somebody who opens a conversation today, where the last message is from
 *      Monday, gets a `lastReadAt` of Monday. Presenting that as "read at" would be worse than
 *      showing nothing: it would be a specific, plausible, wrong time. So no read times are
 *      reported anywhere in this feature, and the interface does not leave room for them.
 *
 * ── ORDERING, AND THE ONE IMPRECISION ───────────────────────────────────────────────────────
 *
 * Comparison is on `createdAt`, never on ids — a uuid says nothing about order. `createdAt` is
 * `TIMESTAMPTZ(3)`, so two messages in the same conversation CAN share a millisecond, and a
 * watermark landing on one then also covers the other.
 *
 * That imprecision is real, bounded at one millisecond, and is not new: the unread badge has
 * always been computed the same way, so this feature cannot be more wrong than the badge beside
 * it. It is also not reachable in practice from the client, which always marks with the NEWEST
 * message in the loaded page — so a tie is resolved by covering both, which is correct, rather
 * than by covering the wrong one. Eliminating it entirely would mean storing a receipt per
 * message per member, which is the migration this batch deliberately does not make.
 *
 * ── ELIGIBILITY (D-03) ──────────────────────────────────────────────────────────────────────
 *
 * Only members who could ever have read the message are considered: `joinedAt <= createdAt`.
 * Somebody added to a group afterwards is not "not read" — the message was never theirs to see,
 * and listing them would both misreport them and disclose the shape of history they cannot read.
 */

import type { PrismaClient } from '../../prisma/generated/client';
import { MessageActionError, loadAccessibleMessage } from './actions';

/** One person's standing with respect to one message. */
export interface MessageReader {
  userId: string;
  /**
   * False when this person has since left the group.
   *
   * Their membership row survives a departure with its watermark intact (`leftAt` is set, nothing
   * is cleared), so "they read it before they left" stays a true and reportable fact.
   */
  stillMember: boolean;
}

export interface MessageReadStatus {
  conversationId: string;
  /** Members eligible for the message whose watermark has reached it. Never the sender. */
  readBy: MessageReader[];
  /**
   * Eligible members whose watermark has not reached it — current members only.
   *
   * Somebody who has left is deliberately NOT listed here. They are not going to read it, and a
   * former colleague pinned under "Not read by" for ever is noise rather than information.
   */
  notReadBy: MessageReader[];
}

/**
 * Per-member read status for a message the caller sent.
 *
 * AUTHORIZATION, in order, and none of it trusts the request:
 *
 *   1. `loadAccessibleMessage` — the message exists, the caller is an ACTIVE member of the
 *      conversation the MESSAGE says it is in, and it is inside the caller's own D-03 window. The
 *      conversation is read from the message row; no conversation id is accepted from the caller,
 *      so a message from one conversation cannot be paired with another the caller is in.
 *   2. The caller is the stored `senderId`. Read status for somebody else's message is not the
 *      caller's business — this is a "who has seen what I said" feature, not a way to watch
 *      colleagues.
 *   3. Not a tombstone. A deleted message has no content left to have been read, and answering
 *      for one would keep a deleted thing alive in the interface.
 *
 * "Not the sender" answers the same `NOT_THE_SENDER` the delete and edit paths use, and the route
 * maps it to the same 403 body as `NOT_ACCESSIBLE` so the two are indistinguishable from outside.
 */
export async function readStatusForMessage(
  db: PrismaClient,
  input: { userId: string; messageId: string },
): Promise<MessageReadStatus> {
  const { message } = await loadAccessibleMessage(db, input.userId, input.messageId);

  if (message.senderId === null || message.senderId !== input.userId) {
    throw new MessageActionError(
      'NOT_THE_SENDER',
      'Only the person who sent a message can see who has read it.',
    );
  }

  if (message.deletedAt !== null) {
    throw new MessageActionError('NOT_ACTIONABLE', 'That message has been deleted.');
  }

  /*
   * Departed members are INCLUDED in this query (`leftAt` is not filtered) so that somebody who
   * read the message and then left is still reported as having read it. Whether they appear at
   * all is then decided below, from their watermark.
   */
  const members = await db.conversationMember.findMany({
    where: {
      conversationId: message.conversationId,
      // D-03: only people who were already in the conversation when this was said.
      joinedAt: { lte: message.createdAt },
      // The sender is neither "read by" nor "not read by" themselves.
      userId: { not: input.userId },
    },
    select: { userId: true, leftAt: true, lastReadAt: true },
  });

  const readBy: MessageReader[] = [];
  const notReadBy: MessageReader[] = [];

  for (const member of members) {
    const stillMember = member.leftAt === null;
    // The complement of the unread count, to the character: unread is `createdAt > lastReadAt`.
    const hasRead = member.lastReadAt !== null && member.lastReadAt >= message.createdAt;

    if (hasRead) readBy.push({ userId: member.userId, stillMember });
    else if (stillMember) notReadBy.push({ userId: member.userId, stillMember });
  }

  return { conversationId: message.conversationId, readBy, notReadBy };
}

/**
 * Whether one member's watermark has reached a message.
 *
 * The single comparison this feature is built on, named once so the direct-chat "Seen" indicator
 * and the group panel cannot drift into asking it two different ways.
 */
export function hasReadMessage(
  lastReadAt: Date | null,
  messageCreatedAt: Date,
): boolean {
  return lastReadAt !== null && lastReadAt >= messageCreatedAt;
}
