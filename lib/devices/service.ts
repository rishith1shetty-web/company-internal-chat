/**
 * The device registry — where identity now comes from.
 *
 * An employee never creates, changes or clears an identity. An administrator assigns a company
 * computer to a named employee, the computer is enrolled once, and from then on the browser on
 * that machine resolves to the assigned `User` through `resolveIdentity()` with no employee
 * action at all (docs/12-admin-device-identity.md).
 *
 * Everything in this module is called from an ADMIN-ONLY route, with one exception: `enrollDevice`,
 * which is reached from the company computer itself and is protected by the one-time enrollment
 * code rather than by the admin token. That is deliberate — the alternative would be typing the
 * administrator's token into an employee's browser, which is a far worse exposure than a
 * single-use, expiring code that grants exactly one device cookie.
 *
 * The rules this module exists to hold:
 *
 *   - Reassignment CREATES A NEW USER. It never renames, reuses or repurposes the previous
 *     employee's row, and never deletes their conversations, memberships or messages (D-14).
 *   - Reassignment REVOKES EVERY SESSION issued for that computer, so the previous employee's
 *     session cookie stops working immediately.
 *   - Reassignment PRESERVES ENROLLMENT. An ordinary staff change does not require anybody to
 *     walk to the machine with a code; re-enrollment is for a browser identity that was actually
 *     lost.
 *   - Only the SHA-256 hash of an enrollment code is stored, and it is cleared the moment the
 *     code is redeemed, so a code works exactly once.
 */

import type { Prisma, PrismaClient } from '../../prisma/generated/client';
import {
  deviceExpiry,
  normaliseDisplayName,
  sessionExpiry,
  truncateUserAgent,
  type IdentityConfig,
} from '../auth/session';
import {
  generateEnrollmentCode,
  generateToken,
  hashEnrollmentCode,
  hashToken,
} from '../auth/tokens';

/** Bounds for the administrator's label for a computer. Matches `Device.label varchar(64)`. */
export const MIN_DEVICE_LABEL_LENGTH = 2;
export const MAX_DEVICE_LABEL_LENGTH = 64;

export type DeviceErrorReason =
  | 'INVALID_LABEL'
  | 'LABEL_TAKEN'
  | 'DEVICE_NOT_FOUND'
  | 'DEVICE_REVOKED'
  | 'DEVICE_NOT_RETIRED'
  | 'INVALID_CODE'
  | 'CODE_EXPIRED';

export class DeviceError extends Error {
  readonly reason: DeviceErrorReason;

  constructor(reason: DeviceErrorReason, message: string) {
    super(message);
    this.name = 'DeviceError';
    this.reason = reason;
  }
}

/** Prisma's unique-constraint violation. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

/**
 * Validates the administrator's label for a computer.
 *
 * A label is how a human tells one machine from another in the admin list, so it is required and
 * unique — but it is NOT an identifier the application resolves anything by. Identity still runs
 * through `Device.id` and `User.id` only.
 */
export function normaliseDeviceLabel(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new DeviceError('INVALID_LABEL', 'Give this computer a name.');
  }

  const label = raw
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (label.length < MIN_DEVICE_LABEL_LENGTH) {
    throw new DeviceError(
      'INVALID_LABEL',
      `Use at least ${MIN_DEVICE_LABEL_LENGTH} characters, e.g. "Reception PC".`,
    );
  }
  if (label.length > MAX_DEVICE_LABEL_LENGTH) {
    throw new DeviceError('INVALID_LABEL', `Use at most ${MAX_DEVICE_LABEL_LENGTH} characters.`);
  }

  return label;
}

/** How long an unredeemed enrollment code stays usable. */
export interface EnrollmentConfig extends IdentityConfig {
  enrollmentTtlHours: number;
}

/** Never inline: storage and lookup must hash the same canonical value (see hashEnrollmentCode). */
function hashCodeForStorage(code: string): string {
  const hash = hashEnrollmentCode(code);
  // Impossible for a generated code; asserted rather than assumed, because a silently wrong hash
  // would make every setup code fail with "not valid" and look like a lost code.
  if (hash === null) throw new Error('Generated enrollment code did not normalise');
  return hash;
}

function enrollmentExpiry(config: EnrollmentConfig): Date {
  return new Date(Date.now() + config.enrollmentTtlHours * 3_600_000);
}

