/**
 * Database target parsing and the single-database safety guard.
 *
 * docs/02-database.md §0 is a hard constraint on this project: it touches exactly ONE database —
 * `company_chat_db` — and nothing else on the PostgreSQL server, whatever else is installed
 * there. Every other database is off-limits: never read, written, migrated, reset, dropped or
 * renamed (D-07).
 *
 * Rule 4 of that section says the target database must be confirmed before any database command
 * runs. This module is that confirmation, expressed as code rather than as discipline: nothing in
 * the application can obtain a Prisma client without the connection string having been parsed and
 * its database name checked here first.
 *
 * It also exists so that a mistyped or copy-pasted connection string fails immediately, with a
 * clear message, instead of quietly connecting to somebody else's database.
 *
 * No value derived here ever includes the password. `describeTarget()` returns a redacted string
 * that is safe to log (CLAUDE.md §13, §14).
 */

/** The only database this project may ever connect to. */
export const REQUIRED_DATABASE_NAME = 'company_chat_db';

const ALLOWED_PROTOCOLS = ['postgresql:', 'postgres:'] as const;

export interface DatabaseTarget {
  host: string;
  port: number;
  /** Always `company_chat_db` — a parse that produced anything else has already thrown. */
  database: string;
  /** The PostgreSQL role. This is a connection identity, never an application user. */
  user: string;
  /** `role@host:port/database`. Safe to log: contains no password. */
  redacted: string;
}

export class DatabaseTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseTargetError';
  }
}

/**
 * Parses `DATABASE_URL` and refuses anything that does not point at `company_chat_db`.
 *
 * @throws DatabaseTargetError when the variable is missing, malformed, not PostgreSQL, or names
 *         a different database. The message never contains the password.
 */
export function parseDatabaseUrl(raw: string | undefined): DatabaseTarget {
  const value = raw?.trim();

  if (!value) {
    throw new DatabaseTargetError(
      'DATABASE_URL is not set. Copy .env.example to .env and set the connection string for ' +
        `the ${REQUIRED_DATABASE_NAME} database. See docs/09-phase-3-database.md.`,
    );
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // Deliberately does not echo the value back: it contains a password.
    throw new DatabaseTargetError(
      'DATABASE_URL is not a valid connection URL. Expected the form ' +
        `postgresql://USER:PASSWORD@HOST:5432/${REQUIRED_DATABASE_NAME}`,
    );
  }

  if (!(ALLOWED_PROTOCOLS as readonly string[]).includes(url.protocol)) {
    throw new DatabaseTargetError(
      `DATABASE_URL must be a PostgreSQL connection string (received protocol "${url.protocol}").`,
    );
  }

  // URL.pathname is "/<database>"; strip the leading slash. Anything after a further slash is
  // not a database name and is treated as malformed rather than guessed at.
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));

  if (database.length === 0) {
    throw new DatabaseTargetError(
      `DATABASE_URL names no database. It must end in /${REQUIRED_DATABASE_NAME}.`,
    );
  }

  if (database !== REQUIRED_DATABASE_NAME) {
    // The whole point of this module. Every other database on the server belongs to something
    // else and must never be touched (D-07).
    throw new DatabaseTargetError(
      `Refusing to connect: DATABASE_URL targets the database "${database}", but this project ` +
        `may only ever connect to "${REQUIRED_DATABASE_NAME}". Every other database on the ` +
        'server is off-limits (docs/02-database.md §0). Fix DATABASE_URL in .env — do not ' +
        'change this check.',
    );
  }

  const host = url.hostname || 'localhost';
  const port = url.port ? Number(url.port) : 5432;

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new DatabaseTargetError(`DATABASE_URL has an invalid port ("${url.port}").`);
  }

  const user = decodeURIComponent(url.username) || '(no role in URL)';

  return {
    host,
    port,
    database,
    user,
    redacted: `${user}@${host}:${port}/${database}`,
  };
}

/**
 * Redacted description of the configured target, for logs and the pre-migration check.
 * Never returns the password, and never returns the raw connection string.
 */
export function describeTarget(env: NodeJS.ProcessEnv = process.env): string {
  return parseDatabaseUrl(env['DATABASE_URL']).redacted;
}
