/**
 * The Prisma client is one client per process, in every environment.
 *
 * This exists because it once was not. `getDb()` cached the instance only outside production, on
 * the reasoning that a module evaluated once needs no cache — but nothing else held the client,
 * so in production every call built a new one with a new connection pool. A server accumulated
 * connections request by request until PostgreSQL refused them and every route began failing with
 * "remaining connection slots are reserved for roles with the SUPERUSER attribute".
 *
 * The failure is invisible in development, invisible in unit tests, and invisible until a
 * production build has served a few hundred requests. So it is asserted directly, with
 * `NODE_ENV` set to production, rather than left to be found again the same way.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { disconnectDb, getDb, isDatabaseConfigured } from '@/lib/db/prisma';

const suite = isDatabaseConfigured() ? describe : describe.skip;

suite('the database client', () => {
  afterAll(async () => {
    await disconnectDb();
  });

  it('is the same instance every time, including in production', () => {
    /*
     * `NODE_ENV` is typed read-only and refuses a redefined property descriptor, so it is set
     * through a plain string map. The cast is confined to this test: production code reads the
     * variable and never writes it.
     */
    const env = process.env as Record<string, string | undefined>;
    const original = env['NODE_ENV'];

    try {
      env['NODE_ENV'] = 'production';

      const first = getDb();
      const second = getDb();
      const third = getDb();

      // Reference equality is the assertion: a second instance means a second pool.
      expect(second).toBe(first);
      expect(third).toBe(first);
    } finally {
      if (original === undefined) delete env['NODE_ENV'];
      else env['NODE_ENV'] = original;
    }
  });

  it('hands out a fresh client after the pool is closed', async () => {
    const before = getDb();
    await disconnectDb();

    const after = getDb();
    // Not the same object: the previous one has no pool left to use. Reconnecting through the
    // cached instance would hand callers a client that can no longer reach the database.
    expect(after).not.toBe(before);
  });
});