/** What a device looks like to an administrator. Carries no token and no hash — ever. */
export interface DeviceSummary {
  id: string;
  label: string;
  status: 'awaiting-setup' | 'enrolled' | 'expired' | 'revoked';
  assignedUser: { id: string; displayName: string };
  assignedAt: Date;
  enrolledAt: Date | null;
  enrollmentExpiresAt: Date | null;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

type DeviceRow = {
  id: string;
  label: string;
  tokenHash: string | null;
  enrollmentExpiresAt: Date | null;
  assignedAt: Date;
  enrolledAt: Date | null;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  user: { id: string; displayName: string };
};

const deviceSelect = {
  id: true,
  label: true,
  tokenHash: true,
  enrollmentExpiresAt: true,
  assignedAt: true,
  enrolledAt: true,
  lastSeenAt: true,
  expiresAt: true,
  revokedAt: true,
  user: { select: { id: true, displayName: true } },
} as const;

function toSummary(device: DeviceRow, now = new Date()): DeviceSummary {
  const status: DeviceSummary['status'] =
    device.revokedAt !== null
      ? 'revoked'
      : device.tokenHash === null
        ? 'awaiting-setup'
        : device.expiresAt <= now
          ? 'expired'
          : 'enrolled';

  return {
    id: device.id,
    label: device.label,
    status,
    assignedUser: device.user,
    assignedAt: device.assignedAt,
    enrolledAt: device.enrolledAt,
    enrollmentExpiresAt: device.enrollmentExpiresAt,
    lastSeenAt: device.lastSeenAt,
    expiresAt: device.expiresAt,
    revokedAt: device.revokedAt,
  };
}

/** The enrollment code is returned ONCE, at the moment it is created, and never stored in clear. */
export interface AssignmentResult {
  device: DeviceSummary;
  enrollmentCode: string;
}

/* ------------------------------------------------------------------------------------------- */
/* Admin operations                                                                              */
/* ------------------------------------------------------------------------------------------- */

/**
 * Every registered computer, computers in service first, then newest assignment first.
 *
 * `nulls: 'first'` is not decoration: PostgreSQL sorts NULLs LAST on an ascending order, so a
 * plain `revokedAt asc` put the RETIRED computers at the top of the administrator's list and the
 * working ones underneath.
 */
export async function listDevices(db: PrismaClient): Promise<DeviceSummary[]> {
  const devices = await db.device.findMany({
    select: deviceSelect,
    orderBy: [{ revokedAt: { sort: 'asc', nulls: 'first' } }, { assignedAt: 'desc' }],
    take: 500,
  });

  const now = new Date();
  return devices.map((device) => toSummary(device, now));
}

/**
 * Registers a computer and assigns it to a newly created employee.
 *
 * Always a new `User`, exactly as before (D-02): an employee name that matches an existing row is
 * a different person who happens to share a name, and silently attaching a computer to that row
 * would be the merge D-02 exists to prevent.
 */
export async function assignDevice(
  db: PrismaClient,
  input: { label: unknown; displayName: unknown },
  config: EnrollmentConfig,
): Promise<AssignmentResult> {
  const label = normaliseDeviceLabel(input.label);
  const { displayName, normalizedName } = normaliseDisplayName(input.displayName);

  const enrollmentCode = generateEnrollmentCode();
  const now = new Date();

  try {
    // One transaction: an employee row with no computer, or a computer with no employee, is a
    // half-made assignment somebody would have to clean up by hand (CLAUDE.md §8).
    const device = await db.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { displayName, normalizedName },
        select: { id: true },
      });

      return tx.device.create({
        data: {
          userId: user.id,
          label,
          enrollmentTokenHash: hashCodeForStorage(enrollmentCode),
          enrollmentExpiresAt: enrollmentExpiry(config),
          assignedAt: now,
          expiresAt: deviceExpiry(config),
        },
        select: deviceSelect,
      });
    });

    return { device: toSummary(device, now), enrollmentCode };
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new DeviceError('LABEL_TAKEN', 'A computer with that name is already registered.');
    }
    throw error;
  }
}

export interface ReassignmentResult {
  device: DeviceSummary;
  /** The employee who had this computer before. Their row and their history are untouched. */
  previousUser: { id: string; displayName: string };
  revokedSessions: number;
}

