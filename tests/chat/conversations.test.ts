/**
 * Direct conversations, previews and unread counts (Phase 5).
 *
 * The three properties under test:
 *
 *   1. Exactly one direct conversation per pair, enforced by the database rather than by hopeful
 *      application code — including when two requests race.
 *   2. A conversation is only ever listed for its own members.
 *   3. The unread count means what the interface claims: messages the caller has not seen and
 *      did not send, inside their visible window (D-03).
 */

import { afterAll, describe, expect, it } from 'vitest';

import {
  ConversationError,
  directKeyFor,
  listConversationsForUser,
  markConversationRead,
  resolveDirectConversation,
} from '@/lib/conversations/service';
import { sendMessage } from '@/lib/messages/service';

import {
  cleanUp,
  createTestIdentity,
  databaseConfigured,
  db,
  disconnect,
  seedDirectConversation,
  seedGroupConversation,
  trackConversation,
  uuid,
} from './harness';

const suite = databaseConfigured ? describe : describe.skip;

suite('direct conversations', () => {
  afterAll(async () => {
    await cleanUp();
    await disconnect();
  });

  it('creates a direct conversation with both members', async () => {
    const alice = await createTestIdentity('Alice Create');
    const bob = await createTestIdentity('Bob Create');

    const result = await resolveDirectConversation(db(), alice.userId, bob.userId);
    trackConversation(result.conversationId);

    expect(result.created).toBe(true);

    const conversation = await db().conversation.findUnique({
      where: { id: result.conversationId },
      select: { type: true, directKey: true, members: { select: { userId: true, role: true } } },
    });

    expect(conversation?.type).toBe('DIRECT');
    expect(conversation?.directKey).toBe(directKeyFor(alice.userId, bob.userId));
    expect(new Set(conversation?.members.map((member) => member.userId))).toEqual(
      new Set([alice.userId, bob.userId]),
    );
    // Direct conversations have no owner: neither member outranks the other.
    expect(conversation?.members.every((member) => member.role === 'MEMBER')).toBe(true);
  });

  it('returns the existing conversation instead of creating a second one', async () => {
    const alice = await createTestIdentity('Alice Reuse');
    const bob = await createTestIdentity('Bob Reuse');

    const first = await resolveDirectConversation(db(), alice.userId, bob.userId);
    trackConversation(first.conversationId);

    const second = await resolveDirectConversation(db(), alice.userId, bob.userId);

    expect(second.conversationId).toBe(first.conversationId);
    expect(second.created).toBe(false);
  });

  it('resolves the same conversation whichever member asks', async () => {
    const alice = await createTestIdentity('Alice Symmetric');
    const bob = await createTestIdentity('Bob Symmetric');

    const fromAlice = await resolveDirectConversation(db(), alice.userId, bob.userId);
    trackConversation(fromAlice.conversationId);

    // The other direction: `directKey` sorts the pair, so the order of the two ids is irrelevant.
    const fromBob = await resolveDirectConversation(db(), bob.userId, alice.userId);

    expect(fromBob.conversationId).toBe(fromAlice.conversationId);
    expect(fromBob.created).toBe(false);
  });

  it('cannot be raced into two conversations for the same pair', async () => {
    const alice = await createTestIdentity('Alice Race');
    const bob = await createTestIdentity('Bob Race');

    // Both sides clicking at the same instant. One insert wins the unique index; the other must
    // read the winner's row rather than failing or duplicating.
    const results = await Promise.all([
      resolveDirectConversation(db(), alice.userId, bob.userId),
      resolveDirectConversation(db(), bob.userId, alice.userId),
      resolveDirectConversation(db(), alice.userId, bob.userId),
    ]);

    const ids = new Set(results.map((result) => result.conversationId));
    expect(ids.size).toBe(1);
    trackConversation([...ids][0] as string);

    const stored = await db().conversation.count({
      where: { directKey: directKeyFor(alice.userId, bob.userId) },
    });
    expect(stored).toBe(1);
  });

  it('refuses a conversation with yourself', async () => {
    const alice = await createTestIdentity('Alice Self');

    await expect(
      resolveDirectConversation(db(), alice.userId, alice.userId),
    ).rejects.toBeInstanceOf(ConversationError);
  });

  it('refuses a conversation with a user id that does not exist', async () => {
    const alice = await createTestIdentity('Alice Ghost');

    await expect(resolveDirectConversation(db(), alice.userId, uuid())).rejects.toMatchObject({
      reason: 'USER_NOT_FOUND',
    });
  });

  it('refuses a conversation with a retired user', async () => {
    const alice = await createTestIdentity('Alice Retired Peer');
    const gone = await createTestIdentity('Gone Person');
    await db().user.update({ where: { id: gone.userId }, data: { isActive: false } });

    await expect(
      resolveDirectConversation(db(), alice.userId, gone.userId),
    ).rejects.toMatchObject({ reason: 'USER_NOT_FOUND' });
  });
});

