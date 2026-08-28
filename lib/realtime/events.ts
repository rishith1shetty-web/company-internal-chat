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

/** Socket.IO path. Shares the application's origin and port (D-09). */
export const SOCKET_PATH = '/socket.io';

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
});

export type JoinConversationPayload = z.infer<typeof joinConversationSchema>;
export type LeaveConversationPayload = z.infer<typeof leaveConversationSchema>;
export type SendMessagePayload = z.infer<typeof sendMessageSchema>;

/* ------------------------------------------------------------------------------------------- */
/* Error codes                                                                                   */
/* ------------------------------------------------------------------------------------------- */

/**
 * The complete set of failures a client is ever told about.
 *
 * Codes are stable and coarse on purpose. `FORBIDDEN` covers both "not a member" and "no such
 * conversation", because telling an outsider which conversation ids exist is a disclosure in
 * itself. Nothing here carries a stack trace, a SQL string, a path or a configuration value
 * (CLAUDE.md §13).
 */
export type SocketErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'INVALID_PAYLOAD'
  | 'MESSAGE_TOO_LONG'
  | 'MESSAGE_EMPTY'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

export interface SocketError {
  code: SocketErrorCode;
  /** Safe, human-readable, and free of internals. */
  message: string;
}

/** Every acknowledged action answers with this shape. */
export type Ack<T> = { ok: true; data: T } | { ok: false; error: SocketError };

/* ------------------------------------------------------------------------------------------- */
/* Wire types                                                                                    */
/* ------------------------------------------------------------------------------------------- */

/** A message as it travels to a browser. Timestamps are ISO-8601 UTC strings. */
export interface MessageWire {
  id: string;
  conversationId: string;
  senderId: string | null;
  clientMessageId: string;
  type: 'TEXT' | 'FILE' | 'SYSTEM';
  body: string | null;
  createdAt: string;
}

export interface PresenceWire {
  userId: string;
  online: boolean;
  /** ISO-8601 UTC. Null when the user has never been seen. */
  lastSeenAt: string | null;
}

export interface JoinedConversationWire {
  conversationId: string;
  /**
   * The start of this member's visible history window (D-03). Sent so the client knows not to
   * ask for anything older; the server enforces it regardless of what the client does.
   */
  joinedAt: string;
}

export interface SessionWire {
  userId: string;
  displayName: string;
  /** Conversations this socket was authorized to join, decided server-side at connection time. */
  conversationIds: string[];
}

/* ------------------------------------------------------------------------------------------- */
/* Event maps                                                                                    */
/* ------------------------------------------------------------------------------------------- */

export interface ClientToServerEvents {
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

export function toMessageWire(message: {
  id: string;
  conversationId: string;
  senderId: string | null;
  clientMessageId: string;
  type: 'TEXT' | 'FILE' | 'SYSTEM';
  body: string | null;
  createdAt: Date;
}): MessageWire {
  return {
    id: message.id,
    conversationId: message.conversationId,
    senderId: message.senderId,
    clientMessageId: message.clientMessageId,
    type: message.type,
    body: message.body,
    createdAt: message.createdAt.toISOString(),
  };
}
