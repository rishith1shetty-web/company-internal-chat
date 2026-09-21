/**
 * The test suite must not be able to reach the live company database.
 *
 * TWO LAYERS, tested separately, because either alone would be a weak claim:
 *
 *   1. The RULES, as a pure function. Every refusal can be exercised — including the ones that
 *      matter most — which is impossible through an entry point that aborts the process.
 *   2. The WIRING, by running vitest as a subprocess with a hostile environment and checking it
 *      actually stops. This is the half that catches the guard being imported but never called,
 *      or called after the test modules are loaded.
 *
 * WHY THIS IS SAFE TO HAVE IN THE SUITE. The subprocess cases below point vitest at ONE pure test
 * file with no database access of its own, and every hostile case is expected to be REFUSED —
 * so the worst outcome of a total guard failure is that a file of arithmetic runs twice. No case
 * here can write to any database.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  PRODUCTION_DATABASE_PORT,
  TEST_DATABASE_FLAG,
  evaluateTestDatabase,
} from '../test-database-guard';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** The exact shape of the development `.env` on this machine: the production database. */
const PRODUCTION_URL = 'postgresql://company_chat_app:secret@localhost:5432/company_chat_db';

/** The isolated cluster: same database name, different port. The port is the whole distinction. */
const ISOLATED_URL = 'postgresql://devuser@127.0.0.1:55433/company_chat_db';

/** An environment that passes every rule, which each case below then breaks one part of. */
const SAFE_ENV = {
  [TEST_DATABASE_FLAG]: 'yes',
  DATABASE_URL: ISOLATED_URL,
} as const;

describe('the test-database guard — rules', () => {
  it('allows the isolated cluster with the explicit opt-in', () => {
    const verdict = evaluateTestDatabase(SAFE_ENV);

    expect(verdict.allowed).toBe(true);
    expect(verdict.reasons).toEqual([]);
    expect(verdict.port).toBe(55433);
  });

  it('REFUSES the production database URL', () => {
    const verdict = evaluateTestDatabase({ ...SAFE_ENV, DATABASE_URL: PRODUCTION_URL });

    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons.join(' ')).toContain(String(PRODUCTION_DATABASE_PORT));
  });

  it('REFUSES port 5432 however the URL is spelled', () => {
    for (const url of [
      'postgresql://user:pw@localhost:5432/company_chat_db',
      'postgresql://user:pw@127.0.0.1:5432/company_chat_db',
      'postgres://user:pw@127.0.0.1:5432/company_chat_db',
      // No port at all. The PostgreSQL default IS 5432, so an omitted port must be treated as
      // production rather than as "unknown and therefore fine" — this is the easiest rule to
      // get wrong and the most dangerous one to get wrong.
      'postgresql://user:pw@localhost/company_chat_db',
    ]) {
      const verdict = evaluateTestDatabase({ ...SAFE_ENV, DATABASE_URL: url });
      expect(verdict.allowed, url).toBe(false);
    }
  });

  it('REFUSES when the opt-in is missing, or is anything but "yes"', () => {
    const { DATABASE_URL } = SAFE_ENV;

    for (const flag of [undefined, '', 'no', 'true', '1', 'YES ', 'yes please']) {
      const env = flag === undefined ? { DATABASE_URL } : { DATABASE_URL, [TEST_DATABASE_FLAG]: flag };
      const verdict = evaluateTestDatabase(env);
      expect(verdict.allowed, `flag=${String(flag)}`).toBe(false);
    }

    // The trimmed exact value is the one that works.
    expect(evaluateTestDatabase({ DATABASE_URL, [TEST_DATABASE_FLAG]: ' yes ' }).allowed).toBe(true);
  });

  it('REFUSES when DATABASE_URL is missing', () => {
    const verdict = evaluateTestDatabase({ [TEST_DATABASE_FLAG]: 'yes' });

    expect(verdict.allowed).toBe(false);
    // Refused, not skipped: a run that silently tested nothing must not look like one that passed.
    expect(verdict.reasons.join(' ')).toContain('DATABASE_URL is not set');
  });

  it('REFUSES when ENV_FILE selects the production configuration', () => {
    const verdict = evaluateTestDatabase({
      ...SAFE_ENV,
      ENV_FILE: 'C:\\company-chat\\production.env',
    });

    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('production');
  });

  it('REFUSES ENV_FILE pointing anywhere at all, not only at a file called production.env', () => {
    // `detectProduction` treats ANY ENV_FILE as a production signal, and that is the right rule:
    // the name of the file is not what makes it production, and a copy called `prod-copy.env`
    // would otherwise slip through a name check.
    const verdict = evaluateTestDatabase({ ...SAFE_ENV, ENV_FILE: 'C:\\somewhere\\other.env' });

    expect(verdict.allowed).toBe(false);
  });

  it('REFUSES NODE_ENV=production', () => {
    const verdict = evaluateTestDatabase({ ...SAFE_ENV, NODE_ENV: 'production' });

    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('NODE_ENV');
  });

  it('REFUSES a database on another machine', () => {
    const verdict = evaluateTestDatabase({
      ...SAFE_ENV,
      DATABASE_URL: 'postgresql://user:pw@192.168.29.244:55433/company_chat_db',
    });

    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('not this machine');
  });

  it('REFUSES something that is not a PostgreSQL URL', () => {
    for (const url of ['not-a-url', 'mysql://user@127.0.0.1:55433/company_chat_db']) {
      expect(evaluateTestDatabase({ ...SAFE_ENV, DATABASE_URL: url }).allowed, url).toBe(false);
    }
  });

  it('collects every problem, rather than stopping at the first', () => {
    const verdict = evaluateTestDatabase({
      DATABASE_URL: PRODUCTION_URL,
      ENV_FILE: 'C:\\company-chat\\production.env',
      NODE_ENV: 'production',
    });

    expect(verdict.allowed).toBe(false);
    // Missing opt-in, NODE_ENV, ENV_FILE, production port — somebody with four things wrong is
    // told all four instead of fixing one and running again.
    expect(verdict.reasons.length).toBeGreaterThanOrEqual(4);
  });

  it('never puts the connection string, or a password, in a refusal', () => {
    const verdict = evaluateTestDatabase({
      ...SAFE_ENV,
      DATABASE_URL: 'postgresql://company_chat_app:hunter2@localhost:5432/company_chat_db',
    });

    const text = verdict.reasons.join(' ');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('postgresql://');
  });
});

