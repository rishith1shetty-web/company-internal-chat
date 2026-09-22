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
  /**
   * This member's read watermark — DIRECT conversations only, null in groups (Batch 1.3).
   *
   * The `createdAt` of the furthest message they have read, not the moment they read it. It
   * drives the "Seen" indicator and nothing else. The server withholds it for groups, where
   * per-member read status belongs to the sender alone.
   */
  lastReadAt: string | null;
}

/**
 * A file attached to a message.
 *
 * `byteSize` is a string because the column is a `BigInt` and the wire carries it as a decimal
 * string. The interface only ever formats it for display, so it is never parsed back into a
 * number that could quietly lose precision.
 *
 * There is no path here and no URL: the download link is built from `id`, and the server decides
 * on every request whether this person may have the bytes.
 */
export interface AttachmentSummary {
  id: string;
  filename: string;
  byteSize: string;
  mimeType: string;
  extension: string;
  createdAt: string;
}

/**
 * A file in the Shared files panel.
 *
 * The same metadata a message attachment carries, plus who sent it — the panel lists files
 * outside the run of conversation, so the sender is not otherwise visible.
 */
export interface SharedFile extends AttachmentSummary {
  uploaderId: string | null;
  messageId: string | null;
}

/**
 * A file being uploaded from this browser, and only from this browser.
 *
 * Purely local: the server has no concept of an upload in progress, because from its point of
 * view a file either committed or did not. `progress` is measured from real bytes handed to the
 * network (`uploadAttachment`), never estimated.
 */
export interface PendingUpload {
  clientMessageId: string;
  conversationId: string;
  filename: string;
  byteSize: number;
  /** 0–1. */
  progress: number;
  state: 'UPLOADING' | 'FAILED';
  error: string | null;
}

/**
 * The quoted message shown above a reply.
 *
 * Built entirely from what the server chose to send. The interface never looks the original up
 * in its own loaded history to fill in a blank: what the server withheld, it withheld on purpose
 * (`ReplyPreviewWire`), and quietly substituting a locally cached copy would defeat that.
 */
export interface ReplyPreview {
  id: string;
  senderId: string | null;
  body: string | null;
  attachmentFilename: string | null;
  /** The original was deleted for everyone — render "Message deleted". */
  deleted: boolean;
  /** The original is outside this reader's window. Render a neutral, uninformative placeholder. */
  unavailable: boolean;
}

/** One emoji's reactions on a message, aggregated by the server. */
export interface MessageReaction {
  emoji: string;
  count: number;
  /** Everyone who reacted with it. The interface derives "did I?" from this, not from a flag. */
  userIds: string[];
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
  /** Set when this message replies to another. */
  replyTo: ReplyPreview | null;
  /** True when it was forwarded from elsewhere. */
  isForwarded: boolean;
  /** ISO-8601 UTC when the sender edited the text, else null. Drives the "edited" label. */
  editedAt: string | null;
  /** ISO-8601 UTC when pinned in this conversation, else null. */
  pinnedAt: string | null;
  /**
   * ISO-8601 UTC when deleted for everyone.
   *
   * Non-null means render the tombstone. `body` and `attachment` are already null when this is
   * set — the server cleared them, so there is nothing here to leak even if the interface got the
   * condition wrong.
   */
  deletedAt: string | null;
  reactions: MessageReaction[];
}

/** The newest message of a conversation, as the sidebar preview needs it. */
export interface MessagePreview {
  id: string;
  senderId: string | null;
  kind: MessageKind;
  body: string | null;
  createdAt: string;
  /** Set when the newest visible message is a file, so the preview can name it. */
  attachmentFilename: string | null;
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
