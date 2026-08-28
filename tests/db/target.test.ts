/**
 * Tests for the single-database safety guard (lib/db/target.ts).
 *
 * These need no database and always run. They matter more than their size suggests: this guard
 * is what stands between a mistyped connection string and one of the other databases on the
 * developer's PostgreSQL server, every one of which is off-limits (D-07, docs/02-database.md §0).
 */

import { describe, expect, it } from 'vitest';

import { DatabaseTargetError, REQUIRED_DATABASE_NAME, parseDatabaseUrl } from '@/lib/db/target';

const VALID = `postgresql://company_chat_app:s3cret@localhost:5432/${REQUIRED_DATABASE_NAME}`;

describe('parseDatabaseUrl', () => {
  it('accepts a connection string that targets company_chat_db', () => {
    const target = parseDatabaseUrl(VALID);

    expect(target.database).toBe('company_chat_db');
    expect(target.host).toBe('localhost');
    expect(target.port).toBe(5432);
    expect(target.user).toBe('company_chat_app');
  });

  it('never exposes the password in the redacted description', () => {
    const target = parseDatabaseUrl(VALID);

    expect(target.redacted).toBe('company_chat_app@localhost:5432/company_chat_db');
    expect(target.redacted).not.toContain('s3cret');
    expect(JSON.stringify(target)).not.toContain('s3cret');
  });

  it('refuses any other database on the same server', () => {
    // The central rule: this project connects to one database and no other.
    for (const other of ['postgres', 'template1', 'some_other_project', 'company_chat_db_old']) {
      const url = `postgresql://company_chat_app:s3cret@localhost:5432/${other}`;

      expect(() => parseDatabaseUrl(url)).toThrow(DatabaseTargetError);
      expect(() => parseDatabaseUrl(url)).toThrow(/may only ever connect to "company_chat_db"/);
    }
  });

  it('does not echo the connection string back in error messages', () => {
    // An error that quotes the URL would put the password into logs and terminals.
    try {
      parseDatabaseUrl('postgresql://company_chat_app:s3cret@localhost:5432/wrong_db');
      expect.unreachable('expected the guard to reject a different database');
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseTargetError);
      expect((error as Error).message).not.toContain('s3cret');
    }
  });

  it('rejects a missing or blank DATABASE_URL with an actionable message', () => {
    expect(() => parseDatabaseUrl(undefined)).toThrow(/DATABASE_URL is not set/);
    expect(() => parseDatabaseUrl('   ')).toThrow(/DATABASE_URL is not set/);
  });

  it('rejects a non-PostgreSQL connection string', () => {
    expect(() => parseDatabaseUrl('mysql://user:pw@localhost:3306/company_chat_db')).toThrow(
      /must be a PostgreSQL connection string/,
    );
  });

  it('rejects a malformed URL without repeating it', () => {
    try {
      parseDatabaseUrl('not-a-url-with-a-s3cret-in-it');
      expect.unreachable('expected the guard to reject a malformed URL');
    } catch (error) {
      expect((error as Error).message).toMatch(/not a valid connection URL/);
      expect((error as Error).message).not.toContain('s3cret');
    }
  });

  it('rejects a URL with no database name', () => {
    expect(() => parseDatabaseUrl('postgresql://company_chat_app:pw@localhost:5432')).toThrow(
      /names no database/,
    );
  });

  it('accepts the postgres:// scheme and query parameters', () => {
    const target = parseDatabaseUrl(
      `postgres://company_chat_app:pw@db.internal:6543/${REQUIRED_DATABASE_NAME}?schema=public&connection_limit=5`,
    );

    expect(target.database).toBe('company_chat_db');
    expect(target.host).toBe('db.internal');
    expect(target.port).toBe(6543);
  });

  it('defaults the port to 5432 when the URL omits it', () => {
    expect(
      parseDatabaseUrl(`postgresql://company_chat_app:pw@localhost/${REQUIRED_DATABASE_NAME}`).port,
    ).toBe(5432);
  });
});
