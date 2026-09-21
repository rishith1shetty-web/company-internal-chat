/**
 * The Socket.IO event contract.
 *
 * Deliberately small. Every event here is one the application actually needs; there is no
 * general-purpose "do a thing" event, and no event lets the client name the user it is acting as.
 * Adding an event means adding an authorization rule for it, so the set stays short on purpose.
 *
 * Directions:
 *   ClientToServerEvents — what a browser may ask for. Every one is authorized server-side.
 *   ServerToClientEvents — what the server tells a browser. Emitted only into rooms whose
 *                          membership the server verified.
 *
 * Payloads are validated with Zod at the boundary before anything reads them: a socket payload is
 * arbitrary attacker-controlled JSON, exactly like an HTTP body.
 */

import { z } from 'zod';

import { MAX_MESSAGE_LENGTH } from '../messages/service';

/*
 * The payload shapes live in lib/chat/wire.ts, which imports nothing and is safe for the browser
 * bundle to pull in. They are re-exported here so that existing server-side imports of this
 * module keep working and there is still exactly one definition of each shape.
 */
export { SOCKET_PATH } from '../chat/wire';
export type {
  Ack,
  ConversationChangedWire,
  JoinedConversationWire,
  MessageWire,
  PresenceWire,
  ReactionWire,
  ReplyPreviewWire,
  SessionWire,
  SocketError,
  SocketErrorCode,
} from '../chat/wire';

import type {
  Ack,
  ConversationChangedWire,
  JoinedConversationWire,
  MessageWire,
  PresenceWire,
  ReactionWire,
  ReplyPreviewWire,
  SessionWire,
  SocketError,
} from '../chat/wire';

/* ------------------------------------------------------------------------------------------- */
/* Payload schemas                                                                               */
/* ------------------------------------------------------------------------------------------- */

const uuid = z.uuid({ version: 'v4' });

export const joinConversationSchema = z.object({
  conversationId: uuid,
});

export const leaveConversationSchema = z.object({
  conversationId: uuid,
});

export const sendMessageSchema = z.object({
  conversationId: uuid,
  /**
   * Length is checked here and again in the service. The service is the authority — this bound
   * exists so an oversized payload is rejected before it reaches the database layer.
   */
  body: z.string().min(1).max(MAX_MESSAGE_LENGTH),
  /**
   * The one client-supplied identifier the design accepts, and only because it is an idempotency
   * key rather than an identity: it cannot name a user, a conversation or another message.
   */
  clientMessageId: uuid,
  /**
   * The message being replied to, if any.
   *
   * An id here grants nothing: the service checks it belongs to the same conversation and lies
   * inside the sender's own visible window before it is written.
   */
  replyToId: uuid.optional(),
});

export type JoinConversationPayload = z.infer<typeof joinConversationSchema>;
export type LeaveConversationPayload = z.infer<typeof leaveConversationSchema>;
export type SendMessagePayload = z.infer<typeof sendMessageSchema>;

/* ------------------------------------------------------------------------------------------- */
/* Event maps                                                                                    */
/* ------------------------------------------------------------------------------------------- */

export interface ClientToServerEvents {
  /**
   * Ask for the current presence of everyone the caller shares an active conversation with.
   *
   * A snapshot, not a subscription: `presence:update` already pushes changes. This exists because
   * a client that has just connected — or that has just started a conversation with somebody —
   * has no way to know who is already online, and presence is deliberately not public, so it
   * cannot simply be included in a directory response (Phase 4 scopes presence to shared
   * conversations). The peer set is computed server-side from the database; the payload is
   * ignored, and a client cannot ask about a user it shares nothing with.
   */
  'presence:sync': (payload: unknown, ack: (response: Ack<PresenceWire[]>) => void) => void;

  /** Ask to join a conversation room. Granted only if the server confirms active membership. */
  'conversation:join': (
    payload: unknown,
    ack: (response: Ack<JoinedConversationWire>) => void,
  ) => void;

