/**
 * Prove that every attachment row still has its file, and that the bytes are the bytes.
 *
 *   npx tsx scripts/verify-attachments.ts                       # the configured UPLOAD_DIR
 *   npx tsx scripts/verify-attachments.ts --upload-dir=<path>   # a backup or a restored copy
 *
 * READ-ONLY. It opens no write transaction, deletes nothing and creates nothing. Safe to run
 * against production at any time, including while employees are using the system.
 *
 * WHY IT EXISTS. The database and the file store are two halves of one record, kept in step by
 * ordering rather than by a transaction: `lib/files/storage.ts` writes the file and renames it
 * into place, and only then is the `Attachment` row committed. Nothing enforces that they stay in
 * step afterwards - a half-copied backup, a restore that missed a directory, or a migration that
 * copied files before dumping the database would all leave rows pointing at bytes that are absent
 * or wrong. `checksumSha256` was recorded at upload time precisely so that this can be checked.
 *
 * `--upload-dir` is what makes it useful for a server move: verify the RESTORED files against the
 * RESTORED database before anybody is allowed to write to the new server.
 *
 * Exit code 0 when every attachment verifies, 1 otherwise.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import { loadConfig } from '../lib/config/env';
import { loadEnvironmentFile } from '../lib/config/env-file';
import { createDatabaseAdapter } from '../lib/db/prisma';
import { parseDatabaseUrl } from '../lib/db/target';
import { resolveStoragePath } from '../lib/files/storage';
import { PrismaClient } from '../prisma/generated/client';

const out = (text = '') => process.stdout.write(`${text}\n`);

function readArgument(name: string): string | undefined {
  const match = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return match?.slice(name.length + 3);
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function main(): Promise<void> {
  loadEnvironmentFile();

  const target = parseDatabaseUrl(process.env['DATABASE_URL']);
  const config = loadConfig();
  const uploadDir = resolve(readArgument('upload-dir') ?? config.uploadDir);

  const db = new PrismaClient({
    adapter: createDatabaseAdapter('verify-attachments'),
  });

  let missing = 0;
  let wrongSize = 0;
  let wrongHash = 0;
  let verified = 0;
  /** Rows whose checksum was never recorded. Counted, never quietly treated as verified. */
  let unchecksummed = 0;

  try {
    out();
    out('  ATTACHMENT VERIFICATION');
    out('  ─────────────────────────────────────────────────────────────────────────────');
    out(`  database    ${target.redacted}`);
    out(`  storage     ${uploadDir}`);
    out();

    /*
     * Only `READY` rows.
     *
     * Delete-for-everyone (Batch 1) sets an attachment to `DELETED` and removes its bytes on
     * purpose, so those rows have no file by design. Checking them would report every deleted
     * file as MISSING and turn a clean verification into a wall of false failures — which is how
     * a check like this stops being read.
     *
     * `PENDING` and `FAILED` are excluded for the same reason: neither promises bytes on disk.
     */
    const attachments = await db.attachment.findMany({
      where: { status: 'READY' },
      select: { id: true, storageKey: true, byteSize: true, checksumSha256: true },
      orderBy: { createdAt: 'asc' },
    });

    /*
     * Counted separately, and tolerantly.
     *
     * `DELETED` is a value migration #3 adds to the enum, so on a database where that migration
     * has not been applied yet PostgreSQL rejects the comparison outright. This tool has to keep
     * working against a server that is mid-upgrade — it is exactly what an administrator reaches
     * for when they are unsure whether a deployment went cleanly — so an older database reports
     * no deleted attachments rather than failing the whole verification.
     */
    let deleted = 0;
    try {
      deleted = await db.attachment.count({ where: { status: 'DELETED' } });
    } catch {
      deleted = 0;
    }

    if (attachments.length === 0) {
      out('  No attachments recorded. Nothing to verify.');
      out();
      return;
    }

    for (const attachment of attachments) {
      // The same resolver the application uses, so a storage key that would escape the root is
      // rejected here exactly as it would be on a download.
      const path = resolveStoragePath({ uploadDir, maxFileSize: config.maxFileSize }, attachment.storageKey);

      let size: number;
      try {
        size = (await stat(path)).size;
      } catch {
        out(`  MISSING   ${attachment.storageKey}  (attachment ${attachment.id})`);
        missing += 1;
        continue;
      }

      if (size !== Number(attachment.byteSize)) {
        out(`  SIZE      ${attachment.storageKey}  recorded ${attachment.byteSize}, on disk ${size}`);
        wrongSize += 1;
        continue;
      }

      if (attachment.checksumSha256 === null) {
        // The column is nullable. A row without a checksum cannot be verified, and calling it
        // verified would be the one lie this whole utility exists to prevent - so it gets its own
        // line in the report. Size still matched, which is why this is not a failure.
        out(`  NO HASH   ${attachment.storageKey}  (no checksum recorded; size matches)`);
        unchecksummed += 1;
        continue;
      }

      const actual = await sha256Of(path);
      if (actual !== attachment.checksumSha256) {
        out(`  CHECKSUM  ${attachment.storageKey}  recorded ${attachment.checksumSha256.slice(0, 16)}…, actual ${actual.slice(0, 16)}…`);
        wrongHash += 1;
        continue;
      }

      verified += 1;
    }

    out();
    out(`  verified          ${verified}`);
    out(`  missing files     ${missing}`);
    out(`  wrong size        ${wrongSize}`);
    out(`  wrong checksum    ${wrongHash}`);
    out(`  no checksum       ${unchecksummed}`);
    if (deleted > 0) {
      out(`  deleted           ${deleted}  (bytes removed deliberately; not checked)`);
    }
    out();

    if (missing + wrongSize + wrongHash > 0) {
      out('  NOT EVERY ATTACHMENT VERIFIES. Investigate before trusting this copy.');
      out();
      process.exitCode = 1;
      return;
    }

    out(`  All ${verified} attachment(s) match the bytes recorded at upload time.`);
    if (unchecksummed > 0) {
      out(`  ${unchecksummed} had no recorded checksum and could only be size-checked.`);
    }
    out();
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`\n  Attachment verification failed: ${String(error)}\n\n`);
  process.exit(1);
});
