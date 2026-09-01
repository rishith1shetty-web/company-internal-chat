/**
 * Environment configuration (docs/01-architecture.md §4, CLAUDE.md §7).
 *
 * The single place environment variables are read and validated. Everything else in the
 * application imports the parsed config object; nothing else calls `process.env` directly.
 *
 * Invalid configuration is a startup failure, not a runtime surprise: `loadConfig()` throws
 * with a message naming every problem it found.
 *
 * SCOPE: only the variables the application actually uses today are parsed here. File-storage
 * and network settings are documented in `.env.example` and will be added to this module by the
 * phase that first needs them — see the note at the bottom of this file.
 *
 * Phase 3 added DATABASE_URL. It is OPTIONAL: the application still starts without it, and only
 * code that actually needs the database fails when it is absent. When it is present it is
 * validated here, including the check that it targets `company_chat_db` and no other database
 * (docs/02-database.md §0).
 */

import { isAbsolute, resolve, sep } from 'node:path';

import { DatabaseTargetError, parseDatabaseUrl } from '../db/target';

export type NodeEnvironment = 'development' | 'production' | 'test';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AppConfig {
  /** Resolved NODE_ENV. */
  nodeEnv: NodeEnvironment;
  isDevelopment: boolean;
  isProduction: boolean;
  /** TCP port the HTTP server listens on. */
  port: number;
  /** Interface the server binds. Loopback by default so nothing is exposed unintentionally. */
  bindHost: string;
  /** Public origin the browser uses. Used later for Origin checks (docs/04-security.md, CSRF). */
  appUrl: string;
  logLevel: LogLevel;
  /** Idle session lifetime in hours, renewed while the user is active (D-04). */
  sessionTtlHours: number;
  /** Device identity lifetime in days, renewed on use (D-13, Q-19). */
  deviceTtlDays: number;
  /** How long an unredeemed device enrollment code stays usable. */
  enrollmentTtlHours: number;
  /**
   * The shared administrator token that guards the device-assignment surface, or `undefined`
   * when none is configured.
   *
   * Absent is a valid and deliberately safe state: with no token the admin API and admin page
   * refuse every request outright rather than falling back to something weaker. See
   * docs/12-admin-device-identity.md for what this is and, more importantly, what it is not.
   */
  adminToken: string | undefined;
  /**
   * Absolute path to the file-storage root (Phase 7).
   *
   * Always absolute, resolved here from a relative setting, because everything downstream joins
   * generated names onto it and a relative root would silently follow the process's working
   * directory. It must not live under `public/` or anywhere Next.js serves statically: nothing
   * in this application ever maps a URL onto this directory (CLAUDE.md §11).
   */
  uploadDir: string;
  /**
   * Largest upload accepted, in bytes. 500 MB by default (D-05), configurable.
   *
   * Enforced while the bytes are still arriving, not after: the request is aborted the moment
   * the counter passes this, so an oversized upload never reaches permanent storage and never
   * has to be buffered to be measured.
   */
  maxFileSize: number;
  /**
   * Redacted description of the configured database (`role@host:port/company_chat_db`), or
   * `undefined` when no database is configured. Safe to log — it contains no password, and the
   * raw connection string is deliberately not exposed on this object (CLAUDE.md §13).
   *
   * Absent is a valid state: the Phase 2 interface runs without a database, and code that needs
   * one fails with its own clear message (lib/db/prisma.ts).
   */
  databaseTarget: string | undefined;
}

const VALID_NODE_ENVS: readonly NodeEnvironment[] = ['development', 'production', 'test'];
const VALID_LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

const DEFAULT_PORT = 3000;
const DEFAULT_BIND_HOST = '127.0.0.1';
/** D-04: 24 hours of inactivity. */
const DEFAULT_SESSION_TTL_HOURS = 24;
/** Q-19: 90 days, renewed on use. */
const DEFAULT_DEVICE_TTL_DAYS = 90;
/** A working day plus slack: long enough to set a machine up, short enough to go stale. */
const DEFAULT_ENROLLMENT_TTL_HOURS = 24;
/**
 * Shortest admin token accepted.
 *
 * The token is a bearer secret with no rate limiting in front of it (Phase 9), so a short one is
 * not a weaker choice by the operator — it is a broken configuration, and the application says so
 * at startup rather than running with it.
 */
