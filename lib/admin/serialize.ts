/**
 * Database rows → admin API shapes.
 *
 * One place that decides what an administrator is told about a computer, so a field cannot be
 * added to `Device` and appear in a response by accident. Note what is absent and stays absent:
 * `tokenHash` and `enrollmentTokenHash` are not mapped here at all, so no future edit to a route
 * can serialise them by spreading a row.
 *
 * Timestamps are ISO 8601 UTC on the wire and formatted for the reader in the browser (A-05).
 */

import type { AdminDeviceWire } from '@/lib/admin/wire';
import type { DeviceSummary } from '@/lib/devices/service';

export function toAdminDeviceWire(device: DeviceSummary): AdminDeviceWire {
  return {
    id: device.id,
    label: device.label,
    status: device.status,
    assignedUser: device.assignedUser,
    assignedAt: device.assignedAt.toISOString(),
    enrolledAt: device.enrolledAt?.toISOString() ?? null,
    enrollmentExpiresAt: device.enrollmentExpiresAt?.toISOString() ?? null,
    lastSeenAt: device.lastSeenAt.toISOString(),
    revokedAt: device.revokedAt?.toISOString() ?? null,
  };
}
