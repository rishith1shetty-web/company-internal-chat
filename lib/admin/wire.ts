/**
 * The admin API's over-the-wire shapes.
 *
 * Kept separate from `lib/chat/wire.ts` because these are a different audience with a different
 * trust level, and mixing them would make it easy to leak an admin-only field into an employee
 * response by reaching for the nearest type.
 *
 * Import-free by design, so both the server routes and the admin page can depend on it without
 * dragging anything server-side into the browser bundle.
 *
 * No token, hash or secret appears in any of these types. `enrollmentCode` is the single
 * exception and is present only on the response that creates it — it is returned once, at that
 * moment, and no later read can produce it again.
 */

/** How far through setup a registered computer is. */
export type DeviceStatusWire = 'awaiting-setup' | 'enrolled' | 'expired' | 'revoked';

export interface AdminDeviceWire {
  id: string;
  /** The administrator's name for the physical machine. */
  label: string;
  status: DeviceStatusWire;
  /** The employee this computer currently resolves to. */
  assignedUser: { id: string; displayName: string };
  assignedAt: string;
  enrolledAt: string | null;
  /** When the outstanding setup code stops working. Null when there is none outstanding. */
  enrollmentExpiresAt: string | null;
  lastSeenAt: string;
  revokedAt: string | null;
}

export interface AdminDeviceListWire {
  devices: AdminDeviceWire[];
}

/**
 * The response to registering or re-enrolling a computer.
 *
 * `enrollmentCode` is shown to the administrator once. It is stored only as a SHA-256 hash, so
 * nothing — not this API, not the database, not a backup — can produce it again.
 */
export interface AdminAssignmentWire {
  device: AdminDeviceWire;
  enrollmentCode: string;
}

export interface AdminReassignmentWire {
  device: AdminDeviceWire;
  /** Left completely intact: their id, messages, conversations and memberships are untouched. */
  previousUser: { id: string; displayName: string };
  /** How many sessions on that computer were revoked by the reassignment. */
  revokedSessions: number;
}

/** Whether this browser currently holds a valid admin cookie. */
export interface AdminSessionWire {
  administrator: boolean;
}

/** What the company computer is told after redeeming its setup code. */
export interface EnrollmentWire {
  deviceLabel: string;
  displayName: string;
}