/**
 * Hands a computer to a different employee.
 *
 * The three things this must get right, and the reasons they are separate statements rather than
 * an update to the existing row:
 *
 *   1. The new employee is a NEW `User`. The previous employee is not renamed, not deactivated
 *      and not deleted, and every conversation, membership and message they own stays exactly
 *      where it is (D-14). Their name simply stops being the one this computer resolves to.
 *   2. Every `Session` issued for this computer is deleted, so the previous employee's session
 *      cookie stops resolving at once rather than at the end of its 24 hours.
 *   3. `tokenHash` is left alone. The computer is already enrolled and stays enrolled — the very
 *      next request from that browser is the new employee.
 */
export async function reassignDevice(
  db: PrismaClient,
  input: { deviceId: string; displayName: unknown },
  config: EnrollmentConfig,
): Promise<ReassignmentResult> {
  const { displayName, normalizedName } = normaliseDisplayName(input.displayName);
  const existing = await requireDevice(db, input.deviceId);

  if (existing.revokedAt !== null) {
    throw new DeviceError(
      'DEVICE_REVOKED',
      'That computer has been retired. Register it again to put it back into service.',
    );
  }

  const now = new Date();

  const result = await db.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { displayName, normalizedName },
      select: { id: true, displayName: true },
    });

    const device = await tx.device.update({
      where: { id: existing.id },
      data: {
        userId: user.id,
        assignedAt: now,
        // The computer keeps working for the new employee without anybody visiting it, so its
        // own lifetime is refreshed alongside the assignment.
        expiresAt: deviceExpiry(config),
      },
      select: deviceSelect,
    });

    // Scoped to this device, not to the outgoing employee: if that person is also assigned
    // another computer, signing them out of it is not part of this operation.
    const revoked = await tx.session.deleteMany({ where: { deviceId: existing.id } });

    return { device, revokedSessions: revoked.count };
  });

  return {
    device: toSummary(result.device, now),
    previousUser: existing.user,
    revokedSessions: result.revokedSessions,
  };
}

/**
 * Issues a fresh enrollment code for a computer that is already registered.
 *
 * For a machine whose browser identity was genuinely lost — a reimaged PC, cleared site data, a
 * replaced browser profile. It is NOT the reassignment path and is not needed for a staff change.
 *
 * The old device cookie is invalidated as part of this: `tokenHash` is cleared, so a browser
 * still holding it (the old profile, a copy taken from it) resolves to nothing.
 */
export async function issueEnrollmentCode(
  db: PrismaClient,
  deviceId: string,
  config: EnrollmentConfig,
): Promise<AssignmentResult> {
  const existing = await requireDevice(db, deviceId);

  if (existing.revokedAt !== null) {
    throw new DeviceError('DEVICE_REVOKED', 'That computer has been retired.');
  }

  const enrollmentCode = generateEnrollmentCode();
  const now = new Date();

  const device = await db.$transaction(async (tx) => {
    const updated = await tx.device.update({
      where: { id: existing.id },
      data: {
        tokenHash: null,
        enrolledAt: null,
        enrollmentTokenHash: hashCodeForStorage(enrollmentCode),
        enrollmentExpiresAt: enrollmentExpiry(config),
        expiresAt: deviceExpiry(config),
      },
      select: deviceSelect,
    });

    await tx.session.deleteMany({ where: { deviceId: existing.id } });
    return updated;
  });

  return { device: toSummary(device, now), enrollmentCode };
}

/**
 * Takes a computer out of service.
 *
 * The counterpart of there being no employee-facing sign-out: a machine that is lost, stolen or
 * decommissioned has to be cuttable off from somewhere, and this is that control. Both hashes are
 * cleared and every session for it is deleted, so nothing it still holds resolves again.
 *
 * Reversible by `reactivateDevice`, but not by simply undoing this: the device cookie is gone for
 * good and the computer must be enrolled again. That asymmetry is the point — retirement is safe
 * to reach for precisely because it cannot be quietly walked back.
 *
 * Deletes nothing: not the device row, not the employee, and not one line of history.
 */
export async function revokeDevice(db: PrismaClient, deviceId: string): Promise<DeviceSummary> {
  const existing = await requireDevice(db, deviceId);
  const now = new Date();

  const device = await db.$transaction(async (tx) => {
    const updated = await tx.device.update({
      where: { id: existing.id },
      data: {
        revokedAt: existing.revokedAt ?? now,
        tokenHash: null,
        enrollmentTokenHash: null,
        enrollmentExpiresAt: null,
      },
      select: deviceSelect,
    });

    await tx.session.deleteMany({ where: { deviceId: existing.id } });
    return updated;
  });

  return toSummary(device, now);
}

