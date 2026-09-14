/**
 * The database and the file store must belong to the same deployment.
 *
 * WHY THIS EXISTS. A chat record is two halves: the row in PostgreSQL and the bytes under
 * `UPLOAD_DIR`. Nothing in the configuration ties them together — `DATABASE_URL` and `UPLOAD_DIR`
 * are independent variables, and a file that sets one without the other gets a default for the
 * rest. That is not hypothetical: the development `.env` sets `DATABASE_URL` to the production
 * database `company_chat_db` but sets no `UPLOAD_DIR` at all, so `loadConfig()` falls back to
 * `./var/uploads` inside the repository (lib/config/env.ts). The result is a configuration that
 * reads and writes LIVE COMPANY ROWS while pointing at an EMPTY DEVELOPMENT DIRECTORY.
 *
 * For an ordinary request that is merely broken. For a destructive tool it is dangerous in a
 * specific way: it deletes every attachment row, then looks for the files to unlink in the wrong
 * directory, finds nothing, and reports success. Every real upload is left on disk with no row
 * referring to it — unreachable through the application, invisible to the orphan sweep that runs
 * from the other configuration, and not obviously missing from any report.
 *
 * So this module answers one question: do the database and the storage root describe the same
 * deployment? It is deliberately a pure function over two strings — no environment, no I/O — so
 * the rule can be tested exhaustively and asserted anywhere it matters.
 *
 * IT IS A CONSISTENCY CHECK, NOT AN ACCESS CONTROL. `parseDatabaseUrl` remains the authority on
 * which database may be touched at all, and `detectProduction` remains the authority on whether a
 * destructive tool may run. This adds a third, independent question that neither of those asks,
 * and it can only ever refuse — it grants nothing.
 */

import { resolve } from 'node:path';

import { REQUIRED_DATABASE_NAME } from './target';

/**
 * The deployed storage root, as configured in the production environment file.
 *
 * A literal, not a lookup, and that is the point: a guard whose expected value is read from the
 * same environment it is checking cannot detect a wrong environment. It is a parameter of
 * `checkStoragePairing` so a future server whose store lives elsewhere (docs/20 §15) changes this
 * one constant rather than the rule.
 */
export const PRODUCTION_UPLOAD_DIR = 'C:\\company-chat\\uploads';

export interface StoragePairing {
  /** The database name, as parsed from `DATABASE_URL`. */
  readonly database: string;
  /** The upload directory, resolved to an absolute path. */
  readonly uploadDir: string;
  /** True when the database and the storage root describe the same deployment. */
  readonly valid: boolean;
  /** Why the pair was rejected. `null` when valid. Never contains a credential. */
  readonly reason: string | null;
}

/**
 * Compares two paths the way the filesystem underneath them does.
 *
 * Windows paths are case-insensitive, and the two sides of this comparison come from different
 * places — one typed into an environment file by hand, one a constant in source — so `c:\` and
 * `C:\`, or a stray trailing separator, must not read as two different directories. Resolving
 * first also collapses `..` and relative forms, which is how `./var/uploads` becomes comparable
 * to an absolute production path in the first place.
 */
function samePath(left: string, right: string): boolean {
  const normalise = (value: string) => resolve(value).replace(/[\\/]+$/, '').toLowerCase();
  return normalise(left) === normalise(right);
}

/**
 * Decides whether a database and a storage root belong together.
 *
 * The rule is symmetry: the production database requires the production store, and the production
 * store requires the production database. Either one alone is a configuration that has been
 * assembled from two different environments.
 *
 * A pair that is neither — a non-production database with a non-production store — is reported
 * VALID here. That is not an endorsement of the database; it is this function declining to answer
 * a question that is not its own. Whether that database may be touched at all is decided by
 * `parseDatabaseUrl`, which refuses everything but `company_chat_db` long before this is reached.
 *
 * @param database            Database name from `parseDatabaseUrl`, not a raw connection string.
 * @param uploadDir           `UPLOAD_DIR` as resolved by `loadConfig()`; may be relative.
 * @param productionUploadDir Overridable so tests need no real directory and so a server move
 *                            changes one value.
 */
export function checkStoragePairing(
  database: string,
  uploadDir: string,
  productionUploadDir: string = PRODUCTION_UPLOAD_DIR,
): StoragePairing {
  const resolved = resolve(uploadDir);
  const isProductionDatabase = database === REQUIRED_DATABASE_NAME;
  const isProductionStore = samePath(uploadDir, productionUploadDir);

  if (isProductionDatabase && !isProductionStore) {
    return {
      database,
      uploadDir: resolved,
      valid: false,
      reason:
        `the database is "${REQUIRED_DATABASE_NAME}" — the live company database — but the ` +
        `storage root is "${resolved}", not the production store "${resolve(productionUploadDir)}". ` +
        'This is the development environment file pointed at production data: rows would be ' +
        'deleted here while their files were looked for somewhere else, leaving every real ' +
        'upload orphaned on disk. Set ENV_FILE to the production environment file.',
    };
  }

  if (!isProductionDatabase && isProductionStore) {
    return {
      database,
      uploadDir: resolved,
      valid: false,
      reason:
        `the storage root is the production store "${resolved}", but the database is ` +
        `"${database}", not "${REQUIRED_DATABASE_NAME}". Deleting from one deployment's database ` +
        "while holding another deployment's files cannot be correct in either direction.",
    };
  }

  return { database, uploadDir: resolved, valid: true, reason: null };
}
