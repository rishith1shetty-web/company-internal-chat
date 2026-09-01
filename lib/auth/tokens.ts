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

/* ------------------------------------------------------------------------------------------- */
/* Enrollment codes                                                                              */
/* ------------------------------------------------------------------------------------------- */

/**
 * The alphabet an enrollment code is drawn from.
 *
 * Deliberately not base64url. An enrollment code is read off an administrator's screen and typed
 * on another computer, so the characters that get mistyped are left out entirely: no `0`/`O`, no
 * `1`/`I`/`L`, no `U` (which is easily read as `V`). What remains is unambiguous in every common
 * font, and case-insensitive, so a code cannot be entered "correctly" and still fail.
 */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 20 characters from a 30-character alphabet ≈ 98 bits. Not a guessable value. */
export const ENROLLMENT_CODE_LENGTH = 20;

/**
 * Generates a one-time enrollment code, grouped for legibility.
 *
 * Rejection sampling rather than `% alphabet.length`: the modulo would make the first six
 * characters of the alphabet slightly more likely than the rest, which is a real (if small) loss
 * of entropy in a value whose whole job is to be unguessable.
 */
export function generateEnrollmentCode(): string {
  const limit = 256 - (256 % CODE_ALPHABET.length);
  let code = '';

  while (code.length < ENROLLMENT_CODE_LENGTH) {
    for (const byte of randomBytes(ENROLLMENT_CODE_LENGTH)) {
      if (byte >= limit) continue;
      code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      if (code.length === ENROLLMENT_CODE_LENGTH) break;
    }
  }

  // Grouped as XXXXX-XXXXX-XXXXX-XXXXX. The dashes are presentation only and are stripped again
  // by `normaliseEnrollmentCode`, so a person may type them or not.
  return (code.match(/.{1,5}/g) ?? []).join('-');
}

/**
 * Canonicalises a typed code before it is hashed and looked up.
 *
 * Uppercases, and drops everything that is not in the alphabet — spaces, dashes, and the stray
 * characters a paste picks up. Returns null when what remains is not a whole code, so malformed
 * input never reaches the database.
 */
export function normaliseEnrollmentCode(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 128) return null;

  let cleaned = '';
  for (const character of raw.toUpperCase()) {
    if (CODE_ALPHABET.includes(character)) cleaned += character;
  }

  return cleaned.length === ENROLLMENT_CODE_LENGTH ? cleaned : null;
}

/**
 * Hashes an enrollment code for storage or lookup.
 *
 * ALWAYS through this function, never `hashToken` directly. A code is generated grouped
 * (`XXXXX-XXXXX-…`) and typed back in any form a person likes, so the hash must be taken over the
 * canonical value at both ends — storing the grouped form and looking up the normalised one is a
 * mismatch that makes every code fail, which is exactly the bug this exists to prevent.
 *
 * Returns null when the input is not a whole code.
 */
export function hashEnrollmentCode(raw: unknown): string | null {
  const normalised = normaliseEnrollmentCode(raw);
  return normalised === null ? null : hashToken(normalised);
}