/**
 * Renames a computer.
 *
 * Touches ONE column. `label` is how a human tells one machine from another in the admin list; it
 * is not an identifier the application resolves anything by, so changing it cannot move an
 * identity, a session or a message. `id`, `userId`, `tokenHash` and every timestamp are untouched,
 * and nothing else in the database references a device by name.
 *
 * Works whether the computer is in service or not: a machine sitting in a cupboard is exactly the
 * one whose placeholder name an administrator wants to correct.
 */
export async function renameDevice(
  db: PrismaClient,
  input: { deviceId: string; label: unknown },
): Promise<DeviceSummary> {
  const label = normaliseDeviceLabel(input.label);
  const existing = await requireDevice(db, input.deviceId);

  // Renaming a computer to the name it already has is a no-op, not a clash with itself.
  if (existing.label === label) return toSummary(existing);

  try {
    const device = await db.device.update({
      where: { id: existing.id },
      data: { label },
      select: deviceSelect,
    });

    return toSummary(device);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new DeviceError('LABEL_TAKEN', 'A computer with that name is already registered.');
    }
    throw error;
  }
}

/**
 * Brings a retired computer back into service.
 *
 * The counterpart of `revokeDevice`, and the reason it exists: retirement is the control that cuts
 * off a lost or stolen machine, so it has to stay easy to reach — which means it will sometimes be
 * used on a computer that later comes back. Without this, the only way back was direct SQL, and the
 * retired row would keep its `label` (which is unique), so the same machine could not even be
 * re-registered under its real name.
 *
 * WHAT IT DOES NOT DO, and why:
 *
 *   - It does not create a second `Device`. The physical computer is this row; a duplicate would
 *     leave two rows claiming one machine and make the admin list a guessing game.
 *   - It does not create a `User`. The computer comes back assigned to the same employee it had.
 *     Handing it to somebody else is Reassign, and stays a separate, deliberate act.
 *   - It does not restore the old device cookie. `revokeDevice` destroyed `tokenHash` on purpose,
 *     because retirement may have been a response to a machine going missing; resurrecting the
 *     token would quietly undo that. So reactivation issues a FRESH one-time setup code, and the
 *     computer is enrolled again — back onto this same row, keeping its id, label and assignment.
 *
 * `expiresAt` is refreshed, so a computer retired for longer than `DEVICE_ID_TTL_DAYS` is usable
 * again rather than coming back already lapsed.
 *
 * Deletes nothing: not the device, not the employee, not a previous employee, and not a single
 * conversation, membership, message or attachment (D-14).
 */
export async function reactivateDevice(
  db: PrismaClient,
  deviceId: string,
  config: EnrollmentConfig,
): Promise<AssignmentResult> {
  const existing = await requireDevice(db, deviceId);

  if (existing.revokedAt === null) {
    throw new DeviceError('DEVICE_NOT_RETIRED', 'That computer is already in service.');
  }

  const enrollmentCode = generateEnrollmentCode();
  const now = new Date();

  const device = await db.$transaction(async (tx) => {
    const updated = await tx.device.update({
      where: { id: existing.id },
      data: {
        // Back in service. `userId` and `label` are deliberately absent from this update.
        revokedAt: null,
        // Already null after retirement; stated so the row cannot come back holding a token that
        // some earlier or later edit left behind.
        tokenHash: null,
        enrolledAt: null,
        enrollmentTokenHash: hashCodeForStorage(enrollmentCode),
        enrollmentExpiresAt: enrollmentExpiry(config),
        expiresAt: deviceExpiry(config),
      },
      select: deviceSelect,
    });

    // Retirement already removed these. Repeated because "there should be none" is an assumption,
    // and a stale session surviving a return to service is exactly what must not happen.
    await tx.session.deleteMany({ where: { deviceId: existing.id } });

    return updated;
  });

  return { device: toSummary(device, now), enrollmentCode };
}

async function requireDevice(db: PrismaClient, deviceId: string): Promise<DeviceRow> {
  const device = await db.device.findUnique({
    where: { id: deviceId },
    select: deviceSelect,
  });

  if (!device) throw new DeviceError('DEVICE_NOT_FOUND', 'That computer is not registered.');
  return device;
}

/* ------------------------------------------------------------------------------------------- */
/* Enrollment, performed on the company computer itself                                          */
/* ------------------------------------------------------------------------------------------- */

