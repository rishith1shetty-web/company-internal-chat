/**
 * The database and the file store must describe the same deployment.
 *
 * This covers the rule itself, as a pure function. The companion cases in
 * `tests/security/reset-production-guard.test.ts` prove that the destructive script actually
 * consults it, by running the script.
 *
 * The case that matters is the second one. It is not hypothetical: the development `.env` names
 * the production database `company_chat_db` and sets no `UPLOAD_DIR`, so storage falls back to
 * `./var/uploads` inside the repository. A destructive tool run under that file deletes real rows
 * and unlinks nothing, because the files it is looking for are somewhere else entirely.
 */

import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PRODUCTION_UPLOAD_DIR, checkStoragePairing } from '../../lib/db/storage-pairing';
import { REQUIRED_DATABASE_NAME } from '../../lib/db/target';

/** What the development `.env` silently resolves to: the default, relative to the repository. */
const DEV_FALLBACK_UPLOAD_DIR = resolve('./var/uploads');

describe('checkStoragePairing', () => {
  it('accepts the production database with the production store', () => {
    const pairing = checkStoragePairing(REQUIRED_DATABASE_NAME, PRODUCTION_UPLOAD_DIR);

    expect(pairing.valid).toBe(true);
    expect(pairing.reason).toBeNull();
    expect(pairing.database).toBe(REQUIRED_DATABASE_NAME);
    expect(pairing.uploadDir).toBe(resolve(PRODUCTION_UPLOAD_DIR));
  });

  it('REFUSES the production database with the development fallback store', () => {
    // The exact configuration that prompted this guard.
    const pairing = checkStoragePairing(REQUIRED_DATABASE_NAME, DEV_FALLBACK_UPLOAD_DIR);

    expect(pairing.valid).toBe(false);
    expect(pairing.reason).toContain(REQUIRED_DATABASE_NAME);
    // The message has to name the directory, or an operator cannot tell which half is wrong.
    expect(pairing.reason).toContain(DEV_FALLBACK_UPLOAD_DIR);
  });

  it('REFUSES another database with the production store', () => {
    const pairing = checkStoragePairing('some_other_db', PRODUCTION_UPLOAD_DIR);

    expect(pairing.valid).toBe(false);
    expect(pairing.reason).toContain('some_other_db');
  });

  it('leaves a wholly non-production pair alone, because that is a different question', () => {
    /*
     * A development database with a development store is internally consistent, and whether that
     * database may be touched at all belongs to `parseDatabaseUrl`, not here. Asserted so that a
     * later "tighten it up" does not quietly turn this consistency check into a second, weaker
     * copy of the target guard.
     */
    const pairing = checkStoragePairing('scratch_db', DEV_FALLBACK_UPLOAD_DIR);

    expect(pairing.valid).toBe(true);
    expect(pairing.reason).toBeNull();
  });

  it('compares paths as the filesystem does, not as strings', () => {
    /*
     * The two sides come from different places — one typed into an environment file, one a
     * constant in source — so case, trailing separators and relative segments must not read as
     * two different directories. A false MISMATCH here would block a correct production run,
     * which is how a safety guard gets disabled by whoever it inconveniences.
     */
    for (const spelling of [
      'c:\\company-chat\\uploads',
      'C:\\company-chat\\uploads\\',
      'C:\\company-chat\\.\\uploads',
      'C:\\company-chat\\logs\\..\\uploads',
    ]) {
      const pairing = checkStoragePairing(REQUIRED_DATABASE_NAME, spelling);
      expect(pairing.valid, `${spelling} should be recognised as the production store`).toBe(true);
    }
  });

  it('does not treat a subdirectory of the production store as the production store', () => {
    /*
     * `startsWith` would accept this. A nested directory is a different storage root: rows would
     * be deleted while the files one level up stayed behind, which is the failure being guarded
     * against, only harder to notice.
     */
    const pairing = checkStoragePairing(
      REQUIRED_DATABASE_NAME,
      `${PRODUCTION_UPLOAD_DIR}\\2026`,
    );

    expect(pairing.valid).toBe(false);
  });

  it('never puts a credential in the reason', () => {
    const pairing = checkStoragePairing(REQUIRED_DATABASE_NAME, DEV_FALLBACK_UPLOAD_DIR);

    expect(pairing.reason).not.toMatch(/postgres(ql)?:\/\//i);
    expect(pairing.reason).not.toMatch(/password/i);
  });
});
