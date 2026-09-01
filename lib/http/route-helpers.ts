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

import { ADMIN_COOKIE, issueAdminCookie, verifyAdminCookie, verifyAdminToken } from '@/lib/auth/admin';
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
import type { EnrollmentConfig } from '@/lib/devices/service';
import type { StorageConfig } from '@/lib/files/storage';
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

/** Identity lifetimes plus the enrollment-code lifetime, for the device registry. */
export const enrollmentConfig: EnrollmentConfig = {
  ...identityConfig,
  enrollmentTtlHours: config.enrollmentTtlHours,
};

/** Whether an administrator token is configured at all. Absent means the admin surface is shut. */
export const adminConfigured = config.adminToken !== undefined;

/**
 * Where uploaded files live and how large one may be (Phase 7).
 *
 * Read once here, like every other setting, so no route reaches into `process.env` and no two
 * routes can end up disagreeing about the limit they enforce.
 */
export const storageConfig: StorageConfig = {
  uploadDir: config.uploadDir,
  maxFileSize: config.maxFileSize,
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

/**
 * Attributes for the admin cookie.
 *
 * `SameSite=Strict` rather than `Lax`: unlike the employee cookies, nothing ever needs to arrive
 * at the admin surface by following a link from somewhere else, so the stricter setting costs
 * nothing and removes a whole class of cross-site request.
 */
export function adminCookieOptions(expires: Date) {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
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
  apiError(401, 'UNAUTHENTICATED', 'This computer is not signed in. Contact IT to have it set up.');

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

/**
 * No ADMIN_TOKEN is configured, so there is no administrator to be.
 *
 * 503 rather than 401: the request is not unauthorised, the feature is switched off. Answering
 * 401 would invite somebody to keep trying a token that could never work.
 */
export const adminUnavailable = () =>
  apiError(
    503,
    'ADMIN_NOT_CONFIGURED',
    'Administration is not configured on this server. Set ADMIN_TOKEN and restart.',
  );

export const adminUnauthorised = () =>
  apiError(401, 'ADMIN_UNAUTHORISED', 'Sign in with the administrator token to continue.');

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

/**
 * Exchanges a submitted administrator token for a signed, short-lived cookie.
 *
 * Returns null both when nothing is configured and when the token is wrong, and the caller
 * distinguishes the two — the configured token itself never leaves this module.
 */
export function startAdminSession(submitted: unknown): { value: string; expiresAt: Date } | null {
  if (config.adminToken === undefined) return null;
  if (!verifyAdminToken(config.adminToken, submitted)) return null;
  return issueAdminCookie(config.adminToken);
}

/**
 * Is this request carrying a valid administrator cookie?
 *
 * Separate from `withAdmin` because the "am I signed in?" probe is not a refused request — it is
 * a question with a legitimate "no" answer, exactly like `GET /api/session` for an employee. A
 * 401 there would be logged by the browser as a failed request on every visit to the admin page.
 */
export function adminSessionState(request: Request): 'unconfigured' | 'signed-in' | 'signed-out' {
  if (config.adminToken === undefined) return 'unconfigured';

  const cookies = parseCookieHeader(request.headers.get('cookie'));
  return verifyAdminCookie(config.adminToken, cookies[ADMIN_COOKIE]) ? 'signed-in' : 'signed-out';
}

/**
 * The standard shape of an ADMIN route.
 *
 * Deliberately a separate preamble from `withIdentity`, and deliberately not composed with it:
 * an administrator is not an employee identity, holds no `User.id`, and must not be able to act
 * as one. There is no path through this function that produces a `CurrentUser`.
 */
export async function withAdmin(
  request: Request,
  handler: () => Promise<NextResponse>,
): Promise<NextResponse> {
  if (config.adminToken === undefined) return adminUnavailable();

  const cookies = parseCookieHeader(request.headers.get('cookie'));
  if (!verifyAdminCookie(config.adminToken, cookies[ADMIN_COOKIE])) {
    return adminUnauthorised();
  }

  try {
    return await handler();
  } catch (error) {
    routeLogger.error('Unhandled admin route failure', describeError(error));
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