export interface EnrollmentResult {
  deviceId: string;
  label: string;
  user: { id: string; displayName: string };
  deviceToken: string;
  deviceExpiresAt: Date;
  sessionToken: string;
  sessionExpiresAt: Date;
}

/**
 * Redeems a one-time enrollment code and hands this browser its device cookie.
 *
 * The code is looked up BY HASH, so the clear value exists only in the administrator's hands and
 * in this request. On success it is cleared, which is what makes it single-use: a second attempt
 * with the same code finds nothing and is refused exactly like a made-up one.
 *
 * This is a setup operation, not a login. It does not let anybody choose who they are — the
 * employee was decided when the administrator made the assignment, and the code carries no name,
 * no user id and no choice.
 */
export async function enrollDevice(
  db: PrismaClient,
  input: { code: unknown; userAgent?: string | null },
  config: EnrollmentConfig,
): Promise<EnrollmentResult> {
  const codeHash = hashEnrollmentCode(input.code);

  // A malformed code is refused with the same message as a wrong one: telling somebody their
  // code was "the right shape" narrows a guess for them.
  if (codeHash === null) {
    throw new DeviceError('INVALID_CODE', 'That setup code is not valid.');
  }

  const device = await db.device.findUnique({
    where: { enrollmentTokenHash: codeHash },
    select: {
      id: true,
      label: true,
      revokedAt: true,
      enrollmentExpiresAt: true,
      user: { select: { id: true, displayName: true, isActive: true } },
    },
  });

  if (!device || device.revokedAt !== null || !device.user.isActive) {
    throw new DeviceError('INVALID_CODE', 'That setup code is not valid.');
  }

  if (!device.enrollmentExpiresAt || device.enrollmentExpiresAt <= new Date()) {
    throw new DeviceError(
      'CODE_EXPIRED',
      'That setup code has expired. Ask for a new one.',
    );
  }

  const deviceToken = generateToken();
  const sessionToken = generateToken();
  const deviceExpiresAt = deviceExpiry(config);
  const sessionExpiresAt = sessionExpiry(config);
  const userAgent = truncateUserAgent(input.userAgent);
  const now = new Date();

  const redeemed = await db.$transaction(async (tx: Prisma.TransactionClient) => {
    /*
     * THE CODE IS CLAIMED HERE, AND THE `where` CLAUSE IS WHAT MAKES IT SINGLE-USE (Phase 9).
     *
     * The lookup above found the device, but between that read and this write the code may
     * already have been spent by another request — two people typing the same code at once, or
     * the same request retried. `updateMany` with `enrollmentTokenHash: codeHash` in the
     * condition turns the claim into one atomic statement: PostgreSQL locks the row, and the
     * second transaction re-evaluates the condition after the first commits, finds the column
     * already NULL, and matches nothing.
     *
     * Written as a conditional update rather than `update({ where: { id } })` for exactly that
     * reason. The unconditional form would let both requests write, and the pair would resolve to
     * whichever committed last — with the loser holding a device cookie that had already stopped
     * working and no way to tell why.
     */
    const claimed = await tx.device.updateMany({
      where: { id: device.id, enrollmentTokenHash: codeHash },
      data: {
        tokenHash: hashToken(deviceToken),
        // Cleared in the same statement that redeems it, inside the same transaction that issues
        // the cookie. There is no window in which the code is both spent and still usable.
        enrollmentTokenHash: null,
        enrollmentExpiresAt: null,
        enrolledAt: now,
        lastSeenAt: now,
        expiresAt: deviceExpiresAt,
        userAgent,
      },
    });

    // Somebody else redeemed it first. Nothing else in this transaction runs.
    if (claimed.count !== 1) return false;

    // Anything left over from a previous enrollment of this machine.
    await tx.session.deleteMany({ where: { deviceId: device.id } });

    await tx.session.create({
      data: {
        userId: device.user.id,
        deviceId: device.id,
        tokenHash: hashToken(sessionToken),
        expiresAt: sessionExpiresAt,
        userAgent,
      },
    });

    return true;
  });

  // Refused with the same message as a made-up code: that a code was real a moment ago is not
  // something this endpoint should confirm.
  if (!redeemed) {
    throw new DeviceError('INVALID_CODE', 'That setup code is not valid.');
  }

  return {
    deviceId: device.id,
    label: device.label,
    user: { id: device.user.id, displayName: device.user.displayName },
    deviceToken,
    deviceExpiresAt,
    sessionToken,
    sessionExpiresAt,
  };
}
