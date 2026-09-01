/**
 * Test setup: load `.env` before any test module is imported.
 *
 * Vitest does not put `.env` values into `process.env` (Vite only exposes `VITE_`-prefixed
 * variables to `import.meta.env`), so without this the database suite would silently skip on a
 * machine that is correctly configured — the worst kind of green test run.
 *
 * Node's built-in loader again, rather than a `dotenv` dependency. A missing `.env` is not an
 * error: the database suite then skips deliberately, which is the intended behaviour for a
 * machine with no database.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

try {
  process.loadEnvFile('.env');
} catch {
  // No .env: tests that need a database skip themselves.
}

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
