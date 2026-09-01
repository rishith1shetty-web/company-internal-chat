/**
 * /api/admin/devices — the registry of company computers.
 *
 * GET  lists every registered computer and who it currently resolves to.
 * POST registers a computer, creates the employee it belongs to, and returns the one-time
 *      enrollment code that links the two.
 *
 * Admin-only through `withAdmin`, which is a different preamble from the employee one and never
 * produces a `CurrentUser`: an administrator acts on the registry, never as somebody.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { toAdminDeviceWire } from '@/lib/admin/serialize';
import type { AdminAssignmentWire, AdminDeviceListWire } from '@/lib/admin/wire';
import { DisplayNameError, MAX_DISPLAY_NAME_LENGTH } from '@/lib/auth/session';
import { getDb } from '@/lib/db/prisma';
import {
  DeviceError,
  MAX_DEVICE_LABEL_LENGTH,
  assignDevice,
  listDevices,
} from '@/lib/devices/service';
import {
  apiError,
  enrollmentConfig,
  invalidRequest,
  readJsonBody,
  routeLogger as logger,
  withAdmin,
} from '@/lib/http/route-helpers';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  return withAdmin(request, async () => {
    const devices = await listDevices(getDb());
    return NextResponse.json({
      devices: devices.map(toAdminDeviceWire),
    } satisfies AdminDeviceListWire);
  });
}

/**
 * The only two things an administrator supplies: which computer, and whose it is.
 *
 * No user id, no device id, no token and no expiry — all of those are decided by the server. The
 * bounds are the column widths, checked here so an over-long value is a clear 400 rather than a
 * database error.
 */
const assignSchema = z.object({
  label: z.string().min(1).max(MAX_DEVICE_LABEL_LENGTH),
  displayName: z.string().min(1).max(MAX_DISPLAY_NAME_LENGTH),
});

export async function POST(request: Request): Promise<NextResponse> {
  return withAdmin(request, async () => {
    const parsed = assignSchema.safeParse(await readJsonBody(request));

    if (!parsed.success) {
      return invalidRequest('Give the computer a name and the employee it belongs to.');
    }

    try {
      const result = await assignDevice(getDb(), parsed.data, enrollmentConfig);

      logger.info('Computer registered and assigned', {
        deviceId: result.device.id,
        userId: result.device.assignedUser.id,
      });

      return NextResponse.json(
        {
          device: toAdminDeviceWire(result.device),
          // Returned once, here, and never recoverable afterwards.
          enrollmentCode: result.enrollmentCode,
        } satisfies AdminAssignmentWire,
        { status: 201 },
      );
    } catch (error) {
      if (error instanceof DeviceError) {
        return apiError(
          error.reason === 'LABEL_TAKEN' ? 409 : 400,
          error.reason,
          error.message,
        );
      }
      if (error instanceof DisplayNameError) {
        return apiError(400, 'INVALID_DISPLAY_NAME', error.message);
      }
      throw error;
    }
  });
}
