/**
 * Client-side UUID generation.
 *
 * WHY THIS EXISTS. `crypto.randomUUID()` is only exposed in a **secure context**. Browsers treat
 * `http://localhost` as one by special exception, so it works all through development — and then
 * disappears the moment the same application is opened over plain HTTP at a LAN address such as
 * `http://192.168.29.244:3000`, which is exactly how employees reach it after Phase 8. The symptom
 * is `TypeError: crypto.randomUUID is not a function`, and it only ever appears on the machines
 * that matter.
 *
 * `crypto.getRandomValues()` carries no such restriction: it is available in every context,
 * secure or not. So the fallback is not a weaker source of randomness — it is the same CSPRNG,
 * reached through the API the browser is still willing to expose.
 *
 * `Math.random()` is deliberately NOT a fallback anywhere in this file. These values are
 * idempotency keys: two browsers that mint the same `clientMessageId` would have one person's
 * message silently collapse into another's, because the server treats a repeat of
 * `(senderId, clientMessageId)` as a retry of the same message. That is a correctness
 * requirement, not a security preference, and `Math.random` cannot meet it.
 */

/**
 * The subset of Web Crypto this module uses.
 *
 * Both members are optional because the whole point is that one of them may be missing. Injectable
 * so the tests can exercise each path for real rather than asserting on a mock of themselves.
 */
export interface UuidSource {
  randomUUID?: () => string;
  getRandomValues?: <T extends ArrayBufferView>(array: T) => T;
}

const HEX = Array.from({ length: 256 }, (_, value) => value.toString(16).padStart(2, '0'));

/** Formats 16 bytes as canonical 8-4-4-4-12 hyphenated hex. */
function format(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (value) => HEX[value] ?? '00').join('');
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  );
}

/**
 * Generates a UUID v4.
 *
 * Uses `crypto.randomUUID()` when the browser offers it, and otherwise builds the same thing from
 * `crypto.getRandomValues()`, setting the two fields RFC 4122 fixes:
 *
 *   byte 6, high nibble  →  0100   the version, 4
 *   byte 8, top two bits →  10     the variant, RFC 4122
 *
 * The remaining 122 bits are random. Both paths therefore produce a value of the same shape and
 * the same quality, and nothing downstream can tell which one made it.
 *
 * Throws if neither API exists. That is deliberate: there is no safe third option. A predictable
 * or colliding id would not fail loudly, it would silently merge two people's messages, so an
 * environment that cannot produce one is told so rather than handed a broken value.
 */
export function randomUuid(source: UuidSource | undefined = globalThis.crypto): string {
  if (source?.randomUUID) return source.randomUUID();

  if (source?.getRandomValues) {
    const bytes = source.getRandomValues(new Uint8Array(16));

    // Version 4: replace the high nibble of byte 6 with 0100.
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    // Variant: replace the top two bits of byte 8 with 10.
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

    return format(bytes);
  }

  throw new Error(
    'This browser provides no secure random source (crypto.getRandomValues is unavailable), ' +
      'so a message identifier cannot be generated.',
  );
}

/**
 * A fresh `clientMessageId`.
 *
 * Named for what it is used for rather than what it contains. The server treats
 * `(senderId, clientMessageId)` as the identity of a message, so this value is minted **once** per
 * message the user sends and reused unchanged on every retry — that is what makes a resend whose
 * acknowledgement was lost collide with the stored row instead of posting a second copy. Calling
 * this again for a retry would defeat the guard entirely.
 */
export function newClientMessageId(): string {
  return randomUuid();
}
