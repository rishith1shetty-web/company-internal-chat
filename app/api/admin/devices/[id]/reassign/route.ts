/**
 * POST /api/admin/devices/:id/reassign — hand a computer to a different employee.
 *
 * The operation the whole design exists for. PC-001 belonged to one person; it now belongs to
 * another. What must be true afterwards, and is asserted by tests rather than hoped for:
 *
 *   - the new employee is a NEW `User` with a NEW id;
 *   - the previous employee's row is not renamed, deactivated or deleted;
 *   - their conversations, memberships and messages are exactly as they were (D-14);
 *   - every session on that computer is gone, so their cookie stops resolving immediately;
 *   - the computer stays enrolled — nobody has to walk to it with a code.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { toAdminDeviceWire } from '@/lib/admin/serialize';
import type { AdminReassignmentWire } from '@/lib/admin/wire';
import { DisplayNameError, MAX_DISPLAY_NAME_LENGTH } from '@/lib/auth/session';
import { getDb } from '@/lib/db/prisma';
import { DeviceError, reassignDevice } from '@/lib/devices/service';
import {
  apiError,
  enrollmentConfig,
  invalidRequest,
  readJsonBody,
  routeLogger as logger,
  withAdmin,
} from '@/lib/http/route-helpers';

export const dynamic = 'force-dynamic';

const reassignSchema = z.object({
  displayName: z.string().min(1).max(MAX_DISPLAY_NAME_LENGTH),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return withAdmin(request, async () => {
    const { id } = await context.params;

    // Checked before it reaches a query: a malformed id is a bad request, not a lookup.
    if (!z.uuid({ version: 'v4' }).safeParse(id).success) {
      return invalidRequest('That computer is not registered.');
    }

    const parsed = reassignSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return invalidRequest('Enter the name of the employee taking over this computer.');
    }

    try {
      const result = await reassignDevice(
        getDb(),
        { deviceId: id, displayName: parsed.data.displayName },
        enrollmentConfig,
      );

      logger.info('Computer reassigned', {
        deviceId: result.device.id,
        previousUserId: result.previousUser.id,
        userId: result.device.assignedUser.id,
        revokedSessions: result.revokedSessions,
      });

      return NextResponse.json({
        device: toAdminDeviceWire(result.device),
        previousUser: result.previousUser,
        revokedSessions: result.revokedSessions,
      } satisfies AdminReassignmentWire);
    } catch (error) {
      if (error instanceof DeviceError) {
        return apiError(
          error.reason === 'DEVICE_NOT_FOUND' ? 404 : 409,
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
