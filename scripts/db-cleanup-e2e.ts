/**
 * Removes the rows one automated end-to-end run created, and nothing else.
 *
 *   npx tsx scripts/db-cleanup-e2e.ts                    # clean up zz-desk- (the desktop client)
 *   npx tsx scripts/db-cleanup-e2e.ts --prefix=zz-gui-   # another harness
 *   npx tsx scripts/db-cleanup-e2e.ts --dry-run          # show what would go, change nothing
 *
 * THIS SCRIPT DELETES DATA, so what it refuses to do matters more than what it does:
 *
 *   1. THE PREFIX MUST BE A KNOWN VERIFICATION PREFIX (scripts/test-prefixes.ts). A typo, or a
 *      prefix somebody invented on the command line, is refused rather than run — there is no way
 *      to point this at real employee names.
 *   2. IT REFUSES ANY DATABASE BUT company_chat_db, through the same target guard the application
 *      uses (docs/02-database.md §0).
 *   3. A CONVERSATION IS ONLY DELETED IF EVERY MEMBER IS A TEST USER. One real employee in a
 *      conversation makes the whole conversation off limits — and the test users in it are left
 *      alone too, because deleting a User cascades their membership out of a conversation that is
 *      somebody's real history. That case is reported and skipped, never guessed at.
 *   4. IT DELETES BY ID, in explicit foreign-key order, inside one transaction. Nothing relies on
 *      a cascade doing the right thing silently.
 *
 * Attachment files are removed from disk AFTER the transaction commits. That order is deliberate:
 * a row without its file is a broken download, while a file without its row is an orphan the
 * storage sweep already handles.
 */

import { PrismaPg } from '@prisma/adapter-pg';

import { loadConfig } from '../lib/config/env';
import { parseDatabaseUrl } from '../lib/db/target';
import { deleteStoredFile } from '../lib/files/storage';
import { PrismaClient } from '../prisma/generated/client';
import { TEST_PREFIXES, isTestPrefix } from './test-prefixes';

/** The desktop client's harness, which is what this is normally run for. */
const DEFAULT_PREFIX = 'zz-desk-';

