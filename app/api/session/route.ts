/**
 * Session endpoints — entering the application and reading the current identity.
 *
 * PHASE 4 SCOPE. These exist because the Socket.IO handshake authenticates from a cookie, and
 * something has to issue that cookie. This is the minimum: enter with a display name, and ask
 * who you are. The wider API surface in docs/01-architecture.md §7 — the user directory,
 * conversations, messages, read markers — belongs to Phase 5.
 *
 * There are no passwords here and none are being added (D-11). What a display name buys is a
 * label; the identity is the server-issued opaque token behind the cookie.
 */

import { NextResponse } from 'next/server';

import {
  DEVICE_COOKIE,
  DisplayNameError,
  SESSION_COOKIE,
  createIdentity,
  parseCookieHeader,
  resolveIdentity,
  switchUser,
} from '@/lib/auth/session';
import { loadConfig } from '@/lib/config/env';
import { getDb } from '@/lib/db/prisma';
import { createLogger, describeError } from '@/lib/logging/logger';

export const dynamic = 'force-dynamic';

const config = loadConfig();
const logger = createLogger({ level: config.logLevel, pretty: !config.isProduction });

const identityConfig = {
  sessionTtlHours: config.sessionTtlHours,
  deviceTtlDays: config.deviceTtlDays,
};

/** Cookie attributes. `Secure` only in production, where TLS terminates at the reverse proxy. */
function cookieOptions(expires: Date) {
  return {
    httpOnly: true, // JavaScript cannot read it, so an XSS bug cannot exfiltrate it.
    sameSite: 'lax' as const, // Blocks cross-site POSTs from carrying the cookie (CSRF).
    secure: config.isProduction,
    path: '/',
    expires,
  };
}

function safeError(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}

/**
 * POST /api/session — enter with a display name.
 *
 * Always creates a NEW user. Matching an existing row by name would silently merge two people
 * who happen to share one, which D-02 forbids.
 */
export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return safeError(400, 'INVALID_PAYLOAD', 'A display name is required.');
  }

  const displayName = (body as { displayName?: unknown } | null)?.displayName;

  try {
    const issued = await createIdentity(
      getDb(),
      { displayName, userAgent: request.headers.get('user-agent') },
      identityConfig,
    );

    const response = NextResponse.json({
      userId: issued.user.id,
      displayName: issued.user.displayName,
    });

    response.cookies.set(
      SESSION_COOKIE,
      issued.sessionToken,
      cookieOptions(issued.sessionExpiresAt),
    );
    response.cookies.set(DEVICE_COOKIE, issued.deviceToken, cookieOptions(issued.deviceExpiresAt));

    logger.info('Identity created', { userId: issued.user.id });
    return response;
  } catch (error) {
    if (error instanceof DisplayNameError) {
      return safeError(400, 'INVALID_DISPLAY_NAME', error.message);
    }
    logger.error('Could not create identity', describeError(error));
    return safeError(500, 'INTERNAL_ERROR', 'Could not start a session. Please try again.');
  }
}

/**
 * GET /api/session — who am I.
 *
 * Returns 204 when there is no identity, which is a normal state, not an error: a first-time
 * visitor simply has no cookie yet.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const cookies = parseCookieHeader(request.headers.get('cookie'));

  try {
    const resolved = await resolveIdentity(
      getDb(),
      { sessionToken: cookies[SESSION_COOKIE], deviceToken: cookies[DEVICE_COOKIE] },
      identityConfig,
    );

    if (!resolved) return new NextResponse(null, { status: 204 });

    const response = NextResponse.json({
      userId: resolved.current.userId,
      displayName: resolved.current.displayName,
    });

    // The device cookie re-established the session; hand the browser its new session cookie.
    if (resolved.renewedSessionToken && resolved.renewedSessionExpiresAt) {
      response.cookies.set(
        SESSION_COOKIE,
        resolved.renewedSessionToken,
        cookieOptions(resolved.renewedSessionExpiresAt),
      );
    }

    return response;
  } catch (error) {
    logger.error('Could not resolve identity', describeError(error));
    return safeError(500, 'INTERNAL_ERROR', 'Could not read the session.');
  }
}

/**
 * DELETE /api/session — "Switch User / Clear Device Identity" (F-19).
 *
 * Revokes the session and the device **server-side** before clearing the cookies. Clearing them
 * in the browser alone would leave a copied cookie working, which is the whole reason this is a
 * server call and not a client-side deletion.
 *
 * Deletes no conversation, message or membership. Those belong to the `User` and survive (D-14).
 */
export async function DELETE(request: Request): Promise<NextResponse> {
  const cookies = parseCookieHeader(request.headers.get('cookie'));

  try {
    const resolved = await resolveIdentity(
      getDb(),
      { sessionToken: cookies[SESSION_COOKIE], deviceToken: cookies[DEVICE_COOKIE] },
      identityConfig,
    );

    if (resolved) {
      await switchUser(getDb(), resolved.current);
      logger.info('Identity revoked', { userId: resolved.current.userId });
    }

    // Cookies are cleared whether or not an identity resolved: the browser end state is the same.
    const response = new NextResponse(null, { status: 204 });
    response.cookies.delete(SESSION_COOKIE);
    response.cookies.delete(DEVICE_COOKIE);
    return response;
  } catch (error) {
    logger.error('Could not revoke identity', describeError(error));
    return safeError(500, 'INTERNAL_ERROR', 'Could not switch user. Please try again.');
  }
}
