/**
 * ONE-TIME: remove ALL application data before the real office rollout.
 *
 *   npx tsx scripts/db-reset-application-data.ts                      # dry run — the default
 *   CONFIRM_ERASE_ALL_DATA=yes npx tsx scripts/db-reset-application-data.ts --erase-all-application-data
 *
 * This is NOT `scripts/db-cleanup-e2e.ts`. That one removes the rows of one test harness, by
 * prefix, and refuses to touch anything else. This one removes EVERY user, device, session,
 * conversation, membership, message and attachment in `company_chat_db` — development data,
 * leftover test data and anything else — so a company can start from an empty system.
 *
 * WHAT IT DELIBERATELY WILL NOT DO, which matters more than what it does:
 *
 *   - It issues no DDL. No DROP DATABASE, no DROP TABLE, no TRUNCATE, no schema change of any
 *     kind. Every deletion is an ordinary parameterised DELETE through Prisma, so the tables,
 *     indexes, constraints and enums are exactly as they were afterwards.
 *   - It never touches `_prisma_migrations`. That table is not a Prisma model, so `deleteMany`
 *     cannot reach it — and the migration count is read before and after and compared, so the
 *     claim is proven rather than asserted.
 *   - It refuses any database but `company_chat_db`, through the same guard the application uses.
 *   - It refuses to run as a PostgreSQL superuser.
 *   - It does nothing at all unless BOTH an environment variable and a command-line flag say so.
 *     A dry run is the default, so the operator sees exactly what would go before anything can.
 *   - It deletes files only by the `storageKey` values it read out of the database, inside the
 *     configured UPLOAD_DIR. It never removes a directory and never deletes a file it cannot
 *     account for, unless `--sweep-orphans` is given as a separate, deliberate act.
 *
 * ORDER OF OPERATIONS. Rows are deleted inside one transaction, in explicit foreign-key order,
 * parent-last — nothing relies on a cascade doing the right thing silently, and every row removed
 * is counted. Files are deleted only AFTER that transaction commits: a file with no row is an
 * orphan the sweep below can find, while a row with no file is a broken download.
 */

