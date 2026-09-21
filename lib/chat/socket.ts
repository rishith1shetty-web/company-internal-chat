/**
 * The browser's Socket.IO connection.
 *
 * A thin wrapper over `socket.io-client` that gives the interface a promise-shaped API and keeps
 * every event name in one file. It holds no chat state: what arrives here is handed straight to
 * the caller, which puts it through the reducer. The socket is a transport, not a store.
 *
 * Identity: none is sent. The connection carries the `HttpOnly` session cookie automatically and
 * the server derives the user from it during the handshake. There is deliberately no `auth`
 * option and no user id in any payload below — a client that could name its own user is a client
 * that could send as somebody else (CLAUDE.md §10).
 *
 * Reconnection: enabled, because a company LAN drops connections. What is *not* enabled is
 * replaying missed events — the server has Socket.IO's connection-state recovery switched off on
 * purpose. After a reconnect the client re-reads from PostgreSQL over REST, which is the only
 * account of history that survives a server restart (docs/01-architecture.md §6).
 */

import { io, type Socket } from 'socket.io-client';

import { SOCKET_PATH } from '@/lib/chat/wire';
import type {
  Ack,
  ConversationChangedWire,
  JoinedConversationWire,
  MessageWire,
  PresenceWire,
  SessionWire,
  SocketError,
} from '@/lib/chat/wire';
import type { ClientToServerEvents, ServerToClientEvents } from '@/lib/realtime/events';

/** How the interface describes the connection to the user. */
export type ConnectionState = 'connecting' | 'online' | 'reconnecting' | 'offline';

/** Nothing acknowledges forever; a hung socket has to become a visible failure. */
const ACK_TIMEOUT_MS = 10_000;

export interface ChatSocketHandlers {
  onConnectionChange(state: ConnectionState): void;
  /** The connection is authenticated and its rooms are joined. Carries the server's own view. */
  onSessionReady(payload: SessionWire): void;
  onMessage(payload: MessageWire): void;
  /**
   * A message that already exists changed — a reaction, a pin, or a delete-for-everyone.
   *
   * Separate from `onMessage` on purpose. `message:new` is a new message and follows the normal
   * notification path (sound, toast, unread); this one is a visual update and must not, or
   * somebody reacting to a week-old message would ring every desk in the office.
   */
  onMessageUpdated(payload: MessageWire): void;
  /** This user hid a message for themselves, in this window or another of theirs. */
  onMessageHidden(payload: { conversationId: string; messageId: string }): void;
  onPresence(payload: PresenceWire): void;
  /**
   * A conversation this user is — or has just stopped being — a member of has changed.
   *
   * Carries only an id. The handler answers it by re-reading over REST, so nothing about the
   * conversation is taken from the socket; this is a nudge, not a payload.
   */
  onConversationChanged(payload: ConversationChangedWire): void;
  /** An out-of-band failure, e.g. the session was revoked while the socket was open. */
  onServerError(payload: SocketError): void;
}

export interface ChatSocketClient {
  joinConversation(conversationId: string): Promise<Ack<JoinedConversationWire>>;
  sendMessage(input: {
    conversationId: string;
    body: string;
    clientMessageId: string;
    /** The message being replied to. Re-verified server-side before it is written. */
    replyToId?: string | undefined;
  }): Promise<Ack<MessageWire>>;
  /** Current presence of everyone the caller shares a conversation with. */
  syncPresence(): Promise<Ack<PresenceWire[]>>;
  close(): void;
}

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** A refusal produced locally, in the same shape the server would have sent. */
function localFailure(message: string): Ack<never> {
  return { ok: false, error: { code: 'INTERNAL_ERROR', message } };
}

export function createChatSocket(handlers: ChatSocketHandlers): ChatSocketClient {
  const socket: ClientSocket = io({
    path: SOCKET_PATH,
    // Same origin as the page: one process, one port (D-09). No URL is given, so this cannot
    // accidentally be pointed at another host.
    withCredentials: true,
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5_000,
  });

  handlers.onConnectionChange('connecting');

  socket.on('connect', () => handlers.onConnectionChange('online'));

  socket.on('disconnect', (reason) => {
    // "io server disconnect" means the server ended it deliberately — a revoked identity, for
    // instance — and socket.io will not retry on its own.
    handlers.onConnectionChange(reason === 'io server disconnect' ? 'offline' : 'reconnecting');
  });

  socket.io.on('reconnect_attempt', () => handlers.onConnectionChange('reconnecting'));
  socket.on('connect_error', () => handlers.onConnectionChange('reconnecting'));

  socket.on('session:ready', handlers.onSessionReady);
  socket.on('message:new', handlers.onMessage);
  socket.on('message:updated', handlers.onMessageUpdated);
  socket.on('message:hidden', handlers.onMessageHidden);
  socket.on('presence:update', handlers.onPresence);
  socket.on('conversation:changed', handlers.onConversationChanged);
  socket.on('server:error', handlers.onServerError);

  /**
   * Emits and resolves with the acknowledgement.
   *
   * Resolves rather than rejects on failure: a refusal is an answer, and the caller has to
   * distinguish "the server said no" from "nothing came back" in the same place either way.
   */
  function emitWithAck<T>(event: keyof ClientToServerEvents, payload: unknown): Promise<Ack<T>> {
    return new Promise((resolve) => {
      if (!socket.connected) {
        resolve(localFailure('You are not connected. The message was not sent.'));
        return;
      }

      const timer = setTimeout(
        () => resolve(localFailure('The server did not respond. The message was not sent.')),
        ACK_TIMEOUT_MS,
      );

      const emit = socket.emit.bind(socket) as (
        event: string,
        payload: unknown,
        ack: (response: Ack<T>) => void,
      ) => void;

      emit(event, payload, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
    });
  }

  return {
    joinConversation(conversationId) {
      return emitWithAck<JoinedConversationWire>('conversation:join', { conversationId });
    },

    sendMessage(input) {
      return emitWithAck<MessageWire>('message:send', input);
    },

    syncPresence() {
      return emitWithAck<PresenceWire[]>('presence:sync', {});
    },

    close() {
      socket.removeAllListeners();
      socket.close();
    },
  };
}
