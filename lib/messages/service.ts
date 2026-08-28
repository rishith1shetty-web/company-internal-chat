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
