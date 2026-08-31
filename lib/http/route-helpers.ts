/**
 * Shared plumbing for the Next.js route handlers.
 *
 * Every endpoint in this application does the same four things before it does anything of its
 * own: resolve the identity from the cookie, refuse the request when there is none, answer
 * failures in one JSON shape, and hand back a renewed session cookie when the device cookie
 * re-established the session. Written once here so that no route can quietly skip a step —
 * a second, subtly different copy of an authorization preamble is how an unauthenticated path
 * gets introduced (CLAUDE.md §9).
 *
 * What this module deliberately does NOT do: accept a user id, a display name or any other
 * identity claim from the request. `authenticate()` reads cookies and nothing else.
 */

import { NextResponse } from 'next/server';

import {
  DEVICE_COOKIE,
  SESSION_COOKIE,
  parseCookieHeader,
  resolveIdentity,
  type CurrentUser,
  type IdentityConfig,
  type ResolvedIdentity,
} from '@/lib/auth/session';
import { loadConfig } from '@/lib/config/env';
import { getDb } from '@/lib/db/prisma';
import { createLogger, describeError, type Logger } from '@/lib/logging/logger';

const config = loadConfig();

/** One logger per route module import; the level comes from configuration, never from a request. */
export const routeLogger: Logger = createLogger({
  level: config.logLevel,
  pretty: !config.isProduction,
});

export const identityConfig: IdentityConfig = {
  sessionTtlHours: config.sessionTtlHours,
  deviceTtlDays: config.deviceTtlDays,
};

/**
 * Cookie attributes for both identity cookies.
 *
 * `HttpOnly` so script cannot read them, `SameSite=Lax` so a cross-site POST cannot carry them,
 * and `Secure` in production, where TLS terminates at the reverse proxy (docs/03-network.md).
 */
export function cookieOptions(expires: Date) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.isProduction,
    path: '/',
    expires,
  };
}

/** The error body every endpoint returns. No stack trace, no path, no SQL, no configuration. */
export function apiError(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}

export const unauthenticated = () =>
  apiError(401, 'UNAUTHENTICATED', 'Enter a display name to use the application.');

/**
 * Deliberately identical for "not a member" and "no such conversation".
 *
 * Distinguishing them would confirm to an outsider that a conversation id exists, which is a
 * disclosure in itself (docs/04-security.md).
 */
export const forbidden = () =>
  apiError(403, 'FORBIDDEN', 'You do not have access to this conversation.');

export const invalidRequest = (message = 'That request was not understood.') =>
  apiError(400, 'INVALID_REQUEST', message);

export const internalError = () =>
  apiError(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.');

/** Resolves the caller's identity from the request cookies, or null when there is none. */
export async function authenticate(request: Request): Promise<ResolvedIdentity | null> {
  const cookies = parseCookieHeader(request.headers.get('cookie'));

  return resolveIdentity(
    getDb(),
    { sessionToken: cookies[SESSION_COOKIE], deviceToken: cookies[DEVICE_COOKIE] },
    identityConfig,
  );
}

/**
 * Attaches a renewed session cookie when the device cookie re-established the session (D-13).
 *
 * Without this a browser whose 24-hour session had lapsed would re-issue a `Session` row on
 * every single request, because it would never be handed the new cookie.
 */
export function withRenewedSession(
  response: NextResponse,
  resolved: ResolvedIdentity,
): NextResponse {
  if (resolved.renewedSessionToken && resolved.renewedSessionExpiresAt) {
    response.cookies.set(
      SESSION_COOKIE,
      resolved.renewedSessionToken,
      cookieOptions(resolved.renewedSessionExpiresAt),
    );
  }
  return response;
}

/**
 * The standard shape of an authenticated route: resolve identity, then run the handler.
 *
 * The handler receives the server-derived `CurrentUser` and cannot reach the request's claimed
 * identity, because there is none to reach.
 */
export async function withIdentity(
  request: Request,
  handler: (current: CurrentUser) => Promise<NextResponse>,
): Promise<NextResponse> {
  let resolved: ResolvedIdentity | null;

  try {
    resolved = await authenticate(request);
  } catch (error) {
    routeLogger.error('Could not resolve identity', describeError(error));
    return internalError();
  }

  if (!resolved) return unauthenticated();

  try {
    const response = await handler(resolved.current);
    return withRenewedSession(response, resolved);
  } catch (error) {
    // The detail goes to the server log; the browser gets a generic message (CLAUDE.md §13).
    routeLogger.error('Unhandled route failure', {
      userId: resolved.current.userId,
      ...describeError(error),
    });
    return internalError();
  }
}

/** Reads a JSON body, returning `undefined` rather than throwing on malformed input. */
export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
