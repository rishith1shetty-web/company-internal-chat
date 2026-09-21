/**
 * The test suite must never be able to reach the live company database.
 *
 * WHY THIS EXISTS, precisely. The development `.env` sets `DATABASE_URL` to `company_chat_db` on
 * `localhost:5432` — which is the PRODUCTION database, because this machine is both the developer's
 * computer and the company server (docs/20-phase-10-deployment.md). The database suite creates
 * users, devices, conversations and messages and deletes them again by id. Run with the
 * development environment and nothing else, `npm test` therefore writes test rows into a database
 * that a dozen employees are using, and a suite interrupted half way leaves them there.
 *
 * Nothing in the harness prevented that. It was a convention — "remember to override
 * DATABASE_URL" — and a convention is not a control (CLAUDE.md §20).
 *
 * WHAT THIS IS NOT. It is not an access control: anybody who can edit these files can delete it.
 * It is a guard against the accident, which is the realistic failure — a habitual `npm test` in
 * the wrong window, a CI job that inherits a stale environment, a new colleague who has not read
 * the deployment document yet. Those are stopped absolutely.
 *
 * THE RULES, all of which must hold before a single test file is imported:
 *
 *   1. `TEST_DATABASE_ALLOWED=yes` — an explicit, deliberate opt-in that no environment sets by
 *      accident. Its absence is the default, and the default is "refuse".
 *   2. Not a production environment: `detectProduction` must say no, which means neither
 *      `NODE_ENV=production` nor `ENV_FILE` pointing anywhere — including at
 *      `C:\company-chat\production.env`.
 *   3. `DATABASE_URL` must be set. A missing one is refused rather than skipped, so a run that
 *      silently tests nothing is not mistaken for a passing one.
 *   4. It must parse as a PostgreSQL URL.
 *   5. **Its port must not be the production port.** This is the rule that does the real work.
 *      The database NAME cannot distinguish the two — `parseDatabaseUrl` requires every database
 *      in this project to be called `company_chat_db`, test cluster included — so identity has to
 *      come from somewhere else, and the port is what actually separates the isolated cluster on
 *      55433 from the live service on 5432.
 *   6. The host must be loopback. A test database is local to the machine running the tests; a
 *      URL pointing anywhere else is a mistake, and refusing it costs nothing real.
 */

import { detectProduction } from '../lib/config/env-file';

/** Read-only view of an environment. Mirrors `EnvSource` so tests can pass plain objects. */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/** The deliberate opt-in. Nothing sets this by accident. */
export const TEST_DATABASE_FLAG = 'TEST_DATABASE_ALLOWED';
export const TEST_DATABASE_FLAG_VALUE = 'yes';

/**
 * The port the live PostgreSQL service listens on.
 *
 * Stated here as the thing to stay away from, not as configuration to follow. It is the default
 * PostgreSQL port and the one `C:\company-chat\production.env` uses; the isolated test cluster
 * deliberately uses another (55433).
 */
export const PRODUCTION_DATABASE_PORT = 5432;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export interface TestDatabaseVerdict {
  /** True only when every rule above holds. */
  allowed: boolean;
  /** Why it was refused, in the order the rules are applied. Empty when allowed. */
  reasons: string[];
  /** The port that was parsed, for the message. Null when there was nothing to parse. */
  port: number | null;
}

/**
 * Decides whether this environment may run database-backed tests.
 *
 * A pure function over an environment object: no I/O, no `process.exit`, nothing read from the
 * real environment unless the caller passes it. That is what makes the rules testable
 * exhaustively — including the ones that must REFUSE, which could not be exercised at all if the
 * only entry point aborted the process.
 *
 * Every failing rule is collected rather than returning at the first, so somebody who has two
 * things wrong is told both instead of fixing one and running again.
 */
