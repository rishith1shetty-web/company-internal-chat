/**
 * Identity resolution — the single swap point for real authentication later.
 *
 * docs/01-architecture.md §4 ("The identity seam"): every request-scoped and socket-scoped
 * identity in the application flows through `resolveIdentity()` here. Replacing device identity
 * with company SSO later means reimplementing this one module and adding an `externalId` column
 * to `User` — no call site changes. That is the concrete meaning of "designed so it can be
 * replaced" (CLAUDE.md §2.2).
 *
 * IDENTITY IS ADMIN-ASSIGNED, NOT SELF-DECLARED (docs/12-admin-device-identity.md).
 *
 * An employee cannot create, choose, change or clear who they are. An administrator assigns a
 * company computer to a named employee; that computer is enrolled once; from then on the browser
 * on it resolves to the assigned `User` with no employee action at all. There is deliberately no
 * function in this module that turns a display name from a browser into an identity — the only
 * way in is a device cookie, and the only way a device cookie exists is an admin assignment.
 *
 * The two-cookie model (D-13), unchanged in shape and changed in origin:
 *
 *   session cookie  →  "is this browser currently active?"   24h idle, renewed on activity
 *   device cookie   →  "which company computer is this?"      90 days, renewed on use
 *
 * The device answers which computer, and the computer's current assignment answers which `User`.
 * That indirection is what makes reassignment work: an administrator repoints the assignment and
 * the same browser is the new employee, without the old employee's identity being renamed or
 * their history being touched (D-14).
 *
 * WHAT THIS IS NOT. It is not authentication (D-11). Both cookies are bearer tokens: whoever
 * holds one is treated as that user. Nothing here proves a human, and no authorization decision
 * anywhere may be relaxed because a device cookie is present (docs/04-security.md R-16).
 */

import type { PrismaClient } from '../../prisma/generated/client';
import { generateToken, hashToken, looksLikeToken } from './tokens';

/** Cookie names. Prefixed so they are recognisable in a browser's storage inspector. */
export const SESSION_COOKIE = 'cic_session';
export const DEVICE_COOKIE = 'cic_device';

/** UI-level display-name bounds, enforced again here because no input is trusted. */
export const MIN_DISPLAY_NAME_LENGTH = 2;
export const MAX_DISPLAY_NAME_LENGTH = 64;

/**
 * A session's expiry is slid forward at most once per this interval, so an active user does not
 * cause a database write on every request or socket event (D-04).
 */
const RENEWAL_THROTTLE_MS = 5 * 60_000;

/** The server-derived identity behind a request or a socket. Never built from client input. */
export interface CurrentUser {
  userId: string;
  displayName: string;
  sessionId: string;
  /** The company computer this identity came from. Always present: identity is device-anchored. */
  deviceId: string;
  /** The administrator's label for that computer, shown read-only in the employee's profile. */
  deviceLabel: string;
}

export interface IdentityConfig {
  sessionTtlHours: number;
  deviceTtlDays: number;
}

export class DisplayNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DisplayNameError';
  }
}

/**
 * Validates and normalises a display name.
 *
 * A display name is a **label, not an identifier** (D-02). There is deliberately no uniqueness
 * check: two employees may both be "Sarah Chen", and rejecting the second would be wrong.
 * `normalizedName` is produced for search and ordering only.
 *
 * Called only from the admin assignment path now. No employee-facing endpoint accepts a name.
 */
export function normaliseDisplayName(raw: unknown): { displayName: string; normalizedName: string } {
  if (typeof raw !== 'string') {
    throw new DisplayNameError('An employee name is required.');
  }

  // Collapse whitespace and strip control characters: a name is rendered in the UI, and a name
  // containing newlines or zero-width characters is a presentation problem at best.
  const displayName = raw
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (displayName.length < MIN_DISPLAY_NAME_LENGTH) {
    throw new DisplayNameError(
      `Enter at least ${MIN_DISPLAY_NAME_LENGTH} characters so colleagues can recognise them.`,
    );
  }
  if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new DisplayNameError(`Use at most ${MAX_DISPLAY_NAME_LENGTH} characters.`);
  }

  return { displayName, normalizedName: displayName.toLowerCase() };
}

export function sessionExpiry(config: IdentityConfig): Date {
  return new Date(Date.now() + config.sessionTtlHours * 3_600_000);
}

export function deviceExpiry(config: IdentityConfig): Date {
  return new Date(Date.now() + config.deviceTtlDays * 86_400_000);
}

/** Diagnostics only, and the column is varchar(255). Not logged, not used for any decision. */
export function truncateUserAgent(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value.slice(0, 255);
}

export interface ResolvedIdentity {
  current: CurrentUser;
  /** Set when the device cookie caused a new session to be issued; the caller must set it. */
  renewedSessionToken?: string;
  renewedSessionExpiresAt?: Date;
}

