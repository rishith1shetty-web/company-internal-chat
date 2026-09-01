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
