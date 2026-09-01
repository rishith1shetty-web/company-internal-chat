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
