/**
 * Test harness for the real-time layer.
 *
 * Starts a real HTTP server with a real Socket.IO gateway attached, backed by the real
 * `company_chat_db`, and connects real `socket.io-client` sockets to it. Nothing is mocked:
 * a test that stubs the authorization it is meant to be checking proves nothing.
 *
 * SAFETY, as in the Phase 3 tests: every row created here is registered and deleted afterwards
 * by id. Nothing is truncated, no table is emptied, and no row created by anything other than the
 * test run is read or modified.
 */

import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import { PrismaPg } from '@prisma/adapter-pg';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';

import { SESSION_COOKIE, DEVICE_COOKIE } from '@/lib/auth/session';
import { assignDevice, enrollDevice, type EnrollmentConfig } from '@/lib/devices/service';
import type { Logger } from '@/lib/logging/logger';
import { parseDatabaseUrl } from '@/lib/db/target';
import type { NetworkGate } from '@/lib/net/gate';
import { createRealtimeGateway, type RealtimeGateway } from '@/lib/realtime/gateway';
import type {
  Ack,
  ClientToServerEvents,
  ServerToClientEvents,
  SOCKET_PATH as SocketPathType,
} from '@/lib/realtime/events';
import { SOCKET_PATH } from '@/lib/realtime/events';
import { PrismaClient } from '@/prisma/generated/client';

export const databaseConfigured = Boolean(process.env['DATABASE_URL']?.trim());

/** Display-name prefix, so anything left by an interrupted run is identifiable by a human. */
export const TEST_NAME_PREFIX = 'zz-rt-';

/** Short grace period: the real one is 10s, which no test should wait out. */
export const TEST_PRESENCE_GRACE_MS = 150;

export const IDENTITY_CONFIG = { sessionTtlHours: 24, deviceTtlDays: 90 };

export type TestClient = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

let db: PrismaClient | undefined;
const createdUserIds = new Set<string>();
const createdConversationIds = new Set<string>();

export function testDb(): PrismaClient {
  if (!db) {
    // The single-database guard applies to tests exactly as it does to the application.
    parseDatabaseUrl(process.env['DATABASE_URL']);
    db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env['DATABASE_URL'] }),
    });
  }
  return db;
}

/** A silent logger: the gateway logs deliberately, and test output should stay readable. */
export function silentLogger(): Logger {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}

export interface RunningServer {
  httpServer: HttpServer;
  gateway: RealtimeGateway;
  url: string;
  close(): Promise<void>;
}

/**
 * Starts an HTTP server with the gateway attached.
 *
 * The HTTP server serves nothing else: Next.js is not involved, because what is under test is the
 * socket layer and its authorization, not page rendering.
 */
export async function startTestServer(
  options: {
    logger?: Logger;
    presenceGraceMs?: number;
    /**
     * The Phase 8 network gate. Wired exactly as server.ts wires it — checked before the request
     * handler, and handed to the gateway — so a test exercises the real arrangement rather than
     * a re-implementation of it.
     */
    gate?: NetworkGate;
    /** Stands in for Next.js: called only when a request gets past the gate. */
    onRequest?: (req: IncomingMessage, res: ServerResponse) => void;
  } = {},
): Promise<RunningServer> {
  const { gate } = options;

  const httpServer = createServer((req, res) => {
    if (gate) {
      const decision = gate.check(req.socket.remoteAddress, req.headers, req.url ?? '/');
      if (!decision.allowed) {
        gate.denyHttp(req, res);
        return;
      }
    }

    if (options.onRequest) {
      options.onRequest(req, res);
      return;
    }

    res.statusCode = 404;
    res.end();
  });

  const gateway = createRealtimeGateway(httpServer, {
    db: testDb(),
    logger: options.logger ?? silentLogger(),
    identity: IDENTITY_CONFIG,
    presenceGraceMs: options.presenceGraceMs ?? TEST_PRESENCE_GRACE_MS,
    ...(gate ? { gate } : {}),
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address() as AddressInfo;

  return {
    httpServer,
    gateway,
    url: `http://127.0.0.1:${port}`,
    async close() {
      await gateway.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

export interface TestIdentity {
  userId: string;
  displayName: string;
  sessionToken: string;
  deviceToken: string;
  /** The Cookie header a browser would send. */
  cookie: string;
}

const ENROLLMENT_CONFIG: EnrollmentConfig = { ...IDENTITY_CONFIG, enrollmentTtlHours: 24 };

let labelCounter = 0;

/**
 * A company computer assigned to a new employee and enrolled, which is the only way working
 * cookies come into existence now (docs/12-admin-device-identity.md).
 */
export async function createTestIdentity(displayName = 'Person'): Promise<TestIdentity> {
  labelCounter += 1;

  const assignment = await assignDevice(
    testDb(),
    {
      label: `${TEST_NAME_PREFIX}PC-${labelCounter}-${crypto.randomUUID().slice(0, 8)}`,
      displayName: `${TEST_NAME_PREFIX}${displayName}`,
    },
    ENROLLMENT_CONFIG,
  );

  createdUserIds.add(assignment.device.assignedUser.id);

  const enrolled = await enrollDevice(
    testDb(),
    { code: assignment.enrollmentCode, userAgent: 'vitest' },
    ENROLLMENT_CONFIG,
  );

  return {
    userId: enrolled.user.id,
    displayName: enrolled.user.displayName,
    sessionToken: enrolled.sessionToken,
    deviceToken: enrolled.deviceToken,
    cookie: cookieHeader(enrolled.sessionToken, enrolled.deviceToken),
  };
}

export function cookieHeader(sessionToken?: string, deviceToken?: string): string {
  const parts: string[] = [];
  if (sessionToken) parts.push(`${SESSION_COOKIE}=${sessionToken}`);
  if (deviceToken) parts.push(`${DEVICE_COOKIE}=${deviceToken}`);
  return parts.join('; ');
}

/**
 * Connects a client socket, sending the given Cookie header exactly as a browser would.
 *
 * Rejects when the handshake is refused, so a test can assert that an unauthenticated connection
 * does not get in.
 */
export function connectClient(
  url: string,
  cookie: string,
  options: { timeoutMs?: number } = {},
): Promise<TestClient> {
  const socket: TestClient = connect(url, {
    path: SOCKET_PATH satisfies typeof SocketPathType,
    // WebSocket only: polling would need a second HTTP round trip per test and adds nothing.
    transports: ['websocket'],
    extraHeaders: cookie ? { Cookie: cookie } : {},
    reconnection: false,
    timeout: options.timeoutMs ?? 5_000,
  });

  return new Promise<TestClient>((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (error: Error) => {
      socket.close();
      reject(error);
    });
  });
}

/** Waits for one server-sent event, or rejects on timeout. */
export function waitForEvent<K extends keyof ServerToClientEvents>(
  socket: TestClient,
  event: K,
  options: { timeoutMs?: number; filter?: (...args: Parameters<ServerToClientEvents[K]>) => boolean } = {},
): Promise<Parameters<ServerToClientEvents[K]>[0]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler as never);
      reject(new Error(`Timed out waiting for "${String(event)}"`));
    }, options.timeoutMs ?? 5_000);

    const handler = (...args: Parameters<ServerToClientEvents[K]>) => {
      if (options.filter && !options.filter(...args)) return;
      clearTimeout(timer);
      socket.off(event, handler as never);
      resolve(args[0]);
    };

    socket.on(event, handler as never);
  });
}

