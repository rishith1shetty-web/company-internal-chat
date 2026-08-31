/**
 * The wire contract shared by the browser and the server.
 *
 * Types only, plus one constant. This module imports nothing — deliberately. Both the Node side
 * (route handlers, the Socket.IO gateway) and the browser bundle import it, so anything pulled in
 * here would be pulled into the browser too; a stray import of the Prisma client or of a
 * server-only module would end up shipped to the client or fail the build.
 *
 * Everything is JSON-shaped: timestamps are ISO-8601 UTC strings, formatted for display in the
 * browser's local timezone (A-05). No `Date`, no `BigInt`, no Prisma model types cross this line.
 */

/** Socket.IO path. Shares the application's origin and port (D-09). */
export const SOCKET_PATH = '/socket.io';

/* ------------------------------------------------------------------------------------------- */
/* Socket payloads                                                                               */
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

/** Every acknowledged socket action answers with this shape. */
export type Ack<T> = { ok: true; data: T } | { ok: false; error: SocketError };

export type MessageKindWire = 'TEXT' | 'FILE' | 'SYSTEM';

/** A message as it travels to a browser. */
export interface MessageWire {
  id: string;
  conversationId: string;
  senderId: string | null;
  clientMessageId: string;
  type: MessageKindWire;
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
/* REST payloads                                                                                 */
/* ------------------------------------------------------------------------------------------- */

/** The error body every endpoint returns on failure. */
export interface ApiErrorWire {
  error: { code: string; message: string };
}

/** Who the caller is, from `GET /api/session`. */
export interface SessionIdentityWire {
  userId: string;
  displayName: string;
}

/**
 * A user in the directory or in a conversation.
 *
 * There is no `online` field: presence is derived from live sockets and is scoped to people the
 * caller shares a conversation with (Phase 4), so it arrives over the socket. `lastSeenAt` is the
 * persisted value and is all a REST response is entitled to say.
 */
export interface UserWire {
  id: string;
  displayName: string;
  lastSeenAt: string;
}

export interface ConversationMemberWire {
  userId: string;
  role: 'OWNER' | 'MEMBER';
  joinedAt: string;
}

export interface MessagePreviewWire {
  id: string;
  senderId: string | null;
  type: MessageKindWire;
  body: string | null;
  createdAt: string;
}

export interface ConversationWire {
  id: string;
  type: 'DIRECT' | 'GROUP';
  /** Groups only; null for direct conversations. */
  name: string | null;
  createdAt: string;
  lastMessageAt: string | null;
  members: ConversationMemberWire[];
  /** Newest message inside the caller's visible window, for the sidebar preview. */
  lastMessage: MessagePreviewWire | null;
  unreadCount: number;
}

/**
 * `GET /api/conversations`.
 *
 * `users` carries every member of every listed conversation, so the sidebar can name people
 * without a second request and without the client ever having to guess who an id belongs to.
 */
export interface ConversationListWire {
  conversations: ConversationWire[];
  users: UserWire[];
}

/** `POST /api/conversations` — the resolved direct conversation, created or pre-existing. */
export interface ConversationCreatedWire {
  conversation: ConversationWire;
  users: UserWire[];
  /** False when an existing direct conversation was returned instead of a new one. */
  created: boolean;
}

/** `GET /api/conversations/:id/messages` — oldest first. */
export interface MessagePageWire {
  messages: MessageWire[];
  /** True when more messages exist beyond this page in the direction that was paged. */
  hasMore: boolean;
}

/** `POST /api/conversations/:id/read`. */
export interface ReadReceiptWire {
  conversationId: string;
  lastReadMessageId: string;
  lastReadAt: string;
  unreadCount: number;
}

/** `GET /api/users`. */
export interface DirectoryWire {
  users: UserWire[];
}
