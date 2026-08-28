/**
 * Identity resolution — the single swap point for real authentication later.
 *
 * docs/01-architecture.md §4 ("The identity seam"): every request-scoped and socket-scoped
 * identity in the application flows through `resolveIdentity()` here. Replacing display-name
 * identity with company SSO later means reimplementing this one module and adding an
 * `externalId` column to `User` — no call site changes. That is the concrete meaning of
 * "designed so it can be replaced" (CLAUDE.md §2.2).
 *
 * The two-cookie model (D-13):
 *
 *   session cookie  →  "is this browser currently active?"   24h idle, renewed on activity
 *   device cookie   →  "which User.id does this browser be-   90 days, renewed on use
 *                       long to?"
 *
 * When the session has expired but the device cookie is still valid, a NEW session is issued for
 * the SAME `User.id`, so conversations and history are still reachable (D-14). With neither
 * cookie, the caller has no identity and must enter a display name.
 *
 * WHAT THIS IS NOT. It is not authentication (D-11). Both cookies are bearer tokens: whoever
 * holds one is treated as that user. Nothing here proves a human, and no authorization decision
 * anywhere may be relaxed because a device cookie is present (docs/04-security.md R-16).
 *
 * PHASE 4 SCOPE: issuing, resolving and revoking identity — the minimum the Socket.IO handshake
 * needs in order to have a server-derived user. The wider session API surface (leave, the user
 * directory, conversation endpoints) belongs to Phase 5.
 */

import type { PrismaClient, User } from '../../prisma/generated/client';
import { generateToken, hashToken, looksLikeToken } from './tokens';

/** Cookie names. Prefixed so they are recognisable in a browser's storage inspector. */
export const SESSION_COOKIE = 'cic_session';
export const DEVICE_COOKIE = 'cic_device';

/** UI-level display-name bounds, enforced again here because the client is not trusted. */
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
  deviceId: string | null;
}

export interface IdentityConfig {
  sessionTtlHours: number;
  deviceTtlDays: number;
}

/** Raw tokens, returned once at issue time so they can be written into cookies. */
export interface IssuedIdentity {
  user: Pick<User, 'id' | 'displayName'>;
  sessionToken: string;
  deviceToken: string;
  sessionExpiresAt: Date;
  deviceExpiresAt: Date;
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
 */
export function normaliseDisplayName(raw: unknown): { displayName: string; normalizedName: string } {
  if (typeof raw !== 'string') {
    throw new DisplayNameError('A display name is required.');
  }

  // Collapse whitespace and strip control characters: a name is rendered in the UI, and a name
  // containing newlines or zero-width characters is a presentation problem at best.
  const displayName = raw
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (displayName.length < MIN_DISPLAY_NAME_LENGTH) {
    throw new DisplayNameError(
      `Enter at least ${MIN_DISPLAY_NAME_LENGTH} characters so colleagues can recognise you.`,
    );
  }
  if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new DisplayNameError(`Use at most ${MAX_DISPLAY_NAME_LENGTH} characters.`);
  }

  return { displayName, normalizedName: displayName.toLowerCase() };
}

function sessionExpiry(config: IdentityConfig): Date {
  return new Date(Date.now() + config.sessionTtlHours * 3_600_000);
}

function deviceExpiry(config: IdentityConfig): Date {
  return new Date(Date.now() + config.deviceTtlDays * 86_400_000);
}

/**
 * Creates a NEW user, device and session — the "enter a display name" path.
 *
 * Deliberately always a new `User` row. Reusing a row whose name matches would silently merge two
 * different people who share a name, which is exactly what D-02 forbids.
 */
