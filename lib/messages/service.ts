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
  | 'CONVERSATION_NOT_FOUND';

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
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  senderId: string | null;
  clientMessageId: string;
  type: 'TEXT' | 'FILE' | 'SYSTEM';
  body: string | null;
  createdAt: Date;
}

export interface SendMessageResult {
  message: StoredMessage;
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

    return { message, duplicate: false };
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

      if (existing) return { message: existing, duplicate: true };
    }

    throw error;
  }
}

const messageSelection = {
  id: true,
  conversationId: true,
  senderId: true,
  clientMessageId: true,
  type: true,
  body: true,
  createdAt: true,
} as const;

/**
 * Records a membership/group event in the conversation's own timeline.
 *
 * `SYSTEM` messages have no sender: the server writes them, not a user. Phase 6 uses this for
 * group events; Phase 4 exposes it so the type is exercised and the shape is settled.
 */
export async function recordSystemMessage(
  db: PrismaClient,
  input: { conversationId: string; body: string; clientMessageId: string },
): Promise<StoredMessage> {
  return db.$transaction(async (tx) => {
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
  });
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
  const window = { conversationId: input.conversationId, createdAt: { gte: membership.joinedAt } };

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
    return { messages: hasMore ? messages.slice(0, limit) : messages, hasMore };
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

  return { messages: page.reverse(), hasMore };
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
