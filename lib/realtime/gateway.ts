/**
 * The Socket.IO gateway.
 *
 * Attaches to the HTTP server created by `server.ts` (D-09), so the browser talks to one origin
 * and one port, and the session cookie applies to both transports with no CORS handling.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE (CLAUDE.md §10): the server decides everything that
 * matters. The client cannot claim a user id, a membership, a role or a sender. It can ask to
 * join a room and ask to send a message; both are answered from the database.
 *
 *   handshake  →  cookie → resolveIdentity() → User.id     (no valid identity → disconnect)
 *   join       →  findActiveMembership() → room            (never on the client's say-so)
 *   send       →  membership + validate → commit → ack → broadcast
 *   changed    →  a committed membership change (over HTTP) → tell the members to re-read
 *
 * Nothing is broadcast before PostgreSQL has committed the row: the real-time layer is a delivery
 * accelerator, never the source of truth.
 */

import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';

import type { PrismaClient } from '../../prisma/generated/client';
import {
  DEVICE_COOKIE,
  SESSION_COOKIE,
  parseCookieHeader,
  resolveIdentity,
  touchLastSeen,
  type IdentityConfig,
} from '../auth/session';
import {
  findActiveMembership,
  listActiveMemberships,
  listOtherActiveMemberIds,
  listPresencePeerIds,
} from '../authz/membership';
import type { Logger } from '../logging/logger';
import { describeError } from '../logging/logger';
import { SendMessageError, sendMessage } from '../messages/service';
import type { NetworkGate } from '../net/gate';
import {
  SOCKET_PATH,
  joinConversationSchema,
  leaveConversationSchema,
  sendMessageSchema,
  toMessageWire,
  type Ack,
  type ClientToServerEvents,
  type ServerToClientEvents,
  type SocketData,
  type SocketError,
  type SocketErrorCode,
} from './events';
import {
  clearRealtimeNotifier,
  setRealtimeNotifier,
  type ConversationAudienceChange,
  type RealtimeNotifier,
} from './notify';
import { PresenceTracker } from './presence';

type ChatSocket = Socket<ClientToServerEvents, ServerToClientEvents, never, SocketData>;
export type ChatServer = Server<ClientToServerEvents, ServerToClientEvents, never, SocketData>;

export interface GatewayDependencies {
  db: PrismaClient;
  logger: Logger;
  identity: IdentityConfig;
  /** Overridable so tests do not have to wait out the real presence grace period. */
  presenceGraceMs?: number;
  /**
   * The network gate (Phase 8).
   *
   * Optional only so the realtime test harness can build a gateway without one. In the running
   * application server.ts always supplies it, and when it is absent the socket layer is
   * unrestricted — which is why the absence is logged loudly at construction below.
   */
  gate?: NetworkGate;
}

export interface RealtimeGateway {
  io: ChatServer;
  presence: PresenceTracker;
  close(): Promise<void>;
}

/** Room naming. Centralised so a room name is never assembled ad hoc at a call site. */
export const rooms = {
  /** Every socket a user has open. Used for cross-tab updates. */
  user: (userId: string) => `user:${userId}`,
  /** Joined only after membership is confirmed from the database. */
  conversation: (conversationId: string) => `conversation:${conversationId}`,
} as const;

function fail(code: SocketErrorCode, message: string): Ack<never> {
  return { ok: false, error: { code, message } };
}

