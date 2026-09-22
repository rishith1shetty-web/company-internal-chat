/**
 * Test helpers for the database layer.
 *
 * SAFETY. These tests run against `company_chat_db` itself — the project's own database, and the
 * only one it may ever touch (docs/02-database.md §0). They are written so that is safe:
 *
 *   - Every row they create is registered here and removed afterwards by id.
 *   - Nothing is ever truncated, and no table is emptied. `TRUNCATE`, `DROP` and every reset
 *     command are prohibited in this project, tests included.
 *   - Rows created by anything other than the test run are never read, modified or deleted.
 *   - Test users are named with a recognisable prefix so that anything left behind by an
 *     interrupted run can be identified by a human, rather than guessed at by a script.
 *
 * The suite skips entirely when DATABASE_URL is not configured, so `npm test` works on a machine
 * that has not set up the database.
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@/prisma/generated/client';
import { createDatabaseAdapter } from '@/lib/db/prisma';
import { parseDatabaseUrl } from '@/lib/db/target';

/** Prefix for every display name created by the tests. */
export const TEST_NAME_PREFIX = 'zz-test-';

/** True when a database is configured; the integration suite is skipped when it is not. */
export const databaseConfigured = Boolean(process.env['DATABASE_URL']?.trim());

let client: PrismaClient | undefined;

/** Ids created during the run, removed by `cleanUp()`. */
const created = {
  users: new Set<string>(),
  conversations: new Set<string>(),
};

export function db(): PrismaClient {
  if (!client) {
    // Parsed through the guard here too: a test run must not be able to reach another database
    // any more than the application can.
    parseDatabaseUrl(process.env['DATABASE_URL']);

    client = new PrismaClient({
      adapter: createDatabaseAdapter('tests/db'),
    });
  }
  return client;
}

/** Creates a user and registers it for cleanup. Display names are intentionally NOT unique. */
export async function createUser(displayName = 'Test Person'): Promise<{
  id: string;
  displayName: string;
}> {
  const name = `${TEST_NAME_PREFIX}${displayName}`;
  const user = await db().user.create({
    data: {
      displayName: name,
      normalizedName: name.toLowerCase().replace(/\s+/g, ' '),
    },
  });
  created.users.add(user.id);
  return user;
}

/** The sorted-pair key that makes "one direct conversation per pair" a database constraint. */
export function directKeyFor(userIdA: string, userIdB: string): string {
  return [userIdA, userIdB].sort().join(':');
}

export async function createDirectConversation(
  userIdA: string,
  userIdB: string,
): Promise<{ id: string }> {
  const conversation = await db().conversation.create({
    data: {
      type: 'DIRECT',
      directKey: directKeyFor(userIdA, userIdB),
      createdById: userIdA,
      members: {
        create: [{ userId: userIdA }, { userId: userIdB }],
      },
    },
  });
  created.conversations.add(conversation.id);
  return conversation;
}

export async function createGroup(
  ownerId: string,
  name = 'Test Group',
  memberIds: string[] = [],
): Promise<{ id: string }> {
  const conversation = await db().conversation.create({
    data: {
      type: 'GROUP',
      name: `${TEST_NAME_PREFIX}${name}`,
      createdById: ownerId,
      members: {
        create: [
          { userId: ownerId, role: 'OWNER' },
          ...memberIds.map((userId) => ({ userId })),
        ],
      },
    },
  });
  created.conversations.add(conversation.id);
  return conversation;
}

/** A client-minted idempotency key, as the browser would generate. */
export function clientMessageId(): string {
  return randomUUID();
}

/**
 * Removes everything the run created, by id.
 *
 * Conversations are deleted first so their members, messages and attachments go with them
 * through the intended cascades; users follow, taking their sessions and devices. `deleteMany`
 * is used deliberately: a test that already deleted a row must not make cleanup fail.
 */
export async function cleanUp(): Promise<void> {
  if (!client) return;

  await client.conversation.deleteMany({ where: { id: { in: [...created.conversations] } } });
  await client.user.deleteMany({ where: { id: { in: [...created.users] } } });

  created.conversations.clear();
  created.users.clear();
}

export async function disconnect(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}
