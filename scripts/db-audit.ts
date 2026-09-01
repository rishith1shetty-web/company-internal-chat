/**
 * Read-only row audit.
 *
 * Run after a test suite to confirm the run left nothing behind. It reads counts and looks for
 * display names carrying the test prefixes; it never writes, deletes or alters anything, and it
 * refuses to run against any database but `company_chat_db` because it goes through the same
 * target guard the application does (docs/02-database.md §0).
 *
 *   npx tsx scripts/db-audit.ts
 */

import { PrismaPg } from '@prisma/adapter-pg';

import { parseDatabaseUrl } from '../lib/db/target';
import { PrismaClient } from '../prisma/generated/client';

/**
 * Every prefix used by anything that creates rows for verification.
 *
 * The list must stay complete. An audit that only knows some of the prefixes reports "none" while
 * rows are still there, which is worse than not auditing at all.
 */
const TEST_PREFIXES = ['zz-test-', 'zz-rt-', 'zz-test-p5-', 'zz-e2e-', 'zz-ui-'];

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // A missing .env is not an error here; the guard below reports the real problem.
  }

  const target = parseDatabaseUrl(process.env['DATABASE_URL']);

  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env['DATABASE_URL'] }),
  });

  try {
    // Redacted deliberately: the database name only, never the connection string.
    process.stdout.write(`\nRow audit for "${target.database}"\n\n`);

    const counts = {
      User: await db.user.count(),
      Session: await db.session.count(),
      Device: await db.device.count(),
      Conversation: await db.conversation.count(),
      ConversationMember: await db.conversationMember.count(),
      Message: await db.message.count(),
      Attachment: await db.attachment.count(),
    };

    for (const [table, count] of Object.entries(counts)) {
      process.stdout.write(`  ${table.padEnd(20)} ${count}\n`);
    }

    const users = await db.user.findMany({
      where: { OR: TEST_PREFIXES.map((prefix) => ({ normalizedName: { startsWith: prefix } })) },
      select: { id: true, displayName: true, createdAt: true },
      take: 50,
    });

    /*
     * Devices are checked by their own label, not through their assigned employee.
     *
     * A reassigned device belongs to a different employee than the one it was created with, so a
     * device left behind by an interrupted run would not be found by looking at test users — and
     * an audit that reports "none" while rows remain is worse than no audit at all.
     */
    const devices = await db.device.findMany({
      where: { OR: TEST_PREFIXES.map((prefix) => ({ label: { startsWith: prefix } })) },
      select: { id: true, label: true, createdAt: true },
      take: 50,
    });

    const leftovers = [
      ...users.map((user) => ({ id: user.id, name: user.displayName, createdAt: user.createdAt })),
      ...devices.map((device) => ({
        id: device.id,
        name: `device "${device.label}"`,
        createdAt: device.createdAt,
      })),
    ];

    process.stdout.write('\nTest rows still present\n');

    if (leftovers.length === 0) {
      process.stdout.write('  none\n\n');
    } else {
      // Reported, never deleted: removing rows a script merely guessed were test data is exactly
      // the kind of destructive action this project forbids.
      for (const row of leftovers) {
        process.stdout.write(`  ${row.id}  ${row.name}  ${row.createdAt.toISOString()}\n`);
      }
      process.stdout.write(
        `\n  ${leftovers.length} left behind. Remove them by id if they are not wanted.\n\n`,
      );
      process.exitCode = 1;
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