export async function createIdentity(
  db: PrismaClient,
  input: { displayName: unknown; userAgent?: string | null },
  config: IdentityConfig,
): Promise<IssuedIdentity> {
  const { displayName, normalizedName } = normaliseDisplayName(input.displayName);

  const sessionToken = generateToken();
  const deviceToken = generateToken();
  const sessionExpiresAt = sessionExpiry(config);
  const deviceExpiresAt = deviceExpiry(config);
  const userAgent = truncateUserAgent(input.userAgent);

  // One transaction: a user without their session, or a session without its device, would be a
  // half-created identity (CLAUDE.md §8).
  const user = await db.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: { displayName, normalizedName },
      select: { id: true, displayName: true },
    });

    await tx.device.create({
      data: {
        userId: created.id,
        tokenHash: hashToken(deviceToken),
        expiresAt: deviceExpiresAt,
        userAgent,
      },
    });

    await tx.session.create({
      data: {
        userId: created.id,
        tokenHash: hashToken(sessionToken),
        expiresAt: sessionExpiresAt,
        userAgent,
      },
    });

    return created;
  });

  return { user, sessionToken, deviceToken, sessionExpiresAt, deviceExpiresAt };
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
        expiresAt: true,
        lastSeenAt: true,
        user: { select: { id: true, displayName: true, isActive: true } },
      },
    });

    // Expiry is enforced on every lookup rather than trusted to a sweep: a sweep that has not
    // run yet must never mean an expired session still works.
    if (session && session.expiresAt > now && session.user.isActive) {
      await slideSessionExpiry(db, session.id, session.lastSeenAt, config, now);

      return {
        current: {
          userId: session.user.id,
          displayName: session.user.displayName,
          sessionId: session.id,
          deviceId: await findDeviceId(db, cookies.deviceToken, session.user.id, now),
        },
      };
    }
  }

  // 2. No usable session: the device cookie reattaches this browser to the same user (D-13).
  if (looksLikeToken(cookies.deviceToken)) {
    const device = await db.device.findUnique({
      where: { tokenHash: hashToken(cookies.deviceToken) },
      select: {
        id: true,
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
          tokenHash: hashToken(sessionToken),
          expiresAt: sessionExpiresAt,
        },
        select: { id: true },
      });

      // Renewing the device on use keeps a working browser working, and lets an unused one lapse.
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
        },
        renewedSessionToken: sessionToken,
        renewedSessionExpiresAt: sessionExpiresAt,
      };
    }
  }

  return null;
}

/** The device row backing this browser, when its cookie belongs to the resolved user. */
async function findDeviceId(
  db: PrismaClient,
  deviceToken: string | undefined,
  userId: string,
  now: Date,
): Promise<string | null> {
  if (!looksLikeToken(deviceToken)) return null;

  const device = await db.device.findUnique({
    where: { tokenHash: hashToken(deviceToken) },
    select: { id: true, userId: true, revokedAt: true, expiresAt: true },
  });

  // A device cookie belonging to a different user is ignored rather than honoured: it must never
  // be able to re-point an active session at someone else.
  if (!device || device.userId !== userId || device.revokedAt !== null || device.expiresAt <= now) {
    return null;
  }

  return device.id;
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

/**
 * "Switch User / Clear Device Identity" (F-19).
 *
 * Revokes the session and the device **server-side**. Clearing the cookies in the browser is not
 * sufficient and never was: a copied cookie would still resolve. The next entry creates a new
 * `User`, so the next person at a shared computer is not silently the previous one.
 *
 * Deletes nothing else. Conversations, memberships, messages and files belong to the `User` and
 * survive untouched (D-14).
 */
export async function switchUser(
  db: PrismaClient,
  current: CurrentUser,
  now: Date = new Date(),
): Promise<void> {
  await db.$transaction(async (tx) => {
    // Scoped to this user's own rows: a caller can only ever revoke their own identity.
    await tx.session.deleteMany({ where: { id: current.sessionId, userId: current.userId } });

    if (current.deviceId) {
      await tx.device.updateMany({
        where: { id: current.deviceId, userId: current.userId, revokedAt: null },
        data: { revokedAt: now },
      });
    }
  });
}

/** Records that a user was seen, for the "last seen" display. Best-effort, never blocking. */
export async function touchLastSeen(db: PrismaClient, userId: string): Promise<void> {
  await db.user.update({ where: { id: userId }, data: { lastSeenAt: new Date() } });
}

function truncateUserAgent(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  // Diagnostics only, and the column is varchar(255). Not logged, not used for any decision.
  return value.slice(0, 255);
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
