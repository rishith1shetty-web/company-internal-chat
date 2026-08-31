/**
 * View-model types for the chat interface.
 *
 * These are the shapes the UI renders. They mirror the entities in docs/02-database.md (User,
 * Conversation, ConversationMember, Message, Attachment), and from Phase 5 they are built from
 * the server's answers — see lib/chat/wire.ts for what actually crosses the network and
 * lib/chat/state.ts for the mapping.
 *
 * What they are NOT: database models. They carry browser-only fields the server neither sends
 * nor accepts (`presence`, `deliveryState`), and they never carry anything the server would not
 * disclose.
 *
 * Identity rules encoded here (docs/01-architecture.md §5):
 *   - A user is identified by `id`, never by `displayName` (D-02).
 *   - Display names are not unique; the UI disambiguates with a discriminator.
 */

/** Conversation kinds. Mirrors `Conversation.type`. */
export type ConversationType = 'DIRECT' | 'GROUP';

/** Presence is derived server-side in Phase 4; in Phase 2 it is fixed mock state. */
export type PresenceState = 'ONLINE' | 'OFFLINE';

/** Mirrors `Message.type`. */
export type MessageKind = 'TEXT' | 'FILE' | 'SYSTEM';

/** Mirrors `ConversationMember.role`. */
export type MemberRole = 'OWNER' | 'MEMBER';

/**
 * Local delivery state of a message the user sent.
 *
 * `SENDING` is a bubble that exists only in this browser. It becomes `SENT` when the server
 * acknowledges it — which happens after the row is committed, never before — and `FAILED` when
 * the acknowledgement says no or never arrives. A failed message is never shown as sent: the
 * user is told, and can retry with the same `clientMessageId`, so the retry collides with the
 * stored row rather than inserting a second one (docs/01-architecture.md §6).
 */
export type DeliveryState = 'SENDING' | 'SENT' | 'FAILED';

export interface UserSummary {
  /** Server-issued identity. The only thing ownership and access are ever keyed on. */
  id: string;
  displayName: string;
  /**
   * Derived in the browser from the socket's presence events, not from a REST field. Presence is
   * scoped server-side to people the caller shares a conversation with, so a colleague who is
   * only in the directory is shown as `OFFLINE` with their last-seen time.
   */
  presence: PresenceState;
  /** ISO-8601 UTC, or null when never seen. */
  lastSeenAt: string | null;
}

export interface ConversationMember {
  userId: string;
  role: MemberRole;
  /** ISO-8601 UTC. Bounds the member's visible history for groups (D-03). */
  joinedAt: string;
}

/** Placeholder shape for Phase 7. No attachment is ever created in Phase 2. */
export interface AttachmentSummary {
  id: string;
  originalFilename: string;
  byteSize: number;
}

export interface ChatMessage {
  id: string;
  /** Browser-minted idempotency key (docs/01-architecture.md §6). */
  clientMessageId: string;
  conversationId: string;
  /** Null for SYSTEM messages, and for messages whose sender row was removed. */
  senderId: string | null;
  kind: MessageKind;
  body: string | null;
  /** ISO-8601 UTC; rendered in the browser's local timezone (A-05). */
  createdAt: string;
  deliveryState: DeliveryState;
  attachment: AttachmentSummary | null;
}

/** The newest message of a conversation, as the sidebar preview needs it. */
export interface MessagePreview {
  id: string;
  senderId: string | null;
  kind: MessageKind;
  body: string | null;
  createdAt: string;
}

export interface Conversation {
  id: string;
  type: ConversationType;
  /** Groups only; null for direct conversations. */
  name: string | null;
  createdAt: string;
  lastMessageAt: string | null;
  members: ConversationMember[];
  /**
   * Server-computed preview, inside this member's visible window (D-03). Present so the sidebar
   * can show a conversation whose history has not been opened and therefore not loaded.
   */
  lastMessage: MessagePreview | null;
  /** Server-computed: messages newer than this member's read marker that they did not send. */
  unreadCount: number;
}

/**
 * UI-level message length ceiling. The server re-validates independently from Phase 4 —
 * a client-side limit is a usability aid, never a control (CLAUDE.md §9).
 */
export const MAX_MESSAGE_LENGTH = 4000;

/** UI-level group name ceiling; matches `Conversation.name varchar(120)`. */
export const MAX_GROUP_NAME_LENGTH = 120;

/** UI-level display name ceiling; matches `User.displayName varchar(64)`. */
export const MAX_DISPLAY_NAME_LENGTH = 64;
