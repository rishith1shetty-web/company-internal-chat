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