/** Maps a service failure onto a client-safe code. Unknown failures never leak their detail. */
function toSocketError(error: unknown): SocketError {
  if (error instanceof SendMessageError) {
    switch (error.reason) {
      case 'NOT_A_MEMBER':
      case 'CONVERSATION_NOT_FOUND':
        return { code: 'FORBIDDEN', message: 'You are not a member of this conversation.' };
      case 'BODY_TOO_LONG':
        return { code: 'MESSAGE_TOO_LONG', message: error.message };
      case 'EMPTY_BODY':
        return { code: 'MESSAGE_EMPTY', message: error.message };
    }
  }

  // Anything else — including a database failure — is an internal error to the browser. The
  // detail goes to the server log, never over the wire (CLAUDE.md §13).
  return { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' };
}

/**
 * Creates the gateway and attaches it to an existing HTTP server.
 *
 * The server instance is passed in rather than created here, so Socket.IO and Next.js share one
 * listener. That is decision D-09 and is not to be worked around by starting a second server.
 */
export function createRealtimeGateway(
  httpServer: HttpServer,
  deps: GatewayDependencies,
): RealtimeGateway {
  const { db, logger, identity, gate } = deps;

  const io: ChatServer = new Server(httpServer, {
    path: SOCKET_PATH,
    /*
     * NETWORK RESTRICTION, AT THE HANDSHAKE (Phase 8).
     *
     * This is not defence in depth — it is the only place the socket transport can be gated.
     * When engine.io attaches it caches the HTTP server's `request` listeners, removes them, and
     * calls them only for requests it does not claim itself. Socket.IO's polling transport
     * therefore never reaches the check in server.ts, and the WebSocket upgrade arrives on the
     * `upgrade` event, which that listener never sees either. `allowRequest` runs for the
     * initial handshake of BOTH transports (engine.io `verify()`), so it is the one hook that
     * covers the whole surface.
     *
     * Refusing here means the connection is rejected before engine.io creates a session: no
     * socket, so no identity lookup, no room join, no presence, and no message delivery. The
     * client sees a transport error and nothing about why.
     */
    allowRequest: (req, callback) => {
      if (!gate) {
        callback(undefined, true);
        return;
      }

      const decision = gate.check(req.socket.remoteAddress, req.headers, SOCKET_PATH);
      // engine.io turns `false` into a 403 with an opaque code. The message is never sent to the
      // client in a form that describes the policy.
      callback(decision.allowed ? undefined : 'FORBIDDEN', decision.allowed);
    },
    // Same origin by construction: no CORS configuration, so no chance of accidentally
    // permitting one. A cross-origin browser cannot open this socket.
    cors: { origin: false },
    // The application is a company-network LAN application; a small ceiling is plenty and keeps
    // an oversized frame from reaching the handlers at all (docs/04-security.md, "Denial of
    // service").
    maxHttpBufferSize: 128 * 1024,
    connectionStateRecovery: {
      // Deliberately off. Socket.IO's recovery would replay missed events from an in-memory
      // buffer; this application backfills from PostgreSQL instead, which is the only source of
      // truth and the only thing that survives a restart (docs/01-architecture.md §6).
      maxDisconnectionDuration: 0,
      skipMiddlewares: false,
    },
  });

  const presence = new PresenceTracker(
    deps.presenceGraceMs === undefined ? {} : { graceMs: deps.presenceGraceMs },
  );

  if (!gate) {
    logger.warn('Realtime gateway created without a network gate: socket access is unrestricted');
  }

  /*
   * Network restriction, re-checked per socket (Phase 8).
   *
   * REGISTERED FIRST, ahead of identity, so an address outside the company network is turned
   * away before a cookie is read or the database is touched — the requirement is that an outside
   * client cannot establish a socket, not that it fails a later check.
   *
   * `allowRequest` above already refused the handshake, so in normal operation this never fires.
   * It exists for the one case that hook does not cover: engine.io skips `allowRequest` for a
   * request that carries an existing session id, so a connection resumed with a stolen `sid`
   * would otherwise not be re-evaluated. Cheap, and it keeps the socket layer's answer to "who
   * is allowed here" identical to the HTTP layer's on every connection rather than once.
   */
  io.use((socket, next) => {
    if (!gate) {
      next();
      return;
    }

    const decision = gate.check(
      socket.conn.remoteAddress,
      socket.handshake.headers,
      SOCKET_PATH,
    );

    if (!decision.allowed) {
      next(new Error('FORBIDDEN'));
      return;
    }

    next();
  });

  /*
   * Handshake authentication.
   *
   * Runs before any event handler is registered, so an unauthenticated socket never reaches a
   * handler at all. Identity comes from the cookie header and nothing else — not from
   * `socket.handshake.auth`, not from a query parameter, not from the first event.
   */
  io.use((socket, next) => {
    void (async () => {
      try {
        const cookies = parseCookieHeader(socket.handshake.headers.cookie);
        const resolved = await resolveIdentity(
          db,
          { sessionToken: cookies[SESSION_COOKIE], deviceToken: cookies[DEVICE_COOKIE] },
          identity,
        );

        if (!resolved) {
          // No usable session or device: this computer has no assignment, so there is nobody
          // for the socket to be. Setting that right is an administrator's job.
          logger.debug('Socket handshake rejected: no valid identity');
          next(new Error('UNAUTHENTICATED'));
          return;
        }

        // The server-derived context. Everything this socket is later allowed to do is decided
        // from these values, never from a payload.
        socket.data.userId = resolved.current.userId;
        socket.data.displayName = resolved.current.displayName;
        socket.data.sessionId = resolved.current.sessionId;
        socket.data.deviceId = resolved.current.deviceId;

        next();
      } catch (error) {
        // A database failure during the handshake is an internal error, not an invitation to
        // let the connection through.
        logger.error('Socket handshake failed', describeError(error));
        next(new Error('INTERNAL_ERROR'));
      }
    })();
  });

  io.on('connection', (socket: ChatSocket) => {
    void onConnection(socket).catch((error: unknown) => {
      logger.error('Socket connection setup failed', {
        userId: socket.data.userId,
        ...describeError(error),
      });
      socket.emit('server:error', {
        code: 'INTERNAL_ERROR',
        message: 'Could not establish the connection. Please reload.',
      });
      socket.disconnect(true);
    });
  });

  async function onConnection(socket: ChatSocket): Promise<void> {
    const { userId, displayName } = socket.data;

    /*
     * Handlers are registered FIRST, before any await.
     *
     * A browser can emit the moment its socket connects, and Socket.IO drops an event that
     * arrives before a listener exists — silently, with no acknowledgement ever sent. Doing the
     * database work first would leave a window of several round trips in which a client's first
     * message vanishes. Every handler authorizes itself from the database, so none of them
     * depends on the setup below having finished.
     */
    registerHandlers(socket);

    /*
     * Rooms are decided here, from the database, on every connection — including reconnections.
     * A reconnecting socket is a new socket with no memory: it inherits no room from its
     * predecessor, and nothing it claims about previous membership is consulted.
     */
    const memberships = await listActiveMemberships(db, userId);

    await socket.join(rooms.user(userId));
    for (const membership of memberships) {
      await socket.join(rooms.conversation(membership.conversationId));
    }

    socket.emit('session:ready', {
      userId,
      displayName,
      conversationIds: memberships.map((membership) => membership.conversationId),
    });

    // Presence is derived from this connection existing, not from the client announcing it.
    const cameOnline = presence.add(userId, socket.id);
    if (cameOnline) {
      await touchLastSeen(db, userId).catch((error: unknown) => {
        // A failed timestamp write must not fail the connection; it is a display value.
        logger.warn('Could not update lastSeenAt on connect', {
          userId,
          ...describeError(error),
        });
      });
      await announcePresence(userId, true);
    }

    logger.debug('Socket connected', {
      userId,
      socketId: socket.id,
      conversations: memberships.length,
      connections: presence.connectionCount(userId),
    });

    socket.on('disconnect', (reason) => {
      logger.debug('Socket disconnected', { userId, socketId: socket.id, reason });

      // Only the user's LAST socket starts the offline countdown; other tabs keep them online.
      presence.remove(userId, socket.id, (offlineUserId) => {
        void (async () => {
          try {
            await touchLastSeen(db, offlineUserId);
            await announcePresence(offlineUserId, false);
          } catch (error) {
            logger.warn('Could not announce offline presence', {
              userId: offlineUserId,
              ...describeError(error),
            });
          }
        })();
      });
    });
  }

  function registerHandlers(socket: ChatSocket): void {
    const { userId } = socket.data;

    /*
     * Presence snapshot.
     *
     * `presence:update` covers changes, but a client that has just connected knows nothing about
     * who was already online, and a client that has just started a new conversation knows nothing
     * about its new peer. The peer set is read from the database on every call, so the answer is
     * always scoped to the people this user actually shares a conversation with — the client
     * cannot name anybody, and the payload is ignored entirely.
     */
    socket.on('presence:sync', (_payload, ack) => {
      void (async () => {
        try {
          const peerIds = await listPresencePeerIds(db, userId);
          const peers = await db.user.findMany({
            where: { id: { in: peerIds } },
            select: { id: true, lastSeenAt: true },
          });

          respond(ack, {
            ok: true,
            data: peers.map((peer) => ({
              userId: peer.id,
              online: presence.isOnline(peer.id),
              lastSeenAt: peer.lastSeenAt.toISOString(),
            })),
          });
        } catch (error) {
          logger.error('presence:sync failed', { userId, ...describeError(error) });
          respond(ack, { ok: false, error: toSocketError(error) });
        }
      })();
    });

    socket.on('conversation:join', (payload, ack) => {
      void (async () => {
        const parsed = joinConversationSchema.safeParse(payload);
        if (!parsed.success) {
          respond(ack, fail('INVALID_PAYLOAD', 'That request was not understood.'));
          return;
        }

        try {
          // The authorization that matters: membership is read from the database, and the room
          // is joined only if it comes back. `socket.join` is never reached otherwise.
          const membership = await findActiveMembership(db, userId, parsed.data.conversationId);
          if (!membership) {
            logger.warn('Socket denied conversation room', {
              userId,
              conversationId: parsed.data.conversationId,
            });
            respond(
              ack,
              fail('FORBIDDEN', 'You are not a member of this conversation.'),
            );
            return;
          }

          await socket.join(rooms.conversation(membership.conversationId));

          respond(ack, {
            ok: true,
            data: {
              conversationId: membership.conversationId,
              // D-03: the client is told where its visible history starts. The server filters
              // regardless — this is information, not enforcement.
              joinedAt: membership.joinedAt.toISOString(),
            },
          });
        } catch (error) {
          logger.error('conversation:join failed', { userId, ...describeError(error) });
          respond(ack, { ok: false, error: toSocketError(error) });
        }
      })();
    });

    socket.on('conversation:leave', (payload, ack) => {
      void (async () => {
        const parsed = leaveConversationSchema.safeParse(payload);
        if (!parsed.success) {
          respond(ack, fail('INVALID_PAYLOAD', 'That request was not understood.'));
          return;
        }

        // Leaving needs no authorization: it grants nothing and reveals nothing.
        await socket.leave(rooms.conversation(parsed.data.conversationId));
        respond(ack, { ok: true, data: null });
      })();
    });

    socket.on('message:send', (payload, ack) => {
      void (async () => {
        const parsed = sendMessageSchema.safeParse(payload);
        if (!parsed.success) {
          // Distinguish the length failure, because the user can act on it.
          const tooLong = parsed.error.issues.some(
            (issue) => issue.code === 'too_big' && issue.path[0] === 'body',
          );
          respond(
            ack,
            tooLong
              ? fail('MESSAGE_TOO_LONG', 'That message is too long to send.')
              : fail('INVALID_PAYLOAD', 'That message could not be sent.'),
          );
          return;
        }

        try {
          /*
           * `senderId` comes from the socket's server-derived identity. Any `senderId` in the
           * payload was already dropped by the schema, which has no such field — a client
           * cannot send as anybody but itself.
           */
          const result = await sendMessage(db, {
            senderId: userId,
            conversationId: parsed.data.conversationId,
            body: parsed.data.body,
            clientMessageId: parsed.data.clientMessageId,
          });

          const wire = toMessageWire(result.message);

          // The acknowledgement follows the commit, never precedes it.
          respond(ack, { ok: true, data: wire });

          if (result.duplicate) {
            // A retry of an already-stored message. The sender gets the stored row back, and
            // nothing is broadcast a second time.
            logger.debug('Duplicate message suppressed', {
              userId,
              conversationId: wire.conversationId,
            });
            return;
          }

          /*
           * Make sure every active member's sockets are actually in the room before broadcasting.
           *
           * A socket joins its conversation rooms at connection time, so a conversation created
           * *after* a member connected has no room membership for them and the broadcast below
           * would reach nobody. Rather than have conversation creation reach into the socket
           * server, the room is repaired here, from the database, at the only moment it matters.
           *
           * This grants nothing: the member ids come from `listOtherActiveMemberIds`, which is the
           * same authorization source `conversation:join` uses. It adds people who are entitled to
           * the room, never people who asked for it.
           *
           * It cannot throw. The acknowledgement has already gone out, so a failure here must not
           * reach the catch below — that would log a stored message as failed and send a second
           * acknowledgement for a send that actually succeeded.
           */
          await ensureMembersInRoom(wire.conversationId, userId);

          // Everyone in the room except the sender, whose acknowledgement already carried it.
          socket.to(rooms.conversation(wire.conversationId)).emit('message:new', wire);
        } catch (error) {
          const socketError = toSocketError(error);
          if (socketError.code === 'INTERNAL_ERROR') {
            logger.error('message:send failed', {
              userId,
              conversationId: parsed.data.conversationId,
              ...describeError(error),
            });
          }
          respond(ack, { ok: false, error: socketError });
        }
      })();
    });
  }

  /**
   * Joins every active member's open sockets to a conversation's room.
   *
   * Called on the send path, where a conversation that did not exist when a member connected
   * would otherwise deliver to an empty room. Membership is read from the database; the sender's
   * own other tabs are included so every window of theirs stays in step.
   */
  async function ensureMembersInRoom(conversationId: string, senderId: string): Promise<void> {
    try {
      const peerIds = await listOtherActiveMemberIds(db, conversationId, senderId);
      const room = rooms.conversation(conversationId);

      for (const peerId of [...peerIds, senderId]) {
        io.in(rooms.user(peerId)).socketsJoin(room);
      }
    } catch (error) {
      // Best-effort: the message is already committed and acknowledged. Anyone already in the
      // room still receives it; anyone who is not will see it on their next read.
      logger.warn('Could not repair conversation room membership', {
        conversationId,
        ...describeError(error),
      });
    }
  }

  /**
   * Tells the people entitled to know that a user's presence changed.
   *
   * Scoped to users who share at least one active conversation: presence is not public, and
   * broadcasting it to everyone would leak who exists and who is at their desk.
   */
  async function announcePresence(userId: string, online: boolean): Promise<void> {
    const [peerIds, user] = await Promise.all([
      listPresencePeerIds(db, userId),
      db.user.findUnique({ where: { id: userId }, select: { lastSeenAt: true } }),
    ]);

    const payload = {
      userId,
      online,
      lastSeenAt: user?.lastSeenAt.toISOString() ?? null,
    };

    for (const peerId of peerIds) {
      io.to(rooms.user(peerId)).emit('presence:update', payload);
    }

    // The user's own other tabs, so every window agrees about their state.
    io.to(rooms.user(userId)).emit('presence:update', payload);
  }

  /*
   * The seam route handlers reach the socket server through (lib/realtime/notify.ts).
   *
   * Group creation, adding a member and leaving all happen over HTTP, and all three have to
   * change somebody else's screen. This is the only way in, and it accepts an audience the
   * caller read from the database — never one from a request.
   */
  const notifier: RealtimeNotifier = {
    conversationChanged(change: ConversationAudienceChange): void {
      const room = rooms.conversation(change.conversationId);
      const payload = { conversationId: change.conversationId };

      /*
       * Joining the room here is what makes the next message reach a newly added member without
       * waiting for them to reload. It grants nothing: `memberIds` came from the membership
       * table, which is the same source `conversation:join` authorizes against.
       */
      for (const userId of change.memberIds) {
        io.in(rooms.user(userId)).socketsJoin(room);
        io.to(rooms.user(userId)).emit('conversation:changed', payload);
      }

      /*
       * And leaving the room is what stops a removed member receiving the next one. Their own
       * sockets are told too, so the conversation disappears from their sidebar rather than
       * lingering until they reload — the order matters, because the notification is what makes
       * them re-read.
       */
      for (const userId of change.removedIds ?? []) {
        io.to(rooms.user(userId)).emit('conversation:changed', payload);
        io.in(rooms.user(userId)).socketsLeave(room);
      }
    },

    /**
     * A file uploaded over HTTP, delivered to the conversation exactly as a socket send would be.
     *
     * The room is repaired first for the same reason the send path repairs it: a conversation
     * created after a member connected has no room membership for them, and the broadcast would
     * reach nobody. Membership comes from the database, so this adds people who are entitled to
     * the room and never people who asked for it.
     *
     * The sender's own other tabs are included — their uploading tab already has the message from
     * the HTTP response, and the reducer discards the duplicate by `clientMessageId`.
     */
    messagePosted(posted): void {
      void (async () => {
        try {
          await ensureMembersInRoom(posted.conversationId, posted.senderId);
          io.to(rooms.conversation(posted.conversationId)).emit(
            'message:new',
            posted.message as never,
          );
        } catch (error) {
          // The message is committed. A delivery that fails here costs a refresh, not a message.
          logger.warn('Could not deliver an uploaded file over the socket', {
            conversationId: posted.conversationId,
            ...describeError(error),
          });
        }
      })();
    },
  };

  setRealtimeNotifier(notifier);

  return {
    io,
    presence,
    async close(): Promise<void> {
      // Only if it is still ours: a test that started a second gateway must not have its
      // registration removed by the first one shutting down.
      clearRealtimeNotifier(notifier);
      presence.dispose();
      // Disconnects every socket and stops accepting new ones. The HTTP server is closed by
      // server.ts, which owns it.
      await io.close();
    },
  };
}

/** Socket.IO acknowledgements are optional on the wire; a client may simply not send one. */
function respond<T>(ack: ((response: Ack<T>) => void) | undefined, response: Ack<T>): void {
  if (typeof ack === 'function') ack(response);
}