function readArgument(name: string): string | undefined {
  const match = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return match?.slice(name.length + 3);
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // A missing .env is not an error here; the target guard below reports the real problem.
  }

  const dryRun = process.argv.includes('--dry-run');
  const prefix = readArgument('prefix') ?? DEFAULT_PREFIX;

  if (!isTestPrefix(prefix)) {
    process.stderr.write(
      `Refusing to run: "${prefix}" is not a known verification prefix.\n` +
        `Known prefixes: ${TEST_PREFIXES.join(', ')}\n` +
        'Add it to scripts/test-prefixes.ts if a new harness needs one.\n',
    );
    process.exit(1);
  }

  // Same guard as the application and the audit: this can only ever run against company_chat_db.
  const target = parseDatabaseUrl(process.env['DATABASE_URL']);
  const config = loadConfig();

  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env['DATABASE_URL'] }),
  });

  const out = (text: string) => process.stdout.write(`${text}\n`);

  try {
    out('');
    out(`Cleanup of "${prefix}" rows in "${target.database}"${dryRun ? '  (DRY RUN)' : ''}`);
    out('');

    /* ---------------------------------------------------------------- what belongs to the run */

    const users = await db.user.findMany({
      where: { normalizedName: { startsWith: prefix } },
      select: { id: true, displayName: true },
    });
    const userIds = new Set(users.map((user) => user.id));

    /*
     * Devices are matched by their own label as well as by their employee, for the reason the
     * audit gives: a reassigned device belongs to a different employee than it was created with,
     * so looking only at test users would miss one an interrupted run left behind.
     */
    const devices = await db.device.findMany({
      where: {
        OR: [{ label: { startsWith: prefix } }, { userId: { in: [...userIds] } }],
      },
      select: { id: true, label: true },
    });

    const conversations = await db.conversation.findMany({
      where: { members: { some: { userId: { in: [...userIds] } } } },
      select: {
        id: true,
        name: true,
        members: { select: { userId: true, user: { select: { displayName: true } } } },
      },
    });

    const testOnly = conversations.filter((c) => c.members.every((m) => userIds.has(m.userId)));
    const shared = conversations.filter((c) => !c.members.every((m) => userIds.has(m.userId)));

    /*
     * Guard 3. A test user sitting in a real conversation is not deleted at all: the User→
     * ConversationMember cascade would quietly remove them from somebody's real history, which is
     * a change to real data dressed up as a cleanup.
     */
    const protectedUserIds = new Set(shared.flatMap((c) => c.members.map((m) => m.userId)));
    const deletableUsers = users.filter((user) => !protectedUserIds.has(user.id));
    const deletableUserIds = deletableUsers.map((user) => user.id);
    const conversationIds = testOnly.map((c) => c.id);

    const attachments = await db.attachment.findMany({
      where: { conversationId: { in: conversationIds } },
      select: { id: true, storageKey: true, originalFilename: true },
    });

    const messageCount = await db.message.count({ where: { conversationId: { in: conversationIds } } });
    const memberCount = await db.conversationMember.count({
      where: { conversationId: { in: conversationIds } },
    });
    const sessionCount = await db.session.count({
      where: {
        OR: [{ userId: { in: deletableUserIds } }, { deviceId: { in: devices.map((d) => d.id) } }],
      },
    });

    out('  To remove');
    out(`    Attachments          ${attachments.length}`);
    out(`    Messages             ${messageCount}`);
    out(`    ConversationMembers  ${memberCount}`);
    out(`    Conversations        ${testOnly.length}`);
    out(`    Sessions             ${sessionCount}`);
    out(`    Devices              ${devices.length}`);
    out(`    Users                ${deletableUsers.length}`);
    out('');

    if (shared.length > 0) {
      out('  LEFT ALONE — these conversations contain someone who is not a test user:');
      for (const conversation of shared) {
        const outsiders = conversation.members
          .filter((m) => !userIds.has(m.userId))
          .map((m) => m.user.displayName);
        out(`    ${conversation.id}  ${conversation.name ?? '(direct)'}  with ${outsiders.join(', ')}`);
      }
      out(`  and the ${users.length - deletableUsers.length} test user(s) in them are kept too.`);
      out('');
    }

    if (dryRun) {
      out('  Dry run: nothing was changed.');
      out('');
      return;
    }

    if (
      attachments.length === 0 &&
      testOnly.length === 0 &&
      devices.length === 0 &&
      deletableUsers.length === 0
    ) {
      out('  Nothing to remove.');
      out('');
      return;
    }

    /* ------------------------------------------------------- delete, in foreign-key order */

    await db.$transaction(async (tx) => {
      await tx.attachment.deleteMany({ where: { conversationId: { in: conversationIds } } });
      await tx.message.deleteMany({ where: { conversationId: { in: conversationIds } } });
      await tx.conversationMember.deleteMany({ where: { conversationId: { in: conversationIds } } });
      await tx.conversation.deleteMany({ where: { id: { in: conversationIds } } });

      await tx.session.deleteMany({
        where: {
          OR: [{ userId: { in: deletableUserIds } }, { deviceId: { in: devices.map((d) => d.id) } }],
        },
      });
      await tx.device.deleteMany({ where: { id: { in: devices.map((d) => d.id) } } });
      await tx.user.deleteMany({ where: { id: { in: deletableUserIds } } });
    });

    out('  Database rows removed.');

    /* ------------------------------------------------------------------------- then the files */

    let filesRemoved = 0;
    for (const attachment of attachments) {
      try {
        await deleteStoredFile(
          { uploadDir: config.uploadDir, maxFileSize: config.maxFileSize },
          attachment.storageKey,
        );
        filesRemoved += 1;
      } catch {
        // Reported rather than thrown: the rows are already gone, and an orphaned file is a
        // storage-sweep problem rather than a reason to fail the cleanup.
        out(`  Could not remove ${attachment.originalFilename}; it is now an orphan on disk.`);
      }
    }

    out(`  ${filesRemoved} of ${attachments.length} attachment file(s) removed from storage.`);
    out('');
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
