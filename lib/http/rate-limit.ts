/**
 * Request rate limiting (Phase 9).
 *
 * Two endpoints in this application accept a secret and answer "yes" or "no" to anyone who can
 * reach them: the administrator sign-in and the device enrollment code. Until now neither had a
 * ceiling, and both `lib/auth/admin.ts` and `app/api/enroll/route.ts` said so in their own
 * comments and deferred it to this phase. This module is that ceiling.
 *
 * WHAT IT IS. A fixed-window counter in this process's memory, with a penalty period once the
 * window is exhausted. No Redis, no external store, no new dependency — the deployment is one
 * Node process on one company server (D-09), so a shared store would be infrastructure bought to
 * synchronise a single writer with itself.
 *
 * WHAT IT IS NOT, stated because the limits of a control are part of the control:
 *
 *   - It does not survive a restart. Someone who can restart the server can reset a lockout, but
 *     someone who can restart the server already has the machine.
 *   - It is not a distributed limiter. If this application is ever run as more than one process,
 *     each keeps its own counts and the effective limit multiplies. That is a deployment change
 *     which would have to revisit this file (docs/19-phase-9-security-hardening.md).
 *   - It is not protection against a distributed attack. It raises the cost of guessing from one
 *     source; it cannot raise the cost of guessing from a thousand.
 *
 * It is deliberately pure and clock-injectable: what makes a limiter safe is the arithmetic, and
 * the arithmetic is only trustworthy if it can be tested without waiting fifteen minutes.
 */

/** One named limit. */
export interface RateLimitRule {
  /** Attempts permitted inside `windowMs`. */
  readonly limit: number;
  /** Length of the counting window, in milliseconds. */
  readonly windowMs: number;
  /**
   * How long a caller is refused after exhausting the window.
   *
   * Separate from `windowMs` on purpose. Without it, a limit of 10 per 15 minutes lets an
   * attacker make 10 guesses, wait for the window to roll, and make 10 more — a steady drip that
   * never trips anything. The penalty makes the (n+1)th attempt cost real time.
   */
  readonly blockMs: number;
}

export interface RateLimitVerdict {
  readonly allowed: boolean;
  /** Attempts left in the current window. Zero once blocked. */
  readonly remaining: number;
  /** Seconds until the caller may try again. Zero when allowed. Suitable for `Retry-After`. */
  readonly retryAfterSeconds: number;
}

interface Bucket {
  /** When the current counting window started. */
  windowStartedAt: number;
  count: number;
  /** Set when the window was exhausted; refusals continue until this passes. */
  blockedUntil: number;
  /** For eviction only. */
  touchedAt: number;
}

/**
 * How many distinct callers are tracked at once.
 *
 * Bounded because the key is derived from the client address, and a spray of source addresses
 * would otherwise grow this map without limit — turning a control against brute force into a way
 * to exhaust the server's memory.
 */
const DEFAULT_MAX_TRACKED = 4096;

export interface RateLimiterOptions {
  readonly maxTracked?: number;
  readonly now?: () => number;
}

export interface RateLimiter {
  /**
   * Records an attempt and says whether it is permitted.
   *
   * Call this for the attempt itself, not for its outcome: a limiter that only counted FAILED
   * sign-ins would let an attacker interleave a known-good request to keep its counter clear.
   */
  consume(key: string, rule: RateLimitRule): RateLimitVerdict;
  /**
   * Clears a caller's count.
   *
   * NOT wired into the HTTP path, and the reason is worth writing down. The natural use would be
   * "forget the failures once the administrator gets their token right" — but the limiter lives
   * in the custom server (server.ts) and the sign-in outcome is known inside a Next.js route
   * handler, and those are two separate module graphs: the route would reset a different
   * limiter's map. Rather than build a channel between them, the rules below are set wide enough
   * that a person typing a token never reaches them (see server.ts).
   */
  reset(key: string): void;
  /** Diagnostics and tests. Never used for a decision. */
  size(): number;
}

export function createRateLimiter(options: RateLimiterOptions = {}): RateLimiter {
  const now = options.now ?? (() => Date.now());
  const maxTracked = options.maxTracked ?? DEFAULT_MAX_TRACKED;
  const buckets = new Map<string, Bucket>();

  /**
   * Makes room when the map is full.
   *
   * Expired entries first — those are simply finished. Only if none has expired is the
   * least-recently-touched one dropped, which is the least-bad remaining option: it forgets the
   * caller who has been quiet longest, never the one currently being refused.
   */
  function evictIfFull(timestamp: number): void {
    if (buckets.size < maxTracked) return;

    for (const [key, bucket] of buckets) {
      if (isFinished(bucket, timestamp)) buckets.delete(key);
    }
    if (buckets.size < maxTracked) return;

    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [key, bucket] of buckets) {
      if (bucket.touchedAt < oldestAt) {
        oldestAt = bucket.touchedAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) buckets.delete(oldestKey);
  }

  function isFinished(bucket: Bucket, timestamp: number): boolean {
    return bucket.blockedUntil <= timestamp && bucket.windowStartedAt <= timestamp;
  }

  return {
    consume(key, rule): RateLimitVerdict {
      const timestamp = now();
      let bucket = buckets.get(key);

      // Still serving a penalty: refused without the attempt being counted again, so a client
      // that keeps hammering does not extend its own block indefinitely.
      if (bucket && bucket.blockedUntil > timestamp) {
        bucket.touchedAt = timestamp;
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: secondsUntil(bucket.blockedUntil, timestamp),
        };
      }

      // No bucket, or the previous window has rolled over.
      if (!bucket || timestamp - bucket.windowStartedAt >= rule.windowMs) {
        evictIfFull(timestamp);
        bucket = { windowStartedAt: timestamp, count: 0, blockedUntil: 0, touchedAt: timestamp };
        buckets.set(key, bucket);
      }

      bucket.count += 1;
      bucket.touchedAt = timestamp;

      if (bucket.count > rule.limit) {
        bucket.blockedUntil = timestamp + rule.blockMs;
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: secondsUntil(bucket.blockedUntil, timestamp),
        };
      }

      return {
        allowed: true,
        remaining: rule.limit - bucket.count,
        retryAfterSeconds: 0,
      };
    },

    reset(key): void {
      buckets.delete(key);
    },

    size(): number {
      return buckets.size;
    },
  };
}

/** Always at least one second: `Retry-After: 0` invites an immediate retry. */
function secondsUntil(deadline: number, timestamp: number): number {
  return Math.max(1, Math.ceil((deadline - timestamp) / 1000));
}
