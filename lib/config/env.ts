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
import { LOOPBACK_RULES, parseCidrList, type CidrRule } from '../net/ip';
import type { NetworkPolicy } from '../net/policy';

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
  /**
   * Who may reach this application, and whose forwarding headers are believed (Phase 8).
   *
   * Always present — there is no "restriction disabled" state. In production the ranges must be
   * configured explicitly or the process refuses to start; everywhere else the default is
   * loopback only, which is the tightest policy there is rather than the loosest
   * (docs/16-phase-8-network-restriction.md).
   */
  networkPolicy: NetworkPolicy;
  /** True when ALLOWED_NETWORKS was set, rather than defaulted to loopback. For the startup log. */
  networkPolicyConfigured: boolean;
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

  const rawAllowedNetworks = readOptional(env, 'ALLOWED_NETWORKS');
  const allowed = parseAllowedNetworks(rawAllowedNetworks, problems);
  const trustedProxies = parseTrustedProxies(readOptional(env, 'TRUSTED_PROXY_IPS'), problems);

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
    networkPolicy: { allowed, trustedProxies },
    networkPolicyConfigured: rawAllowedNetworks !== undefined,
  };
}

/**
 * ALLOWED_NETWORKS — the ranges permitted to reach the application (Phase 8).
 *
 * With no value set the default is LOOPBACK ONLY. Note which direction that goes: it is the
 * *tightest* policy available, not a relaxation. That matters because NODE_ENV is a string an
 * operator can get wrong, and this arrangement means getting it wrong can only lock people out —
 * never let outsiders in. There is deliberately no branch anywhere in this file that widens
 * access because the environment is not production.
 *
 * The production requirement — that a real policy must be configured, not defaulted — is NOT
 * enforced here. See `assertNetworkPolicyConfigured` below for where it lives and why.
 *
 * A malformed entry is a configuration failure rather than a skipped rule, in every environment.
 * Dropping an unparsable range would silently produce a narrower allow-list than the operator
 * wrote, which fails on a Monday morning and looks like an outage rather than a configuration
 * error.
 */
function parseAllowedNetworks(raw: string | undefined, problems: string[]): readonly CidrRule[] {
  if (raw === undefined) return LOOPBACK_RULES;

  const { rules, invalid } = parseCidrList(raw);

  for (const entry of invalid) {
    problems.push(
      `ALLOWED_NETWORKS contains an invalid address or CIDR range: "${entry}" ` +
        '(expected forms: 192.168.1.0/24, 10.0.0.5, ::1, fd00::/8; host bits must be zero)',
    );
  }

  if (rules.length === 0 && invalid.length === 0) {
    problems.push('ALLOWED_NETWORKS is set but lists no ranges — remove it or give it a value');
    return LOOPBACK_RULES;
  }

  return rules;
}

/**
 * FAIL CLOSED: a production server must have a real network policy, not the loopback default.
 *
 * WHY THIS IS SEPARATE FROM `loadConfig`. Route handlers import the configuration at module
 * scope, and `next build` evaluates those modules with NODE_ENV=production while collecting page
 * data. Enforcing the rule inside `loadConfig` therefore broke the build — and it should: a build
 * machine has no business knowing the company's address ranges, and requiring them to compile
 * would push a production secret into every environment that ever builds the app.
 *
 * The rule belongs where it actually matters, which is the moment a process is about to accept
 * traffic. `server.ts` calls this immediately before `listen()`, so a production server with no
 * policy configured refuses to start — the setting that decides who can read the company's
 * conversations is not one that can be forgotten — while a build, a test run and a type-check
 * are unaffected.
 *
 * Throws `ConfigError`, so the operator sees the same plain message as any other bad setting.
 */
export function assertNetworkPolicyConfigured(config: AppConfig): void {
  if (!config.isProduction || config.networkPolicyConfigured) return;

  throw new ConfigError([
    'ALLOWED_NETWORKS must be set in production — list the company ranges permitted to reach ' +
      'this application, e.g. "192.168.1.0/24" (see docs/16-phase-8-network-restriction.md)',
  ]);
}

/**
 * TRUSTED_PROXY_IPS — peers whose `X-Forwarded-For` is believed (Phase 8).
 *
 * Unset means forwarding headers are IGNORED ENTIRELY, which is both the default and the
 * correct setting for the V1 deployment, where the Node process is what employees connect to.
 * Trusting the header without this list would turn the allow-list into a value the client
 * supplies (docs/16-phase-8-network-restriction.md §5, lib/net/policy.ts).
 */
function parseTrustedProxies(raw: string | undefined, problems: string[]): readonly CidrRule[] {
  if (raw === undefined) return [];

  const { rules, invalid } = parseCidrList(raw);

  for (const entry of invalid) {
    problems.push(
      `TRUSTED_PROXY_IPS contains an invalid address or CIDR range: "${entry}"`,
    );
  }

  return rules;
}

/*
 * Deferred configuration — documented in .env.example, added here by the phase that needs it:
 *
 *   Phase 4  (none)                    the realtime layer reuses PORT / APP_URL
 *   Phase 8  ALLOWED_NETWORKS          IMPLEMENTED above
 *            TRUSTED_PROXY_IPS         IMPLEMENTED above
 *
 * Nothing remains deferred here.
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
