/**
 * GET /api/session — who am I.
 *
 * The whole employee-facing identity surface, and read-only by design.
 *
 * There is deliberately no POST and no DELETE here any more. An employee cannot create an
 * identity, cannot choose a name, cannot sign out and cannot clear the identity of the computer
 * they are sitting at (docs/12-admin-device-identity.md). Those were the "enter a display name"
 * and "Switch user" endpoints, and their absence is the change: identity is assigned by an
 * administrator to a company computer, and this endpoint only reports the answer.
 *
 * The answer comes from the cookie and nothing else. A query string, a header or a body naming
 * somebody is ignored, because none of them is read.
 */

import { NextResponse } from 'next/server';

import type { SessionIdentityWire } from '@/lib/chat/wire';
import {
  DEVICE_COOKIE,
  SESSION_COOKIE,
  parseCookieHeader,
  resolveIdentity,
} from '@/lib/auth/session';
import { getDb } from '@/lib/db/prisma';
import {
  apiError as safeError,
  cookieOptions,
  identityConfig,
  routeLogger as logger,
  storageConfig,
} from '@/lib/http/route-helpers';
import { describeError } from '@/lib/logging/logger';

export const dynamic = 'force-dynamic';

/**
 * Returns 204 when this computer has no assigned identity.
 *
 * A normal state, not an error: a machine that has not been set up by IT yet, or one whose
 * assignment has been retired. The interface shows an explanation and a "contact IT" message —
 * it has nothing to offer the employee to fix it, and says so rather than pretending otherwise.
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
      // Shown read-only in the profile area, so an employee can tell IT which machine they are at.
      deviceLabel: resolved.current.deviceLabel,
      // So the composer can refuse an oversized file before sending it. The server enforces the
      // same limit while the bytes arrive, whatever the browser was told.
      maxFileSize: storageConfig.maxFileSize,
    } satisfies SessionIdentityWire);

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
