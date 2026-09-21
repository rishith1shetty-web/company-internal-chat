/**
 * Message service — the business rules for sending and reading messages.
 *
 * Callable from both entry points, which is what keeps them from drifting: the Socket.IO handler
 * calls `sendMessage` today, and the Phase 5 REST fallback will call the same function
 * (docs/01-architecture.md §4, "Services").
 *
 * The ordering rule this module exists to enforce (CLAUDE.md §10): **a message counts as sent
 * only once the transaction commits.** The acknowledgement follows the write; it never precedes
 * it, and nothing is broadcast before PostgreSQL has the row. The real-time layer is a delivery
 * accelerator, never the source of truth.
 */

import { Prisma, type PrismaClient } from '../../prisma/generated/client';
import { findActiveMembership } from '../authz/membership';

/** Server-side message length limit. The UI applies the same number; the server decides. */
export const MAX_MESSAGE_LENGTH = 4000;

/** Prisma's unique-constraint violation. */
const UNIQUE_VIOLATION = 'P2002';

export type SendMessageFailure =
  | 'NOT_A_MEMBER'
  | 'EMPTY_BODY'
  | 'BODY_TOO_LONG'
  | 'CONVERSATION_NOT_FOUND'
  /** The reply target is not in this conversation, or not inside the sender's window. */
  | 'REPLY_TARGET_INVALID';

export class SendMessageError extends Error {
  readonly reason: SendMessageFailure;

  constructor(reason: SendMessageFailure, message: string) {
    super(message);
    this.name = 'SendMessageError';
    this.reason = reason;
  }
}

export interface SendMessageInput {
  /** Server-derived. Never accepted from the client (CLAUDE.md §10). */
  senderId: string;
  conversationId: string;
  body: string;
  /** Browser-minted idempotency key. The one client-supplied id the design accepts, by design. */
  clientMessageId: string;
  /**
   * Batch 1: the message being replied to, if any.
   *
   * Verified, never trusted — `assertReplyTargetVisible` requires it to be in the SAME
   * conversation and inside the sender's own D-03 window. Without that check a member could
   * quote a message out of a conversation they have no access to, and the quoted text would be
   * rendered to everyone here.
   */
  replyToId?: string | undefined;
}

/**
 * The file on a `FILE` message (Phase 7).
 *
 * Selected alongside every message rather than fetched separately: a page of fifty messages would
 * otherwise be fifty extra queries, and the join is on `Attachment.messageId`, which is unique.
 *
 * `storageKey` is deliberately absent. It is never selected into anything that travels upward, so
 * there is no route by which a physical path could reach a browser even by accident.
 */
export interface StoredAttachment {
  id: string;
  originalFilename: string;
  byteSize: bigint;
  mimeType: string;
  extension: string;
  createdAt: Date;
}

/** The message a reply points at, as stored. Gated per reader during serialization (D-03). */
export interface StoredReplyTarget {
  id: string;
  senderId: string | null;
  body: string | null;
  createdAt: Date;
  deletedAt: Date | null;
  attachment: { originalFilename: string } | null;
}

/** One reaction row, before aggregation. */
export interface StoredReaction {
  emoji: string;
  userId: string;
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  senderId: string | null;
  clientMessageId: string;
  type: 'TEXT' | 'FILE' | 'SYSTEM';
  body: string | null;
  createdAt: Date;
  /** Present on `FILE` messages, null on the rest. */
  attachment: StoredAttachment | null;
  /** Batch 1. Null when this message is not a reply, or the parent row is gone. */
  replyTo: StoredReplyTarget | null;
  isForwarded: boolean;
  pinnedAt: Date | null;
  deletedAt: Date | null;
  reactions: StoredReaction[];
}

export interface SendMessageResult {
  message: StoredMessage;
  /**
   * The sender's own D-03 lower bound, so the caller can serialize the message for them without
   * a second membership read. Serialization needs it because a reply quotes another message.
   */
  viewerJoinedAt: Date;
  /**
   * True when this call matched an existing row rather than inserting one — a retry after a
   * dropped acknowledgement. The caller must not broadcast again.
   */
  duplicate: boolean;
}

/**
 * Validates, authorizes, persists and returns a message.
 *
 * Order matters and is deliberate: authorize before touching content, write inside one
 * transaction with the conversation's `lastMessageAt`, and only then hand the row back for
 * delivery.
 */
