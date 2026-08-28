/**
 * Prisma client access layer (docs/01-architecture.md §4, `lib/db/`).
 *
 * The only place in the application that constructs a `PrismaClient`. Services import `getDb()`;
 * nothing else instantiates a client, reads `DATABASE_URL`, or opens a connection pool.
 *
 * Three things this module is responsible for:
 *
 * 1. **One client per process.** Next.js development reloads modules on every edit; a client
 *    created at module scope would leak a connection pool per reload until PostgreSQL refuses
 *    new connections. The instance is therefore cached on `globalThis` in development, which is
 *    the standard remedy. In production the module is evaluated once and the cache is unused.
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
 * Cached across module reloads in development only. Typed on `globalThis` rather than cast at
 * the use site so the shape stays checked.
 */
const globalForPrisma = globalThis as unknown as {
  __companyChatPrisma?: PrismaClient;
};

function createClient(): PrismaClient {
  // Throws unless DATABASE_URL is present, well-formed, and targets company_chat_db.
  const target = parseDatabaseUrl(process.env['DATABASE_URL']);

  const adapter = new PrismaPg({
    connectionString: process.env['DATABASE_URL'],
    // Named so this project's connections are identifiable in pg_stat_activity when
    // diagnosing a problem on the company server.
    application_name: `company-internal-chat (${target.database})`,
  });

  return new PrismaClient({
    adapter,
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

  if (process.env['NODE_ENV'] !== 'production') {
    globalForPrisma.__companyChatPrisma = client;
  }

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
