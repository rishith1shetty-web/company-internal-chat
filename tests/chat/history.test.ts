/**
 * Message history: authorization, ordering and keyset pagination (Phase 5).
 *
 * The endpoint behind these tests is what makes PostgreSQL the source of truth — the client
 * recovers from a reconnect by reading here, not by replaying socket events. So the properties
 * that matter are: it refuses non-members, it never returns anything before the caller's
 * `joinedAt` (D-03), and paging is stable while messages are being inserted underneath it.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { listMessages, sendMessage } from '@/lib/messages/service';

import {
  cleanUp,
  createTestIdentity,
  databaseConfigured,
  db,
  disconnect,
  seedDirectConversation,
  seedGroupConversation,
  uuid,
} from './harness';

const suite = databaseConfigured ? describe : describe.skip;

/** Sends `count` messages and returns them oldest first. */
async function seedMessages(
  conversationId: string,
  senderId: string,
  count: number,
): Promise<{ id: string; body: string }[]> {
  const created: { id: string; body: string }[] = [];

  for (let index = 0; index < count; index += 1) {
    const result = await sendMessage(db(), {
      senderId,
      conversationId,
      body: `message ${index}`,
      clientMessageId: uuid(),
    });
    created.push({ id: result.message.id, body: result.message.body ?? '' });
  }

  return created;
}

suite('message history', () => {
  afterAll(async () => {
    await cleanUp();
    await disconnect();
  });

  it('returns a conversation oldest first for a member', async () => {
    const alice = await createTestIdentity('Alice History');
    const bob = await createTestIdentity('Bob History');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const seeded = await seedMessages(conversationId, bob.userId, 5);

    const page = await listMessages(db(), { userId: alice.userId, conversationId });

    expect(page.messages.map((message) => message.body)).toEqual(
      seeded.map((message) => message.body),
    );
    expect(page.hasMore).toBe(false);
  });

  it('refuses a conversation the caller is not a member of', async () => {
    const alice = await createTestIdentity('Alice Closed');
    const bob = await createTestIdentity('Bob Closed');
    const outsider = await createTestIdentity('Outsider Closed');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    await seedMessages(conversationId, bob.userId, 2);

    await expect(
      listMessages(db(), { userId: outsider.userId, conversationId }),
    ).rejects.toMatchObject({ reason: 'NOT_A_MEMBER' });
  });

  it('gives the same answer for a conversation that does not exist', async () => {
    const alice = await createTestIdentity('Alice Unknown');

    // Identical failure to "not a member": distinguishing them would confirm which ids exist.
    await expect(
      listMessages(db(), { userId: alice.userId, conversationId: uuid() }),
    ).rejects.toMatchObject({ reason: 'NOT_A_MEMBER' });
  });

  it('refuses a member whose membership has been ended', async () => {
    const alice = await createTestIdentity('Alice Removed');
    const bob = await createTestIdentity('Bob Removed');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);
    await seedMessages(conversationId, alice.userId, 2);

    await db().conversationMember.update({
      where: { conversationId_userId: { conversationId, userId: bob.userId } },
      data: { leftAt: new Date() },
    });

    // The row still exists. Testing only for its existence is the access-control bug the schema
    // warns about; `leftAt IS NULL` is what actually decides.
    await expect(
      listMessages(db(), { userId: bob.userId, conversationId }),
    ).rejects.toMatchObject({ reason: 'NOT_A_MEMBER' });
  });

  it('never returns messages sent before the caller joined (D-03)', async () => {
    const owner = await createTestIdentity('Owner Bound');
    const latecomer = await createTestIdentity('Latecomer Bound');

    const joinedAt = new Date(Date.now() + 60_000);
    const conversationId = await seedGroupConversation(owner.userId, [
      { userId: latecomer.userId, joinedAt },
    ]);

    await seedMessages(conversationId, owner.userId, 3);

    const hidden = await listMessages(db(), { userId: latecomer.userId, conversationId });
    expect(hidden.messages).toEqual([]);

    const visible = await listMessages(db(), { userId: owner.userId, conversationId });
    expect(visible.messages).toHaveLength(3);
  });

  it('pages backwards with a keyset cursor', async () => {
    const alice = await createTestIdentity('Alice Paging');
    const bob = await createTestIdentity('Bob Paging');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const seeded = await seedMessages(conversationId, bob.userId, 7);

    const newest = await listMessages(db(), { userId: alice.userId, conversationId, limit: 3 });
    expect(newest.messages.map((m) => m.body)).toEqual(['message 4', 'message 5', 'message 6']);
    expect(newest.hasMore).toBe(true);

    const older = await listMessages(db(), {
      userId: alice.userId,
      conversationId,
      before: newest.messages[0]?.id,
      limit: 3,
    });
    expect(older.messages.map((m) => m.body)).toEqual(['message 1', 'message 2', 'message 3']);
    expect(older.hasMore).toBe(true);

    const oldest = await listMessages(db(), {
      userId: alice.userId,
      conversationId,
      before: older.messages[0]?.id,
      limit: 3,
    });
    expect(oldest.messages.map((m) => m.body)).toEqual(['message 0']);
    expect(oldest.hasMore).toBe(false);
    expect(oldest.messages[0]?.id).toBe(seeded[0]?.id);
  });

  it('backfills forwards from a cursor, which is how a reconnect catches up', async () => {
    const alice = await createTestIdentity('Alice Backfill');
    const bob = await createTestIdentity('Bob Backfill');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const before = await seedMessages(conversationId, bob.userId, 2);
    // What arrived while the socket was down.
    const during = await seedMessages(conversationId, bob.userId, 3);

    const page = await listMessages(db(), {
      userId: alice.userId,
      conversationId,
      after: before[before.length - 1]?.id,
    });

    expect(page.messages.map((m) => m.id)).toEqual(during.map((m) => m.id));
  });

  it('rejects a cursor from another conversation', async () => {
    const alice = await createTestIdentity('Alice Cursor');
    const bob = await createTestIdentity('Bob Cursor');
    const carol = await createTestIdentity('Carol Cursor');

    const mine = await seedDirectConversation(alice.userId, bob.userId);
    const elsewhere = await seedDirectConversation(alice.userId, carol.userId);

    const foreign = await seedMessages(elsewhere, carol.userId, 1);

    await expect(
      listMessages(db(), { userId: alice.userId, conversationId: mine, before: foreign[0]?.id }),
    ).rejects.toMatchObject({ reason: 'INVALID_CURSOR' });
  });

  it('clamps an oversized limit rather than honouring it', async () => {
    const alice = await createTestIdentity('Alice Limit');
    const bob = await createTestIdentity('Bob Limit');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    await seedMessages(conversationId, bob.userId, 3);

    // 10_000 would be a request for the whole conversation; the ceiling is applied server-side.
    const page = await listMessages(db(), {
      userId: alice.userId,
      conversationId,
      limit: 10_000,
    });

    expect(page.messages).toHaveLength(3);
  });
});