import { readdir, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';

import { loadConfig } from '../lib/config/env';
import { parseDatabaseUrl } from '../lib/db/target';
import { deleteStoredFile } from '../lib/files/storage';
import { PrismaClient } from '../prisma/generated/client';

/** Both are required. Two independent gestures, so neither alone can erase a company's data. */
const CONFIRM_ENV = 'CONFIRM_ERASE_ALL_DATA';
const CONFIRM_ENV_VALUE = 'yes';
const CONFIRM_FLAG = '--erase-all-application-data';

/**
 * The tables this script expects to find, and the only ones it touches.
 *
 * Checked against the live schema before anything is deleted. A table missing from the database,
 * or an application table present that this script does not know about, means the schema has
 * moved on and this script has not — and a data wipe that silently skips a table is worse than
 * one that refuses to start.
 */
const APPLICATION_TABLES = [
  'Attachment',
  'Conversation',
  'ConversationMember',
  'Device',
  'Message',
  'Session',
  'User',
] as const;

/** Prisma's own bookkeeping. Never read for deletion; read only to prove it was left alone. */
const MIGRATIONS_TABLE = '_prisma_migrations';

/** A stored file, as `lib/files/storage.ts` names one: `YYYY/MM/<uuid>.bin`. */
const STORAGE_KEY_SHAPE = /^\d{4}\/\d{2}\/[0-9a-f-]{36}\.bin$/i;

/** An interrupted upload, in the storage root's `tmp/` directory. */
const PARTIAL_SHAPE = /^tmp\/[0-9a-f-]{36}\.part$/i;

type TableName = (typeof APPLICATION_TABLES)[number];

const out = (text = '') => process.stdout.write(`${text}\n`);
// A function declaration, not a const arrow: TypeScript applies never-returning control-flow
// analysis only to declarations (or to a const with an explicit type annotation), and without it
// every `if (!x) fail(...)` below fails to narrow `x`.
function fail(text: string): never {
  process.stderr.write(`${text}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // A missing .env is not an error here; the target guard below reports the real problem.
  }

  const armed =
    process.argv.includes(CONFIRM_FLAG) && process.env[CONFIRM_ENV] === CONFIRM_ENV_VALUE;
  const sweepOrphans = process.argv.includes('--sweep-orphans');

  /* ------------------------------------------------------------------ safeguard 1: the target */

  // Throws unless DATABASE_URL names company_chat_db. Same guard the application itself uses.
  const target = parseDatabaseUrl(process.env['DATABASE_URL']);
  const config = loadConfig();

  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env['DATABASE_URL'] }),
  });

  try {
    out();
    out('  ERASE ALL APPLICATION DATA');
    out('  ─────────────────────────────────────────────────────────────────────────────');
    out(`  database    ${target.redacted}`);
    out(`  storage     ${config.uploadDir}`);
    out(`  mode        ${armed ? 'ARMED — data will be deleted' : 'DRY RUN — nothing will change'}`);
    out();

    /* ---------------------------------------------------------- safeguard 2: not a superuser */

    const [identity] = await db.$queryRaw<{ role: string; isSuperuser: boolean }[]>`
      SELECT current_user AS "role",
             COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false)
               AS "isSuperuser"
    `;

    if (!identity) fail('  Refusing to run: could not determine the PostgreSQL role.');

    if (identity.isSuperuser) {
      fail(
        `  Refusing to run: connected as "${identity.role}", which is a PostgreSQL SUPERUSER.\n` +
          '  This project connects only as its dedicated non-superuser role (docs/02-database.md §0).\n' +
          '  Point DATABASE_URL at company_chat_app and run it again.',
      );
    }

    out(`  role        ${identity.role} (not a superuser) ✓`);

    /* --------------------------------------------- safeguard 3: the schema is the one expected */

    const tables = await liveTables(db);
    const missing = APPLICATION_TABLES.filter((name) => !tables.includes(name));
    if (missing.length > 0) {
      fail(
        `  Refusing to run: these tables are not in the database: ${missing.join(', ')}.\n` +
          '  Run `npm run db:status` — the schema is not the one this script was written for.',
      );
    }

    const unknown = tables.filter(
      (name) => name !== MIGRATIONS_TABLE && !APPLICATION_TABLES.includes(name as TableName),
    );
    if (unknown.length > 0) {
      fail(
        `  Refusing to run: unrecognised table(s) present: ${unknown.join(', ')}.\n` +
          '  A newer schema may hold application data this script does not know to delete.\n' +
          '  Add them to APPLICATION_TABLES, in foreign-key order, before running this.',
      );
    }

    if (!tables.includes(MIGRATIONS_TABLE)) {
      fail(`  Refusing to run: ${MIGRATIONS_TABLE} is missing. This is not a migrated database.`);
    }

    const migrationsBefore = await migrationCount(db);
    out(`  schema      ${APPLICATION_TABLES.length} application tables, ${migrationsBefore} migrations ✓`);
    out();

    /* ------------------------------------------------------------------ safeguard 6: counts before */

    const before = await counts(db);
    out('  Rows now');
    printCounts(before);

    const storedKeys = (
      await db.attachment.findMany({ select: { storageKey: true } })
    ).map((row) => row.storageKey);
    out(`  Attachment files recorded in the database: ${storedKeys.length}`);
    out();

    const totalRows = Object.values(before).reduce((sum, n) => sum + n, 0);

    if (!armed) {
      out('  ─────────────────────────────────────────────────────────────────────────────');
      out(`  DRY RUN. Nothing was changed. ${totalRows} row(s) and ${storedKeys.length} file(s) would be removed.`);
      out();
      out('  To actually erase everything, run BOTH of these together:');
      out();
      out(`      ${CONFIRM_ENV}=${CONFIRM_ENV_VALUE} npx tsx scripts/db-reset-application-data.ts ${CONFIRM_FLAG}`);
      out();
      out('  Add --sweep-orphans to also remove stored files that no database row refers to.');
      out();
      return;
    }

    if (totalRows === 0 && storedKeys.length === 0) {
      out('  Nothing to delete: the application tables are already empty.');
      out();
      return;
    }

    /* ------------------------------------- safeguard 7: one transaction, explicit FK order */

    /*
     * Parent-last, so no statement can violate a foreign key and nothing depends on a cascade
     * firing. Attachment references Conversation, Message and User; Message references
     * Conversation and User; ConversationMember references both; Conversation references User;
     * Session references User and Device; Device references User. So:
     *
     *   Attachment → Message → ConversationMember → Conversation → Session → Device → User
     */
    const deleted = await db.$transaction(async (tx) => ({
      Attachment: (await tx.attachment.deleteMany({})).count,
      Message: (await tx.message.deleteMany({})).count,
      ConversationMember: (await tx.conversationMember.deleteMany({})).count,
      Conversation: (await tx.conversation.deleteMany({})).count,
      Session: (await tx.session.deleteMany({})).count,
      Device: (await tx.device.deleteMany({})).count,
      User: (await tx.user.deleteMany({})).count,
    }));

    out('  Deleted (one transaction, foreign-key order)');
    printCounts(deleted);
    out();

    /* ---------------------------------------------------------------- stored files, after commit */

    let filesRemoved = 0;
    for (const key of storedKeys) {
      // Resolves the key and refuses anything outside the storage root before unlinking.
      if (await deleteStoredFile({ uploadDir: config.uploadDir, maxFileSize: config.maxFileSize }, key)) {
        filesRemoved += 1;
      }
    }
    out(`  Removed ${filesRemoved} of ${storedKeys.length} recorded attachment file(s).`);

    const leftovers = await findStoredFiles(config.uploadDir);
    if (leftovers.length === 0) {
      out('  No unaccounted files remain under the storage directory.');
    } else if (sweepOrphans) {
      let swept = 0;
      for (const key of leftovers) {
        if (
          await deleteStoredFile({ uploadDir: config.uploadDir, maxFileSize: config.maxFileSize }, key)
        ) {
          swept += 1;
        }
      }
      out(`  Swept ${swept} orphaned file(s) that no database row referred to.`);
    } else {
      out(`  ${leftovers.length} file(s) remain that no database row referred to. They are inert —`);
      out('  nothing can reach a stored file without a row naming it. Re-run with --sweep-orphans');
      out('  to remove them.');
      for (const key of leftovers.slice(0, 10)) out(`      ${key}`);
      if (leftovers.length > 10) out(`      ... and ${leftovers.length - 10} more`);
    }
    out();

    /* ------------------------------- safeguards 8 and 9: prove the result and the preservation */

    const after = await counts(db);
    out('  Rows now');
    printCounts(after);

    const remaining = Object.values(after).reduce((sum, n) => sum + n, 0);
    const migrationsAfter = await migrationCount(db);
    const tablesAfter = await liveTables(db);

    const tablesIntact =
      APPLICATION_TABLES.every((name) => tablesAfter.includes(name)) &&
      tablesAfter.includes(MIGRATIONS_TABLE);

    out();
    out('  ─────────────────────────────────────────────────────────────────────────────');
    out(`  Application tables empty      ${remaining === 0 ? 'YES ✓' : `NO — ${remaining} row(s) left`}`);
    out(`  Tables still present          ${tablesIntact ? `YES ✓ (${tablesAfter.length})` : 'NO — STRUCTURE CHANGED'}`);
    out(
      `  Migration history untouched   ${
        migrationsAfter === migrationsBefore
          ? `YES ✓ (${migrationsAfter} rows, unchanged)`
          : `NO — was ${migrationsBefore}, now ${migrationsAfter}`
      }`,
    );
    out();

    if (remaining !== 0 || !tablesIntact || migrationsAfter !== migrationsBefore) {
      fail('  The end state is not what it should be. Investigate before rolling out.');
    }

    out('  The system is empty and ready for the rollout. Register each computer in /admin.');
    out();
  } finally {
    await db.$disconnect();
  }
}

/* ------------------------------------------------------------------------------- helpers */

async function liveTables(db: PrismaClient): Promise<string[]> {
  const rows = await db.$queryRaw<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `;
  return rows.map((row) => row.table_name);
}

async function migrationCount(db: PrismaClient): Promise<number> {
  // Read-only, and the only statement in this file that names the migrations table at all.
  const rows = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM _prisma_migrations`;
  return Number(rows[0]?.n ?? 0n);
}

async function counts(db: PrismaClient): Promise<Record<TableName, number>> {
  return {
    Attachment: await db.attachment.count(),
    Conversation: await db.conversation.count(),
    ConversationMember: await db.conversationMember.count(),
    Device: await db.device.count(),
    Message: await db.message.count(),
    Session: await db.session.count(),
    User: await db.user.count(),
  };
}

function printCounts(values: Record<string, number>): void {
  for (const name of [...APPLICATION_TABLES].sort()) {
    out(`      ${name.padEnd(20)} ${String(values[name] ?? 0).padStart(6)}`);
  }
}

/**
 * Every file under the storage root that looks like something this application stored.
 *
 * Shape-matched on purpose. The storage root is configuration and could, through a mistaken
 * UPLOAD_DIR, point somewhere with unrelated files in it — so this reports only paths of the form
 * `YYYY/MM/<uuid>.bin` and `tmp/<uuid>.part`, which nothing but `lib/files/storage.ts` produces.
 * Anything else is listed by neither this function nor removed by the sweep.
 */
async function findStoredFiles(uploadDir: string): Promise<string[]> {
  const root = resolve(uploadDir);
  const found: string[] = [];

  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return; // The storage directory may not exist yet. Not an error.
    }

    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }

      const key = relative(root, full).split(sep).join('/');
      if (STORAGE_KEY_SHAPE.test(key) || PARTIAL_SHAPE.test(key)) found.push(key);
    }
  }

  try {
    if (!(await stat(root)).isDirectory()) return [];
  } catch {
    return [];
  }

  await walk(root);
  return found;
}

main().catch((error: unknown) => {
  process.stderr.write(`\n  ${error instanceof Error ? error.message : String(error)}\n\n`);
  process.exit(1);
});
