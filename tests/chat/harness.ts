/**
 * Test harness for the Phase 5 one-to-one chat layer.
 *
 * Everything here runs against the real `company_chat_db` through the real services and the real
 * route handlers. Nothing is mocked: a test that stubs the membership check it is meant to be
 * proving proves nothing.
 *
 * SAFETY, exactly as in Phases 3 and 4:
 *
 *   - Every row created here is registered and deleted afterwards **by id**.
 *   - Nothing is truncated, no table is emptied, no schema is touched, and no reset command is
 *     used anywhere.
 *   - Rows created by anything other than the test run are never read, modified or deleted.
 *   - Display names carry a recognisable prefix so anything left by an interrupted run can be
 *     identified by a human rather than guessed at by a script.
 *
 * The suite skips entirely when DATABASE_URL is absent, so `npm test` still works on a machine
 * with no database configured.
 */

import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { NextResponse } from 'next/server';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';

import { DEVICE_COOKIE, SESSION_COOKIE, type IdentityConfig } from '@/lib/auth/session';
import {
  assignDevice,
  enrollDevice,
  type EnrollmentConfig,
} from '@/lib/devices/service';
import { SOCKET_PATH } from '@/lib/chat/wire';
import type {
  Ack,
  ClientToServerEvents,
  ServerToClientEvents,
  SessionWire,
} from '@/lib/realtime/events';
import { directKeyFor } from '@/lib/conversations/service';
import { getDb, disconnectDb as closeDb } from '@/lib/db/prisma';
import type { Logger } from '@/lib/logging/logger';
import { createRealtimeGateway, type RealtimeGateway } from '@/lib/realtime/gateway';
import type { PrismaClient } from '@/prisma/generated/client';

export const databaseConfigured = Boolean(process.env['DATABASE_URL']?.trim());

/** Prefix for every display name the Phase 5 tests create. */
export const TEST_NAME_PREFIX = 'zz-test-p5-';

/** The real presence grace period is 10s, which no test should wait out. */
export const TEST_PRESENCE_GRACE_MS = 150;

export const IDENTITY_CONFIG: IdentityConfig = { sessionTtlHours: 24, deviceTtlDays: 90 };

export const ENROLLMENT_CONFIG: EnrollmentConfig = {
  ...IDENTITY_CONFIG,
  enrollmentTtlHours: 24,
};

export type TestClient = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

const createdUserIds = new Set<string>();
const createdConversationIds = new Set<string>();
/*
 * Devices are tracked separately from users, not derived from them.
 *
 * After a reassignment a device belongs to the NEW employee, so deleting the original user would
 * leave the device behind — which is exactly the row a reassignment test creates. Cleanup deletes
 * devices by their own id for that reason.
 */
const createdDeviceIds = new Set<string>();

/**
 * The application's own Prisma client.
 *
 * Deliberately the same one the route handlers use, so a test and the code under test see one
 * connection pool and one transactional view of the database.
 */
export function db(): PrismaClient {
  return getDb();
}

export function silentLogger(): Logger {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}

export interface TestIdentity {
  userId: string;
  displayName: string;
  deviceId: string;
  deviceLabel: string;
  sessionToken: string;
  deviceToken: string;
  /** The Cookie header a browser would send. */
  cookie: string;
}

/** Labels must be unique across devices, so every test computer gets its own suffix. */
let labelCounter = 0;

export function testDeviceLabel(hint = 'PC'): string {
  labelCounter += 1;
  return `${TEST_NAME_PREFIX}${hint}-${labelCounter}-${crypto.randomUUID().slice(0, 8)}`;
}

/** Registers a computer to a new employee, exactly as the admin console would. */
export async function assignTestDevice(
  displayName = 'Person',
): Promise<{ deviceId: string; userId: string; label: string; enrollmentCode: string }> {
  const label = testDeviceLabel();
  const assignment = await assignDevice(
    db(),
    { label, displayName: `${TEST_NAME_PREFIX}${displayName}` },
    ENROLLMENT_CONFIG,
  );

  createdDeviceIds.add(assignment.device.id);
  createdUserIds.add(assignment.device.assignedUser.id);

  return {
    deviceId: assignment.device.id,
    userId: assignment.device.assignedUser.id,
    label: assignment.device.label,
    enrollmentCode: assignment.enrollmentCode,
  };
}

