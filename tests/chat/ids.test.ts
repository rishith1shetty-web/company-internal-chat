/**
 * Client-side UUID generation, both paths.
 *
 * The fallback is the one that matters here. It is the path that runs on every employee computer
 * once the application is reached over plain HTTP at a LAN address, where `crypto.randomUUID` is
 * not exposed — and it is therefore the path that is never exercised by developing on localhost.
 */

import { randomFillSync } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { newClientMessageId, randomUuid, type UuidSource } from '@/lib/chat/ids';
import { sendMessageSchema } from '@/lib/realtime/events';

/** Canonical UUID v4: version nibble `4`, variant nibble one of 8/9/a/b. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * A source with `getRandomValues` and no `randomUUID` — an insecure-context browser.
 *
 * The bytes come from Node's real CSPRNG rather than a fixed pattern, so the formatting and the
 * bit-fiddling are checked against arbitrary input rather than one lucky vector.
 */
function insecureContextSource(): UuidSource {
  return {
    getRandomValues: <T extends ArrayBufferView>(array: T): T => {
      randomFillSync(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
      return array;
    },
  };
}

describe('the native path', () => {
  it('uses crypto.randomUUID when the browser offers it', () => {
    const randomUUID = vi.fn(() => '11111111-2222-4333-8444-555555555555');
    const getRandomValues = vi.fn();

    const value = randomUuid({ randomUUID, getRandomValues });

    expect(value).toBe('11111111-2222-4333-8444-555555555555');
    expect(randomUUID).toHaveBeenCalledTimes(1);
    // The fallback must not run when the native call succeeded.
    expect(getRandomValues).not.toHaveBeenCalled();
  });

  it('produces a valid v4 from the real platform crypto', () => {
    expect(randomUuid()).toMatch(UUID_V4);
  });
});

describe('the getRandomValues fallback', () => {
  it('is used when randomUUID is missing', () => {
    const source = insecureContextSource();
    const spy = vi.spyOn(source, 'getRandomValues');

    expect(randomUuid(source)).toMatch(UUID_V4);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('produces a valid v4 every time, over many draws', () => {
    const source = insecureContextSource();
    for (let attempt = 0; attempt < 500; attempt += 1) {
      expect(randomUuid(source)).toMatch(UUID_V4);
    }
  });

  /*
   * The two fields RFC 4122 fixes, checked against a source of all-zero and all-one bytes — the
   * inputs that would expose a mask applied to the wrong nibble or the wrong byte.
   */
  it('sets the version and variant bits regardless of the random input', () => {
    for (const fill of [0x00, 0xff, 0x0f, 0xf0]) {
      const source: UuidSource = {
        getRandomValues: <T extends ArrayBufferView>(array: T): T => {
          new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(fill);
          return array;
        },
      };

      const value = randomUuid(source);
      expect(value, `fill 0x${fill.toString(16)}`).toMatch(UUID_V4);
      // Version nibble is the 15th hex digit; variant nibble the 20th.
      expect(value[14], `fill 0x${fill.toString(16)}`).toBe('4');
      expect(['8', '9', 'a', 'b']).toContain(value[19]);
    }
  });

  it('preserves the randomness it was given in the other bytes', () => {
    const source: UuidSource = {
      getRandomValues: <T extends ArrayBufferView>(array: T): T => {
        const view = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
        for (let index = 0; index < view.length; index += 1) view[index] = index;
        return array;
      },
    };
    // 00 01 02 03 04 05 [06→46] 07 [08→88] 09 0a 0b 0c 0d 0e 0f
    expect(randomUuid(source)).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
  });
});

describe('uniqueness', () => {
  it('does not repeat across many native calls', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 1_000; index += 1) seen.add(randomUuid());
    expect(seen.size).toBe(1_000);
  });

  it('does not repeat across many fallback calls', () => {
    const source = insecureContextSource();
    const seen = new Set<string>();
    for (let index = 0; index < 1_000; index += 1) seen.add(randomUuid(source));
    expect(seen.size).toBe(1_000);
  });
});

describe('when there is no secure random source at all', () => {
  /*
   * Throwing is the deliberate choice. There is no safe third option: `Math.random()` would not
   * fail loudly, it would silently produce colliding idempotency keys, and the server treats a
   * repeated `(senderId, clientMessageId)` as a retry — so two people's messages would merge.
   */
  it('throws rather than falling back to a weak source', () => {
    // A crypto object that offers neither API — and, below, no crypto object at all, which is
    // what `globalThis.crypto` would be on a browser old enough to lack Web Crypto entirely.
    expect(() => randomUuid({})).toThrow(/no secure random source/i);
    expect(() => randomUuid({ randomUUID: undefined, getRandomValues: undefined })).toThrow(
      /no secure random source/i,
    );
  });

  /*
   * Passing nothing is NOT the "no source" case: the default parameter resolves to
   * `globalThis.crypto`, which is the whole point of the helper being callable with no arguments
   * from application code.
   */
  it('falls back to the platform crypto when no source is passed', () => {
    expect(randomUuid(undefined)).toMatch(UUID_V4);
    expect(randomUuid()).toMatch(UUID_V4);
  });
});

describe('newClientMessageId', () => {
  it('returns a valid v4', () => {
    expect(newClientMessageId()).toMatch(UUID_V4);
  });

  it('returns a different value each time, so two messages are never the same message', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 500; index += 1) seen.add(newClientMessageId());
    expect(seen.size).toBe(500);
  });
});

/*
 * The check that makes the fix real.
 *
 * The server validates `clientMessageId` with `z.uuid({ version: 'v4' })` — strict, version-aware,
 * and the same schema on both the socket path and the attachment upload route. A fallback that
 * produced a merely UUID-shaped string would send fine and then be refused as an invalid request,
 * which is a worse failure than the TypeError it replaced. So the generated value is run through
 * the application's own schema rather than through a regular expression written to agree with it.
 */
describe('acceptance by the server contract', () => {
  it('accepts a natively generated id', () => {
    const result = sendMessageSchema.safeParse({
      conversationId: randomUuid(),
      body: 'hello',
      clientMessageId: newClientMessageId(),
    });
    expect(result.success).toBe(true);
  });

  it('accepts a fallback-generated id, over many draws', () => {
    const source = insecureContextSource();

    for (let attempt = 0; attempt < 200; attempt += 1) {
      const result = sendMessageSchema.safeParse({
        conversationId: randomUuid(source),
        body: 'hello',
        clientMessageId: randomUuid(source),
      });
      expect(result.success, `attempt ${attempt}`).toBe(true);
    }
  });
});
