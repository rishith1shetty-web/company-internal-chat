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

/**
 * A file attached to a message (Phase 7).
 *
 * Metadata only, and deliberately not everything the row holds. There is no `storageKey` here and
 * there never will be: the physical location of a file is a server detail, and a browser that
 * cannot name a path cannot ask for one. `byteSize` is a string because the column is a BigInt —
 * JSON numbers lose precision long before 500 MB, but sending it as a number invites somebody to
 * do arithmetic on it in a language where that is only usually safe.
 *
 * The download URL is built from `id` alone; every request through it is authorized afresh.
 */
export interface AttachmentWire {
  id: string;
  /** As the sender's computer had it, sanitized. Rendered as text, never used as a path. */
  filename: string;
  /** Decimal string. */
  byteSize: string;
  /** Detected server-side from the leading bytes. A label — never what a download is served as. */
  mimeType: string;
  /** Lower-cased, dot-less, possibly empty. For an icon, never for a decision. */
  extension: string;
  createdAt: string;
}

/**
 * One emoji's worth of reactions on a message, already aggregated.
 *
 * `userIds` rather than a `mine` flag, deliberately. A `mine` flag would have to be computed per
 * reader, which would force the server to serialize a separate copy of every broadcast for every
 * member. The reader knows its own id, so it can answer "did I react?" itself — and the ids are
 * conversation members whose names the client already holds, so nothing new is disclosed.
 */
export interface ReactionWire {
  emoji: string;
  count: number;
  /** Everyone who reacted with this emoji. Always conversation members. */
  userIds: string[];
}

/**
 * The message a reply points at, as much of it as this reader is entitled to see.
 *
 * `unavailable` is NOT the same as `deleted`, and conflating them would be a disclosure:
 *
 *   - `deleted` — the original was deleted for everyone. Everybody sees "This message was
 *     deleted", which is a fact about the conversation.
 *   - `unavailable` — the original is outside this reader's D-03 window, or was hidden by them.
 *     They are told nothing about it at all, not even that it was deleted.
 */
export interface ReplyPreviewWire {
  id: string;
  senderId: string | null;
  /** Truncated for display. Null for a file with no caption, or when deleted/unavailable. */
  body: string | null;
  /** Set when the original carried a file, so the preview can name it. */
  attachmentFilename: string | null;
  /** The original was deleted for everyone. */
  deleted: boolean;
  /** The original is outside this reader's visible window. Nothing else is populated. */
  unavailable: boolean;
}

/** A message as it travels to a browser. */
export interface MessageWire {
  id: string;
  conversationId: string;
  senderId: string | null;
  clientMessageId: string;
  type: MessageKindWire;
  /** Null once deleted for everyone — the body is cleared in the database, not just hidden. */
  body: string | null;
  createdAt: string;
  /** Present on `FILE` messages. Null on every other kind, and null once deleted for everyone. */
  attachment: AttachmentWire | null;
  /** Set when this message is a reply. Resolved per reader (D-03). */
  replyTo: ReplyPreviewWire | null;
  /** True when this message was forwarded from another conversation. */
  isForwarded: boolean;
  /** ISO-8601 UTC when pinned in this conversation; null when not pinned. */
  pinnedAt: string | null;
  /** ISO-8601 UTC when deleted for everyone. Non-null means render the tombstone. */
  deletedAt: string | null;
  /** Aggregated reactions. Empty when there are none. */
  reactions: ReactionWire[];
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

/**
 * `conversation:changed` — a conversation the recipient is, or has just stopped being, a member
 * of has changed.
 *
 * Deliberately just an id. The recipient re-reads the authorized REST endpoints; nothing about
 * the conversation travels in the event itself.
 */
export interface ConversationChangedWire {
  conversationId: string;
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

/**
 * Who the caller is, from `GET /api/session`.
 *
 * All three fields are server-decided. `deviceLabel` is the administrator's name for the computer
 * this identity is assigned to, shown read-only so an employee can tell IT which machine they are
 * at — it is information, not a control.
 */
export interface SessionIdentityWire {
  userId: string;
  displayName: string;
  deviceLabel: string;
  /**
   * The configured upload ceiling in bytes, so the composer can refuse an oversized file before
   * spending minutes sending it.
   *
   * Sent rather than compiled into the browser bundle: it is `MAX_FILE_SIZE` from the server's
   * environment, and a second copy in the client would be a number to keep in step by hand. It is
   * a courtesy, not a control — the server enforces the same limit while the bytes arrive, and
   * would enforce it against a browser that ignored this value entirely.
   */
  maxFileSize: number;
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
  /** The filename, so the sidebar can preview a file without a second request. */
  attachmentFilename: string | null;
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

/**
 * `POST /api/conversations/:id/members` and `DELETE /api/conversations/:id/members/:userId`.
 *
 * `conversation` is null when the caller is no longer a member — which is what leaving a group
 * looks like from the leaver's side. The response is built through the same membership-filtered
 * listing the sidebar uses, so it can never describe a conversation the caller cannot see.
 */
export interface ConversationMembersWire {
  conversation: ConversationWire | null;
  users: UserWire[];
}

/**
 * `GET /api/conversations/:id/attachments` — the Shared files panel.
 *
 * Bounded by the caller's `joinedAt` exactly as message history is, so a newly added group member
 * cannot use this list to learn that older files exist, let alone open them.
 */
export interface ConversationAttachmentsWire {
  attachments: (AttachmentWire & { uploaderId: string | null; messageId: string | null })[];
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

/* ------------------------------------------------------------------------------------------- */
/* Message actions (Batch 1)                                                                     */
/* ------------------------------------------------------------------------------------------- */

/**
 * The answer to every single-message mutation: react, pin, unpin, delete.
 *
 * Always the whole message as the caller may now see it, rather than a diff. One shape means the
 * client has one code path for "replace this message in the list", and a client that missed an
 * earlier event still converges on the correct state instead of applying a delta to a stale row.
 */
export interface MessageMutationWire {
  message: MessageWire;
}

/** `POST /api/messages/:id/forward` — the messages created in the destination conversations. */
export interface ForwardResultWire {
  /** One per destination that accepted the forward, in the order they were requested. */
  messages: MessageWire[];
  /**
   * Destinations that were refused, and why — so the interface can say "sent to 2 of 3" rather
   * than failing the whole operation because one group was left.
   */
  failures: { conversationId: string; reason: 'FORBIDDEN' | 'UNAVAILABLE' | 'FAILED' }[];
}

/** `GET /api/conversations/:id/pins` — pinned messages, newest pin first. */
export interface PinnedMessagesWire {
  messages: MessageWire[];
}

/** The emoji the server accepts. The client renders this set in the picker. */
export const REACTION_EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const;

export type ReactionEmoji = (typeof REACTION_EMOJI)[number];
