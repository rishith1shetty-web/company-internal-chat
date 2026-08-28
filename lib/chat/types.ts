/**
 * View-model types for the chat interface.
 *
 * These are the shapes the UI renders. They intentionally mirror the entities designed in
 * docs/02-database.md (User, Conversation, ConversationMember, Message, Attachment) so that
 * when Phase 3 introduces Prisma and Phase 4/5 introduce the real API, the server can return
 * these shapes and the components need no redesign.
 *
 * What they are NOT: database models. There is no persistence, no Prisma, and no server
 * behind them in Phase 2 — see lib/mock/chat-seed.ts.
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
 * Local delivery state of a message the user just sent. Phase 4 replaces this with the real
 * optimistic-send/ack cycle (docs/01-architecture.md §6); nothing here implies persistence.
 */
export type DeliveryState = 'SENDING' | 'SENT';

export interface UserSummary {
  /** Server-issued identity. The only thing ownership and access are ever keyed on. */
  id: string;
  displayName: string;
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

export interface Conversation {
  id: string;
  type: ConversationType;
  /** Groups only; null for direct conversations. */
  name: string | null;
  createdAt: string;
  lastMessageAt: string | null;
  members: ConversationMember[];
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
