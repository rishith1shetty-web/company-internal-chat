/**
 * WHICH environment file a process loads — and why it is not always `.env`.
 *
 * Every entry point used to call `process.loadEnvFile('.env')` directly. That is correct on a
 * developer's machine and wrong on the production server, where the development `.env` also sits
 * in the working directory: a service that forgot to set one variable would silently inherit the
 * development value for it, and `DEV_ORIGINS` would be loaded into a production process that must
 * not have it (docs/20-phase-10-deployment.md §3).
 *
 * So the file is selected explicitly:
 *
 *   ENV_FILE unset  →  `.env` relative to the working directory. A missing file is normal, and
 *                      every setting has a safe default. This is exactly the previous behaviour,
 *                      so development and the test suite are unaffected.
 *
 *   ENV_FILE set    →  that file, and ONLY that file. `.env` is not read at all. A missing or
 *                      unreadable file is a STARTUP FAILURE, not a fallback — a production
 *                      service pointed at a file that is not there must stop and say so, because
 *                      the alternative is a server that boots with loopback-only access, no
 *                      database and no admin token, and looks merely broken rather than
 *                      misconfigured.
 *
 * `process.loadEnvFile` never overwrites a variable that is already set in the real environment,
 * so a value exported by the service wrapper still wins over the file. That ordering is
 * deliberate and unchanged.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { ConfigError } from './env';

/**
 * What these functions read.
 *
 * Deliberately looser than `NodeJS.ProcessEnv`: the Next.js type augmentation makes `NODE_ENV` a
 * required literal union, which would force every caller — and every test case — to supply it
 * even when the point of the case is that it is absent. Nothing here needs more than "string keys
 * that may be missing", and `process.env` satisfies it.
 */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/** The variable that selects a non-default environment file. */
export const ENV_FILE_VARIABLE = 'ENV_FILE';

/** What is loaded when nothing selects otherwise. Relative to the working directory, as before. */
export const DEFAULT_ENV_FILE = '.env';

export interface EnvFileSelection {
  /** Absolute path to the file that was selected. */
  readonly path: string;
  /** True when `ENV_FILE` chose it, rather than the `.env` default. */
  readonly explicit: boolean;
  /** True when the file existed and was read. Only ever false for a defaulted, absent `.env`. */
  readonly loaded: boolean;
}

/** Which file would be loaded, without loading it. Pure, so it is testable and reusable. */
export function resolveEnvFilePath(
  env: EnvSource = process.env,
): { path: string; explicit: boolean } {
  const raw = env[ENV_FILE_VARIABLE]?.trim();
  if (raw === undefined || raw.length === 0) {
    return { path: resolve(DEFAULT_ENV_FILE), explicit: false };
  }
  return { path: resolve(raw), explicit: true };
}

/**
 * Loads the selected environment file into `process.env`.
 *
 * Throws `ConfigError` — the same type every other configuration problem uses, so the operator
 * sees a plain message rather than a stack trace — when an explicitly selected file is missing or
 * cannot be read.
 */
export function loadEnvironmentFile(env: EnvSource = process.env): EnvFileSelection {
  const { path, explicit } = resolveEnvFilePath(env);

  if (!explicit) {
    try {
      process.loadEnvFile(path);
      return { path, explicit, loaded: true };
    } catch {
      // No `.env` on this machine. Every setting has a safe default and the database is optional.
      return { path, explicit, loaded: false };
    }
  }

  if (!existsSync(path)) {
    throw new ConfigError([
      `${ENV_FILE_VARIABLE} points at "${path}", which does not exist. ` +
        'Create it, or unset the variable to use the default .env.',
    ]);
  }

  try {
    process.loadEnvFile(path);
  } catch (error) {
    throw new ConfigError([
      `${ENV_FILE_VARIABLE} points at "${path}", which could not be read ` +
        `(${error instanceof Error ? error.message : String(error)}).`,
    ]);
  }

  return { path, explicit, loaded: true };
}

export interface ProductionVerdict {
  /** True when this process is pointed at a production environment by any signal below. */
  readonly production: boolean;
  /** Every signal that fired, in the operator's words. Empty when none did. */
  readonly reasons: readonly string[];
}

/**
 * Is this process configured for production?
 *
 * Used by tooling that must refuse to run against real company data —
 * `scripts/db-reset-application-data.ts` above all (docs/20 §4). It answers on the environment
 * ALONE and opens no connection, so a refusal can happen before anything is read or written.
 *
 * TWO INDEPENDENT SIGNALS, either of which is enough:
 *
 *   1. `NODE_ENV=production` — the process is a production process.
 *   2. `ENV_FILE` is set — a non-default environment file was deliberately selected, which on
 *      this project means the production configuration. This catches the case that matters most:
 *      an operator on the production server who runs a destructive script by hand and does not
 *      happen to have exported NODE_ENV in that shell.
 *
 * Deliberately over-inclusive. A false positive costs a developer one unset variable; a false
 * negative costs a company its messages and files.
 */
export function detectProduction(env: EnvSource = process.env): ProductionVerdict {
  const reasons: string[] = [];

  if (env['NODE_ENV']?.trim() === 'production') {
    reasons.push('NODE_ENV is "production"');
  }

  const envFile = env[ENV_FILE_VARIABLE]?.trim();
  if (envFile !== undefined && envFile.length > 0) {
    reasons.push(`${ENV_FILE_VARIABLE} selects a non-default configuration ("${envFile}")`);
  }

  return { production: reasons.length > 0, reasons };
}
