/**
 * Test setup: load `.env` before any test module is imported.
 *
 * Vitest does not put `.env` values into `process.env` (Vite only exposes `VITE_`-prefixed
 * variables to `import.meta.env`), so without this the database suite would silently skip on a
 * machine that is correctly configured — the worst kind of green test run.
 *
 * Node's built-in loader again, rather than a `dotenv` dependency.
 *
 * It also enforces the database guard. A missing or production-looking `DATABASE_URL` used to be
 * survivable — the database suite skipped itself — and that is no longer acceptable on a machine
 * where the development `.env` points at the live company database. The run is refused instead.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertTestDatabaseSafe } from './test-database-guard';

try {
  process.loadEnvFile('.env');
} catch {
  // No .env. The guard below decides what that means; it is no longer silently survivable,
  // because a run with no database is a run that proved nothing.
}

/*
 * THE DATABASE GUARD, and it runs here for a reason.
 *
 * vitest loads this file before it imports a single test module, so a refusal happens before any
 * test code is evaluated and therefore before any Prisma client can exist.
 *
 * It runs AFTER `.env` is loaded, not before — otherwise it would judge an environment the tests
 * are not actually going to use. Note that `process.loadEnvFile` does not overwrite variables
 * that are already set, so a DATABASE_URL exported by the shell still wins over the one in
 * `.env`; that is exactly how a run is pointed at the isolated test cluster.
 *
 * See tests/test-database-guard.ts for what it refuses and why.
 */
assertTestDatabaseSafe();

/*
 * A deterministic ADMIN_TOKEN for the test run.
 *
 * The admin surface refuses everything when no token is configured, which is the correct
 * production default but would make the admin tests skip on a machine that is otherwise
 * perfectly configured. A value is therefore supplied here when the environment does not have
 * one — never overriding a real `.env` value, and never written to disk.
 */
process.env['ADMIN_TOKEN'] ??= 'zz-test-admin-token-0123456789abcdef';

/*
 * A storage root of the test run's own, under the system temp directory.
 *
 * Set BEFORE any module reads configuration, because `lib/config/env.ts` is evaluated once at
 * import and `UPLOAD_DIR` is resolved to an absolute path there. Without this the file tests
 * would write into — and delete out of — whatever storage the developer's own server is using,
 * which is exactly the kind of thing a test must never do.
 *
 * Overridden unconditionally rather than with `??=`: a real `UPLOAD_DIR` in `.env` is the
 * running application's storage, and it is the value most important NOT to point tests at.
 */
process.env['UPLOAD_DIR'] = mkdtempSync(join(tmpdir(), 'zz-test-uploads-'));

/*
 * A small upload limit for the test run: 1 MB.
 *
 * The production ceiling is 500 MB (D-05), and a test that proved the route refuses an oversized
 * file by sending 500 MB through it would be slow enough that nobody would run it. The limit is
 * configuration, so the tests configure it — which exercises the same code path with the same
 * enforcement, at a size a test suite can afford. The boundary behaviour is what is being
 * checked, not the number.
 */
process.env['MAX_FILE_SIZE'] = String(1024 * 1024);
