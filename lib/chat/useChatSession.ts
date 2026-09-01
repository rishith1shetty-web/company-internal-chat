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

import { useCallback, useEffect, useReducer, useRef } from 'react';

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
} from '@/lib/chat/api';
import {
  chatReducer,
  initialChatState,
  type ChatState,
} from '@/lib/chat/state';
import { createChatSocket, type ChatSocketClient } from '@/lib/chat/socket';
import type { ChatMessage } from '@/lib/chat/types';

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
  searchDirectory(term: string): void;
  setSearchTerm(term: string): void;
  dismissNotice(): void;
}

export function useChatSession(): ChatSession {
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

  const currentUserId = state.currentUser?.id ?? null;

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

      onMessage(wire) {
        dispatch({ type: 'message-received', message: wire });

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
    },
    [loadAttachments, loadHistory],
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
    async (conversationId: string, body: string, clientMessageId: string) => {
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

      const ack = await socket.sendMessage({ conversationId, body, clientMessageId });

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

      const clientMessageId = crypto.randomUUID();

      dispatch({
        type: 'message-queued',
        conversationId,
        clientMessageId,
        body: trimmed,
        now: new Date().toISOString(),
      });

      void deliver(conversationId, trimmed, clientMessageId);
    },
    [deliver],
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

      const clientMessageId = crypto.randomUUID();

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

  return {
    state,
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
