/**
 * Environment configuration (docs/01-architecture.md §4, CLAUDE.md §7).
 *
 * The single place environment variables are read and validated. Everything else in the
 * application imports the parsed config object; nothing else calls `process.env` directly.
 *
 * Invalid configuration is a startup failure, not a runtime surprise: `loadConfig()` throws
 * with a message naming every problem it found.
 *
 * PHASE 1 SCOPE: only the variables the application actually uses today are parsed here.
 * Database, file-storage, session and network settings are documented in `.env.example` and
 * will be added to this module by the phase that first needs them — see the note at the
 * bottom of this file. In particular, DATABASE_URL is deliberately NOT read yet, so nothing
 * in the application can attempt a database connection before Phase 3.
 */

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
}

const VALID_NODE_ENVS: readonly NodeEnvironment[] = ['development', 'production', 'test'];
const VALID_LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

const DEFAULT_PORT = 3000;
const DEFAULT_BIND_HOST = '127.0.0.1';

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

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    nodeEnv,
    isDevelopment: nodeEnv === 'development',
    isProduction: nodeEnv === 'production',
    port,
    bindHost,
    appUrl,
    logLevel,
  };
}

/*
 * Deferred configuration — documented in .env.example, added here by the phase that needs it:
 *
 *   Phase 3  DATABASE_URL              PostgreSQL connection (company_chat_db only)
 *   Phase 4  (none)                    the realtime layer reuses PORT / APP_URL
 *   Phase 5  SESSION_TTL_HOURS         idle session lifetime, default 24        (D-04)
 *            DEVICE_ID_TTL_DAYS        device identity lifetime, default 90     (D-13)
 *   Phase 7  UPLOAD_DIR                file storage root, outside the web root
 *            MAX_FILE_SIZE             upload ceiling in bytes, default 500 MB  (D-05)
 *            ALLOWED_FILE_EXTENSIONS   upload allowlist
 *   Phase 8  ALLOWED_NETWORKS          CIDRs permitted to reach the application
 *            TRUSTED_PROXY_IPS         peers whose forwarding headers are believed
 */