export async function sendMessage(
  db: PrismaClient,
  input: SendMessageInput,
): Promise<SendMessageResult> {
  const body = input.body.trim();

  if (body.length === 0) {
    throw new SendMessageError('EMPTY_BODY', 'A message cannot be empty.');
  }
  if (body.length > MAX_MESSAGE_LENGTH) {
    throw new SendMessageError(
      'BODY_TOO_LONG',
      `A message may be at most ${MAX_MESSAGE_LENGTH} characters.`,
    );
  }

  // Authorization first, and from the database — not from anything the socket was told earlier.
  const membership = await findActiveMembership(db, input.senderId, input.conversationId);
  if (!membership) {
    // Deliberately the same failure for "not a member" and "no such conversation": distinguishing
    // them would confirm that a conversation id exists to someone with no access to it.
    throw new SendMessageError('NOT_A_MEMBER', 'You are not a member of this conversation.');
  }

  if (input.replyToId !== undefined) {
    await assertReplyTargetVisible(db, {
      conversationId: input.conversationId,
      joinedAt: membership.joinedAt,
      replyToId: input.replyToId,
    });
  }

  try {
    const message = await db.$transaction(async (tx) => {
      const created = await tx.message.create({
        data: {
          conversationId: input.conversationId,
          // From the resolved session, never from the payload.
          senderId: input.senderId,
          type: 'TEXT',
          body,
          clientMessageId: input.clientMessageId,
          ...(input.replyToId === undefined ? {} : { replyToId: input.replyToId }),
        },
        select: messageSelection,
      });

      // Same transaction as the insert, so the denormalised ordering column cannot drift from
      // the messages it orders (docs/02-database.md §5).
      await tx.conversation.update({
        where: { id: input.conversationId },
        data: { lastMessageAt: created.createdAt },
      });

      return created;
    });

    return { message, viewerJoinedAt: membership.joinedAt, duplicate: false };
  } catch (error) {
    // The duplicate-send guard: unique (senderId, clientMessageId). A retry after a dropped
    // acknowledgement lands here, and the correct answer is the message that already exists —
    // not a second copy of it, and not an error the user would see.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION) {
      const existing = await db.message.findUnique({
        where: {
          senderId_clientMessageId: {
            senderId: input.senderId,
            clientMessageId: input.clientMessageId,
          },
        },
        select: messageSelection,
      });

      if (existing) {
        return { message: existing, viewerJoinedAt: membership.joinedAt, duplicate: true };
      }
    }

    throw error;
  }
}

/**
 * Everything a message needs to render, in one query.
 *
 * The three joins here (attachment, reply target, reactions) are all bounded: one attachment per
 * message, one parent, and at most one reaction row per member. Fetching them separately would
 * turn a fifty-message page into a few hundred round trips for no benefit.
 *
 * `storageKey` is deliberately absent, here and in the reply target — a physical path has no
 * route to a browser even by accident.
 */
export const messageSelection = {
  id: true,
  conversationId: true,
  senderId: true,
  clientMessageId: true,
  type: true,
  body: true,
  createdAt: true,
  isForwarded: true,
  pinnedAt: true,
  deletedAt: true,
  attachment: {
    select: {
      id: true,
      originalFilename: true,
      byteSize: true,
      mimeType: true,
      extension: true,
      createdAt: true,
    },
  },
  replyTo: {
    select: {
      id: true,
      senderId: true,
      body: true,
      createdAt: true,
      deletedAt: true,
      attachment: { select: { originalFilename: true } },
    },
  },
  reactions: {
    select: { emoji: true, userId: true },
    orderBy: { createdAt: 'asc' },
  },
} as const;

/**
 * A Prisma client or a transaction handle.
 *
 * Group membership changes (Phase 6) write the membership rows and the `SYSTEM` message that
 * records them in ONE transaction, so the timeline cannot end up describing a change that did
 * not commit. That means the message writer has to be usable inside a caller's transaction as
 * well as on its own.
 */
export type MessageWriter = PrismaClient | Prisma.TransactionClient;

export interface SystemMessageInput {
  conversationId: string;
  body: string;
  clientMessageId: string;
}