const MIN_ADMIN_TOKEN_LENGTH = 24;

/** D-05: 500 MB. */
const DEFAULT_MAX_FILE_SIZE = 500 * 1024 * 1024;

/**
 * A ceiling on the ceiling: 8 GB.
 *
 * Not a policy about how large a file should be. It catches a mistyped `MAX_FILE_SIZE` at
 * startup — a stray zero would otherwise be discovered when a single upload filled the disk.
 */
const MAX_CONFIGURABLE_FILE_SIZE = 8 * 1024 * 1024 * 1024;

/** Storage root, relative to the working directory, when none is configured. Git-ignored. */
const DEFAULT_UPLOAD_DIR = './var/uploads';

export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: string[]) {
    super(
      'Invalid environment configuration:\n' +
        problems.map((problem) => `  - ${problem}`).join('\n') +
        '\n\nSee .env.example for the expected values.',
    );
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/** Reads a variable, treating empty/whitespace-only values as absent. */
function readOptional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function parsePort(raw: string | undefined, problems: string[]): number {
  if (raw === undefined) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push(`PORT must be an integer between 1 and 65535 (received "${raw}")`);
    return DEFAULT_PORT;
  }
  return port;
}

/** Positive integer with a sane ceiling, so a typo cannot create an effectively eternal session. */
function parsePositiveInteger(
  name: string,
  raw: string | undefined,
  fallback: number,
  max: number,
  problems: string[],
): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    problems.push(`${name} must be an integer between 1 and ${max} (received "${raw}")`);
    return fallback;
  }
  return value;
}

function parseEnum<T extends string>(
  name: string,
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
  problems: string[],
): T {
  if (raw === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    problems.push(`${name} must be one of: ${allowed.join(', ')} (received "${raw}")`);
    return fallback;
  }
  return raw as T;
}

function parseAppUrl(raw: string | undefined, port: number, problems: string[]): string {
  if (raw === undefined) return `http://localhost:${port}`;
  try {
    // Validate the shape; a malformed APP_URL would otherwise fail much later, during an
    // Origin check, where the cause would be far harder to see.
    new URL(raw);
  } catch {
    problems.push(`APP_URL must be an absolute URL (received "${raw}")`);
    return `http://localhost:${port}`;
  }
  return raw.replace(/\/$/, '');
}

/**
 * Validates DATABASE_URL when one is set, and returns a redacted description of the target.
 *
 * Checking at startup rather than at first query means a wrong connection string is a boot
 * failure with an explanatory message, not a surprise during a request. The check enforces
 * docs/02-database.md §0: the target must be `company_chat_db` and nothing else.
 */
function parseDatabaseTarget(raw: string | undefined, problems: string[]): string | undefined {
  if (raw === undefined) return undefined;
  try {
    return parseDatabaseUrl(raw).redacted;
  } catch (error) {
    // The guard's messages are written for an operator and never include the password.
    problems.push(
      error instanceof DatabaseTargetError ? error.message : 'DATABASE_URL is invalid',
    );
    return undefined;
  }
}

