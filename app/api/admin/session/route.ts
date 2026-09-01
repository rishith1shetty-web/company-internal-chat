/**
 * /api/admin/session — the administrator's sign-in.
 *
 * The token is presented once here and exchanged for a short-lived signed cookie, so it is not
 * replayed on every subsequent admin request and does not end up in a proxy log or a browser
 * history. What this mechanism is and is not is set out in lib/auth/admin.ts and
 * docs/12-admin-device-identity.md; the short version is that it guards the device registry only
 * and confers no ability to read anybody's messages.
 */

import { NextResponse } from 'next/server';

import type { AdminSessionWire } from '@/lib/admin/wire';
import { ADMIN_COOKIE } from '@/lib/auth/admin';
import {
  adminConfigured,
  adminCookieOptions,
  adminSessionState,
  adminUnauthorised,
  adminUnavailable,
  invalidRequest,
  readJsonBody,
  routeLogger as logger,
  startAdminSession,
} from '@/lib/http/route-helpers';

export const dynamic = 'force-dynamic';

/**
 * GET — does this browser already hold a valid admin cookie?
 *
 * 204 for "no", not 401: this is a question, and "you are not signed in" is a valid answer to it.
 * Answering 401 would make every first visit to the admin page log a failed request in the
 * browser console, which trains people to ignore console errors.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const state = adminSessionState(request);

  if (state === 'unconfigured') return adminUnavailable();
  if (state === 'signed-out') return new NextResponse(null, { status: 204 });

  return NextResponse.json({ administrator: true } satisfies AdminSessionWire);
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!adminConfigured) return adminUnavailable();

  const body = await readJsonBody(request);
  const token = (body as { token?: unknown } | undefined)?.token;

  if (typeof token !== 'string' || token.length === 0) {
    return invalidRequest('Enter the administrator token.');
  }

  const issued = startAdminSession(token);

  if (!issued) {
    // Logged without the submitted value: a near-miss token in a log file is still a secret.
    logger.warn('Rejected administrator sign-in');
    return adminUnauthorised();
  }

  const response = NextResponse.json({ administrator: true } satisfies AdminSessionWire);
  response.cookies.set(ADMIN_COOKIE, issued.value, adminCookieOptions(issued.expiresAt));

  logger.info('Administrator signed in');
  return response;
}

/**
 * DELETE — sign out.
 *
 * Requires no admin cookie of its own: clearing a cookie you are holding is not a privileged
 * action, and refusing an already-expired session's sign-out would only strand the browser.
 */
export async function DELETE(): Promise<NextResponse> {
  const response = new NextResponse(null, { status: 204 });
  response.cookies.delete(ADMIN_COOKIE);
  return response;
}