/**
 * Writes a membership/group event into the conversation's timeline, inside the caller's
 * transaction, and returns the stored row.
 *
 * `SYSTEM` messages have no sender: the server writes them, not a user. The unique index on
 * `(senderId, clientMessageId)` therefore never collides between two of them — PostgreSQL treats
 * NULLs as distinct — so these cannot be de-duplicated by the send guard and must not be retried
 * blindly.
 *
 * There is deliberately no way to supply `createdAt`. The column default is the database's own
 * transaction timestamp, and the group operations depend on that: they write the event first and
 * stamp `joinedAt` from the row that comes back, so a member's D-03 window and the message
 * announcing them are the same instant on the same clock. An overridable timestamp here would be
 * an invitation to hand in the application's clock and quietly widen somebody's window
 * (lib/conversations/service.ts).
 */
export async function writeSystemMessage(
  tx: MessageWriter,
  input: SystemMessageInput,
): Promise<StoredMessage> {
  const created = await tx.message.create({
    data: {
      conversationId: input.conversationId,
      senderId: null,
      type: 'SYSTEM',
      body: input.body,
      clientMessageId: input.clientMessageId,
    },
    select: messageSelection,
  });

  await tx.conversation.update({
    where: { id: input.conversationId },
    data: { lastMessageAt: created.createdAt },
  });

  return created;
}

/** The same write, in a transaction of its own, for a caller that has none. */
export async function recordSystemMessage(
  db: PrismaClient,
  input: SystemMessageInput,
): Promise<StoredMessage> {
  return db.$transaction((tx) => writeSystemMessage(tx, input));
}

/* --------------------------------------------------------------------------------------------- */
/* History (Phase 5)                                                                               */
/* --------------------------------------------------------------------------------------------- */

/** Initial history window. Enough to fill a screen and scroll back a little. */
export const HISTORY_DEFAULT_LIMIT = 50;
/** Ceiling, so a crafted `limit` cannot ask for a conversation's entire history in one request. */
export const HISTORY_MAX_LIMIT = 100;

export type ListMessagesFailure = 'NOT_A_MEMBER' | 'INVALID_CURSOR';

export class ListMessagesError extends Error {
  readonly reason: ListMessagesFailure;

  constructor(reason: ListMessagesFailure, message: string) {
    super(message);
    this.name = 'ListMessagesError';
    this.reason = reason;
  }
}

export interface ListMessagesInput {
  /** Server-derived. Never accepted from the client. */
  userId: string;
  conversationId: string;
  /** Page backwards: messages older than this message id. */
  before?: string | undefined;
  /** Backfill forwards: messages newer than this message id. Used after a reconnect. */
  after?: string | undefined;
  limit?: number | undefined;
}

export interface MessagePage {
  /** Oldest first, so the caller can append them to a rendered list without re-sorting. */
  messages: StoredMessage[];
  /** True when more messages exist beyond this page in the direction that was paged. */
  hasMore: boolean;
  /** The reader's D-03 lower bound, which serialization needs to gate reply previews. */
  viewerJoinedAt: Date;
}

/**
 * Reads a page of conversation history.
 *
 * Two rules, both enforced here rather than by the caller:
 *
 * 1. **Membership.** A conversation id from a browser is a request, not a permission. Failure is
 *    indistinguishable from "no such conversation" on purpose.
 *
 * 2. **`joinedAt` (D-03).** Every query filters `createdAt >= joinedAt`, including the cursor
 *    lookup — otherwise a member could page backwards past their own join time by handing in the
 *    id of a message from before it.
 *
 * Pagination is keyset on `(createdAt, id)`, matching the index the schema declares for exactly
 * this query. OFFSET would silently skip or repeat rows as messages arrive underneath it, which
 * in a live chat is not a theoretical concern.
 */
