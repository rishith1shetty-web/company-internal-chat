/**
 * POST /api/enroll — link this browser to the company computer it is running on.
 *
 * A ONE-TIME SETUP OPERATION, PERFORMED BY IT, NOT A LOGIN. It is the only endpoint outside the
 * admin surface that can bring an identity into existence, and it is deliberately incapable of
 * being used as an account switcher:
 *
 *   - it accepts no name, no user id and no choice of any kind — only a code;
 *   - the code names one computer, whose employee an administrator has already decided;
 *   - the code is stored hashed, expires, and is cleared the instant it is redeemed, so it works
 *     exactly once and a second attempt is refused like a made-up one;
 *   - nothing in the employee interface links here or mentions it.
 *
 * It is protected by the code rather than by the admin cookie on purpose: the alternative is
 * typing the administrator's token into an employee's browser, which is a far worse exposure than
 * a single-use value that grants one device cookie and nothing else.
 *
 * NOT HARDENED YET: there is no rate limiting in front of this endpoint. A ~98-bit code is not
 * guessable, but the throttling belongs here in Phase 9 (docs/12-admin-device-identity.md).
 */

import { NextResponse } from 'next/server';

import type { EnrollmentWire } from '@/lib/admin/wire';
import { DEVICE_COOKIE, SESSION_COOKIE } from '@/lib/auth/session';
import { getDb } from '@/lib/db/prisma';
import { DeviceError, enrollDevice } from '@/lib/devices/service';
import {
  apiError,
  cookieOptions,
  enrollmentConfig,
  readJsonBody,
  routeLogger as logger,
} from '@/lib/http/route-helpers';
import { describeError } from '@/lib/logging/logger';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const body = await readJsonBody(request);
  const code = (body as { code?: unknown } | undefined)?.code;

  try {
    const enrolled = await enrollDevice(
      getDb(),
      { code, userAgent: request.headers.get('user-agent') },
      enrollmentConfig,
    );

    const response = NextResponse.json({
      deviceLabel: enrolled.label,
      displayName: enrolled.user.displayName,
    } satisfies EnrollmentWire);

    response.cookies.set(DEVICE_COOKIE, enrolled.deviceToken, cookieOptions(enrolled.deviceExpiresAt));
    response.cookies.set(
      SESSION_COOKIE,
      enrolled.sessionToken,
      cookieOptions(enrolled.sessionExpiresAt),
    );

    // The code is never logged, redeemed or not.
    logger.info('Computer enrolled', {
      deviceId: enrolled.deviceId,
      userId: enrolled.user.id,
    });

    return response;
  } catch (error) {
    if (error instanceof DeviceError) {
      return apiError(400, error.reason, error.message);
    }

    logger.error('Could not enroll this computer', describeError(error));
    return apiError(500, 'INTERNAL_ERROR', 'Could not complete setup. Please try again.');
  }
}