/**
 * A fully set-up company computer: assigned by an administrator, then enrolled on the machine.
 *
 * This is the only way a test can obtain working cookies, which is the point — it is the only way
 * the application can produce them either. There is no path from a display name to an identity.
 */
export async function createTestIdentity(displayName = 'Person'): Promise<TestIdentity> {
  const assigned = await assignTestDevice(displayName);

  const enrolled = await enrollDevice(
    db(),
    { code: assigned.enrollmentCode, userAgent: 'vitest' },
    ENROLLMENT_CONFIG,
  );

  return {
    userId: enrolled.user.id,
    displayName: enrolled.user.displayName,
    deviceId: enrolled.deviceId,
    deviceLabel: enrolled.label,
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

/** Registers a conversation the code under test created, so cleanup can remove it. */
export function trackConversation(conversationId: string): string {
  createdConversationIds.add(conversationId);
  return conversationId;
}

export function trackUser(userId: string): string {
  createdUserIds.add(userId);
  return userId;
}

export function trackDevice(deviceId: string): string {
  createdDeviceIds.add(deviceId);
  return deviceId;
}

/** Creates a direct conversation directly, for tests that need one to already exist. */
export async function seedDirectConversation(
  userIdA: string,
  userIdB: string,
): Promise<string> {
  const conversation = await db().conversation.create({
    data: {
      type: 'DIRECT',
      directKey: directKeyFor(userIdA, userIdB),
      createdById: userIdA,
      members: { create: [{ userId: userIdA }, { userId: userIdB }] },
    },
    select: { id: true },
  });

  return trackConversation(conversation.id);
}

/** Creates a group conversation. Used only to prove the D-03 join window is applied. */
export async function seedGroupConversation(
  ownerId: string,
  members: { userId: string; joinedAt?: Date }[],
): Promise<string> {
  const conversation = await db().conversation.create({
    data: {
      type: 'GROUP',
      name: `${TEST_NAME_PREFIX}Group`,
      createdById: ownerId,
      members: {
        create: [
          { userId: ownerId, role: 'OWNER' },
          ...members.map((member) => ({
            userId: member.userId,
            ...(member.joinedAt ? { joinedAt: member.joinedAt } : {}),
          })),
        ],
      },
    },
    select: { id: true },
  });

  return trackConversation(conversation.id);
}

/* ------------------------------------------------------------------------------------------- */
/* Route handlers                                                                                */
/* ------------------------------------------------------------------------------------------- */

export interface RouteCall {
  url: string;
  method?: string;
  cookie?: string;
  body?: unknown;
}

/** Builds the `Request` a browser would send, cookies included. */
export function buildRequest(call: RouteCall): Request {
  const headers = new Headers();
  if (call.cookie) headers.set('cookie', call.cookie);
  if (call.body !== undefined) headers.set('content-type', 'application/json');

  return new Request(`http://127.0.0.1${call.url}`, {
    method: call.method ?? 'GET',
    headers,
    ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
  });
}

export interface RouteResult<T> {
  status: number;
  body: T;
}

/** Calls a route handler and reads its JSON body. */
export async function readResponse<T>(response: NextResponse): Promise<RouteResult<T>> {
  const text = await response.text();
  return {
    status: response.status,
    body: (text.length > 0 ? JSON.parse(text) : undefined) as T,
  };
}

/** Params are a promise in the App Router, so tests must hand one over the same way. */
export function params<T extends Record<string, string>>(value: T): { params: Promise<T> } {
  return { params: Promise.resolve(value) };
}

/* ------------------------------------------------------------------------------------------- */
/* Socket server                                                                                 */
/* ------------------------------------------------------------------------------------------- */

export interface RunningServer {
  httpServer: HttpServer;
  gateway: RealtimeGateway;
  url: string;
  close(): Promise<void>;
}

/** An HTTP server with the real gateway attached. Next.js is not involved. */
export async function startTestServer(
  options: { presenceGraceMs?: number } = {},
): Promise<RunningServer> {
  const httpServer = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });

  const gateway = createRealtimeGateway(httpServer, {
    db: db(),
    logger: silentLogger(),
    identity: IDENTITY_CONFIG,
    presenceGraceMs: options.presenceGraceMs ?? TEST_PRESENCE_GRACE_MS,
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

/**
 * `session:ready` arrives on its own schedule, shortly after the handshake.
 *
 * A test that connects a socket and only then starts listening has already lost the race — the
 * event can be delivered while the test is still awaiting something else. So the listener is
 * attached synchronously, at construction, and `waitForReady` reads the captured result.
 */
const readySignals = new WeakMap<TestClient, Promise<SessionWire>>();

/** Connects a client socket with the given Cookie header, exactly as a browser would. */
export function connectClient(url: string, cookie: string): Promise<TestClient> {
  const socket: TestClient = connect(url, {
    path: SOCKET_PATH,
    transports: ['websocket'],
    extraHeaders: cookie ? { Cookie: cookie } : {},
    reconnection: false,
    timeout: 5_000,
  });

  // Attached before the connection can possibly complete, so nothing is missed.
  readySignals.set(
    socket,
    new Promise<SessionWire>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for session:ready')), 5_000);
      socket.once('session:ready', (payload) => {
        clearTimeout(timer);
        resolve(payload);
      });
    }),
  );

  return new Promise<TestClient>((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (error: Error) => {
      socket.close();
      reject(error);
    });
  });
}

