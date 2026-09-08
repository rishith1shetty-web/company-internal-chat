/**
 * The rate limiter's arithmetic (Phase 9).
 *
 * Every test here injects the clock. A limiter is only trustworthy if its behaviour at the
 * boundaries can be checked exactly, and a test that waited out a fifteen-minute window would
 * either be skipped or be quietly shortened until it stopped testing the real numbers.
 *
 * What is being pinned down is not "does it refuse" — anything refuses eventually. It is the two
 * ways a limiter is usually wrong: letting the (limit + 1)th attempt through, and letting an
 * attacker reset their own budget by waiting for a window to roll.
 */

import { describe, expect, it } from 'vitest';

import { createRateLimiter, type RateLimitRule } from '@/lib/http/rate-limit';

/** Small numbers, so an off-by-one is visible rather than buried in a count of ten. */
const RULE: RateLimitRule = { limit: 3, windowMs: 1_000, blockMs: 5_000 };

/** A clock the test moves by hand. */
function clock(startAt = 1_000_000) {
  let current = startAt;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('inside the window', () => {
  it('permits exactly the configured number of attempts', () => {
    const time = clock();
    const limiter = createRateLimiter({ now: time.now });

    expect(limiter.consume('a', RULE).allowed).toBe(true);
    expect(limiter.consume('a', RULE).allowed).toBe(true);
    expect(limiter.consume('a', RULE).allowed).toBe(true);
    // The fourth is the first refusal: `limit` means attempts permitted, not attempts before the
    // limit applies.
    expect(limiter.consume('a', RULE).allowed).toBe(false);
  });

  it('counts down what is left, so the caller is never guessing', () => {
    const time = clock();
    const limiter = createRateLimiter({ now: time.now });

    expect(limiter.consume('a', RULE).remaining).toBe(2);
    expect(limiter.consume('a', RULE).remaining).toBe(1);
    expect(limiter.consume('a', RULE).remaining).toBe(0);
  });

  it('counts every attempt, not only the failures', () => {
    /*
     * The limiter is consumed by the REQUEST, before anyone knows whether the secret was right.
     * A limiter that only counted failures could be kept clear by interleaving one known-good
     * request, which is exactly what somebody who has one valid code and wants to guess another
     * would do.
     */
    const time = clock();
    const limiter = createRateLimiter({ now: time.now });

    for (let attempt = 0; attempt < 3; attempt += 1) limiter.consume('a', RULE);
    expect(limiter.consume('a', RULE).allowed).toBe(false);
  });

  it('keeps separate callers separate', () => {
    const time = clock();
    const limiter = createRateLimiter({ now: time.now });

    for (let attempt = 0; attempt < 4; attempt += 1) limiter.consume('noisy', RULE);

    // One address exhausting its budget must not refuse everybody else — that would turn the
    // control into a way to lock the company out.
    expect(limiter.consume('quiet', RULE).allowed).toBe(true);
  });
});

describe('once the window is exhausted', () => {
  it('keeps refusing for the whole penalty, not just to the end of the window', () => {
    /*
     * THE TEST THIS FILE EXISTS FOR. Without a penalty, a limit of three per second is three
     * guesses a second forever: exhaust, wait for the window to roll, exhaust again. The block is
     * what makes the attempt after the limit actually cost time.
     */
    const time = clock();
    const limiter = createRateLimiter({ now: time.now });

    for (let attempt = 0; attempt < 4; attempt += 1) limiter.consume('a', RULE);

    // The counting window has rolled over several times by now.
    time.advance(2_000);
    expect(limiter.consume('a', RULE).allowed).toBe(false);

    time.advance(2_000);
    expect(limiter.consume('a', RULE).allowed).toBe(false);
  });

  it('lets the caller back in once the penalty has passed', () => {
    const time = clock();
    const limiter = createRateLimiter({ now: time.now });

    for (let attempt = 0; attempt < 4; attempt += 1) limiter.consume('a', RULE);

    time.advance(RULE.blockMs + 1);
    expect(limiter.consume('a', RULE).allowed).toBe(true);
  });

  it('does not extend its own block by being hammered', () => {
    // Otherwise a client retrying in a loop would never be let back in, and an accidental retry
    // loop in a browser would look identical to an attack.
    const time = clock();
    const limiter = createRateLimiter({ now: time.now });

    for (let attempt = 0; attempt < 4; attempt += 1) limiter.consume('a', RULE);

    time.advance(1_000);
    for (let attempt = 0; attempt < 50; attempt += 1) limiter.consume('a', RULE);

    // Still exactly `blockMs` from when the block started, not from the last of those 50.
    time.advance(RULE.blockMs - 1_000 + 1);
    expect(limiter.consume('a', RULE).allowed).toBe(true);
  });

  it('reports a retry time that is never zero', () => {
    // `Retry-After: 0` is an invitation to try again immediately, which is the opposite of what
    // a refusal means.
    const time = clock();
    const limiter = createRateLimiter({ now: time.now });

    for (let attempt = 0; attempt < 4; attempt += 1) limiter.consume('a', RULE);

    const verdict = limiter.consume('a', RULE);
    expect(verdict.retryAfterSeconds).toBeGreaterThan(0);
    expect(verdict.retryAfterSeconds).toBeLessThanOrEqual(RULE.blockMs / 1000);
  });
});

describe('when the window rolls over normally', () => {
  it('gives a caller who stayed under the limit a fresh budget', () => {
    const time = clock();
    const limiter = createRateLimiter({ now: time.now });

    limiter.consume('a', RULE);
    limiter.consume('a', RULE);

    time.advance(RULE.windowMs + 1);

    expect(limiter.consume('a', RULE).remaining).toBe(2);
  });
});

describe('memory', () => {
  it('does not grow without limit when sprayed with distinct callers', () => {
    /*
     * The key is derived from the client address. Without a ceiling, a control against guessing
     * would become a way to spend the server's memory — a worse problem than the one it solves.
     */
    const time = clock();
    const limiter = createRateLimiter({ now: time.now, maxTracked: 16 });

    for (let index = 0; index < 500; index += 1) {
      limiter.consume(`caller-${index}`, RULE);
    }

    expect(limiter.size()).toBeLessThanOrEqual(16);
  });

  it('still refuses the caller it is currently blocking after an eviction sweep', () => {
    // Eviction must not become a way to clear your own block by sending traffic from many
    // addresses: the entry being enforced is the most recently touched, never the oldest.
    const time = clock();
    const limiter = createRateLimiter({ now: time.now, maxTracked: 8 });

    for (let attempt = 0; attempt < 4; attempt += 1) limiter.consume('target', RULE);

    for (let index = 0; index < 6; index += 1) {
      time.advance(1);
      limiter.consume(`filler-${index}`, RULE);
    }

    time.advance(1);
    expect(limiter.consume('target', RULE).allowed).toBe(false);
  });
});
