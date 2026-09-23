/**
 * Group mentions — validation, storage and who they notify (Batch 1.7).
 *
 * THE RULE THE WHOLE FEATURE TURNS ON: a mention is metadata the client PROPOSES and the server
 * DECIDES. What arrives is a list of spans and user ids typed by somebody's browser; none of it
 * is believed. Every span is re-checked against the message text the server is about to store,
 * and every user id is re-checked against the conversation's live membership. A payload claiming
 * to mention somebody in another group, somebody who left, or somebody who never existed is
 * refused — not filtered quietly, refused — because a client sending one is either broken or
 * hostile and both are worth failing loudly.
 *
 * WHY @EVERYONE STORES NO AUDIENCE. The obvious shape is a row per resolved recipient, computed
 * at send time. It is wrong twice over: it would freeze an audience that the membership table
 * answers better at read time, and it would be exactly the "client-submitted array representing
 * everyone" this must not trust. So `@everyone` is ONE row with a null user and a span, and the
 * recipients are derived from active membership whenever anybody asks.
 *
 * WHAT IS NOT HERE, deliberately: nothing that notifies, nothing that emits, nothing that writes
 * outside the mention rows. Mentions change who a notification is ABOUT; they never add a second
 * notification, a second sound, a second unread increment or a second delivery path. The
 * functions below return data and the existing message paths carry it.
 */

import type { ConversationType, MentionKind, Prisma, PrismaClient } from '../../prisma/generated/client';

/** The literal that means everyone. The only special token; there is no @all, @channel or @here. */
export const MENTION_EVERYONE_TOKEN = 'everyone';

/** The text a client must have written for an `EVERYONE` mention. */
export const MENTION_EVERYONE_TEXT = `@${MENTION_EVERYONE_TOKEN}`;

/**
 * Most mentions one message may carry.
 *
 * A real sentence names a handful of people. Twenty is far beyond that and still small enough
 * that validating them all is free; past it, the payload is a script rather than a message.
 */
export const MAX_MENTIONS_PER_MESSAGE = 20;

/** A mention as the client proposes it. Every field is re-derived or re-checked below. */
export interface MentionInput {
  kind: MentionKind;
  /** Required for `USER`, and must be absent or null for `EVERYONE`. */
  userId?: string | null;
  startOffset: number;
  endOffset: number;
}

/** A mention the server has accepted, ready to be written. */
export interface ValidatedMention {
  kind: MentionKind;
  mentionedUserId: string | null;
  startOffset: number;
  endOffset: number;
}

export type MentionErrorCode =
  | 'NOT_A_GROUP'
  | 'TOO_MANY_MENTIONS'
  | 'INVALID_RANGE'
  | 'OVERLAPPING_RANGES'
  | 'TEXT_MISMATCH'
  | 'NOT_A_MEMBER'
  | 'DUPLICATE_MENTION';

export class MentionError extends Error {
  readonly code: MentionErrorCode;

  constructor(code: MentionErrorCode, message: string) {
    super(message);
    this.name = 'MentionError';
    this.code = code;
  }
}

/**
 * Checks a proposed mention list against the body it claims to describe and the group it claims
 * to be in, and returns the rows to store.
 *
 * Order is deliberate. The cheap structural checks run before the database is touched, so a
 * malformed payload costs no query; membership — the only check that can disclose anything — is
 * resolved once, in a single query, for every mentioned id at once.
 *
 * MENTIONS ARE GROUP-ONLY. A direct conversation has exactly two people who are both already
 * looking at the same thread; "@" there means nothing and would only create a second, quieter
 * way of notifying somebody who is already notified. A payload carrying mentions for a direct
 * conversation is therefore refused rather than stripped — silently stripping would make a
 * confused client look like a working one.
 */
