/**
 * POST /api/admin/devices/:id/enrollment — issue a fresh setup code for a registered computer.
 *
 * NOT the staff-change path. Reassigning a computer to a new employee needs nothing from here —
 * the machine stays enrolled and the next request from it is already the new person. This exists
 * for a browser identity that was actually lost: a reimaged PC, cleared site data, a replaced
 * profile, a machine whose device cookie must be invalidated because a copy of it may exist.
 *
 * Issuing a new code therefore invalidates the old device cookie as part of the same operation.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { toAdminDeviceWire } from '@/lib/admin/serialize';
import type { AdminAssignmentWire } from '@/lib/admin/wire';
import { getDb } from '@/lib/db/prisma';
import { DeviceError, issueEnrollmentCode } from '@/lib/devices/service';
import {
  apiError,
  enrollmentConfig,
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
      const result = await issueEnrollmentCode(getDb(), id, enrollmentConfig);

      logger.info('Setup code re-issued', { deviceId: result.device.id });

      return NextResponse.json({
        device: toAdminDeviceWire(result.device),
        enrollmentCode: result.enrollmentCode,
      } satisfies AdminAssignmentWire);
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
