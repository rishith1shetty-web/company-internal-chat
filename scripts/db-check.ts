/**
 * Database target and connectivity check — run before any migration.
 *
 * docs/02-database.md §0 rule 4: "Before any migration or database command, the target database
 * name in the active DATABASE_URL must be printed and confirmed to be `company_chat_db`."
 * This script is that step, so it is performed the same way every time rather than by eye.
 *
 * It is strictly read-only. It creates nothing, alters nothing, and drops nothing; it connects,
 * asks PostgreSQL four questions about the current connection, lists this project's tables, and
 * disconnects.
 *
 * It never prints the connection string or the password — only `role@host:port/database`.
 *
 *     npm run db:check
 */

import { PrismaClient } from '../prisma/generated/client';
import { createDatabaseAdapter } from '../lib/db/prisma';
import { DatabaseTargetError, parseDatabaseUrl } from '../lib/db/target';

/** Tables this project owns, in dependency order. Nothing outside this list is inspected. */
const PROJECT_TABLES = [
  'User',
  'Session',
  'Device',
  'Conversation',
  'ConversationMember',
  'Message',
  'Attachment',
  '_prisma_migrations',
] as const;

interface ConnectionFacts {
  database: string;
  role: string;
  isSuperuser: boolean;
  serverVersion: string;
  currentSchema: string;
  canCreateInSchema: boolean;
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // Absent .env is reported below by the target check, with instructions.
  }

  let target;
  try {
    target = parseDatabaseUrl(process.env['DATABASE_URL']);
  } catch (error) {
    if (error instanceof DatabaseTargetError) {
      process.stderr.write(`\n✖ ${error.message}\n\n`);
      process.exit(1);
    }
    throw error;
  }

  process.stdout.write('\nDatabase target (from DATABASE_URL, password redacted)\n');
  process.stdout.write(`  ${target.redacted}\n`);
  process.stdout.write(`  host      ${target.host}\n`);
  process.stdout.write(`  port      ${target.port}\n`);
  process.stdout.write(`  database  ${target.database}\n`);
  process.stdout.write(`  role      ${target.user}\n`);
  process.stdout.write('  ✔ target is company_chat_db — no other database is contacted\n\n');

  const adapter = createDatabaseAdapter('db-check');
  const prisma = new PrismaClient({ adapter });

  try {
    const [facts] = await prisma.$queryRaw<ConnectionFacts[]>`
      SELECT current_database()                                   AS "database",
             current_user                                         AS "role",
             (SELECT usesuper FROM pg_user WHERE usename = current_user) AS "isSuperuser",
             current_setting('server_version')                    AS "serverVersion",
             current_schema()                                     AS "currentSchema",
             has_schema_privilege(current_user, 'public', 'CREATE') AS "canCreateInSchema"
    `;

    if (!facts) throw new Error('The connection returned no result.');

    process.stdout.write('Connection\n');
    process.stdout.write(`  ✔ connected to "${facts.database}" as "${facts.role}"\n`);
    process.stdout.write(`  PostgreSQL ${facts.serverVersion}\n`);
    process.stdout.write(`  search_path schema: ${facts.currentSchema}\n`);

    // The connected database must still be the one the URL claimed. A mismatch would mean
    // something rewrote the connection between parsing and connecting.
    if (facts.database !== target.database) {
      process.stderr.write(
        `\n✖ Connected database "${facts.database}" does not match the configured ` +
          `"${target.database}". Stopping.\n\n`,
      );
      process.exit(1);
    }

    // The application role must not be a superuser (D-06): a non-superuser role is what makes
    // the "one database only" rule enforced by PostgreSQL rather than by discipline.
    if (facts.isSuperuser) {
      process.stderr.write(
        '\n✖ The configured role is a PostgreSQL SUPERUSER. This project must connect with a ' +
          'dedicated non-superuser role (docs/02-database.md §0 rule 2). Stopping.\n\n',
      );
      process.exit(1);
    }
    process.stdout.write('  ✔ role is not a superuser\n');

    process.stdout.write(
      `  ${facts.canCreateInSchema ? '✔' : '✖'} role ${facts.canCreateInSchema ? 'can' : 'CANNOT'}` +
        ' CREATE in schema public (needed to apply migrations)\n\n',
    );

    if (!facts.canCreateInSchema) {
      process.stderr.write(
        'The role is missing CREATE on schema public, so migrations cannot be applied.\n' +
          'Ask the database owner to run, connected to company_chat_db:\n\n' +
          `    GRANT USAGE, CREATE ON SCHEMA public TO ${facts.role};\n\n` +
          'Do not work around this with a superuser account.\n\n',
      );
    }

    // Which of this project's tables exist. Scoped to the known table names on purpose: no
    // survey of the database, and nothing outside this project is listed.
    const tables = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY(${[...PROJECT_TABLES]})
      ORDER BY table_name
    `;

    const present = new Set(tables.map((row) => row.table_name));
    process.stdout.write("This project's tables in schema public\n");
    for (const table of PROJECT_TABLES) {
      process.stdout.write(`  ${present.has(table) ? '✔' : '·'} ${table}\n`);
    }
    process.stdout.write(
      present.size === 0
        ? '\n  None present: the schema has not been migrated yet.\n\n'
        : `\n  ${present.size} of ${PROJECT_TABLES.length} present.\n\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  // Deliberately terse: a connection failure message can echo the connection string back.
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\n✖ Database check failed: ${message.split('\n')[0]}\n\n`);
  process.exit(1);
});
