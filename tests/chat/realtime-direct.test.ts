/**
 * One-to-one chat over the real socket, against the real database (Phase 5).
 *
 * Real Socket.IO clients, real cookies, real Prisma. The questions being answered are the ones a
 * reviewer would ask about a chat system: does a message actually reach the other person without
 * a refresh, is it in PostgreSQL before it is acknowledged, can a client send as somebody else,
 * and does a retry write the message twice.
 */

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { resolveDirectConversation } from '@/lib/conversations/service';
import type { MessageWire, PresenceWire } from '@/lib/chat/wire';

import {
  type RunningServer,
  type TestClient,
  cleanUp,
  connectClient,
  createTestIdentity,
  databaseConfigured,
  db,
  disconnect,
  emitWithAck,
  expectNoEvent,
  seedDirectConversation,
  startTestServer,
  trackConversation,
  uuid,
  waitFor,
  waitForEvent,
  waitForReady,
} from './harness';

const suite = databaseConfigured ? describe : describe.skip;

suite('one-to-one chat over the socket', () => {
  let server: RunningServer | undefined;
  const sockets: TestClient[] = [];

  /** Opens a client and registers it so a failing test cannot leave a socket behind. */
  async function open(cookie: string): Promise<TestClient> {
    if (!server) server = await startTestServer();
    const socket = await connectClient(server.url, cookie);
    sockets.push(socket);
    return socket;
  }

  afterEach(() => {
    while (sockets.length > 0) sockets.pop()?.close();
  });

  afterAll(async () => {
    await server?.close();
    await cleanUp();
    await disconnect();
  });

  it('delivers a message to the other member without a refresh', async () => {
    const alice = await createTestIdentity('Alice Live');
    const bob = await createTestIdentity('Bob Live');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const aliceSocket = await open(alice.cookie);
    const bobSocket = await open(bob.cookie);

    // Both sockets joined every conversation room at connection time, from the database.
    await waitForReady(aliceSocket);
    await waitForReady(bobSocket);

    const delivered = waitForEvent(bobSocket, 'message:new');

    const ack = await emitWithAck<MessageWire>(aliceSocket, 'message:send', {
      conversationId,
      body: 'good morning',
      clientMessageId: uuid(),
    });

    expect(ack.ok).toBe(true);

    const received = await delivered;
    expect(received.body).toBe('good morning');
    expect(received.senderId).toBe(alice.userId);
  });

  it('has committed the row before it acknowledges', async () => {
    const alice = await createTestIdentity('Alice Commit');
    const bob = await createTestIdentity('Bob Commit');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const aliceSocket = await open(alice.cookie);
    await waitForReady(aliceSocket);

    const ack = await emitWithAck<MessageWire>(aliceSocket, 'message:send', {
      conversationId,
      body: 'persisted before acknowledged',
      clientMessageId: uuid(),
    });

    if (!ack.ok) throw new Error('send was refused');

    // The acknowledgement carries a server-assigned id, so the row must already exist.
    const stored = await db().message.findUnique({
      where: { id: ack.data.id },
      select: { body: true, senderId: true, conversationId: true },
    });

    expect(stored).toEqual({
      body: 'persisted before acknowledged',
      senderId: alice.userId,
      conversationId,
    });
  });

  it('derives the sender from the session, never from the payload', async () => {
    const alice = await createTestIdentity('Alice Honest');
    const bob = await createTestIdentity('Bob Honest');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const aliceSocket = await open(alice.cookie);
    await waitForReady(aliceSocket);

    const ack = await emitWithAck<MessageWire>(aliceSocket, 'message:send', {
      conversationId,
      body: 'not from bob',
      clientMessageId: uuid(),
      // A client claiming to be somebody else. The schema has no such field, so it is dropped
      // before a handler ever sees it.
      senderId: bob.userId,
      userId: bob.userId,
    });

    if (!ack.ok) throw new Error('send was refused');

    expect(ack.data.senderId).toBe(alice.userId);

    const stored = await db().message.findUnique({
      where: { id: ack.data.id },
      select: { senderId: true },
    });
    expect(stored?.senderId).toBe(alice.userId);
  });

  it('stores one message when a send is retried with the same idempotency key', async () => {
    const alice = await createTestIdentity('Alice Retry');
    const bob = await createTestIdentity('Bob Retry');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const aliceSocket = await open(alice.cookie);
    const bobSocket = await open(bob.cookie);
    await waitForReady(aliceSocket);
    await waitForReady(bobSocket);

    const clientMessageId = uuid();
    const payload = { conversationId, body: 'sent once', clientMessageId };

    const first = await emitWithAck<MessageWire>(aliceSocket, 'message:send', payload);
    await waitForEvent(bobSocket, 'message:new');

    // The retry a browser makes when an acknowledgement is lost.
    const second = await emitWithAck<MessageWire>(aliceSocket, 'message:send', payload);

    if (!first.ok || !second.ok) throw new Error('send was refused');
    expect(second.data.id).toBe(first.data.id);

    const stored = await db().message.count({
      where: { conversationId, senderId: alice.userId, clientMessageId },
    });
    expect(stored).toBe(1);

    // And the duplicate is not broadcast a second time.
    await expectNoEvent(bobSocket, 'message:new');
  });

  it('refuses to send into a conversation the caller is not a member of', async () => {
    const alice = await createTestIdentity('Alice Outsider Send');
    const bob = await createTestIdentity('Bob Outsider Send');
    const outsider = await createTestIdentity('Outsider Send');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const outsiderSocket = await open(outsider.cookie);
    await waitForReady(outsiderSocket);

    const ack = await emitWithAck<MessageWire>(outsiderSocket, 'message:send', {
      conversationId,
      body: 'let me in',
      clientMessageId: uuid(),
    });

    expect(ack.ok).toBe(false);
    if (ack.ok) return;
    expect(ack.error.code).toBe('FORBIDDEN');

    const stored = await db().message.count({ where: { conversationId } });
    expect(stored).toBe(0);
  });

  it('refuses to join a room the caller has no membership of', async () => {
    const alice = await createTestIdentity('Alice Room');
    const bob = await createTestIdentity('Bob Room');
    const outsider = await createTestIdentity('Outsider Room');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const outsiderSocket = await open(outsider.cookie);
    await waitForReady(outsiderSocket);

    const ack = await emitWithAck(outsiderSocket, 'conversation:join', { conversationId });

    expect(ack.ok).toBe(false);
    if (ack.ok) return;
    expect(ack.error.code).toBe('FORBIDDEN');
  });

  it('delivers into a conversation created after both sockets connected', async () => {
    const alice = await createTestIdentity('Alice Fresh');
    const bob = await createTestIdentity('Bob Fresh');

    // Connect first, with no conversation between them: neither socket can be in a room that
    // does not exist yet.
    const aliceSocket = await open(alice.cookie);
    const bobSocket = await open(bob.cookie);
    await waitForReady(aliceSocket);
    await waitForReady(bobSocket);

    const resolved = await resolveDirectConversation(db(), alice.userId, bob.userId);
    trackConversation(resolved.conversationId);

    // Alice's own client asks to join, as the interface does after creating a conversation.
    const joined = await emitWithAck(aliceSocket, 'conversation:join', {
      conversationId: resolved.conversationId,
    });
    expect(joined.ok).toBe(true);

    // Bob never asked for anything. The server repairs the room membership on the send path,
    // from the database, so the broadcast still reaches him.
    const delivered = waitForEvent(bobSocket, 'message:new');

    const ack = await emitWithAck<MessageWire>(aliceSocket, 'message:send', {
      conversationId: resolved.conversationId,
      body: 'first message in a brand new conversation',
      clientMessageId: uuid(),
    });
    expect(ack.ok).toBe(true);

    const received = await delivered;
    expect(received.body).toBe('first message in a brand new conversation');
  });

  it('mirrors a sent message to the sender other tabs', async () => {
    const alice = await createTestIdentity('Alice Tabs');
    const bob = await createTestIdentity('Bob Tabs');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const tabOne = await open(alice.cookie);
    const tabTwo = await open(alice.cookie);
    await waitForReady(tabOne);
    await waitForReady(tabTwo);

    const mirrored = waitForEvent(tabTwo, 'message:new');

    await emitWithAck<MessageWire>(tabOne, 'message:send', {
      conversationId,
      body: 'typed in the other window',
      clientMessageId: uuid(),
    });

    const received = await mirrored;
    expect(received.body).toBe('typed in the other window');
  });

  it('reports presence only for people who share a conversation', async () => {
    const alice = await createTestIdentity('Alice Presence');
    const bob = await createTestIdentity('Bob Presence');
    const stranger = await createTestIdentity('Stranger Presence');
    await seedDirectConversation(alice.userId, bob.userId);

    const bobSocket = await open(bob.cookie);
    const strangerSocket = await open(stranger.cookie);
    await waitForReady(bobSocket);
    await waitForReady(strangerSocket);

    const aliceSocket = await open(alice.cookie);
    await waitForReady(aliceSocket);

    const snapshot = await emitWithAck<PresenceWire[]>(aliceSocket, 'presence:sync', {});
    if (!snapshot.ok) throw new Error('presence:sync was refused');

    const peers = new Map(snapshot.data.map((entry) => [entry.userId, entry]));

    expect(peers.get(bob.userId)?.online).toBe(true);
    // The stranger is online too, but Alice shares no conversation with them and is told nothing.
    expect(peers.has(stranger.userId)).toBe(false);
  });

  it('marks a user offline once their last socket closes', async () => {
    const alice = await createTestIdentity('Alice Offline');
    const bob = await createTestIdentity('Bob Offline');
    await seedDirectConversation(alice.userId, bob.userId);

    const aliceSocket = await open(alice.cookie);
    const bobTabOne = await open(bob.cookie);
    const bobTabTwo = await open(bob.cookie);
    await waitForReady(aliceSocket);
    await waitForReady(bobTabOne);
    await waitForReady(bobTabTwo);

    const running = server;
    if (!running) throw new Error('server not started');

    bobTabOne.close();

    // One tab closing is not going offline: the other window is still open.
    await waitFor(() => running.gateway.presence.connectionCount(bob.userId) === 1);
    expect(running.gateway.presence.isOnline(bob.userId)).toBe(true);

    bobTabTwo.close();
    await waitFor(() => !running.gateway.presence.isOnline(bob.userId), { timeoutMs: 5_000 });
  });

  it('refuses a socket with no identity at all', async () => {
    if (!server) server = await startTestServer();

    await expect(connectClient(server.url, '')).rejects.toThrow();
  });
});
