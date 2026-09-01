/**
 * POST /api/admin/devices/:id/rename — change the administrator's name for a computer.
 *
 * The smallest operation in the registry: it writes `Device.label` and nothing else. A label is
 * how a human recognises a machine in the admin list, not something the application resolves an
 * identity by, so a rename cannot move an assignment, a session, a conversation or a message.
 *
 * Allowed whether the computer is in service or out of it — a machine in a cupboard is exactly the
 * one whose placeholder name someone wants to correct.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { toAdminDeviceWire } from '@/lib/admin/serialize';
import type { AdminDeviceWire } from '@/lib/admin/wire';
import { getDb } from '@/lib/db/prisma';
import { DeviceError, MAX_DEVICE_LABEL_LENGTH, renameDevice } from '@/lib/devices/service';
import {
  apiError,
  invalidRequest,
  readJsonBody,
  routeLogger as logger,
  withAdmin,
} from '@/lib/http/route-helpers';

export const dynamic = 'force-dynamic';

const renameSchema = z.object({
  label: z.string().min(1).max(MAX_DEVICE_LABEL_LENGTH),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return withAdmin(request, async () => {
    const { id } = await context.params;

    if (!z.uuid({ version: 'v4' }).safeParse(id).success) {
      return invalidRequest('That computer is not registered.');
    }

    const parsed = renameSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return invalidRequest('Give this computer a name.');
    }

    try {
      const device = await renameDevice(getDb(), { deviceId: id, label: parsed.data.label });

      logger.info('Computer renamed', { deviceId: device.id });

      return NextResponse.json(toAdminDeviceWire(device) satisfies AdminDeviceWire);
    } catch (error) {
      if (error instanceof DeviceError) {
        switch (error.reason) {
          case 'DEVICE_NOT_FOUND':
            return apiError(404, error.reason, error.message);
          case 'LABEL_TAKEN':
            return apiError(409, error.reason, error.message);
          default:
            // An invalid label is a bad request, not a conflict.
            return apiError(400, error.reason, error.message);
        }
      }
      throw error;
    }
  });
}