suite('conversation listing', () => {
  afterAll(async () => {
    await cleanUp();
    await disconnect();
  });

  it('lists only the conversations the caller is a member of', async () => {
    const alice = await createTestIdentity('Alice List');
    const bob = await createTestIdentity('Bob List');
    const carol = await createTestIdentity('Carol List');
    const outsider = await createTestIdentity('Outsider List');

    const mine = await seedDirectConversation(alice.userId, bob.userId);
    const theirs = await seedDirectConversation(bob.userId, carol.userId);

    const listed = await listConversationsForUser(db(), alice.userId);
    const ids = listed.map((conversation) => conversation.id);

    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);

    // Somebody with no conversations at all sees an empty list, not everybody else's.
    expect(await listConversationsForUser(db(), outsider.userId)).toEqual([]);
  });

  it('carries the newest message as the preview and orders by activity', async () => {
    const alice = await createTestIdentity('Alice Preview');
    const bob = await createTestIdentity('Bob Preview');

    const older = await seedDirectConversation(alice.userId, bob.userId);
    const carol = await createTestIdentity('Carol Preview');
    const newer = await seedDirectConversation(alice.userId, carol.userId);

    await sendMessage(db(), {
      senderId: bob.userId,
      conversationId: older,
      body: 'first',
      clientMessageId: uuid(),
    });
    await sendMessage(db(), {
      senderId: carol.userId,
      conversationId: newer,
      body: 'second',
      clientMessageId: uuid(),
    });

    const listed = await listConversationsForUser(db(), alice.userId);
    const ordered = listed.filter((item) => item.id === older || item.id === newer);

    expect(ordered[0]?.id).toBe(newer);
    expect(ordered[0]?.lastMessage?.body).toBe('second');
    expect(ordered[1]?.lastMessage?.body).toBe('first');
    expect(ordered[0]?.lastMessageAt).not.toBeNull();
  });

  it('counts messages from the other person as unread, and never your own', async () => {
    const alice = await createTestIdentity('Alice Unread');
    const bob = await createTestIdentity('Bob Unread');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    await sendMessage(db(), {
      senderId: bob.userId,
      conversationId,
      body: 'one',
      clientMessageId: uuid(),
    });
    await sendMessage(db(), {
      senderId: bob.userId,
      conversationId,
      body: 'two',
      clientMessageId: uuid(),
    });
    await sendMessage(db(), {
      senderId: alice.userId,
      conversationId,
      body: 'my own reply',
      clientMessageId: uuid(),
    });

    const forAlice = await listConversationsForUser(db(), alice.userId);
    expect(forAlice.find((item) => item.id === conversationId)?.unreadCount).toBe(2);

    const forBob = await listConversationsForUser(db(), bob.userId);
    expect(forBob.find((item) => item.id === conversationId)?.unreadCount).toBe(1);
  });

  it('clears the unread count when the conversation is marked read', async () => {
    const alice = await createTestIdentity('Alice Read');
    const bob = await createTestIdentity('Bob Read');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const first = await sendMessage(db(), {
      senderId: bob.userId,
      conversationId,
      body: 'unread one',
      clientMessageId: uuid(),
    });
    const second = await sendMessage(db(), {
      senderId: bob.userId,
      conversationId,
      body: 'unread two',
      clientMessageId: uuid(),
    });

    const partial = await markConversationRead(
      db(),
      alice.userId,
      conversationId,
      first.message.id,
    );
    expect(partial.unreadCount).toBe(1);

    const full = await markConversationRead(db(), alice.userId, conversationId, second.message.id);
    expect(full.unreadCount).toBe(0);

    const listed = await listConversationsForUser(db(), alice.userId);
    expect(listed.find((item) => item.id === conversationId)?.unreadCount).toBe(0);
  });

  it('never moves the read marker backwards', async () => {
    const alice = await createTestIdentity('Alice Rewind');
    const bob = await createTestIdentity('Bob Rewind');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const first = await sendMessage(db(), {
      senderId: bob.userId,
      conversationId,
      body: 'older',
      clientMessageId: uuid(),
    });
    const second = await sendMessage(db(), {
      senderId: bob.userId,
      conversationId,
      body: 'newer',
      clientMessageId: uuid(),
    });

    await markConversationRead(db(), alice.userId, conversationId, second.message.id);

    // A stale request from another tab, naming an older message. The badge must stay cleared.
    const stale = await markConversationRead(db(), alice.userId, conversationId, first.message.id);
    expect(stale.unreadCount).toBe(0);
    expect(stale.lastReadMessageId).toBe(second.message.id);
  });

  it('refuses to mark read for someone who is not a member', async () => {
    const alice = await createTestIdentity('Alice Guarded');
    const bob = await createTestIdentity('Bob Guarded');
    const outsider = await createTestIdentity('Outsider Guarded');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const message = await sendMessage(db(), {
      senderId: bob.userId,
      conversationId,
      body: 'private',
      clientMessageId: uuid(),
    });

    await expect(
      markConversationRead(db(), outsider.userId, conversationId, message.message.id),
    ).rejects.toMatchObject({ reason: 'NOT_A_MEMBER' });
  });

  it('refuses a read marker naming a message from another conversation', async () => {
    const alice = await createTestIdentity('Alice Crossed');
    const bob = await createTestIdentity('Bob Crossed');
    const carol = await createTestIdentity('Carol Crossed');

    const mine = await seedDirectConversation(alice.userId, bob.userId);
    const elsewhere = await seedDirectConversation(alice.userId, carol.userId);

    const foreign = await sendMessage(db(), {
      senderId: carol.userId,
      conversationId: elsewhere,
      body: 'somewhere else',
      clientMessageId: uuid(),
    });

    await expect(
      markConversationRead(db(), alice.userId, mine, foreign.message.id),
    ).rejects.toMatchObject({ reason: 'MESSAGE_NOT_FOUND' });
  });

  it('bounds the preview and unread count by joinedAt (D-03)', async () => {
    const owner = await createTestIdentity('Owner Window');
    const latecomer = await createTestIdentity('Latecomer Window');

    // A member who joined an hour ago must not see what was said before that.
    const joinedAt = new Date(Date.now() + 60_000);
    const conversationId = await seedGroupConversation(owner.userId, [
      { userId: latecomer.userId, joinedAt },
    ]);

    await sendMessage(db(), {
      senderId: owner.userId,
      conversationId,
      body: 'said before they joined',
      clientMessageId: uuid(),
    });

    const listed = await listConversationsForUser(db(), latecomer.userId);
    const conversation = listed.find((item) => item.id === conversationId);

    expect(conversation).toBeDefined();
    expect(conversation?.lastMessage).toBeNull();
    expect(conversation?.unreadCount).toBe(0);

    // The owner, whose window covers it, does see it.
    const ownerView = await listConversationsForUser(db(), owner.userId);
    expect(ownerView.find((item) => item.id === conversationId)?.lastMessage?.body).toBe(
      'said before they joined',
    );
  });

  it('hides a conversation from a member who has left', async () => {
    const alice = await createTestIdentity('Alice Left');
    const bob = await createTestIdentity('Bob Left');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    // The membership row is kept so history stays attributable; `leftAt` is what revokes access.
    await db().conversationMember.update({
      where: { conversationId_userId: { conversationId, userId: bob.userId } },
      data: { leftAt: new Date() },
    });

    const forBob = await listConversationsForUser(db(), bob.userId);
    expect(forBob.map((item) => item.id)).not.toContain(conversationId);

    const forAlice = await listConversationsForUser(db(), alice.userId);
    expect(forAlice.map((item) => item.id)).toContain(conversationId);
  });
});
