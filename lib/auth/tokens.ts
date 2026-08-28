/**
 * Opaque token generation and hashing.
 *
 * Both the session cookie and the device cookie carry a **cryptographically random opaque
 * token** (docs/01-architecture.md §5). The token carries no user id, no display name and no
 * structure the browser can read, edit or forge — the only thing it can do is match a row.
 *
 * Only the SHA-256 hash of a token is ever stored. A stolen database backup therefore does not
 * yield working cookies, and nothing in the logs or the database can be replayed as an identity.
 *
 * This is NOT authentication (D-11). It is a bearer token: whoever holds it is treated as that
 * user until it expires or is revoked. Its limitations are documented in docs/04-security.md
 * (R-16) and are not solved here.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 32 bytes = 256 bits of entropy. Guessing one is not a realistic attack. */
const TOKEN_BYTES = 32;

/** Length of a SHA-256 hex digest — matches the `char(64)` columns. */
export const TOKEN_HASH_LENGTH = 64;

/** Generates a new opaque token. The raw value is returned once and never stored. */
export function generateToken(): string {
  // base64url: URL- and cookie-safe with no escaping, and shorter than hex.
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** SHA-256 hex digest of a token — the only form that reaches the database. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of two token hashes.
 *
 * Lookups are by hash equality in SQL, so this is used only where a hash is compared in
 * application code. Constant time regardless, because a comparison that returns early leaks how
 * much of a value was correct.
 */
export function hashesMatch(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

/**
 * Rejects anything that is not shaped like a token before it reaches the database.
 *
 * A cookie value is attacker-controlled. This keeps absurd input (a megabyte of text, a null
 * byte) out of the query path entirely.
 */
export function looksLikeToken(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 16 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);
}
