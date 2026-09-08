/**
 * Administrator access to the device-assignment surface.
 *
 * WHAT THIS IS. A single shared token, held by whoever administers this system, checked in
 * constant time, exchanged for a short-lived signed cookie so the token itself is not replayed on
 * every request. It exists because identity is now assigned rather than self-declared, and
 * something has to guard the assigning.
 *
 * WHAT THIS IS NOT, stated plainly rather than implied (CLAUDE.md §20):
 *
 *   - It is not per-administrator authentication. Everyone who holds the token is the same
 *     "admin", so an action cannot be attributed to a person.
 *   - Sign-in attempts ARE now rate limited per client address, in `server.ts` (Phase 9). There is
 *     still no per-administrator lockout, because there is still only one administrator secret.
 *   - It does not restrict *where* the admin surface can be reached from. Confining `/admin` and
 *     `/api/admin` to an operator network is a reverse-proxy and firewall job, and is Phase 8.
 *
 * It is therefore the minimum honest mechanism, not a finished one, and docs/12 says so in the
 * same words. Nothing elsewhere in the application relaxes a check because an admin cookie is
 * present: admin access governs the device registry and nothing else. It confers no ability to
 * read a conversation, a message or a file.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Prefixed like the other cookies so it is recognisable in a browser's storage inspector. */
export const ADMIN_COOKIE = 'cic_admin';

/** An admin sign-in lasts one working day. Not renewed on activity — it simply lapses. */
export const ADMIN_SESSION_TTL_HOURS = 8;

/** Versioned so the format can change later without old cookies quietly still verifying. */
const COOKIE_CONTEXT = 'cic-admin:v1';

/**
 * Constant-time comparison of two secrets of any length.
 *
 * `timingSafeEqual` throws on a length mismatch, and returning early on one would leak the length
 * of the configured token. Hashing both sides first makes the compared buffers the same size
 * whatever was supplied.
 */
function secretsMatch(left: string, right: string): boolean {
  const digest = (value: string) =>
    createHmac('sha256', COOKIE_CONTEXT).update(value, 'utf8').digest();
  return timingSafeEqual(digest(left), digest(right));
}

/**
 * Checks a submitted admin token against the configured one.
 *
 * Returns false when nothing is configured. That is the important case: an unconfigured system
 * must refuse every administrator, not accept every one.
 */
export function verifyAdminToken(configured: string | undefined, submitted: unknown): boolean {
  if (!configured || typeof submitted !== 'string' || submitted.length === 0) return false;
  return secretsMatch(configured, submitted);
}

/**
 * Mints the admin cookie value: an expiry, and an HMAC over it keyed by the admin token.
 *
 * The cookie carries no secret and needs no server-side table — and because the key is the admin
 * token itself, rotating that token invalidates every admin cookie that was ever issued, which is
 * exactly what an operator expects rotation to do.
 */
export function issueAdminCookie(
  configured: string,
  now: Date = new Date(),
): { value: string; expiresAt: Date } {
  const expiresAt = new Date(now.getTime() + ADMIN_SESSION_TTL_HOURS * 3_600_000);
  const expiry = String(expiresAt.getTime());

  return { value: `${expiry}.${sign(configured, expiry)}`, expiresAt };
}

/** Verifies a presented admin cookie. Signature first, then expiry. */
export function verifyAdminCookie(
  configured: string | undefined,
  value: unknown,
  now: Date = new Date(),
): boolean {
  if (!configured || typeof value !== 'string' || value.length > 256) return false;

  const separator = value.indexOf('.');
  if (separator < 1) return false;

  const expiry = value.slice(0, separator);
  const signature = value.slice(separator + 1);

  if (!/^\d{1,15}$/.test(expiry)) return false;
  if (!secretsMatch(sign(configured, expiry), signature)) return false;

  return Number(expiry) > now.getTime();
}

function sign(configured: string, expiry: string): string {
  return createHmac('sha256', configured).update(`${COOKIE_CONTEXT}:${expiry}`).digest('hex');
}
