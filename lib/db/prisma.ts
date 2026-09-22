/**
 * Prisma client access layer (docs/01-architecture.md §4, `lib/db/`).
 *
 * The only place in the application that constructs a `PrismaClient`. Services import `getDb()`;
 * nothing else instantiates a client, reads `DATABASE_URL`, or opens a connection pool.
 *
 * Three things this module is responsible for:
 *
 * 1. **One client per process, in every environment.** The instance is cached on `globalThis`,
 *    which is the standard remedy for Next.js development reloading modules on every edit — a
 *    client at module scope would leak a connection pool per reload until PostgreSQL refuses new
 *    connections.
 *
 *    The cache is NOT skipped in production, and that is the whole point of this note. It was,
 *    on the reasoning that the module is evaluated once there so a cache would be redundant. It
 *    is not redundant: nothing here holds the client except the cache, so skipping it made every
 *    single `getDb()` call construct a fresh client and a fresh pool. A production server then
 *    accumulates connections request by request until PostgreSQL answers "remaining connection
 *    slots are reserved for roles with the SUPERUSER attribute" and every route starts failing.
 *    Found in the Phase 6 browser regression, which was the first thing to put sustained traffic
 *    through a production build.
 *
 * 2. **The single-database guard.** The connection string is parsed through `lib/db/target.ts`
 *    before a client exists, so a `DATABASE_URL` pointing anywhere other than `company_chat_db`
 *    fails immediately with an explanatory error instead of connecting (docs/02-database.md §0).
 *
 * 3. **Lazy construction.** `getDb()` connects on first use, not at import time. The Phase 2
 *    interface still runs with no `.env` at all; only code that actually needs the database
 *    fails when the database is not configured, and it fails with a clear message.
 *
 * Prisma 7 requires a driver adapter for a direct database connection, so the pool is owned by
 * `@prisma/adapter-pg` (node-postgres) and handed to the client.
 */

import { PrismaPg } from '@prisma/adapter-pg';

// Relative imports, not the `@/` alias: this module is compiled by tsconfig.server.json into
// dist/ with plain tsc, which does not rewrite path aliases (see lib/logging/logger.ts).
import { PrismaClient } from '../../prisma/generated/client';
import { parseDatabaseUrl } from './target';

/**
 * The one client, cached across module reloads and across the separately-bundled copies of this
 * module that Next.js and the custom server each load. Typed on `globalThis` rather than cast at
 * the use site so the shape stays checked.
 */
const globalForPrisma = globalThis as unknown as {
  __companyChatPrisma?: PrismaClient;
};

/**
 * libpq connection options applied to EVERY connection this project opens.
 *
 * `timezone=UTC` is not a preference. It is what makes a stored timestamp mean what it says.
 *
 * THE BUG THIS FIXES, precisely. Prisma hands a `DateTime` to the driver as the instant's UTC
 * wall clock in a NAIVE, offset-less form — `2026-09-22 16:00:00` for `2026-09-22T16:00:00Z`.
 * PostgreSQL has to attach an offset to a naive literal, and the one it attaches is the SESSION
 * timezone's. This machine's cluster was initialised from the operating system, so its session
 * timezone is `America/New_York`, and the row therefore stored `2026-09-22 16:00:00-04` — the
 * instant `20:00Z`, four hours after the one that was written.
 *
 * It went unnoticed for so long because the READ path is exactly symmetric: PostgreSQL renders
 * the row back in the same session zone, Prisma keeps the naive part and calls it UTC, and the
 * original instant comes back intact. Every comparison the application makes is between two
 * values that carry the identical error, so ordering, unread counts, read watermarks and
 * session expiry all behaved correctly while the stored data was wrong.
 *
 * Three things it was NOT safe to leave alone:
 *
 *   1. The skew is the session's offset, so it is +5h in winter and +4h in summer — a stored
 *      value cannot be corrected by subtracting any single interval.
 *   2. A naive literal landing in the spring-forward gap (a local time that does not exist)
 *      cannot round-trip, so messages sent during that hour come back an hour out and can sort
 *      into the wrong order.
 *   3. Restoring a backup onto a cluster whose timezone setting differs — a different server, a
 *      cloud instance, a colleague's machine — re-reads every historical row through the wrong
 *      offset. The database was only readable on a machine configured exactly like this one.
 *
 * With the session pinned to UTC the naive literal is interpreted as what it actually is, the
 * stored instant is correct, and the read path stays symmetric. Nothing in the application's own
 * comparisons changes.
 *
 * It is set here rather than in `production.env` deliberately: it is a correctness invariant of
 * the data layer, not a deployment choice, and a connection opened by a script or a test must
 * carry it too. `lib/time/company-time.ts` handles the other half — showing those correct
 * instants to employees in company time.
 */
export const DATABASE_SESSION_OPTIONS = '-c timezone=UTC';

/**
 * The driver adapter, configured identically everywhere.
 *
 * A factory rather than a documented convention, because the convention was the problem: seven
 * places in this project construct a client, and one that quietly omitted the session options
 * would write skewed rows into the same database the others were writing correct ones into.
 * There is nowhere to forget it now.
 */
export function createDatabaseAdapter(applicationName?: string): PrismaPg {
  return new PrismaPg({
    connectionString: process.env['DATABASE_URL'],
    options: DATABASE_SESSION_OPTIONS,
    // Named so this project's connections are identifiable in pg_stat_activity when
    // diagnosing a problem on the company server.
    ...(applicationName === undefined ? {} : { application_name: applicationName }),
  });
}

function createClient(): PrismaClient {
  // Throws unless DATABASE_URL is present, well-formed, and targets company_chat_db.
  const target = parseDatabaseUrl(process.env['DATABASE_URL']);

  return new PrismaClient({
    adapter: createDatabaseAdapter(`company-internal-chat (${target.database})`),
    // Errors and warnings only. Query logging would put message bodies in the log, which
    // CLAUDE.md §14 forbids.
    log: ['warn', 'error'],
  });
}

/**
 * The process-wide Prisma client, created on first call.
 *
 * @throws DatabaseTargetError when DATABASE_URL is missing or does not target company_chat_db.
 */
export function getDb(): PrismaClient {
  const existing = globalForPrisma.__companyChatPrisma;
  if (existing) return existing;

  const client = createClient();

  // Unconditionally, including in production: see note 1 above. Without this line the pool is
  // per-call rather than per-process, and the server exhausts PostgreSQL under ordinary use.
  globalForPrisma.__companyChatPrisma = client;

  return client;
}

/**
 * Closes the pool. Used by the server's shutdown handler and by tests; ordinary request handling
 * never calls this.
 */
export async function disconnectDb(): Promise<void> {
  const client = globalForPrisma.__companyChatPrisma;
  if (client) {
    globalForPrisma.__companyChatPrisma = undefined;
    await client.$disconnect();
  }
}

/** True when a database connection is configured at all. Never throws. */
export function isDatabaseConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof env['DATABASE_URL'] === 'string' && env['DATABASE_URL'].trim().length > 0;
}