/**
 * Resolves the identity behind a pair of cookie values. Returns null when there is none.
 *
 * This is the only function that turns cookies into a `User.id`. Nothing else in the
 * application may derive identity, and no caller may accept a user id from the client.
 *
 * Both paths end at the same question — **who is this computer assigned to right now?** — which
 * is why a reassignment takes effect immediately and cannot be outlived by a cookie.
 */
export async function resolveIdentity(
  db: PrismaClient,
  cookies: { sessionToken?: string | undefined; deviceToken?: string | undefined },
  config: IdentityConfig,
): Promise<ResolvedIdentity | null> {
  const now = new Date();

  // 1. An active session is the fast path.
  if (looksLikeToken(cookies.sessionToken)) {
    const session = await db.session.findUnique({
      where: { tokenHash: hashToken(cookies.sessionToken) },
      select: {
        id: true,
        userId: true,
        expiresAt: true,
        lastSeenAt: true,
        device: {
          select: {
            id: true,
            label: true,
            userId: true,
            revokedAt: true,
            expiresAt: true,
            user: { select: { id: true, displayName: true, isActive: true } },
          },
        },
      },
    });

    /*
     * Expiry is enforced on every lookup rather than trusted to a sweep: a sweep that has not
     * run yet must never mean an expired session still works.
     *
     * And the session is only as good as its device's CURRENT assignment. A session issued to
     * the previous employee of this computer is checked against `device.userId` on every single
     * request, so reassignment is effective at once — even if the explicit session revocation
     * that accompanies it had somehow not run. A session with no device cannot be checked this
     * way and is therefore not honoured at all.
     */
    const device = session?.device;

    if (
      session &&
      device &&
      session.expiresAt > now &&
      device.revokedAt === null &&
      device.expiresAt > now &&
      device.userId === session.userId &&
      device.user.isActive
    ) {
      await slideSessionExpiry(db, session.id, session.lastSeenAt, config, now);

      return {
        current: {
          userId: device.user.id,
          displayName: device.user.displayName,
          sessionId: session.id,
          deviceId: device.id,
          deviceLabel: device.label,
        },
      };
    }
  }

  // 2. No usable session: the device cookie identifies the computer, and the computer's
  //    assignment identifies the employee (D-13).
  if (looksLikeToken(cookies.deviceToken)) {
    const device = await db.device.findUnique({
      where: { tokenHash: hashToken(cookies.deviceToken) },
      select: {
        id: true,
        label: true,
        expiresAt: true,
        revokedAt: true,
        userId: true,
        user: { select: { id: true, displayName: true, isActive: true } },
      },
    });

    // The resolution rule, stated in the schema: revoked OR expired means no identity. Checking
    // that the row merely exists is the bug this comment exists to prevent.
    if (device && device.revokedAt === null && device.expiresAt > now && device.user.isActive) {
      const sessionToken = generateToken();
      const sessionExpiresAt = sessionExpiry(config);

      const session = await db.session.create({
        data: {
          userId: device.userId,
          deviceId: device.id,
          tokenHash: hashToken(sessionToken),
          expiresAt: sessionExpiresAt,
        },
        select: { id: true },
      });

      // Renewing the device on use keeps a working computer working, and lets a machine that has
      // been out of service for months lapse.
      await db.device.update({
        where: { id: device.id },
        data: { expiresAt: deviceExpiry(config), lastSeenAt: now },
      });

      return {
        current: {
          userId: device.user.id,
          displayName: device.user.displayName,
          sessionId: session.id,
          deviceId: device.id,
          deviceLabel: device.label,
        },
        renewedSessionToken: sessionToken,
        renewedSessionExpiresAt: sessionExpiresAt,
      };
    }
  }

  return null;
}

/**
 * Slides the session expiry forward, at most once per throttle interval.
 *
 * Without the throttle a sliding 24-hour window would mean a database write on every request and
 * every socket event (D-04).
 */
async function slideSessionExpiry(
  db: PrismaClient,
  sessionId: string,
  lastSeenAt: Date,
  config: IdentityConfig,
  now: Date,
): Promise<void> {
  if (now.getTime() - lastSeenAt.getTime() < RENEWAL_THROTTLE_MS) return;

  await db.session.update({
    where: { id: sessionId },
    data: { expiresAt: sessionExpiry(config), lastSeenAt: now },
  });
}

/** Records that a user was seen, for the "last seen" display. Best-effort, never blocking. */
export async function touchLastSeen(db: PrismaClient, userId: string): Promise<void> {
  await db.user.update({ where: { id: userId }, data: { lastSeenAt: new Date() } });
}

/** Parses a Cookie header into a name→value map. Used by both HTTP routes and the socket handshake. */
export function parseCookieHeader(header: string | undefined | null): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;

  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name.length > 0) {
      try {
        cookies[name] = decodeURIComponent(value);
      } catch {
        // A malformed percent-encoding is attacker-controlled input, not a server error.
        cookies[name] = value;
      }
    }
  }

  return cookies;
}