  /** Leave a room. Needs no authorization: leaving grants nothing. */
  'conversation:leave': (payload: unknown, ack: (response: Ack<null>) => void) => void;

  /**
   * Send a message. The acknowledgement arrives only after the row is committed, and carries the
   * stored message — including the server-assigned id and timestamp.
   */
  'message:send': (payload: unknown, ack: (response: Ack<MessageWire>) => void) => void;
}

export interface ServerToClientEvents {
  /** Sent once, immediately after a successful handshake. The client's own identity. */
  'session:ready': (payload: SessionWire) => void;

  /** A new message in a conversation this socket is in. */
  'message:new': (payload: MessageWire) => void;

  /** A user this socket shares a conversation with came online or went offline. */
  'presence:update': (payload: PresenceWire) => void;

  /**
   * A conversation this user is (or has just stopped being) a member of has changed: it was
   * created, somebody was added, or somebody left.
   *
   * Carries an id and nothing else, on purpose. The client answers it by re-reading
   * `GET /api/conversations`, which authorizes from the caller's own membership rows — so this
   * event cannot disclose a name, a member list or a message, and a browser that receives one in
   * error simply learns nothing.
   */
  'conversation:changed': (payload: ConversationChangedWire) => void;

  /**
   * A message that already exists has changed: a reaction, a pin, or a delete-for-everyone.
   *
   * ONE event for all three rather than three events, deliberately. It carries the whole message
   * as the recipient may now see it, so a client has a single "replace this row" code path and a
   * client that missed an earlier event still converges instead of applying a delta to a stale
   * row. It is also why there is no `reaction:added` / `reaction:removed` pair to get out of
   * order under a flurry of taps.
   *
   * Emitted per member, not into the conversation room: the message may predate a member's D-03
   * window, and the quoted reply preview inside it is resolved against each reader.
   *
   * Never a notification. The client treats this as a visual update — no sound, no toast, no
   * unread increment (`lib/notifications/policy.ts` is not consulted for it).
   */
  'message:updated': (payload: MessageWire) => void;

  /**
   * A message this user hid for themselves ("delete for me").
   *
   * Sent only to that user's own sockets, so their other tabs and their desktop app stop showing
   * it too. Nobody else is told, because for everybody else nothing happened.
   */
  'message:hidden': (payload: { conversationId: string; messageId: string }) => void;

  /** An error that is not the answer to a specific request (e.g. a failed re-authorization). */
  'server:error': (payload: SocketError) => void;
}

/** Per-socket server state. Set at handshake; never derived from anything the client sends. */
export interface SocketData {
  userId: string;
  displayName: string;
  sessionId: string;
  deviceId: string | null;
}

/** How much of a quoted message the reply preview carries. Enough to recognise, not to read. */
export const REPLY_PREVIEW_LENGTH = 140;

/**
 * A stored message as it travels to a browser — the one mapping, used by the socket and by every
 * REST route (`lib/http/serialize.ts` delegates here).
 *
 * `byteSize` becomes a decimal string because the column is a `BigInt`: `JSON.stringify` refuses
 * one outright, and converting to a number would silently trade exactness for convenience on a
 * value the interface only ever formats.
 *
 * There is no `storageKey` in the output and none in the input type. A browser is given an
 * attachment id and nothing else about where the bytes live.
 *
 * **`viewerJoinedAt` is not decoration.** A reply quotes another message, and that message can
 * be older than the reader's D-03 window — a group member who joined on Tuesday must not read
 * Monday's text merely because somebody replied to it on Wednesday. The quoted preview is
 * therefore resolved against the reader, which is also why broadcasts of replies and of message
 * updates are emitted per member rather than into a room (see the gateway).
 */