/* --------------------------------------------------------------------------------------------- */
/* The wiring — vitest itself is run, and has to stop                                              */
/* --------------------------------------------------------------------------------------------- */

interface Run {
  readonly status: number | null;
  readonly combined: string;
}

/** A pure test file with no database of its own. What the subprocess is pointed at. */
const HARMLESS_TARGET = 'tests/db/target.test.ts';

const REFUSAL = 'TEST RUN REFUSED';

/**
 * Runs vitest in a subprocess with a chosen environment.
 *
 * ASYNCHRONOUS ON PURPOSE. `spawnSync` would be shorter, but it blocks the event loop for the
 * several seconds each run takes, and timers elsewhere in the suite do not fire while it is
 * blocked — which is enough to make a timing-sensitive presence test fail in a full run while
 * passing on its own. That has already happened once in this project.
 */
function runVitest(overrides: Record<string, string | undefined>): Promise<Run> {
  const env: Record<string, string | undefined> = { ...(process.env as Record<string, string>) };

  // Cleared BEFORE the caller's values are applied, so a case starts from nothing rather than
  // from whatever this (correctly configured) parent run happens to have.
  delete env[TEST_DATABASE_FLAG];
  delete env['DATABASE_URL'];
  delete env['ENV_FILE'];
  Object.assign(env, overrides);
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];

  return new Promise<Run>((resolve, reject) => {
    const child = spawn('npx', ['vitest', 'run', HARMLESS_TARGET], {
      cwd: REPO_ROOT,
      env: env as NodeJS.ProcessEnv,
      shell: true,
    });

    let combined = '';
    child.stdout.on('data', (chunk: Buffer) => {
      combined += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      combined += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (status) => resolve({ status, combined }));
  });
}

describe('the test-database guard — wiring', () => {
  it('refuses a run pointed at the production database', async () => {
    /*
     * The accident this exists to stop: a habitual `npm test` in a shell where the development
     * `.env` supplies the production DATABASE_URL.
     */
    const run = await runVitest({ [TEST_DATABASE_FLAG]: 'yes', DATABASE_URL: PRODUCTION_URL });

    expect(run.status).not.toBe(0);
    expect(run.combined).toContain(REFUSAL);
  }, 180_000);

  it('refuses a run with no opt-in, even against a safe database', async () => {
    // This is the plain `npm test` case once `.env` has been loaded: the URL may be anything, and
    // without the deliberate flag the run stops regardless.
    const run = await runVitest({ DATABASE_URL: ISOLATED_URL });

    expect(run.status).not.toBe(0);
    expect(run.combined).toContain(REFUSAL);
  }, 180_000);

  it('refuses a run whose ENV_FILE is the production configuration', async () => {
    const run = await runVitest({
      [TEST_DATABASE_FLAG]: 'yes',
      DATABASE_URL: ISOLATED_URL,
      ENV_FILE: 'C:\\company-chat\\production.env',
    });

    expect(run.status).not.toBe(0);
    expect(run.combined).toContain(REFUSAL);
  }, 180_000);

  it('ALLOWS the isolated cluster with the explicit opt-in', async () => {
    /*
     * The control, and it is not optional. Without it every assertion above would pass on a guard
     * that refused everything — including the configuration the project actually uses.
     */
    const run = await runVitest({ [TEST_DATABASE_FLAG]: 'yes', DATABASE_URL: ISOLATED_URL });

    expect(run.combined).not.toContain(REFUSAL);
    expect(run.status).toBe(0);
  }, 180_000);
});