/**
 * Parses and validates the environment. Throws `ConfigError` if anything is invalid.
 * Called once at process start (see server.ts).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const problems: string[] = [];

  const nodeEnv = parseEnum(
    'NODE_ENV',
    readOptional(env, 'NODE_ENV'),
    VALID_NODE_ENVS,
    'development',
    problems,
  );
  const port = parsePort(readOptional(env, 'PORT'), problems);
  const bindHost = readOptional(env, 'BIND_HOST') ?? DEFAULT_BIND_HOST;
  const appUrl = parseAppUrl(readOptional(env, 'APP_URL'), port, problems);
  const logLevel = parseEnum(
    'LOG_LEVEL',
    readOptional(env, 'LOG_LEVEL'),
    VALID_LOG_LEVELS,
    nodeEnv === 'production' ? 'info' : 'debug',
    problems,
  );

  const sessionTtlHours = parsePositiveInteger(
    'SESSION_TTL_HOURS',
    readOptional(env, 'SESSION_TTL_HOURS'),
    DEFAULT_SESSION_TTL_HOURS,
    24 * 365,
    problems,
  );
  const deviceTtlDays = parsePositiveInteger(
    'DEVICE_ID_TTL_DAYS',
    readOptional(env, 'DEVICE_ID_TTL_DAYS'),
    DEFAULT_DEVICE_TTL_DAYS,
    3650,
    problems,
  );

  const enrollmentTtlHours = parsePositiveInteger(
    'ENROLLMENT_TTL_HOURS',
    readOptional(env, 'ENROLLMENT_TTL_HOURS'),
    DEFAULT_ENROLLMENT_TTL_HOURS,
    24 * 30,
    problems,
  );

  const uploadDir = parseUploadDir(readOptional(env, 'UPLOAD_DIR'), problems);
  const maxFileSize = parseMaxFileSize(readOptional(env, 'MAX_FILE_SIZE'), problems);

  const adminToken = readOptional(env, 'ADMIN_TOKEN');
  if (adminToken !== undefined && adminToken.length < MIN_ADMIN_TOKEN_LENGTH) {
    // The value itself is never echoed, here or anywhere else.
    problems.push(`ADMIN_TOKEN must be at least ${MIN_ADMIN_TOKEN_LENGTH} characters`);
  }

  const databaseTarget = parseDatabaseTarget(readOptional(env, 'DATABASE_URL'), problems);

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    nodeEnv,
    isDevelopment: nodeEnv === 'development',
    isProduction: nodeEnv === 'production',
    port,
    bindHost,
    appUrl,
    logLevel,
    sessionTtlHours,
    deviceTtlDays,
    enrollmentTtlHours,
    adminToken,
    uploadDir,
    maxFileSize,
    databaseTarget,
  };
}

/*
 * Deferred configuration — documented in .env.example, added here by the phase that needs it:
 *
 *   Phase 4  (none)                    the realtime layer reuses PORT / APP_URL
 *   Phase 8  ALLOWED_NETWORKS          CIDRs permitted to reach the application
 *            TRUSTED_PROXY_IPS         peers whose forwarding headers are believed
 *
 * ALLOWED_FILE_EXTENSIONS was listed here for Phase 7 and is deliberately NOT implemented. The
 * company transfers arbitrary business files — video, archives, source, exports, anything a
 * colleague needs to send — and an allowlist would block ordinary work while stopping nothing:
 * an extension is a string the sender chose, so it is not a security control (docs/14-phase-7-
 * file-transfer.md §7). Uploads are opaque bytes; safety comes from never executing them, never
 * serving them inline, and authorizing every download.
 */

/**
 * Resolves the storage root to an absolute path.
 *
 * Relative settings are accepted and resolved against the working directory, because that is
 * what a developer expects from `./var/uploads`. What is stored on the config object is always
 * absolute: every path built downstream is joined onto this value and then checked to still be
 * inside it, and that containment check is meaningless against a relative root.
 */
function parseUploadDir(raw: string | undefined, problems: string[]): string {
  const value = raw ?? DEFAULT_UPLOAD_DIR;
  const absolute = isAbsolute(value) ? value : resolve(process.cwd(), value);

  // A storage root inside the statically served directory would publish every uploaded file.
  // Refusing at startup is better than discovering it from a URL that should not have worked.
  const publicDir = resolve(process.cwd(), 'public');
  if (absolute === publicDir || absolute.startsWith(publicDir + sep)) {
    problems.push('UPLOAD_DIR must not be inside public/ — uploaded files must never be served statically');
  }

  return absolute;
}

function parseMaxFileSize(raw: string | undefined, problems: string[]): number {
  if (raw === undefined) return DEFAULT_MAX_FILE_SIZE;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_CONFIGURABLE_FILE_SIZE) {
    problems.push(
      `MAX_FILE_SIZE must be an integer number of bytes between 1 and ${MAX_CONFIGURABLE_FILE_SIZE} ` +
        `(received "${raw}")`,
    );
    return DEFAULT_MAX_FILE_SIZE;
  }

  return value;
}
