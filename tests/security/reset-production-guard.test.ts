/**
 * `scripts/db-reset-application-data.ts` must be unusable against production.
 *
 * The script erases every user, device, conversation, message and attachment. It was written to
 * clear development leftovers once, before the office rollout; from the moment real employees are
 * enrolled it has no legitimate use, and the cost of it running by accident is the company's
 * entire chat history.
 *
 * WHY THESE RUN THE REAL SCRIPT AS A SUBPROCESS rather than testing a function. The guarantee
 * being tested is not "a predicate returns true" — `tests/config/env-file.test.ts` covers that.
 * It is "this executable, invoked the way an operator would invoke it, stops". Only running it
 * proves that, and only running it would catch the guard being moved below the code it protects.
 *
 * WHY THIS IS SAFE TO HAVE IN THE SUITE. Arming the script requires a confirmation variable AND a
 * command-line flag. No case below ever passes the flag, so even a total failure of the production
 * guard leaves the script in its default DRY RUN mode, which deletes nothing. The test can fail;
 * it cannot destroy anything.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = 'scripts/db-reset-application-data.ts';

/** The banner the script prints once it has started work. Its ABSENCE is the real assertion. */
const WORK_STARTED = 'ERASE ALL APPLICATION DATA';
const REFUSAL = 'REFUSING TO RUN';

interface ResetRun {
  readonly status: number | null;
  readonly combined: string;
}

/*
 * ASYNCHRONOUS ON PURPOSE — `spawnSync` would be shorter.
 *
 * Each of these runs takes a few seconds, and `spawnSync` blocks the event loop for the whole of
 * it. Timers elsewhere in the suite do not fire while it is blocked, which is enough to make a
 * timing-sensitive presence test fail in a full run while passing on its own. Spawning
 * asynchronously keeps the loop turning and the rest of the suite honest.
 */
function runReset(extraEnv: Record<string, string>): Promise<ResetRun> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };

  // Cleared BEFORE the caller's values are applied, so the suite behaves identically whatever the
  // developer happens to have exported, while a case that deliberately sets it still can.
  delete env['CONFIRM_ERASE_ALL_DATA'];
  Object.assign(env, extraEnv);

  /*
   * THE COMMAND-LINE FLAG IS NEVER PASSED, by any case in this file.
   *
   * Arming requires the variable AND the flag. Withholding the flag means that if the production
   * guard were ever removed entirely, the worst outcome of running this suite is a read-only dry
   * run. A test for a destructive lockout must not itself be one regression away from performing
   * the destruction it is testing against.
   */
  return new Promise<ResetRun>((resolveRun, rejectRun) => {
    const child = spawn('npx', ['tsx', SCRIPT], {
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

    child.on('error', rejectRun);
    child.on('close', (status) => {
      resolveRun({ status, combined });
    });
  });
}

describe('the data reset utility refuses production', () => {
  it('refuses when NODE_ENV=production, before reading anything', async () => {
    const run = await runReset({ NODE_ENV: 'production' });

    expect(run.status).not.toBe(0);
    expect(run.combined).toContain(REFUSAL);
    expect(run.combined).toContain('NODE_ENV');

    // It stopped before it began: the banner is printed immediately after the database target is
    // parsed and the client is constructed, so its absence proves nothing was even connected to.
    expect(run.combined).not.toContain(WORK_STARTED);
  }, 120_000);

  it('refuses when ENV_FILE selects a production configuration', async () => {
    /*
     * The realistic accident. An administrator on the company server opens a shell, does not
     * export NODE_ENV, and runs the script. The service configuration is what marks the machine
     * as production, so that is what has to be noticed.
     */
    const directory = mkdtempSync(join(tmpdir(), 'zz-test-prodenv-'));
    const file = join(directory, 'production.env');
    writeFileSync(file, 'ZZ_TEST_NOT_A_REAL_CONFIG=1\n', 'utf8');

    const run = await runReset({ ENV_FILE: file });

    expect(run.status).not.toBe(0);
    expect(run.combined).toContain(REFUSAL);
    expect(run.combined).toContain('ENV_FILE');
    expect(run.combined).not.toContain(WORK_STARTED);
  }, 120_000);

  it('refuses even when a confirmation is supplied', async () => {
    /*
     * Ordering, stated as a test. The production check runs before the confirmations are read, so
     * supplying one cannot buy past it — the difference between a warning and a lockout.
     *
     * The confirmation VARIABLE is set; the confirmation FLAG is not (see `runReset`). Arming
     * needs both, so this exercises the ordering while remaining incapable of deleting a row.
     */
    const run = await runReset({ NODE_ENV: 'production', CONFIRM_ERASE_ALL_DATA: 'yes' });

    expect(run.status).not.toBe(0);
    expect(run.combined).toContain(REFUSAL);
    expect(run.combined).not.toContain(WORK_STARTED);
  }, 120_000);

  it('does NOT refuse outside production, so the guard is specific rather than blanket', async () => {
    /*
     * A control. Without it, a script that failed for any unrelated reason — a syntax error, a
     * bad import — would make every test above pass while proving nothing.
     *
     * This asserts only the absence of the production refusal. Whatever the script does next
     * (a dry run against a configured database, or a complaint about an unconfigured one) is not
     * this test's business.
     */
    const run = await runReset({ NODE_ENV: 'test' });

    expect(run.combined).not.toContain(REFUSAL);
  }, 120_000);
});
