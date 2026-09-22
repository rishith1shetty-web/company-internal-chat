'use client';

/**
 * The chat controller: everything with a side effect, in one place.
 *
 * `chatReducer` decides what the state becomes; this hook decides when to ask the server and
 * what to do with the answer. Components below it stay presentational and are handed data and
 * callbacks, which is what stopped Phase 5 from becoming a redesign of the Phase 2 interface.
 *
 * The rule that shapes the whole file: **PostgreSQL is the source of truth and the socket is a
 * delivery accelerator** (CLAUDE.md §10). So:
 *
 *   - History is read over REST, never replayed from the socket.
 *   - Every (re)connection triggers a re-read, because a socket that was closed for ten seconds
 *     has no idea what it missed and must not guess.
 *   - A message is shown as sent only when the server acknowledges it, which happens after the
 *     row is committed. A failed send is shown as failed and can be retried with the same
 *     `clientMessageId`, so the retry collides with the stored row instead of duplicating it.
 *
 * No identity is ever sent from here, and none can be chosen here. The session and device
 * cookies are `HttpOnly`; the server derives the user from the computer's assignment on both
 * transports. There is deliberately no `enter`, no `switchUser` and no way to clear an identity —
 * assignment is an administrator's job (docs/12-admin-device-identity.md).
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import {
  ApiError,
  addGroupMembers as requestAddMembers,
  uploadAttachment,
  createGroupConversation as requestGroup,
  fetchConversationAttachments,
  fetchConversations,
  fetchDirectory,
  fetchMessages,
  fetchSession,
  markRead,
  removeGroupMember as requestRemoveMember,
  startDirectConversation as requestDirectConversation,
  clearReaction as clearMessageReaction,
  deleteMessageForEveryone as removeMessageForEveryone,
  editMessage as requestMessageEdit,
  deleteMessageForMe as hideMessage,
  fetchPinnedMessages,
  forwardMessage as sendForward,
  setMessagePinned,
  setReaction as setMessageReaction,
  fetchMessageReadStatus,
} from '@/lib/chat/api';
import {
  chatReducer,
  initialChatState,
  type ChatState,
} from '@/lib/chat/state';
import { newClientMessageId } from '@/lib/chat/ids';
import { createChatSocket, type ChatSocketClient } from '@/lib/chat/socket';
import type { ChatMessage } from '@/lib/chat/types';
import type { MessageReadStatusWire, MessageWire } from '@/lib/chat/wire';
import { conversationTitle, selectUsersById } from '@/lib/chat/state';
import {
  describeIncomingMessage,
  type IncomingMessageEvent,
} from '@/lib/notifications/describe';

/** Initial history window. Matches the server's default; stated here so the intent is visible. */
const HISTORY_PAGE_SIZE = 50;

export interface ChatSession {
  state: ChatState;
  selectConversation(conversationId: string): void;
  startDirectConversation(userId: string): Promise<void>;
  /** Create a group. The caller is its owner; the server decides that, not this call. */
  createGroup(name: string, memberIds: string[]): Promise<void>;
  /** Add colleagues to the open group. They see messages from this moment on, never before. */
  addMembers(conversationId: string, userIds: string[]): Promise<void>;
  /** Remove somebody from a group — or leave it, by naming yourself. */
  removeMember(conversationId: string, userId: string): Promise<void>;
  /** Re-reads the colleague list, so a picker never opens on a stale directory. */
  refreshDirectory(): void;
  sendMessage(body: string): void;
  /** Uploads a file into the open conversation. Returns once the server has committed it. */
  sendFile(file: File, caption?: string): void;
  /** Abandons an upload still in flight. Nothing is written and no message appears. */
  cancelUpload(clientMessageId: string): void;
  /** Clears a failed upload card the user has read. */
  dismissUpload(clientMessageId: string): void;
  retryMessage(message: ChatMessage): void;
  loadOlderMessages(): void;
  /* ------------------------------------------------ message actions (Batch 1) --------------- */
  /** The message the composer is replying to, or null. Purely local until the reply is sent. */
  replyTarget: ChatMessage | null;
  beginReply(message: ChatMessage): void;
  cancelReply(): void;
  /* ------------------------------------------------ edit message (Batch 1.1) ---------------- */
  /**
   * The message being edited, or null.
   *
   * A snapshot taken when Edit was chosen: it is what seeds the composer, not a live view. The
   * live row stays in `state`, and the effect below cancels edit mode if it stops being editable.
   *
   * Edit and reply are mutually exclusive, and that is enforced here rather than in the composer —
   * one place where the two can never both be set beats two components agreeing to keep them apart.
   */
  editTarget: ChatMessage | null;
  beginEdit(message: ChatMessage): void;
  cancelEdit(): void;
  /**
   * Saves the edited text. Resolves true when the server accepted it.
   *
   * Edit mode is left only on success: a save that fails keeps the banner and the typing, so the
   * user can correct it and try again rather than losing what they wrote.
   */
  saveEdit(body: string): Promise<boolean>;
  /**
   * Adds, changes or removes this user's reaction — one call, because one person has at most one
   * reaction per message. Tapping the emoji already chosen removes it.
   */
  toggleReaction(message: ChatMessage, emoji: string): void;
  /** Pins or unpins for the whole conversation, from the message's current state. */
  togglePin(message: ChatMessage): void;
  /** Hides a message for this user only. */
  deleteForMe(message: ChatMessage): void;
  /** Replaces a message with a tombstone for everyone. The server allows only its sender. */
  deleteForEveryone(message: ChatMessage): void;
  /** Copies a message into other conversations. Returns how many destinations accepted. */
  forwardTo(message: ChatMessage, conversationIds: string[]): Promise<number>;
  /* ------------------------------------------- read receipts (Batch 1.3) -------------------- */
  /**
   * Who has read one of this user's own group messages.
   *
   * Rejects for anybody else's message — the server decides that, and the hidden menu item is
   * only a courtesy.
   */
  readStatusFor(messageId: string): Promise<MessageReadStatusWire>;
  /**
   * Subscribes to "somebody read something here" nudges, returning an unsubscribe function.
   *
   * Exists so an open Message info panel can refresh itself in real time without the group's
   * per-member watermarks ever being broadcast — the nudge carries no read state at all, and the
   * panel answers it by re-reading through the authorized endpoint.
   */
  subscribeToReadNudges(
    handler: (conversationId: string, userId: string) => void,
  ): () => void;
  searchDirectory(term: string): void;
  setSearchTerm(term: string): void;
  dismissNotice(): void;
}

