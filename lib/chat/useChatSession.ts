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
 * No identity is ever sent from here. The session and device cookies are `HttpOnly`; the server
 * derives the user from them on both transports.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import {
  ApiError,
  createSession,
  endSession,
  fetchConversations,
  fetchDirectory,
  fetchMessages,
  fetchSession,
  markRead,
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
  /** True while `POST /api/session` is in flight, so the entry screen can disable its button. */
  entering: boolean;
  enter(displayName: string): Promise<void>;
  switchUser(): Promise<boolean>;
  selectConversation(conversationId: string): void;
  startDirectConversation(userId: string): Promise<void>;
  /** Re-reads the colleague list, so a picker never opens on a stale directory. */
  refreshDirectory(): void;
  sendMessage(body: string): void;
  retryMessage(message: ChatMessage): void;
  loadOlderMessages(): void;
  searchDirectory(term: string): void;
  setSearchTerm(term: string): void;
  dismissNotice(): void;
}

export function useChatSession(): ChatSession {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [entering, setEntering] = useState(false);

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

  const currentUserId = state.currentUser?.id ?? null;

  /* ----------------------------------------------------------------------------------------- */
  /* Failure handling                                                                            */
  /* ----------------------------------------------------------------------------------------- */

  /**
   * A 401 means the identity has gone — the session expired and there is no usable device cookie,
   * or it was revoked elsewhere. The only correct response is the name screen; carrying on with
   * a stale user id on screen would be a lie.
   */
  const handleFailure = useCallback((error: unknown, fallback: string) => {
    if (error instanceof ApiError && error.isUnauthenticated) {
      dispatch({ type: 'identity-missing' });
      dispatch({ type: 'notice', message: 'Your session ended. Enter your name to continue.' });
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
        }
      },

      onPresence(wire) {
        dispatch({ type: 'presence-changed', entries: [wire] });
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
  }, [currentUserId, backfill, loadConversations, loadHistory, markConversationRead, syncPresence]);

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

  const enter = useCallback(async (displayName: string) => {
    setEntering(true);
    try {
      const identity = await createSession(displayName);
      dispatch({
        type: 'identity-ready',
        userId: identity.userId,
        displayName: identity.displayName,
      });
    } catch (error) {
      dispatch({
        type: 'notice',
        message: error instanceof ApiError ? error.message : 'Could not start a session.',
      });
    } finally {
      setEntering(false);
    }
  }, []);

  /**
   * Switch User / Clear Device Identity (F-19).
   *
   * Returns false and changes nothing locally when the server call fails. Clearing the screen
   * while the session and device rows still exist would be the worst of both worlds on a shared
   * computer: the next person would see an empty interface but still hold a working cookie.
   */
  const switchUser = useCallback(async (): Promise<boolean> => {
    try {
      await endSession();
    } catch (error) {
      dispatch({
        type: 'notice',
        message:
          error instanceof ApiError && error.status !== 0
            ? error.message
            : 'Could not switch user. Check your connection and try again.',
      });
      return false;
    }

    socketRef.current?.close();
    socketRef.current = null;
    openConversationRef.current = null;
    newestMessageRef.current = null;
    oldestMessageRef.current = null;
    knownConversationsRef.current = new Set();

    dispatch({ type: 'switched-user' });
    return true;
  }, []);

  const selectConversation = useCallback(
    (conversationId: string) => {
      dispatch({ type: 'select-conversation', conversationId });
      // Always re-read: the badge was cleared optimistically and the history on screen may be a
      // reconnection old. The merge in the reducer keeps anything still sending.
      void loadHistory(conversationId);
    },
    [loadHistory],
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
    entering,
    enter,
    switchUser,
    selectConversation,
    startDirectConversation,
    refreshDirectory,
    sendMessage,
    retryMessage,
    loadOlderMessages,
    searchDirectory,
    setSearchTerm,
    dismissNotice,
  };
}
