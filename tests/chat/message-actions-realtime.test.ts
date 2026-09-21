/**
 * Message actions over the real socket, and what they must NOT do to unread counts (Batch 1).
 *
 * Real Socket.IO clients, real cookies, real Prisma — the same harness the Phase 5 tests use.
 * Two questions are being answered here that the service tests cannot answer:
 *
 *   1. Does the other person's screen actually change, without a refresh?
 *   2. Does reacting or pinning leave the conversation alone — no unread badge, no reordering,
 *      no new message? That is the requirement most easily broken by a well-meaning change, and
 *      the one a user would notice fastest.
 */

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { listConversationsForUser } from '@/lib/conversations/service';
import {
  deleteMessageForEveryone,
  hideMessageForUser,
  setPinned,
  setReaction,
} from '@/lib/messages/actions';
import { sendMessage } from '@/lib/messages/service';
import { notifyMessageHidden, notifyMessageUpdated } from '@/lib/realtime/notify';
import type { MessageWire } from '@/lib/chat/wire';

import {
  type RunningServer,
  type TestClient,
  cleanUp,
  connectClient,
  createTestIdentity,
  databaseConfigured,
  db,
  disconnect,
  expectNoEvent,
  seedDirectConversation,
  seedGroupConversation,
  seedMessageAt,
  startTestServer,
  uuid,
  waitForEvent,
  waitForReady,
} from './harness';

const suite = databaseConfigured ? describe : describe.skip;