/**
 * Asserts that an event does NOT arrive within a window. Used for "must not be told" cases.
 *
 * `filter` narrows what counts: a user legitimately receives presence updates about themselves,
 * so a test about somebody else's presence has to ignore those rather than fail on them.
 */
export async function expectNoEvent<K extends keyof ServerToClientEvents>(
  socket: TestClient,
  event: K,
  options: { windowMs?: number; filter?: (payload: unknown) => boolean } = {},
): Promise<void> {
  const windowMs = options.windowMs ?? 400;
  await new Promise<void>((resolve, reject) => {
    const handler = (payload: unknown) => {
      if (options.filter && !options.filter(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler as never);
      reject(new Error(`Unexpectedly received "${String(event)}"`));
    };
    const timer = setTimeout(() => {
      socket.off(event, handler as never);
      resolve();
    }, windowMs);
    socket.on(event, handler as never);
  });
}

/** Emits an event and resolves with the acknowledgement. */
export function emitWithAck<T>(
  socket: TestClient,
  event: keyof ClientToServerEvents,
  payload: unknown,
  timeoutMs = 5_000,
): Promise<Ack<T>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No acknowledgement for "${event}"`)), timeoutMs);
    (socket.emit as (event: string, payload: unknown, ack: (response: Ack<T>) => void) => void)(
      event,
      payload,
      (response) => {
        clearTimeout(timer);
        resolve(response);
      },
    );
  });
}

/**
 * Waits until a condition on the SERVER becomes true.
 *
 * A client-side `disconnect` fires before the server has processed the disconnection, so
 * asserting on server state immediately after closing a socket is a race. This polls instead.
 */
export async function waitFor(
  condition: () => boolean,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 3_000);
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 20));
  }
  throw new Error('Timed out waiting for the expected server state');
}

/** Waits until a socket has fully disconnected. */
export function waitForDisconnect(socket: TestClient, timeoutMs = 5_000): Promise<void> {
  if (socket.disconnected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket did not disconnect')), timeoutMs);
    socket.once('disconnect', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function createDirectConversation(
  userIdA: string,
  userIdB: string,
): Promise<string> {
  const conversation = await testDb().conversation.create({
    data: {
      type: 'DIRECT',
      directKey: [userIdA, userIdB].sort().join(':'),
      createdById: userIdA,
      members: { create: [{ userId: userIdA }, { userId: userIdB }] },
    },
    select: { id: true },
  });

  createdConversationIds.add(conversation.id);
  return conversation.id;
}

export async function createGroupConversation(
  ownerId: string,
  memberIds: string[],
  options: { joinedAt?: Date } = {},
): Promise<string> {
  const conversation = await testDb().conversation.create({
    data: {
      type: 'GROUP',
      name: `${TEST_NAME_PREFIX}Group`,
      createdById: ownerId,
      members: {
        create: [
          { userId: ownerId, role: 'OWNER' },
          ...memberIds.map((userId) => ({
            userId,
            ...(options.joinedAt ? { joinedAt: options.joinedAt } : {}),
          })),
        ],
      },
    },
    select: { id: true },
  });

  createdConversationIds.add(conversation.id);
  return conversation.id;
}

/** Removes everything the run created, by id. Never truncates. */
export async function cleanUp(): Promise<void> {
  if (!db) return;
  await db.conversation.deleteMany({ where: { id: { in: [...createdConversationIds] } } });
  await db.user.deleteMany({ where: { id: { in: [...createdUserIds] } } });
  createdConversationIds.clear();
  createdUserIds.clear();
}

export async function disconnectDb(): Promise<void> {
  if (db) {
    await db.$disconnect();
    db = undefined;
  }
}

/** A v4 UUID, as a browser would mint for `clientMessageId`. */
export function uuid(): string {
  return crypto.randomUUID();
}