export async function listMessages(
  db: PrismaClient,
  input: ListMessagesInput,
): Promise<MessagePage> {
  const membership = await findActiveMembership(db, input.userId, input.conversationId);
  if (!membership) {
    throw new ListMessagesError('NOT_A_MEMBER', 'You do not have access to this conversation.');
  }

  const limit = clampHistoryLimit(input.limit);
  /*
   * The reader's visible window: their conversation, their D-03 lower bound, and — from Batch 1 —
   * excluding anything they deleted for themselves.
   *
   * `hiddenFor: { none: ... }` filters in SQL rather than after the fact. Filtering in JavaScript
   * would silently shorten pages (a page of 50 arriving as 47) and, worse, would make `hasMore`
   * and the keyset cursor disagree with what was actually returned.
   */
  const window = {
    conversationId: input.conversationId,
    createdAt: { gte: membership.joinedAt },
    hiddenFor: { none: { userId: input.userId } },
  };

  if (input.after !== undefined) {
    const cursor = await loadCursor(db, input.conversationId, membership.joinedAt, input.after);

    // Strictly newer than the cursor, oldest first: this is the reconnect backfill.
    const messages = await db.message.findMany({
      where: {
        ...window,
        OR: [
          { createdAt: { gt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { gt: cursor.id } },
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      select: messageSelection,
    });

    const hasMore = messages.length > limit;
    return {
      messages: hasMore ? messages.slice(0, limit) : messages,
      hasMore,
      viewerJoinedAt: membership.joinedAt,
    };
  }

  // Newest-first read, reversed before returning. `before` pages further back from a cursor;
  // without one this is the initial window at the end of the conversation.
  const olderThan =
    input.before === undefined
      ? undefined
      : await loadCursor(db, input.conversationId, membership.joinedAt, input.before);

  const newestFirst = await db.message.findMany({
    where: {
      ...window,
      ...(olderThan
        ? {
            OR: [
              { createdAt: { lt: olderThan.createdAt } },
              { createdAt: olderThan.createdAt, id: { lt: olderThan.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: messageSelection,
  });

  const hasMore = newestFirst.length > limit;
  const page = hasMore ? newestFirst.slice(0, limit) : newestFirst;

  return { messages: page.reverse(), hasMore, viewerJoinedAt: membership.joinedAt };
}

/**
 * Resolves a pagination cursor.
 *
 * The cursor is a message id from the browser, so it is verified rather than trusted: it must
 * belong to this conversation and lie inside the caller's visible window. An id that does not is
 * rejected as an invalid request — not silently ignored, which would quietly return the wrong
 * page, and not reported as "not found", which would confirm that the id exists elsewhere.
 */
async function loadCursor(
  db: PrismaClient,
  conversationId: string,
  joinedAt: Date,
  messageId: string,
): Promise<{ id: string; createdAt: Date }> {
  const cursor = await db.message.findFirst({
    where: { id: messageId, conversationId, createdAt: { gte: joinedAt } },
    select: { id: true, createdAt: true },
  });

  if (!cursor) {
    throw new ListMessagesError('INVALID_CURSOR', 'That position in the conversation is not valid.');
  }

  return cursor;
}

function clampHistoryLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return HISTORY_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), HISTORY_MAX_LIMIT);
}

/* --------------------------------------------------------------------------------------------- */
/* Reply targets (Batch 1)                                                                         */
/* --------------------------------------------------------------------------------------------- */

/**
 * Refuses a reply whose target the sender may not quote.
 *
 * A message id from a browser is a request, not a permission — exactly like a conversation id.
 * Two conditions, and both matter:
 *
 *   1. **Same conversation.** Otherwise a member could quote a message out of a private
 *      conversation into a group, and the quoted text would be rendered to everyone in it. The
 *      foreign key cannot express this: it constrains the id to *a* message, not to one here.
 *   2. **Inside the sender's own D-03 window.** A group member who joined today must not be able
 *      to reach back past their join time by handing in an older id — the same rule
 *      `loadCursor` applies to pagination, for the same reason.
 *
 * A message the sender has hidden for themselves is deliberately still a valid target: hiding is
 * a personal view preference, not a loss of access, and the message is still in the conversation
 * for everyone else.
 *
 * Deleted-for-everyone targets are allowed too. The reply renders "Message deleted", which is
 * what the tombstone already says to everybody — refusing would be a pointless race with whoever
 * deleted it a moment ago.
 */
export async function assertReplyTargetVisible(
  db: PrismaClient,
  input: { conversationId: string; joinedAt: Date; replyToId: string },
): Promise<void> {
  const target = await db.message.findFirst({
    where: {
      id: input.replyToId,
      conversationId: input.conversationId,
      createdAt: { gte: input.joinedAt },
    },
    select: { id: true },
  });

  if (!target) {
    throw new SendMessageError(
      'REPLY_TARGET_INVALID',
      'That message is not available to reply to.',
    );
  }
}