export function toMessageWire(
  message: {
    id: string;
    conversationId: string;
    senderId: string | null;
    clientMessageId: string;
    type: 'TEXT' | 'FILE' | 'SYSTEM';
    body: string | null;
    createdAt: Date;
    isForwarded?: boolean;
    pinnedAt?: Date | null;
    deletedAt?: Date | null;
    attachment?: {
      id: string;
      originalFilename: string;
      byteSize: bigint;
      mimeType: string;
      extension: string;
      createdAt: Date;
    } | null;
    replyTo?: {
      id: string;
      senderId: string | null;
      body: string | null;
      createdAt: Date;
      deletedAt: Date | null;
      attachment: { originalFilename: string } | null;
    } | null;
    reactions?: { emoji: string; userId: string }[];
  },
  viewerJoinedAt: Date,
): MessageWire {
  const deleted = message.deletedAt != null;

  return {
    id: message.id,
    conversationId: message.conversationId,
    senderId: message.senderId,
    clientMessageId: message.clientMessageId,
    type: message.type,
    // Cleared in the database by delete-for-everyone; nulled here too so that a row written by an
    // older code path can never render its text under a tombstone.
    body: deleted ? null : message.body,
    createdAt: message.createdAt.toISOString(),
    attachment:
      message.attachment && !deleted
        ? {
            id: message.attachment.id,
            filename: message.attachment.originalFilename,
            byteSize: message.attachment.byteSize.toString(),
            mimeType: message.attachment.mimeType,
            extension: message.attachment.extension,
            createdAt: message.attachment.createdAt.toISOString(),
          }
        : null,
    replyTo: toReplyPreview(message.replyTo ?? null, viewerJoinedAt),
    isForwarded: message.isForwarded ?? false,
    pinnedAt: message.pinnedAt?.toISOString() ?? null,
    deletedAt: message.deletedAt?.toISOString() ?? null,
    reactions: aggregateReactions(message.reactions ?? []),
  };
}

/**
 * Builds the quoted preview, refusing to say anything the reader is not entitled to.
 *
 * The order of these branches is the security property. "Outside your window" is checked FIRST,
 * before deletion, because `deleted: true` is itself information — it would tell a reader that a
 * message they may not see once existed and was removed.
 */
function toReplyPreview(
  target: {
    id: string;
    senderId: string | null;
    body: string | null;
    createdAt: Date;
    deletedAt: Date | null;
    attachment: { originalFilename: string } | null;
  } | null,
  viewerJoinedAt: Date,
): ReplyPreviewWire | null {
  if (!target) return null;

  if (target.createdAt < viewerJoinedAt) {
    return {
      id: target.id,
      senderId: null,
      body: null,
      attachmentFilename: null,
      deleted: false,
      unavailable: true,
    };
  }

  if (target.deletedAt != null) {
    return {
      id: target.id,
      senderId: target.senderId,
      body: null,
      attachmentFilename: null,
      deleted: true,
      unavailable: false,
    };
  }

  const body = target.body?.trim() ?? null;

  return {
    id: target.id,
    senderId: target.senderId,
    body:
      body && body.length > REPLY_PREVIEW_LENGTH
        ? `${body.slice(0, REPLY_PREVIEW_LENGTH)}…`
        : body,
    attachmentFilename: target.attachment?.originalFilename ?? null,
    deleted: false,
    unavailable: false,
  };
}

/**
 * Collapses reaction rows into one entry per emoji.
 *
 * Insertion order is preserved rather than sorted by count, so a reaction badge does not jump
 * sideways under the pointer the moment somebody else reacts.
 */
function aggregateReactions(rows: readonly { emoji: string; userId: string }[]): ReactionWire[] {
  const byEmoji = new Map<string, string[]>();

  for (const row of rows) {
    const existing = byEmoji.get(row.emoji);
    if (existing) existing.push(row.userId);
    else byEmoji.set(row.emoji, [row.userId]);
  }

  return [...byEmoji].map(([emoji, userIds]) => ({ emoji, count: userIds.length, userIds }));
}