export async function validateMentions(
  db: Pick<PrismaClient, 'conversationMember'>,
  input: {
    conversationId: string;
    conversationType: ConversationType;
    body: string;
    mentions: readonly MentionInput[];
  },
): Promise<ValidatedMention[]> {
  if (input.mentions.length === 0) return [];

  if (input.conversationType !== 'GROUP') {
    throw new MentionError('NOT_A_GROUP', 'Mentions are only available in group conversations.');
  }

  if (input.mentions.length > MAX_MENTIONS_PER_MESSAGE) {
    throw new MentionError(
      'TOO_MANY_MENTIONS',
      `A message may mention at most ${MAX_MENTIONS_PER_MESSAGE} times.`,
    );
  }

  const ordered = [...input.mentions].sort((a, b) => a.startOffset - b.startOffset);

  /* ---- structural checks, before any query -------------------------------------------------- */

  /*
   * Exact duplicates first, so a doubled payload is reported as what it is rather than as an
   * overlap — two identical spans are both, and "duplicate" is the more useful of the two.
   */
  const seenStarts = new Set<number>();
  for (const mention of ordered) {
    if (seenStarts.has(mention.startOffset)) {
      throw new MentionError('DUPLICATE_MENTION', 'That message could not be sent.');
    }
    seenStarts.add(mention.startOffset);
  }

  let previousEnd = -1;
  for (const mention of ordered) {
    assertWholeNumber(mention.startOffset);
    assertWholeNumber(mention.endOffset);

    if (
      mention.startOffset < 0 ||
      mention.endOffset <= mention.startOffset ||
      mention.endOffset > input.body.length
    ) {
      throw new MentionError('INVALID_RANGE', 'That message could not be sent.');
    }

    /*
     * Sorted by start, so a partial overlap can only be "this one begins before the last one
     * ended". Two highlights over the same characters have no sensible rendering. Adjacency —
     * one ending exactly where the next begins — is allowed: "@a@b" is odd but not malformed.
     */
    if (mention.startOffset < previousEnd) {
      throw new MentionError('OVERLAPPING_RANGES', 'That message could not be sent.');
    }
    previousEnd = mention.endOffset;
  }

  /* ---- the text must actually say what the metadata claims ---------------------------------- */

  const userIds = new Set<string>();
  for (const mention of ordered) {
    const text = input.body.slice(mention.startOffset, mention.endOffset);

    if (mention.kind === 'EVERYONE') {
      if (mention.userId != null) {
        throw new MentionError('INVALID_RANGE', 'That message could not be sent.');
      }
      if (text !== MENTION_EVERYONE_TEXT) {
        throw new MentionError('TEXT_MISMATCH', 'That message could not be sent.');
      }
      continue;
    }

    if (typeof mention.userId !== 'string' || mention.userId.length === 0) {
      throw new MentionError('INVALID_RANGE', 'That message could not be sent.');
    }
    if (!text.startsWith('@')) {
      throw new MentionError('TEXT_MISMATCH', 'That message could not be sent.');
    }
    userIds.add(mention.userId);
  }

  /* ---- membership, and the name the text must match ----------------------------------------- */

  /*
   * ONE query for every mentioned person, and it is the authorization boundary: it asks the
   * membership table for rows in THIS conversation that have not left. Somebody outside the
   * group, somebody who left, a member of another group and an invented id all come back absent,
   * and absence is a refusal.
   */
  const members =
    userIds.size === 0
      ? []
      : await db.conversationMember.findMany({
          where: {
            conversationId: input.conversationId,
            userId: { in: [...userIds] },
            leftAt: null,
          },
          select: { userId: true, user: { select: { displayName: true } } },
        });

  const nameById = new Map(members.map((member) => [member.userId, member.user.displayName]));

  for (const id of userIds) {
    if (!nameById.has(id)) {
      throw new MentionError(
        'NOT_A_MEMBER',
        'You can only mention people who are in this group.',
      );
    }
  }

  /*
   * The written text must be the person's name.
   *
   * This is what stops a message reading "@Harsh" while quietly notifying Nilesh: the span, the
   * id and the name all have to agree at the moment of sending. Afterwards the name may change
   * and the text does not — see the note on `MessageMention` — but at send time they are one
   * fact, checked once.
   */
  for (const mention of ordered) {
    if (mention.kind !== 'USER') continue;

    const expected = `@${nameById.get(mention.userId as string) ?? ''}`;
    if (input.body.slice(mention.startOffset, mention.endOffset) !== expected) {
      throw new MentionError('TEXT_MISMATCH', 'That message could not be sent.');
    }
  }

  return ordered.map((mention) => ({
    kind: mention.kind,
    mentionedUserId: mention.kind === 'USER' ? (mention.userId as string) : null,
    startOffset: mention.startOffset,
    endOffset: mention.endOffset,
  }));
}

