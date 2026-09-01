/**
 * POST /api/admin/devices/:id/reactivate — bring a retired computer back into service.
 *
 * The counterpart of `/revoke`, and deliberately a separate action from `/enrollment`:
 *
 *   Reassign     same computer, in service, a different employee
 *   Retire       computer out of service; its cookie destroyed, its sessions deleted
 *   Reactivate   that same computer back in service, same employee, new setup code
 *
 * Folding this into "new setup code" would mean an administrator tidying up codes could silently
 * un-retire a machine they had deliberately cut off. Two intents, two endpoints, two log lines.
 *
 * Acts on the EXISTING `Device` row: same id, same label, same assigned employee. It creates no
 * device, creates no user, and deletes nothing.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { toAdminDeviceWire } from '@/lib/admin/serialize';
import type { AdminAssignmentWire } from '@/lib/admin/wire';
import { getDb } from '@/lib/db/prisma';
import { DeviceError, reactivateDevice } from '@/lib/devices/service';
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
      const result = await reactivateDevice(getDb(), id, enrollmentConfig);

      logger.info('Computer returned to service', {
        deviceId: result.device.id,
        userId: result.device.assignedUser.id,
      });

      return NextResponse.json({
        device: toAdminDeviceWire(result.device),
        // Returned once. The computer must be set up again — retirement destroyed its cookie.
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
