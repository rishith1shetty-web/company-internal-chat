/**
 * Prisma CLI configuration (Prisma 7).
 *
 * In Prisma 7 the connection URL is no longer allowed in `schema.prisma`; migration and
 * introspection commands read it from here, and the running application gets it from the driver
 * adapter in `lib/db/prisma.ts`. The URL itself still comes only from the environment — no
 * credential, host or database name is hard-coded in tracked source (CLAUDE.md §7).
 *
 * The Prisma 7 CLI does not load `.env` files by itself, so this file loads `.env` using Node's
 * built-in loader. That is deliberately not `dotenv`: Node 20.12+ can do it without a dependency,
 * and the project adds a package only when one is actually needed (CLAUDE.md §3).
 */

import { defineConfig } from 'prisma/config';

import { loadEnvironmentFile } from './lib/config/env-file';

// Absent .env is not an error here: commands that genuinely need DATABASE_URL fail with their
// own clear message, and commands that do not (validate, format, generate) still work.
//
// `ENV_FILE` selects the production configuration instead, so `prisma migrate deploy` and
// `prisma migrate status` on the company server read the production DATABASE_URL rather than a
// development one that happens to sit in the same directory (docs/20-phase-10-deployment.md §3).
loadEnvironmentFile();

/*
 * Supplied only when it is actually set, so that `prisma validate`, `prisma format` and
 * `prisma generate` keep working on a machine with no `.env` — as they must, because the build
 * runs `prisma generate` and must not require database credentials. Commands that do need a
 * connection (migrate deploy, migrate status) report the missing datasource themselves.
 *
 * The value is never printed: `npm run db:check` reports a redacted target instead
 * (docs/02-database.md §0 rule 4).
 */
const databaseUrl = process.env['DATABASE_URL']?.trim();

export default defineConfig({
  schema: 'prisma/schema.prisma',

  ...(databaseUrl ? { datasource: { url: databaseUrl } } : {}),

  // NOTE (datasource): there is deliberately no `shadowDatabaseUrl` and no shadow database.
  //
  // `prisma migrate dev` creates and drops a temporary shadow database, which requires the
  // CREATEDB privilege. The application role is intentionally non-superuser without CREATEDB,
  // and this project may not create databases at all (docs/02-database.md §0 rule 5).
  // Migrations are therefore generated with `prisma migrate diff` and applied with
  // `prisma migrate deploy`, neither of which needs one. See docs/09-phase-3-database.md,
  // "Migration strategy".

  migrations: {
    path: 'prisma/migrations',
  },
});
