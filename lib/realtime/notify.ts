/**
 * The one seam between a route handler and the live socket server.
 *
 * Group creation and membership changes happen over HTTP, but their whole point is that other
 * people's screens change: a colleague added to a group must see it appear without reloading
 * (CLAUDE.md §2.3). The route handler therefore has to reach the Socket.IO server, which lives in
 * `server.ts` and not in the Next.js request scope.
 *
 * WHAT IS DELIBERATELY NOT DONE HERE: the notification carries no message, no name, no member
 * list — only a conversation id, and only to users the *database* just said are members. Every
 * browser that receives one re-reads through `GET /api/conversations`, which authorizes from
 * their own membership rows. So even a mistaken audience discloses nothing: the worst case is a
 * pointless request that comes back without the conversation in it.
 *
 * The registration is held on `globalThis`, like the Prisma client, and for the same reason:
 * Next.js bundles route modules separately from the code `tsc` compiles for the custom server, so
 * a plain module-level variable would be two different variables. Nothing is registered under a
 * test that starts no gateway, and every function here is a no-op in that case rather than a
 * failure — a membership change must still commit on a server with no socket layer.
 */

import type { StoredMessage } from '../messages/service';

export interface ConversationAudienceChange {
  conversationId: string;
  /**
   * Everyone who is an active member now. Their sockets are joined to the conversation's room
   * and told to re-read. Read from the database by the caller; never from a request.
   */
  memberIds: readonly string[];
  /**
   * Everyone who has just stopped being a member. Their sockets are removed from the room, so a
   * later broadcast cannot reach them, and they are told to re-read — which is what makes the
   * conversation disappear from their sidebar.
   */
  removedIds?: readonly string[];
}

/**
 * A message committed over HTTP rather than over the socket — a file upload (Phase 7).
 *
 * Carries the message METADATA, which for a file means its name, size and type. It never carries
 * the file. Bytes travel over HTTP, in both directions, and are fetched by whoever chooses to
 * download them through an endpoint that authorizes them again; pushing them down a socket would
 * send a 500 MB video to every member whether they wanted it or not.
 */
export interface PostedMessage {
  conversationId: string;
  /** Server-derived. Their own other tabs are told; their sending tab already has the answer. */
  senderId: string;
  /** Exactly what `message:new` carries when the socket path sends one. */
  message: unknown;
}

/**
 * A message that already exists has changed — a reaction, a pin, or a delete-for-everyone
 * (Batch 1).
 *
 * Carries the STORED row rather than a serialized wire, unlike `PostedMessage`. That is the whole
 * point: an update can concern a message older than some members' D-03 window, and the quoted
 * reply preview inside it has to be resolved per reader. The gateway therefore serializes this
 * once per recipient and skips members who may not see the message at all.
 *
 * A type-only import, so this module still pulls nothing into the browser bundle at runtime.
 */
export interface MessageUpdate {
  conversationId: string;
  message: StoredMessage;
}

/** One person hid one message for themselves. Only their own sockets are told. */
export interface MessageHidden {
  userId: string;
  conversationId: string;
  messageId: string;
}

export interface RealtimeNotifier {
  conversationChanged(change: ConversationAudienceChange): void;
  messagePosted(posted: PostedMessage): void;
  messageUpdated(update: MessageUpdate): void;
  messageHidden(hidden: MessageHidden): void;
}

const globalForRealtime = globalThis as unknown as {
  __companyChatNotifier?: RealtimeNotifier;
};

/** Called by the gateway when it attaches. Passing `null` clears the registration. */
export function setRealtimeNotifier(notifier: RealtimeNotifier | null): void {
  if (notifier === null) {
    globalForRealtime.__companyChatNotifier = undefined;
    return;
  }
  globalForRealtime.__companyChatNotifier = notifier;
}

/** Clears the registration, but only if it is still the given one. Used on gateway shutdown. */
export function clearRealtimeNotifier(notifier: RealtimeNotifier): void {
  if (globalForRealtime.__companyChatNotifier === notifier) {
    globalForRealtime.__companyChatNotifier = undefined;
  }
}

/**
 * Tells the members of a conversation that it changed.
 *
 * Silently does nothing when no gateway is attached. That is correct rather than lenient: the
 * change is already committed, and PostgreSQL — not the socket — is the source of truth. A
 * browser that misses this event still gets the change on its next read, and every reconnection
 * performs one.
 */
export function notifyConversationChanged(change: ConversationAudienceChange): void {
  globalForRealtime.__companyChatNotifier?.conversationChanged(change);
}

/**
 * Delivers a message that was committed over HTTP to the conversation's members.
 *
 * Same guarantee as `notifyConversationChanged`: called only after the transaction commits, and a
 * no-op when no gateway is attached. A browser that misses it sees the file on its next read, and
 * every reconnection performs one.
 */
export function notifyMessagePosted(posted: PostedMessage): void {
  globalForRealtime.__companyChatNotifier?.messagePosted(posted);
}

/**
 * Tells a conversation's members that one of its messages changed.
 *
 * Same contract as the rest of this module: called only after the change is committed, and a
 * no-op when no gateway is attached. A browser that misses it converges on its next read, and
 * every reconnection performs one.
 */
export function notifyMessageUpdated(update: MessageUpdate): void {
  globalForRealtime.__companyChatNotifier?.messageUpdated(update);
}

/** Tells one person's other sockets that they hid a message. Nobody else is told. */
export function notifyMessageHidden(hidden: MessageHidden): void {
  globalForRealtime.__companyChatNotifier?.messageHidden(hidden);
}