export function evaluateTestDatabase(env: EnvSource): TestDatabaseVerdict {
  const reasons: string[] = [];

  if (env[TEST_DATABASE_FLAG]?.trim() !== TEST_DATABASE_FLAG_VALUE) {
    reasons.push(
      `${TEST_DATABASE_FLAG} is not set to "${TEST_DATABASE_FLAG_VALUE}". Running the database ` +
        'suite has to be a deliberate act, not the default.',
    );
  }

  const production = detectProduction(env);
  if (production.production) {
    for (const reason of production.reasons) {
      reasons.push(`this looks like a production environment: ${reason}`);
    }
  }

  const raw = env['DATABASE_URL']?.trim();
  if (raw === undefined || raw.length === 0) {
    reasons.push(
      'DATABASE_URL is not set. A run with no database is refused rather than skipped, so a ' +
        'suite that tested nothing cannot be mistaken for a suite that passed.',
    );
    return { allowed: false, reasons, port: null };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    reasons.push('DATABASE_URL is not a valid URL.');
    return { allowed: false, reasons, port: null };
  }

  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    reasons.push(`DATABASE_URL is not a PostgreSQL URL (protocol "${url.protocol}").`);
  }

  // An absent port means the PostgreSQL default, which IS the production port — so an omitted
  // port must be treated as 5432 rather than as "unknown and therefore fine".
  const port = url.port === '' ? PRODUCTION_DATABASE_PORT : Number(url.port);

  if (!Number.isInteger(port) || port <= 0) {
    reasons.push(`DATABASE_URL has an invalid port ("${url.port}").`);
  } else if (port === PRODUCTION_DATABASE_PORT) {
    reasons.push(
      `DATABASE_URL points at port ${PRODUCTION_DATABASE_PORT}, which is the live PostgreSQL ` +
        'service. The test database must be a separate cluster on a different port — the database ' +
        'NAME cannot tell them apart, because every database in this project is called ' +
        '"company_chat_db".',
    );
  }

  const host = url.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    reasons.push(
      `DATABASE_URL points at "${host}", which is not this machine. A test database is local to ` +
        'the machine running the tests.',
    );
  }

  return { allowed: reasons.length === 0, reasons, port: Number.isFinite(port) ? port : null };
}

/**
 * The message shown when a run is refused.
 *
 * Kept with the rules rather than at the call site, and deliberately long: somebody meeting this
 * for the first time is mid-task and needs the way forward, not only the refusal. It never prints
 * `DATABASE_URL` itself, which carries the database password (CLAUDE.md §13).
 */
export function describeRefusal(verdict: TestDatabaseVerdict): string {
  return [
    '',
    '  ┌───────────────────────────────────────────────────────────────────────────┐',
    '  │  TEST RUN REFUSED — the test database is not safely configured.           │',
    '  └───────────────────────────────────────────────────────────────────────────┘',
    '',
    ...verdict.reasons.map((reason) => `    · ${reason}`),
    '',
    '  This machine is both the development computer and the live company server, so the',
    '  development .env points DATABASE_URL at the PRODUCTION database. The test suite',
    '  creates and deletes rows, so it must never be pointed there.',
    '',
    '  Start the isolated test cluster (a separate PostgreSQL data directory on port 55433,',
    '  which never touches the live service on 5432):',
    '',
    '      powershell -ExecutionPolicy Bypass -File deploy\\test-db-up.ps1',
    '',
    '  Then run the suite against it:',
    '',
    '      TEST_DATABASE_ALLOWED=yes \\',
    '      DATABASE_URL="postgresql://devuser@127.0.0.1:55433/company_chat_db" \\',
    '      npm test',
    '',
    '  Nothing was read and nothing was changed.',
    '',
  ].join('\n');
}

/**
 * Enforces the rules, or stops the run.
 *
 * Called from `tests/setup-env.ts`, which vitest loads before it imports a single test file — so
 * a refusal happens before any test module is evaluated and therefore before any database client
 * can be constructed.
 *
 * Throws rather than calling `process.exit`: vitest reports a setup-file error clearly and fails
 * the run, while an exit code from inside a worker is reported as a crash and is easy to mistake
 * for a flaky suite.
 */
export function assertTestDatabaseSafe(env: EnvSource = process.env): void {
  const verdict = evaluateTestDatabase(env);
  if (verdict.allowed) return;

  throw new Error(describeRefusal(verdict));
}