function assertWholeNumber(value: number): void {
  if (!Number.isInteger(value)) {
    throw new MentionError('INVALID_RANGE', 'That message could not be sent.');
  }
}

/** Writes a message's mentions. Call inside the same transaction as the message itself. */
export async function writeMentions(
  tx: Pick<Prisma.TransactionClient, 'messageMention'>,
  messageId: string,
  mentions: readonly ValidatedMention[],
): Promise<void> {
  if (mentions.length === 0) return;

  await tx.messageMention.createMany({
    data: mentions.map((mention) => ({
      messageId,
      kind: mention.kind,
      mentionedUserId: mention.mentionedUserId,
      startOffset: mention.startOffset,
      endOffset: mention.endOffset,
    })),
  });
}

/**
 * Replaces a message's mentions wholesale. For editing.
 *
 * Delete-then-insert rather than a diff: the offsets of every surviving mention move when the
 * text around them changes, so almost nothing is ever reusable and a diff would be more code
 * doing the same work less obviously. Both statements run in one transaction, so a message is
 * never briefly mentioning the wrong people.
 */
export async function replaceMentions(
  tx: Pick<Prisma.TransactionClient, 'messageMention'>,
  messageId: string,
  mentions: readonly ValidatedMention[],
): Promise<void> {
  await tx.messageMention.deleteMany({ where: { messageId } });
  await writeMentions(tx, messageId, mentions);
}

/**
 * Who a message's mentions actually notify.
 *
 * Resolved from CURRENT active membership, never from stored rows, because `@everyone` names no
 * one at write time and because a member who left between the send and the read should not be
 * counted.
 *
 * Three rules, all of them about not notifying somebody twice or pointlessly:
 *
 *   - The sender is removed last, after everything else, so a forged self-mention and an
 *     `@everyone` that structurally includes them both come to nothing.
 *   - `@everyone` collapses with explicit mentions rather than adding to them — the result is a
 *     SET, so "@everyone @Nilesh" names Nilesh exactly once.
 *   - Repeating a name repeats the highlight, not the recipient.
 *
 * Returns ids only. Turning those into a notification is the existing message path's job, and
 * this adds nothing to it — one arrived message is still one notification event at most.
 */
export async function resolveMentionRecipients(
  db: Pick<PrismaClient, 'conversationMember'>,
  input: {
    conversationId: string;
    senderId: string | null;
    mentions: readonly { kind: MentionKind; mentionedUserId: string | null }[];
  },
): Promise<string[]> {
  if (input.mentions.length === 0) return [];

  const recipients = new Set<string>();

  if (input.mentions.some((mention) => mention.kind === 'EVERYONE')) {
    const members = await db.conversationMember.findMany({
      where: { conversationId: input.conversationId, leftAt: null },
      select: { userId: true },
    });
    for (const member of members) recipients.add(member.userId);
  }

  for (const mention of input.mentions) {
    if (mention.kind === 'USER' && mention.mentionedUserId !== null) {
      recipients.add(mention.mentionedUserId);
    }
  }

  // Never yourself, however the mention got there.
  if (input.senderId !== null) recipients.delete(input.senderId);

  return [...recipients];
}
