/**
 * Turning an arrived message into the two lines a notification shows.
 *
 * Pure, and separate from both the delivery mechanisms and the decision to notify, because the
 * wording is the part a person actually reads and it has four shapes to get right:
 *
 *   direct, text     Rishith                    ·  Can you review the report?
 *   direct, file     Rishith                    ·  Sent report.pdf
 *   group,  text     Engineering Team           ·  Sumit: Can you review the report?
 *   group,  file     Engineering Team           ·  Sumit sent report.pdf
 *
 * PRIVACY (docs/04-security.md, CLAUDE.md §13). What comes out of here is the only thing that
 * reaches the operating system's notification centre, so it carries display metadata and nothing
 * else: a name, a group name, a filename and a message preview. No storage key, no filesystem
 * path, no user id, no conversation id, no MIME type. The ids on the event below never appear in
 * any rendered string — they exist so a click can open the right conversation and so the same
 * message cannot notify twice.
 *
 * And the content itself is already authorized: this is built from a `message:new` payload, which
 * the server emitted into a room it verified this socket belongs to. Nothing here can widen that.
 */

import { mentionsEveryone, mentionsUser } from '../chat/mentions';
import type { MessageWire } from '../chat/wire';

/** How much of a message a preview shows before it is cut. Two lines' worth at toast width. */
export const PREVIEW_LIMIT = 140;

/** A message that has arrived, described for display and for routing a click. */
export interface IncomingMessageEvent {
  /** Server id. Used to suppress duplicates and never rendered. */
  messageId: string;
  /** Used to open the conversation on click and never rendered. */
  conversationId: string;
  /** The notification's first line: the group's name, or the sender's for a direct message. */
  title: string;
  /** The second line: the preview, prefixed with the sender's name in a group. */
  body: string;
  /** For the toast's avatar. Null for a system message or a sender whose row was removed. */
  senderId: string | null;
  senderName: string | null;
  isGroup: boolean;
  /** Set on a FILE message, so the toast can show a file icon rather than guessing from text. */
  filename: string | null;
  createdAt: string;
  isOwnMessage: boolean;
  isSystemMessage: boolean;
  /** Whether the employee is looking at this conversation right now. */
  isOpenConversation: boolean;
  /**
   * Whether this message mentions the reader (Batch 1.7).
   *
   * PRESENTATION ONLY. It changes the second line's wording and nothing else — not whether there
   * is a notification, not the sound, not the surface, not the unread count. One arrived message
   * is one notification event, mentioned or not; `planNotification` never sees this field.
   */
  mentionsMe: boolean;
}

/** What the caller must look up. Kept narrow so this can be tested without a whole chat state. */
export interface DescribeInput {
  currentUserId: string;
  /** The conversation's display title: its name for a group, the counterpart for a direct. */
  conversationTitle: string;
  isGroup: boolean;
  /** The sender's display name, or null when they are unknown or it is a system message. */
  senderName: string | null;
  isOpenConversation: boolean;
}

/** Collapses whitespace and trims to a preview length, without cutting mid-word where avoidable. */
export function previewOf(body: string | null | undefined, limit = PREVIEW_LIMIT): string {
  const text = (body ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;

  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  // Only prefer a word boundary when one is reasonably near the end; otherwise a single very long
  // token would be cut back to almost nothing.
  const stem = lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${stem.trimEnd()}…`;
}

export function describeIncomingMessage(
  message: MessageWire,
  input: DescribeInput,
): IncomingMessageEvent {
  const isOwnMessage = message.senderId !== null && message.senderId === input.currentUserId;
  const isSystemMessage = message.type === 'SYSTEM';
  const filename = message.attachment?.filename ?? null;
  const sender = input.senderName;
  const mentionsMe = mentionsUser(message.mentions, input.currentUserId, message.senderId);

  return {
    messageId: message.id,
    conversationId: message.conversationId,
    title: input.conversationTitle,
    body: bodyFor({
      isGroup: input.isGroup,
      sender,
      filename,
      text: message.body,
      mentionsMe,
      everyone: mentionsMe && mentionsEveryone(message.mentions),
    }),
    senderId: message.senderId,
    senderName: sender,
    isGroup: input.isGroup,
    filename,
    createdAt: message.createdAt,
    isOwnMessage,
    isSystemMessage,
    isOpenConversation: input.isOpenConversation,
    mentionsMe,
  };
}

/**
 * The second line.
 *
 * The sender's name is prefixed only in a group, where the title is the group and the sender
 * would otherwise be unknown. In a direct conversation the title IS the sender, and repeating it
 * ("Rishith · Rishith: hello") is the kind of detail that makes an interface feel unconsidered.
 */
function bodyFor({
  isGroup,
  sender,
  filename,
  text,
  mentionsMe,
  everyone,
}: {
  isGroup: boolean;
  sender: string | null;
  filename: string | null;
  text: string | null;
  mentionsMe: boolean;
  everyone: boolean;
}): string {
  const who = sender ?? 'Someone';

  /*
   * A file says so, and says which file. The caption a sender may have attached is deliberately
   * NOT shown in its place: "what arrived" is the useful fact at notification time, and the
   * caption is right there the moment the conversation is opened.
   */
  if (filename !== null) {
    return isGroup ? `${who} sent ${filename}` : `Sent ${filename}`;
  }

  const preview = previewOf(text);
  const line = preview.length > 0 ? preview : 'Sent a message';

  /*
   * A mention says so, in words, in the line somebody actually reads (Batch 1.7).
   *
   * "@everyone" is distinguished from being named personally rather than collapsed into it —
   * "mentioned everyone" is a different and much less urgent fact than "mentioned you", and
   * presenting a group announcement as a personal summons is how people learn to distrust the
   * notification.
   *
   * Only the WORDING changes here. Whether this notification happens at all, whether it chimes,
   * and which surface it uses are decided by `planNotification`, which knows nothing about
   * mentions and is deliberately left that way.
   */
  if (mentionsMe) {
    return everyone ? `${who} mentioned everyone: ${line}` : `${who} mentioned you: ${line}`;
  }

  return isGroup ? `${who}: ${line}` : line;
}
