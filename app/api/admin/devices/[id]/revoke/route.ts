/**
 * POST /api/admin/devices/:id/revoke — retire a computer.
 *
 * The counterpart of there being no employee-facing sign-out. A machine that is lost, stolen or
 * decommissioned still has to be cuttable off, and this is where that happens: the device cookie
 * and any outstanding setup code stop working, and every session on it is deleted.
 *
 * Retires the computer, not the person. The assigned employee's `User`, conversations and
 * messages are untouched (D-14) — they simply have no computer resolving to them until an
 * administrator assigns one.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { toAdminDeviceWire } from '@/lib/admin/serialize';
import type { AdminDeviceWire } from '@/lib/admin/wire';
import { getDb } from '@/lib/db/prisma';
import { DeviceError, revokeDevice } from '@/lib/devices/service';
import {
  apiError,
  invalidRequest,
  routeLogger as logger,
  withAdmin,
} from '@/lib/http/route-helpers';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return withAdmin(request, async () => {
    const { id } = await context.params;

    if (!z.uuid({ version: 'v4' }).safeParse(id).success) {
      return invalidRequest('That computer is not registered.');
    }

    try {
      const device = await revokeDevice(getDb(), id);
      logger.info('Computer retired', { deviceId: device.id });

      return NextResponse.json(toAdminDeviceWire(device) satisfies AdminDeviceWire);
    } catch (error) {
      if (error instanceof DeviceError) {
        return apiError(
          error.reason === 'DEVICE_NOT_FOUND' ? 404 : 409,
          error.reason,
          error.message,
        );
      }
      throw error;
    }
  });
}