suite('message actions over the socket', () => {
  let server: RunningServer | undefined;
  const sockets: TestClient[] = [];

  async function open(cookie: string): Promise<TestClient> {
    if (!server) server = await startTestServer();
    const socket = await connectClient(server.url, cookie);
    sockets.push(socket);
    return socket;
  }

  async function send(conversationId: string, senderId: string, body: string) {
    return sendMessage(db(), { senderId, conversationId, body, clientMessageId: uuid() });
  }

  /** The caller's own view of one conversation, as the sidebar would compute it. */
  async function conversationFor(userId: string, conversationId: string) {
    const conversations = await listConversationsForUser(db(), userId);
    return conversations.find((conversation) => conversation.id === conversationId);
  }

  afterEach(() => {
    while (sockets.length > 0) sockets.pop()?.close();
  });

  afterAll(async () => {
    await server?.close();
    await cleanUp();
    await disconnect();
  });

  /* ------------------------------------------------------------------------------------------ */
  /* Delivery                                                                                     */
  /* ------------------------------------------------------------------------------------------ */

  it('delivers a reaction to the other member as message:updated', async () => {
    const alice = await createTestIdentity('Alice React');
    const bob = await createTestIdentity('Bob React');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const bobSocket = await open(bob.cookie);
    await waitForReady(bobSocket);

    const { message } = await send(conversationId, alice.userId, 'react to this');

    const updated = waitForEvent(bobSocket, 'message:updated');
    const result = await setReaction(db(), {
      userId: alice.userId,
      messageId: message.id,
      emoji: '👍',
    });
    notifyMessageUpdated({ conversationId, message: result.message });

    const wire = (await updated) as MessageWire;
    expect(wire.id).toBe(message.id);
    expect(wire.reactions).toEqual([
      { emoji: '👍', count: 1, userIds: [alice.userId] },
    ]);
  });

  it('delivers a pin, and then an unpin, to the other member', async () => {
    const alice = await createTestIdentity('Alice Pin');
    const bob = await createTestIdentity('Bob Pin');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const bobSocket = await open(bob.cookie);
    await waitForReady(bobSocket);

    const { message } = await send(conversationId, alice.userId, 'pin this');

    const pinned = waitForEvent(bobSocket, 'message:updated');
    const onPin = await setPinned(db(), {
      userId: alice.userId,
      messageId: message.id,
      pinned: true,
    });
    notifyMessageUpdated({ conversationId, message: onPin.message });
    expect(((await pinned) as MessageWire).pinnedAt).not.toBeNull();

    const unpinned = waitForEvent(bobSocket, 'message:updated');
    const onUnpin = await setPinned(db(), {
      userId: alice.userId,
      messageId: message.id,
      pinned: false,
    });
    notifyMessageUpdated({ conversationId, message: onUnpin.message });
    expect(((await unpinned) as MessageWire).pinnedAt).toBeNull();
  });

  it('delivers a delete-for-everyone as a tombstone, with the body gone', async () => {
    const alice = await createTestIdentity('Alice Del');
    const bob = await createTestIdentity('Bob Del');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const bobSocket = await open(bob.cookie);
    await waitForReady(bobSocket);

    const { message } = await send(conversationId, alice.userId, 'secret text');

    const updated = waitForEvent(bobSocket, 'message:updated');
    const result = await deleteMessageForEveryone(db(), {
      userId: alice.userId,
      messageId: message.id,
    });
    notifyMessageUpdated({ conversationId, message: result.message });

    const wire = (await updated) as MessageWire;
    expect(wire.deletedAt).not.toBeNull();
    // The text does not travel. Bob's browser never receives it, so it cannot render it by
    // mistake and cannot be made to show it by tampering with the client.
    expect(wire.body).toBeNull();
    expect(JSON.stringify(wire)).not.toContain('secret text');
  });

  it('tells ONLY the hider about a delete-for-me', async () => {
    const alice = await createTestIdentity('Alice Hide');
    const bob = await createTestIdentity('Bob Hide');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const aliceSocket = await open(alice.cookie);
    const bobSocket = await open(bob.cookie);
    await waitForReady(aliceSocket);
    await waitForReady(bobSocket);

    const { message } = await send(conversationId, alice.userId, 'bob hides this');

    const mine = waitForEvent(aliceSocket, 'message:hidden');
    // Bob must hear nothing at all: for him, nothing happened.
    const nothingForBob = expectNoEvent(bobSocket, 'message:hidden');

    await hideMessageForUser(db(), { userId: alice.userId, messageId: message.id });
    notifyMessageHidden({ userId: alice.userId, conversationId, messageId: message.id });

    expect(await mine).toMatchObject({ conversationId, messageId: message.id });
    await nothingForBob;
  });

  it('does not deliver an update for a message outside a member’s window (D-03)', async () => {
    const owner = await createTestIdentity('Owner Window');
    const latecomer = await createTestIdentity('Latecomer Window');

    const joinedAt = new Date();
    const conversationId = await seedGroupConversation(owner.userId, [
      { userId: latecomer.userId, joinedAt },
    ]);
    await db().conversationMember.updateMany({
      where: { conversationId, userId: owner.userId },
      data: { joinedAt: new Date(joinedAt.getTime() - 3_600_000) },
    });

    const old = await seedMessageAt(
      conversationId,
      owner.userId,
      'before the latecomer arrived',
      new Date(joinedAt.getTime() - 60_000),
    );

    const latecomerSocket = await open(latecomer.cookie);
    await waitForReady(latecomerSocket);

    /*
     * The owner reacts to a message the latecomer may not see. Broadcasting into the conversation
     * room would reach them and disclose that the message exists; the per-member emitter filters
     * them out instead.
     */
    const nothing = expectNoEvent(latecomerSocket, 'message:updated');
    const result = await setReaction(db(), {
      userId: owner.userId,
      messageId: old.id,
      emoji: '👍',
    });
    notifyMessageUpdated({ conversationId, message: result.message });

    await nothing;
  });

  /* ------------------------------------------------------------------------------------------ */
  /* Unread counts                                                                                */
  /* ------------------------------------------------------------------------------------------ */

  describe('unread counts', () => {
    it('a normal message still increments the recipient’s unread count', async () => {
      const alice = await createTestIdentity('Alice Unread');
      const bob = await createTestIdentity('Bob Unread');
      const conversationId = await seedDirectConversation(alice.userId, bob.userId);

      const before = await conversationFor(bob.userId, conversationId);
      await send(conversationId, alice.userId, 'a real message');
      const after = await conversationFor(bob.userId, conversationId);

      // The control. Without it, the assertions below would pass on a system where nothing
      // counts as unread at all.
      expect(after?.unreadCount).toBe((before?.unreadCount ?? 0) + 1);
    });

    it('a REACTION does not', async () => {
      const alice = await createTestIdentity('Alice NoUnread');
      const bob = await createTestIdentity('Bob NoUnread');
      const conversationId = await seedDirectConversation(alice.userId, bob.userId);

      const { message } = await send(conversationId, alice.userId, 'one message');
      const before = await conversationFor(bob.userId, conversationId);

      await setReaction(db(), { userId: alice.userId, messageId: message.id, emoji: '❤️' });

      const after = await conversationFor(bob.userId, conversationId);
      expect(after?.unreadCount).toBe(before?.unreadCount);
      expect(after?.lastMessageAt?.toISOString()).toBe(before?.lastMessageAt?.toISOString());
    });

    it('a PIN does not', async () => {
      const alice = await createTestIdentity('Alice PinUnread');
      const bob = await createTestIdentity('Bob PinUnread');
      const conversationId = await seedDirectConversation(alice.userId, bob.userId);

      const { message } = await send(conversationId, alice.userId, 'one message');
      const before = await conversationFor(bob.userId, conversationId);

      await setPinned(db(), { userId: alice.userId, messageId: message.id, pinned: true });

      const after = await conversationFor(bob.userId, conversationId);
      expect(after?.unreadCount).toBe(before?.unreadCount);
      expect(after?.lastMessageAt?.toISOString()).toBe(before?.lastMessageAt?.toISOString());
    });

    it('a DELETE FOR EVERYONE does not, and the preview stops showing the text', async () => {
      const alice = await createTestIdentity('Alice DelUnread');
      const bob = await createTestIdentity('Bob DelUnread');
      const conversationId = await seedDirectConversation(alice.userId, bob.userId);

      const { message } = await send(conversationId, alice.userId, 'text to remove');
      const before = await conversationFor(bob.userId, conversationId);
      expect(before?.lastMessage?.body).toBe('text to remove');

      await deleteMessageForEveryone(db(), { userId: alice.userId, messageId: message.id });

      const after = await conversationFor(bob.userId, conversationId);
      expect(after?.unreadCount).toBe(before?.unreadCount);
      /*
       * The sidebar preview is computed from the stored row, and the row's body is now null — so
       * the deleted text cannot linger in the conversation list after it has gone from the
       * conversation.
       */
      expect(after?.lastMessage?.body).toBeNull();
    });

    it('a FORWARD is a real message and does increment the destination’s count', async () => {
      const alice = await createTestIdentity('Alice Fwd');
      const bob = await createTestIdentity('Bob Fwd');
      const carol = await createTestIdentity('Carol Fwd');

      const source = await seedDirectConversation(alice.userId, bob.userId);
      const destination = await seedDirectConversation(alice.userId, carol.userId);
      const { message } = await send(source, bob.userId, 'worth passing on');

      const before = await conversationFor(carol.userId, destination);

      const { forwardMessage } = await import('@/lib/messages/actions');
      await forwardMessage(
        db(),
        { uploadDir: process.env['UPLOAD_DIR'] ?? '.', maxFileSize: 1024 * 1024 },
        {
          userId: alice.userId,
          messageId: message.id,
          destinations: [{ conversationId: destination, clientMessageId: uuid() }],
        },
      );

      const after = await conversationFor(carol.userId, destination);
      // A forward IS a new message, so it behaves like one — this is the intended difference
      // from a reaction or a pin.
      expect(after?.unreadCount).toBe((before?.unreadCount ?? 0) + 1);
      expect(after?.lastMessage?.body).toBe('worth passing on');
    });
  });
});