/** Resolves once the server has authenticated the socket and joined it to its rooms. */
export function waitForReady(socket: TestClient): Promise<SessionWire> {
  const signal = readySignals.get(socket);
  if (!signal) throw new Error('Socket was not created by connectClient');
  return signal;
}

/** Waits for one server-sent event, or rejects on timeout. */
export function waitForEvent<K extends keyof ServerToClientEvents>(
  socket: TestClient,
  event: K,
  options: { timeoutMs?: number } = {},
): Promise<Parameters<ServerToClientEvents[K]>[0]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler as never);
      reject(new Error(`Timed out waiting for "${String(event)}"`));
    }, options.timeoutMs ?? 5_000);

    const handler = (...args: Parameters<ServerToClientEvents[K]>) => {
      clearTimeout(timer);
      socket.off(event, handler as never);
      resolve(args[0]);
    };

    socket.on(event, handler as never);
  });
}

/** Asserts that an event does NOT arrive within a window. Used for "must not be told" cases. */
export async function expectNoEvent<K extends keyof ServerToClientEvents>(
  socket: TestClient,
  event: K,
  windowMs = 400,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const handler = () => {
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
    const timer = setTimeout(
      () => reject(new Error(`No acknowledgement for "${event}"`)),
      timeoutMs,
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

/** Polls until a condition on the server becomes true. */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 3_000);
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 20));
  }
  throw new Error('Timed out waiting for the expected state');
}

/* ------------------------------------------------------------------------------------------- */
/* Cleanup                                                                                       */
/* ------------------------------------------------------------------------------------------- */

/**
 * Removes everything the run created, by id.
 *
 * Conversations first, so their members and messages go with them through the intended cascades;
 * users follow, taking their sessions and devices. `deleteMany` deliberately: a test that already
 * removed a row must not make cleanup fail.
 */
export async function cleanUp(): Promise<void> {
  await db().conversation.deleteMany({ where: { id: { in: [...createdConversationIds] } } });
  // Devices before users: a reassigned device no longer belongs to the user that created it, so
  // the cascade from `User` would not reach it.
  await db().device.deleteMany({ where: { id: { in: [...createdDeviceIds] } } });
  await db().user.deleteMany({ where: { id: { in: [...createdUserIds] } } });
  createdConversationIds.clear();
  createdDeviceIds.clear();
  createdUserIds.clear();
}

export async function disconnect(): Promise<void> {
  await closeDb();
}

/** A v4 UUID, as a browser would mint for `clientMessageId`. */
export function uuid(): string {
  return crypto.randomUUID();
}