export interface ChatSessionOptions {
  /**
   * Called once for every message that arrives over the socket, described for display.
   *
   * The seam for notifications, and it is here rather than in a component because this hook is
   * the only place that has all three facts at once: the payload, who this browser is, and which
   * conversation is open. It is deliberately fed ONLY by `message:new` — history and the
   * reconnect backfill are REST reads that dispatch straight into the reducer and never reach
   * this callback, so old messages cannot be announced as new.
   *
   * Held in a ref, so passing a new function on every render does not tear down the socket.
   */
  onIncomingMessage?: (event: IncomingMessageEvent) => void;
}

export function useChatSession(options: ChatSessionOptions = {}): ChatSession {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);

  const socketRef = useRef<ChatSocketClient | null>(null);
  /*
   * Refs, not state, and written only from effects.
   *
   * The socket handlers are created once per connection and would otherwise close over the state
   * as it was at that moment — which is how a message for the open conversation gets counted as
   * unread five minutes later. These carry the small amount of "what is on screen right now" the
   * handlers need.
   */
  const openConversationRef = useRef<string | null>(null);
  const newestMessageRef = useRef<string | null>(null);
  const oldestMessageRef = useRef<string | null>(null);
  const knownConversationsRef = useRef<Set<string>>(new Set());
  /*
   * Cancel handles for uploads in flight, by idempotency key.
   *
   * A ref rather than state: an `XMLHttpRequest` is not renderable data, and putting it in state
   * would make every progress event replace an object the reducer has no use for. What the
   * interface renders is the `PendingUpload` beside it, which is state.
   */
  const uploadsRef = useRef<Map<string, () => void>>(new Map());

  /*
   * The current state and the current notification callback, for the socket handlers.
   *
   * Same reason as the refs above: the handlers are built once per connection. Describing an
   * arrived message needs the conversation and the sender's name, which live in state, so the
   * handler needs to see state as it is now rather than as it was when the socket opened.
   * Assigned during render, read only from callbacks — never during render.
   */
  const stateRef = useRef(state);
  const onIncomingMessageRef = useRef(options.onIncomingMessage);

  // Written from an effect, like every other ref in this hook. An effect has flushed long before
  // any socket callback can run, so what these hold is never behind by the time it is read.
  useEffect(() => {
    stateRef.current = state;
    onIncomingMessageRef.current = options.onIncomingMessage;
  }, [state, options.onIncomingMessage]);

  const currentUserId = state.currentUser?.id ?? null;

  /**
   * Describes an arrived message and hands it to the notification pipeline.
   *
   * Everything it needs is read from `stateRef` at call time. A conversation this browser has not
   * heard of yet — a colleague's first message in a brand new conversation — still produces a
   * usable notification: the title falls back to the sender's name, which is the right thing to
   * show for a direct message and an honest approximation for a group whose name has not arrived.
   */
  const announce = useCallback((wire: MessageWire) => {
    const handler = onIncomingMessageRef.current;
    if (!handler) return;

    const snapshot = stateRef.current;
    const currentUser = snapshot.currentUser;
    if (!currentUser) return;

    const usersById = selectUsersById(snapshot);
    const conversation = snapshot.conversations.find((item) => item.id === wire.conversationId);
    const senderName =
      wire.senderId === null ? null : (usersById.get(wire.senderId)?.displayName ?? null);

    handler(
      describeIncomingMessage(wire, {
        currentUserId: currentUser.id,
        conversationTitle: conversation
          ? conversationTitle(conversation, currentUser.id, usersById)
          : (senderName ?? 'New message'),
        isGroup: conversation?.type === 'GROUP',
        senderName,
        isOpenConversation: openConversationRef.current === wire.conversationId,
      }),
    );
  }, []);

  /* ----------------------------------------------------------------------------------------- */
  /* Failure handling                                                                            */
  /* ----------------------------------------------------------------------------------------- */

  /**
   * A 401 means this computer no longer resolves to anybody: the assignment was retired, or an
   * administrator reassigned the machine and the previous session was revoked with it.
   *
   * The only correct response is to stop showing a workspace that is no longer this person's.
   * Carrying on with a stale user id on screen would be a lie, and there is nothing the employee
   * can do here to fix it — so the message says who can.
   */
  const handleFailure = useCallback((error: unknown, fallback: string) => {
    if (error instanceof ApiError && error.isUnauthenticated) {
      dispatch({ type: 'identity-missing' });
      dispatch({
        type: 'notice',
        message: 'This computer is no longer signed in. Contact IT to have it set up again.',
      });
      return;
    }

    dispatch({
      type: 'notice',
      message: error instanceof ApiError ? error.message : fallback,
    });
  }, []);

  /* ----------------------------------------------------------------------------------------- */
  /* Loaders                                                                                     */
  /* ----------------------------------------------------------------------------------------- */

  const loadConversations = useCallback(async () => {
    try {
      const data = await fetchConversations();
      knownConversationsRef.current = new Set(data.conversations.map((item) => item.id));
      dispatch({
        type: 'conversations-loaded',
        conversations: data.conversations,
        users: data.users,
      });
    } catch (error) {
      handleFailure(error, 'Could not load your conversations.');
    }
  }, [handleFailure]);

  const loadDirectory = useCallback(
    async (search?: string) => {
      try {
        const data = await fetchDirectory(search);
        dispatch({ type: 'directory-loaded', users: data.users });
      } catch (error) {
        handleFailure(error, 'Could not load the colleague list.');
      }
    },
    [handleFailure],
  );

  /** Moves the read marker and takes the server's unread count as the answer. */
  const markConversationRead = useCallback(async (conversationId: string, messageId: string) => {
    try {
      const receipt = await markRead(conversationId, messageId);
      dispatch({
        type: 'unread-cleared',
        conversationId,
        unreadCount: receipt.unreadCount,
      });
    } catch {
      // A read marker that fails to move is not worth interrupting anybody for; the next open
      // of the conversation will move it.
    }
  }, []);

  /** Reads the newest page of a conversation and marks it read. */
  const loadHistory = useCallback(
    async (conversationId: string) => {
      dispatch({ type: 'history-loading', conversationId });

      try {
        const page = await fetchMessages(conversationId, { limit: HISTORY_PAGE_SIZE });
        dispatch({
          type: 'history-loaded',
          conversationId,
          messages: page.messages,
          hasMore: page.hasMore,
          mode: 'replace',
        });

        const newest = page.messages[page.messages.length - 1];
        if (newest) await markConversationRead(conversationId, newest.id);
      } catch (error) {
        dispatch({
          type: 'history-failed',
          conversationId,
          message:
            error instanceof ApiError ? error.message : 'Could not load this conversation.',
        });
        if (error instanceof ApiError && error.isUnauthenticated) handleFailure(error, '');
      }
    },
    [handleFailure, markConversationRead],
  );

  /**
   * Fetches what arrived while the socket was down.
   *
   * This is why reconnection does not need replayed events: the client asks the database what it
   * missed, and "missed while offline" and "delivered twice" become the same problem.
   */
  const backfill = useCallback(
    async (conversationId: string, afterMessageId: string) => {
      try {
        const page = await fetchMessages(conversationId, { after: afterMessageId });
        if (page.messages.length === 0) return;

        dispatch({
          type: 'history-loaded',
          conversationId,
          messages: page.messages,
          hasMore: page.hasMore,
          mode: 'merge',
        });

        const newest = page.messages[page.messages.length - 1];
        if (newest && openConversationRef.current === conversationId) {
          await markConversationRead(conversationId, newest.id);
        }
      } catch (error) {
        handleFailure(error, 'Could not catch up on this conversation.');
      }
    },
    [handleFailure, markConversationRead],
  );

  /**
   * Reads the files a conversation has, for the Shared files panel.
   *
   * Re-read rather than maintained locally: the server decides which files this person may see
   * (their `joinedAt` bounds it), and inserting one locally would be this browser deciding
   * instead. A failure is silent — the panel is a convenience beside a conversation that works,
   * and interrupting somebody for it would be worse than the panel being briefly out of date.
   */
  const loadAttachments = useCallback(async (conversationId: string) => {
    dispatch({ type: 'attachments-loading', conversationId });
    try {
      const data = await fetchConversationAttachments(conversationId);
      dispatch({ type: 'attachments-loaded', conversationId, files: data.attachments });
    } catch {
      dispatch({ type: 'attachments-loaded', conversationId, files: [] });
    }
  }, []);

  /**
   * Reads the conversation's pinned messages.
   *
   * Fetched rather than derived from the loaded history, because a pin can be far outside the
   * pages on screen. Afterwards the reducer keeps the list current from `message:updated`, so
   * this runs once per conversation open and not on every pin.
   *
   * Silent on failure, like the file panel: the banner is a convenience beside a conversation
   * that works.
   */
  const loadPins = useCallback(async (conversationId: string) => {
    try {
      const data = await fetchPinnedMessages(conversationId);
      dispatch({ type: 'pins-loaded', conversationId, messages: data.messages });
    } catch {
      dispatch({ type: 'pins-loaded', conversationId, messages: [] });
    }
  }, []);

  /**
   * The message the composer is replying to.
   *
   * Local component state, not reducer state: it is a property of this window's composer, nothing
   * is persisted until the reply is actually sent, and a second tab replying to something else is
   * not a conflict to reconcile.
   */
  /**
   * An optional subscriber for read nudges, used by the group Message info panel (Batch 1.3).
   *
   * A ref rather than a dependency of the socket effect: the panel opens and closes constantly,
   * and re-creating the socket each time it did would be a heavy price for a small feature.
   */
  const readNudgeRef = useRef<((conversationId: string, userId: string) => void) | null>(null);

  const [replyTarget, setReplyTarget] = useState<ChatMessage | null>(null);
  /**
   * Which message is being edited, as an id — not as a snapshot of it.
   *
   * The message itself is DERIVED from state below. That is what makes edit mode impossible to
   * leave stale: a message deleted for everyone, hidden, or dropped from the loaded history stops
   * satisfying the derivation and edit mode ends by itself, with no effect watching for it and no
   * second copy of the row to fall out of step with the first.
   */
  const [editing, setEditing] = useState<{ id: string; conversationId: string } | null>(null);

  const syncPresence = useCallback(async () => {
    const response = await socketRef.current?.syncPresence();
    if (response?.ok) dispatch({ type: 'presence-changed', entries: response.data });
  }, []);

  /* ----------------------------------------------------------------------------------------- */
  /* Bootstrap                                                                                   */
  /* ----------------------------------------------------------------------------------------- */

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const identity = await fetchSession();
        if (cancelled) return;

        if (identity) {
          dispatch({
            type: 'identity-ready',
            userId: identity.userId,
            displayName: identity.displayName,
            deviceLabel: identity.deviceLabel,
            maxFileSize: identity.maxFileSize,
          });
        } else {
          dispatch({ type: 'identity-missing' });
        }
      } catch (error) {
        if (cancelled) return;
        // Without an identity there is nothing to show but the entry screen, whatever went wrong.
        dispatch({ type: 'identity-missing' });
        dispatch({
          type: 'notice',
          message:
            error instanceof ApiError ? error.message : 'Could not reach the chat server.',
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  /** First load of the workspace, over REST, so the interface works even if the socket does not. */
  useEffect(() => {
    if (!currentUserId) return;

    void loadConversations();
    void loadDirectory();
  }, [currentUserId, loadConversations, loadDirectory]);

  /* ----------------------------------------------------------------------------------------- */
  /* Socket                                                                                      */
  /* ----------------------------------------------------------------------------------------- */

  useEffect(() => {
    if (!currentUserId) return;

    const socket = createChatSocket({
      onConnectionChange(connection) {
        dispatch({ type: 'connection-changed', connection });
      },

      /*
       * Emitted by the server on every successful connection, including reconnections. It is the
       * signal to re-read from the database: this socket has no memory of what the previous one
       * saw, and neither should the interface.
       */
      onSessionReady() {
        void (async () => {
          await loadConversations();

          const openId = openConversationRef.current;
          const cursor = newestMessageRef.current;

          if (openId) {
            // Re-joining is not strictly required — the server joins every conversation room at
            // connection time — but a conversation created while this socket was down would not
            // be in that set, and asking costs one round trip.
            await socket.joinConversation(openId);
            if (cursor) await backfill(openId, cursor);
            else await loadHistory(openId);
          }

          await syncPresence();
        })();
      },

      /**
       * A reaction, a pin, or a delete-for-everyone on a message that already exists.
       *
       * `announce` is deliberately NOT called. This is a visual update, not an arrival: somebody
       * reacting to a week-old message must not play a sound, raise a desktop notification or
       * mark a conversation unread. The reducer case is equally careful — it replaces the message
       * and leaves the unread count alone.
       */
      onMessageUpdated(wire) {
        dispatch({ type: 'message-updated', message: wire });
      },

      /** This user hid a message for themselves, here or in another of their windows. */
      onMessageHidden({ conversationId, messageId }) {
        dispatch({ type: 'message-hidden', conversationId, messageId });
      },

      /*
       * Somebody read (Batch 1.3).
       *
       * Straight to the reducer, and deliberately NOT to `announce`: reading is not sending, so
       * there is no sound, no toast, no unread change and no reordering. The reducer touches one
       * member's watermark and nothing else.
       *
       * In a group `lastReadAt` is null — the server withholds it — and the reducer ignores it.
       * The nudge is still useful: an open Message info panel re-reads through the authorized
       * endpoint, which is the only place group read state is ever assembled.
       */
      onConversationRead({ conversationId, userId, lastReadAt }) {
        dispatch({ type: 'conversation-read', conversationId, userId, lastReadAt });
        readNudgeRef.current?.(conversationId, userId);
      },

      onMessage(wire) {
        dispatch({ type: 'message-received', message: wire });

        /*
         * Announce it, before anything below returns early.
         *
         * Placed first on purpose: the branch underneath returns when the conversation is not
         * yet known to this browser, and that is exactly the case of a colleague opening a NEW
         * conversation with their first message — the one arrival that most deserves a
         * notification. Describing it from the state we already have costs nothing, and the
         * conversation list re-read that follows only affects what the sidebar shows.
         */
        announce(wire);

        /*
         * A message for a conversation this browser has never heard of: it was created after this
         * socket connected. Re-read the list rather than inventing a conversation locally — and
         * re-read presence too, because the other party has only just become a presence peer and
         * would otherwise show as offline until something else changed.
         */
        if (!knownConversationsRef.current.has(wire.conversationId)) {
          void (async () => {
            await loadConversations();
            await syncPresence();
          })();
          return;
        }

        if (openConversationRef.current === wire.conversationId) {
          void markConversationRead(wire.conversationId, wire.id);
          // A file arriving is a change to the Shared files list, which is otherwise only read
          // when the conversation opens.
          if (wire.attachment) void loadAttachments(wire.conversationId);
        }
      },

      onPresence(wire) {
        dispatch({ type: 'presence-changed', entries: [wire] });
      },

      /*
       * A group was created, somebody was added, or somebody left.
       *
       * The event says only which conversation, so everything is re-read through the authorized
       * REST endpoints: the list (which is what makes a new group appear, a member list change,
       * or a group the user has just left disappear), the open conversation's history (which is
       * what shows the system message recording the change), and presence (because the people in
       * a new group have only just become presence peers, and would otherwise sit at "offline"
       * until something else moved).
       */
      onConversationChanged({ conversationId }) {
        void (async () => {
          await loadConversations();
          if (openConversationRef.current === conversationId) {
            await loadHistory(conversationId);
          }
          await syncPresence();
        })();
      },

      onServerError(error) {
        dispatch({ type: 'notice', message: error.message });
      },
    });

    socketRef.current = socket;

    return () => {
      socketRef.current = null;
      socket.close();
    };
  }, [
    currentUserId,
    announce,
    backfill,
    loadAttachments,
    loadConversations,
    loadHistory,
    markConversationRead,
    syncPresence,
  ]);

  /* ----------------------------------------------------------------------------------------- */
  /* Refs the socket handlers read                                                               */
  /* ----------------------------------------------------------------------------------------- */

  const selectedConversationId = state.selectedConversationId;
  const openMessages = selectedConversationId
    ? state.messagesByConversation[selectedConversationId]
    : undefined;

  useEffect(() => {
    openConversationRef.current = selectedConversationId;

    // The newest and oldest messages the SERVER has confirmed. An optimistic bubble is not a
    // pagination cursor: the server has never heard of its id.
    const delivered = (openMessages ?? []).filter(
      (message) => message.deliveryState === 'SENT',
    );
    newestMessageRef.current = delivered[delivered.length - 1]?.id ?? null;
    oldestMessageRef.current = delivered[0]?.id ?? null;
  }, [selectedConversationId, openMessages]);

  /* ----------------------------------------------------------------------------------------- */
  /* Actions                                                                                     */
  /* ----------------------------------------------------------------------------------------- */

  const selectConversation = useCallback(
    (conversationId: string) => {
      dispatch({ type: 'select-conversation', conversationId });
      // Always re-read: the badge was cleared optimistically and the history on screen may be a
      // reconnection old. The merge in the reducer keeps anything still sending.
      void loadHistory(conversationId);
      void loadAttachments(conversationId);
      void loadPins(conversationId);
      // A reply belongs to the conversation it was started in. Carrying it into another one would
      // quote a message that is not there. The same is true of an edit in progress — and worse,
      // because saving it would rewrite a message the user is no longer looking at.
      setReplyTarget(null);
      setEditing(null);
    },
    [loadAttachments, loadHistory, loadPins],
  );

  const startDirectConversation = useCallback(
    async (userId: string) => {
      try {
        const result = await requestDirectConversation(userId);

        knownConversationsRef.current.add(result.conversation.id);
        dispatch({
          type: 'conversation-opened',
          conversation: result.conversation,
          users: result.users,
        });

        // The room for a conversation created just now did not exist when this socket connected.
        await socketRef.current?.joinConversation(result.conversation.id);
        await loadHistory(result.conversation.id);
        // The new counterpart is a presence peer from this moment; ask for their current state.
        await syncPresence();
      } catch (error) {
        handleFailure(error, 'Could not open that conversation.');
      }
    },
    [handleFailure, loadHistory, syncPresence],
  );

  /**
   * Creates a group and opens it.
   *
   * Everybody else is told by the server over the socket; this browser does not have to announce
   * anything, and could not be trusted to if it did.
   */
  const createGroup = useCallback(
    async (name: string, memberIds: string[]) => {
      try {
        const result = await requestGroup(name, memberIds);

        knownConversationsRef.current.add(result.conversation.id);
        dispatch({
          type: 'conversation-opened',
          conversation: result.conversation,
          users: result.users,
        });

        // The room for a conversation created a moment ago did not exist when this socket
        // connected, so it is joined explicitly rather than waited for.
        await socketRef.current?.joinConversation(result.conversation.id);
        await loadHistory(result.conversation.id);
        await syncPresence();
      } catch (error) {
        handleFailure(error, 'Could not create that group.');
      }
    },
    [handleFailure, loadHistory, syncPresence],
  );

  /** Adds colleagues to a group. Whether this user may is the server's decision. */
  const addMembers = useCallback(
    async (conversationId: string, userIds: string[]) => {
      try {
        const result = await requestAddMembers(conversationId, userIds);
        if (result.conversation) {
          dispatch({
            type: 'conversation-opened',
            conversation: result.conversation,
            users: result.users,
          });
          await loadHistory(conversationId);
        }
        await syncPresence();
      } catch (error) {
        handleFailure(error, 'Could not add those colleagues to the group.');
      }
    },
    [handleFailure, loadHistory, syncPresence],
  );

  /**
   * Removes a member, or leaves the group when the id is the user's own.
   *
   * A null conversation in the answer means the caller is the one who left: the whole list is
   * re-read, which drops the group and clears the selection, rather than trying to work out
   * locally what is no longer visible.
   */
  const removeMember = useCallback(
    async (conversationId: string, userId: string) => {
      try {
        const result = await requestRemoveMember(conversationId, userId);

        if (result.conversation) {
          dispatch({
            type: 'conversation-opened',
            conversation: result.conversation,
            users: result.users,
          });
          await loadHistory(conversationId);
        } else {
          knownConversationsRef.current.delete(conversationId);
          dispatch({ type: 'select-conversation', conversationId: null });
          await loadConversations();
        }
      } catch (error) {
        handleFailure(error, 'Could not change the group members.');
      }
    },
    [handleFailure, loadConversations, loadHistory],
  );

  /**
   * Sends a message: optimistic bubble first, server acknowledgement decides its fate.
   *
   * `clientMessageId` is minted here and reused verbatim on retry. It is the only identifier the
   * browser is allowed to invent, and only because it names nothing — it is an idempotency key,
   * not an identity.
   */
  const deliver = useCallback(
    async (
      conversationId: string,
      body: string,
      clientMessageId: string,
      replyToId?: string | undefined,
    ) => {
      const socket = socketRef.current;

      if (!socket) {
        dispatch({
          type: 'message-failed',
          conversationId,
          clientMessageId,
          message: 'You are not connected. The message was not sent.',
        });
        return;
      }

      const ack = await socket.sendMessage({ conversationId, body, clientMessageId, replyToId });

      if (ack.ok) {
        dispatch({ type: 'message-acknowledged', clientMessageId, message: ack.data });
        dispatch({ type: 'notice', message: null });
      } else {
        dispatch({
          type: 'message-failed',
          conversationId,
          clientMessageId,
          message: ack.error.message,
        });
      }
    },
    [],
  );

  const sendMessage = useCallback(
    (body: string) => {
      const conversationId = openConversationRef.current;
      const trimmed = body.trim();
      if (!conversationId || trimmed.length === 0) return;

      const clientMessageId = newClientMessageId();
      /*
       * Captured before the optimistic dispatch and cleared immediately, so a second send cannot
       * quote the same message again and a slow network cannot leave the banner up over a reply
       * that has already gone.
       */
      const reply = replyTarget && replyTarget.conversationId === conversationId ? replyTarget : null;
      setReplyTarget(null);

      dispatch({
        type: 'message-queued',
        conversationId,
        clientMessageId,
        body: trimmed,
        now: new Date().toISOString(),
        replyTo: reply
          ? {
              id: reply.id,
              senderId: reply.senderId,
              body: reply.body,
              attachmentFilename: reply.attachment?.filename ?? null,
              deleted: reply.deletedAt !== null,
              unavailable: false,
            }
          : null,
      });

      void deliver(conversationId, trimmed, clientMessageId, reply?.id);
    },
    [deliver, replyTarget],
  );

  /**
   * Sends a file.
   *
   * The card is shown as uploading immediately and becomes a real message only when the server
   * answers — never before. That ordering is the point: an upload that is still going up the wire
   * is not something a colleague can open, and claiming otherwise would be the one lie this
   * interface must not tell.
   *
   * The bytes go over HTTP. `clientMessageId` is minted here and reused on any retry, so a repeat
   * of a request whose response was lost collides with the stored row instead of posting the file
   * a second time — the same guard text messages use.
   */
  const sendFile = useCallback(
    (file: File, caption?: string) => {
      const conversationId = openConversationRef.current;
      if (!conversationId) return;

      const clientMessageId = newClientMessageId();

      dispatch({
        type: 'upload-started',
        clientMessageId,
        conversationId,
        filename: file.name,
        byteSize: file.size,
      });

      const upload = uploadAttachment({
        conversationId,
        file,
        clientMessageId,
        caption,
        onProgress: (progress) => {
          dispatch({ type: 'upload-progress', clientMessageId, progress });
        },
      });

      uploadsRef.current.set(clientMessageId, upload.cancel);

      void upload.done
        .then((message) => {
          uploadsRef.current.delete(clientMessageId);
          // The committed message replaces the card. The socket broadcast may also arrive; the
          // reducer discards whichever copy is second by `clientMessageId`.
          dispatch({ type: 'message-received', message });
          dispatch({ type: 'upload-finished', clientMessageId });
          dispatch({ type: 'notice', message: null });
          void loadAttachments(conversationId);
        })
        .catch((error: unknown) => {
          uploadsRef.current.delete(clientMessageId);

          // Cancelling is a decision, not a failure: the card simply goes.
          if (error instanceof ApiError && error.code === 'ABORTED') {
            dispatch({ type: 'upload-finished', clientMessageId });
            return;
          }

          if (error instanceof ApiError && error.isUnauthenticated) {
            dispatch({ type: 'upload-finished', clientMessageId });
            handleFailure(error, '');
            return;
          }

          dispatch({
            type: 'upload-failed',
            clientMessageId,
            message:
              error instanceof ApiError ? error.message : 'The file could not be sent.',
          });
        });
    },
    [handleFailure, loadAttachments],
  );

  const cancelUpload = useCallback((clientMessageId: string) => {
    uploadsRef.current.get(clientMessageId)?.();
    uploadsRef.current.delete(clientMessageId);
    dispatch({ type: 'upload-finished', clientMessageId });
  }, []);

  const dismissUpload = useCallback((clientMessageId: string) => {
    dispatch({ type: 'upload-finished', clientMessageId });
  }, []);

  /** Anything still in flight when the workspace goes away is abandoned rather than left running. */
  useEffect(() => {
    const inFlight = uploadsRef.current;
    return () => {
      for (const cancel of inFlight.values()) cancel();
      inFlight.clear();
    };
  }, []);

  const retryMessage = useCallback(
    (message: ChatMessage) => {
      if (message.deliveryState !== 'FAILED' || message.body === null) return;

      dispatch({
        type: 'message-retrying',
        conversationId: message.conversationId,
        clientMessageId: message.clientMessageId,
      });

      // Same `clientMessageId` as the first attempt. If the original send did commit and only
      // the acknowledgement was lost, the server returns the stored row rather than writing a
      // second message.
      void deliver(message.conversationId, message.body, message.clientMessageId);
    },
    [deliver],
  );

  /** Pages further back in the open conversation. */
  const loadOlderMessages = useCallback(() => {
    const conversationId = openConversationRef.current;
    const oldest = oldestMessageRef.current;
    if (!conversationId || !oldest) return;

    void (async () => {
      dispatch({ type: 'history-loading', conversationId });
      try {
        const page = await fetchMessages(conversationId, {
          before: oldest,
          limit: HISTORY_PAGE_SIZE,
        });
        dispatch({
          type: 'history-loaded',
          conversationId,
          messages: page.messages,
          hasMore: page.hasMore,
          mode: 'replace',
        });
      } catch (error) {
        dispatch({
          type: 'history-failed',
          conversationId,
          message: error instanceof ApiError ? error.message : 'Could not load older messages.',
        });
      }
    })();
  }, []);

  const searchDirectory = useCallback(
    (term: string) => {
      void loadDirectory(term);
    },
    [loadDirectory],
  );

  /**
   * Re-reads the directory.
   *
   * Called when the colleague picker opens. The list is otherwise loaded once, at entry, so a
   * colleague who joined since then would simply not be there — and the person looking for them
   * has no way to tell that from "they are not in the system".
   */
  const refreshDirectory = useCallback(() => {
    void loadDirectory();
  }, [loadDirectory]);

  const setSearchTerm = useCallback((term: string) => {
    dispatch({ type: 'set-search', term });
  }, []);

  const dismissNotice = useCallback(() => {
    dispatch({ type: 'notice', message: null });
  }, []);

  /* ----------------------------------------------------------------------------------------- */
  /* Message actions (Batch 1)                                                                   */
  /* ----------------------------------------------------------------------------------------- */

  const beginReply = useCallback((message: ChatMessage) => {
    // A tombstone has nothing to quote.
    if (message.deletedAt !== null) return;
    setReplyTarget(message);
    // Replying replaces editing, cleanly. Both banners at once would leave the Send button with
    // two meanings and the user with no way to tell which one it has.
    setEditing(null);
  }, []);

  const cancelReply = useCallback(() => setReplyTarget(null), []);

  /* ------------------------------------------------- edit message (Batch 1.1) --------------- */

  /**
   * Enters edit mode for a message this user sent.
   *
   * The same conditions the menu uses, re-checked here so that entering edit mode by any other
   * route still cannot begin on something uneditable. None of this is the control — the server
   * re-derives every one of these from the stored row (`lib/messages/actions.ts`).
   */
  const beginEdit = useCallback(
    (message: ChatMessage) => {
      if (message.deletedAt !== null) return;
      if (message.kind === 'SYSTEM') return;
      if (message.senderId === null || message.senderId !== currentUserId) return;
      // Nothing to edit: a file sent without a caption. Adding one afterwards is a different
      // feature, and the server refuses it too.
      if (!message.body?.trim()) return;

      setEditing({ id: message.id, conversationId: message.conversationId });
      // Editing replaces replying, for the same reason as above.
      setReplyTarget(null);
    },
    [currentUserId],
  );

  const cancelEdit = useCallback(() => setEditing(null), []);

  /**
   * The message being edited, resolved live from state rather than remembered.
   *
   * EDIT MODE CANNOT OUTLIVE ITS MESSAGE, and this is how. Another device — or another person,
   * with a delete-for-everyone — can remove the message while this browser has it open in the
   * composer. Because the target is looked up on every render instead of being held as a copy, it
   * simply stops resolving: `editTarget` becomes null, the banner goes, and the composer returns
   * to normal. There is no effect racing the change and no stale snapshot to write text onto.
   *
   * A concurrent EDIT is deliberately NOT cancelled. The row's text changed underneath, but the
   * message is still there and still theirs; the composer holds what they have typed and their
   * save wins. Throwing their words away to adopt somebody else's would be the worse answer.
   */
  const editTarget = useMemo<ChatMessage | null>(() => {
    if (!editing) return null;

    const live = state.messagesByConversation[editing.conversationId]?.find(
      (message) => message.id === editing.id,
    );

    if (!live || live.deletedAt !== null || live.kind === 'SYSTEM') return null;
    return live;
  }, [editing, state.messagesByConversation]);

  /**
   * Saves the edited text.
   *
   * The response is applied locally as well as broadcast: the actor's own window updates even if
   * their socket is briefly down, and the server remains the authority either way.
   *
   * Edit mode is cleared ONLY on success. A failed save keeps the banner and whatever was typed,
   * which is the difference between "try that again" and "type all of that again".
   */
  const saveEdit = useCallback(
    async (body: string): Promise<boolean> => {
      const target = editTarget;
      if (!target) return false;

      try {
        const result = await requestMessageEdit(target.id, body);
        dispatch({ type: 'message-updated', message: result.message });
        setEditing(null);
        return true;
      } catch (error) {
        handleFailure(error, 'That message could not be edited.');
        return false;
      }
    },
    [editTarget, handleFailure],
  );


  /**
   * Adds, changes or removes this user's reaction.
   *
   * The response is applied locally as well as broadcast, so the actor's own window updates even
   * if their socket is briefly down — the server is still the authority, and a reconnection
   * re-reads history regardless.
   */
  const toggleReaction = useCallback(
    (message: ChatMessage, emoji: string) => {
      const mine = currentUserId;
      if (!mine) return;

      const alreadyMine = message.reactions.some(
        (reaction) => reaction.emoji === emoji && reaction.userIds.includes(mine),
      );

      void (async () => {
        try {
          const result = alreadyMine
            ? await clearMessageReaction(message.id)
            : await setMessageReaction(message.id, emoji);
          dispatch({ type: 'message-updated', message: result.message });
        } catch (error) {
          handleFailure(error, 'That reaction could not be saved.');
        }
      })();
    },
    [currentUserId, handleFailure],
  );

  const togglePin = useCallback(
    (message: ChatMessage) => {
      void (async () => {
        try {
          const result = await setMessagePinned(message.id, message.pinnedAt === null);
          dispatch({ type: 'message-updated', message: result.message });
        } catch (error) {
          handleFailure(error, 'That message could not be pinned.');
        }
      })();
    },
    [handleFailure],
  );

  const deleteForMe = useCallback(
    (message: ChatMessage) => {
      void (async () => {
        try {
          await hideMessage(message.id);
          dispatch({
            type: 'message-hidden',
            conversationId: message.conversationId,
            messageId: message.id,
          });
        } catch (error) {
          handleFailure(error, 'That message could not be removed.');
        }
      })();
    },
    [handleFailure],
  );

  const deleteForEveryone = useCallback(
    (message: ChatMessage) => {
      void (async () => {
        try {
          const result = await removeMessageForEveryone(message.id);
          dispatch({ type: 'message-updated', message: result.message });
        } catch (error) {
          handleFailure(error, 'That message could not be deleted.');
        }
      })();
    },
    [handleFailure],
  );

  /**
   * Forwards a message into other conversations.
   *
   * A fresh `clientMessageId` per destination — the idempotency key, so a retry after a dropped
   * response collides with the stored row instead of forwarding a file twice.
   *
   * Nothing is dispatched for the destinations themselves: each forward arrives as a normal
   * `message:new`, including in this window, so inserting it here as well would be the one place
   * a message could appear twice.
   */
  /** Who has read one of this user's own group messages. Authorized server-side. */
  const readStatusFor = useCallback(
    (messageId: string): Promise<MessageReadStatusWire> => fetchMessageReadStatus(messageId),
    [],
  );

  /**
   * Subscribes to read nudges.
   *
   * Single-subscriber by design: exactly one Message info panel is open at a time, and a list of
   * handlers would be machinery for a case that cannot arise. The unsubscribe clears only its own
   * registration, so a panel closing after another opened cannot silence the newer one.
   */
  const subscribeToReadNudges = useCallback(
    (handler: (conversationId: string, userId: string) => void): (() => void) => {
      readNudgeRef.current = handler;
      return () => {
        if (readNudgeRef.current === handler) readNudgeRef.current = null;
      };
    },
    [],
  );

  const forwardTo = useCallback(
    async (message: ChatMessage, conversationIds: string[]): Promise<number> => {
      if (conversationIds.length === 0) return 0;

      try {
        const result = await sendForward(
          message.id,
          conversationIds.map((conversationId) => ({
            conversationId,
            clientMessageId: newClientMessageId(),
          })),
        );

        if (result.failures.length > 0) {
          dispatch({
            type: 'notice',
            message:
              result.messages.length > 0
                ? `Forwarded to ${result.messages.length} of ${conversationIds.length} conversations.`
                : 'That message could not be forwarded.',
          });
        }

        await loadConversations();
        return result.messages.length;
      } catch (error) {
        handleFailure(error, 'That message could not be forwarded.');
        return 0;
      }
    },
    [handleFailure, loadConversations],
  );

  return {
    state,
    replyTarget,
    beginReply,
    cancelReply,
    editTarget,
    beginEdit,
    cancelEdit,
    saveEdit,
    toggleReaction,
    togglePin,
    deleteForMe,
    deleteForEveryone,
    forwardTo,
    readStatusFor,
    subscribeToReadNudges,
    selectConversation,
    startDirectConversation,
    createGroup,
    addMembers,
    removeMember,
    refreshDirectory,
    sendMessage,
    sendFile,
    cancelUpload,
    dismissUpload,
    retryMessage,
    loadOlderMessages,
    searchDirectory,
    setSearchTerm,
    dismissNotice,
  };
}
