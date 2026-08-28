/**
 * Socket.IO gateway tests (Phase 4).
 *
 * Real sockets, a real gateway and the real `company_chat_db`. The point of these tests is the
 * authorization boundary: that identity comes from the server, that a client cannot claim to be
 * someone else, and that no room is joined and no message stored without a membership check.
 *
 * The suite skips when DATABASE_URL is not configured.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { MAX_MESSAGE_LENGTH } from '@/lib/messages/service';
import type { MessageWire, PresenceWire, SessionWire } from '@/lib/realtime/events';
import { rooms } from '@/lib/realtime/gateway';
import {
  TEST_PRESENCE_GRACE_MS,
  cleanUp,
  connectClient,
  cookieHeader,
  createDirectConversation,
  createGroupConversation,
  createTestIdentity,
  databaseConfigured,
  disconnectDb,
  emitWithAck,
  expectNoEvent,
  startTestServer,
  testDb,
  uuid,
  waitFor,
  waitForDisconnect,
  waitForEvent,
  type RunningServer,
  type TestClient,
} from './harness';

describe.skipIf(!databaseConfigured)('realtime gateway', () => {
  let server: RunningServer;
  const openSockets: TestClient[] = [];

  /** Connects and registers the socket for teardown, so no test leaks a live connection. */
  async function connect(cookie: string): Promise<TestClient> {
    const socket = await connectClient(server.url, cookie);
    openSockets.push(socket);
    return socket;
  }

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterEach(() => {
    while (openSockets.length > 0) openSockets.pop()?.close();
  });

  afterAll(async () => {
    await server.close();
    await cleanUp();
    await disconnectDb();
  });

  describe('handshake and socket identity', () => {
    it('accepts a connection carrying a valid session cookie', async () => {
      const person = await createTestIdentity('Handshake');
      const socket = await connect(person.cookie);

      expect(socket.connected).toBe(true);

      // The identity the server derived, sent back so the client knows who it is.
      const session = (await waitForEvent(socket, 'session:ready')) as SessionWire;
      expect(session.userId).toBe(person.userId);
      expect(session.displayName).toBe(person.displayName);
    });

    it('rejects a connection with no cookie at all', async () => {
      await expect(connect('')).rejects.toThrow(/UNAUTHENTICATED/);
    });

    it('rejects a connection with a forged session token', async () => {
      // A well-formed token that simply does not exist. Guessing one is the attack this rejects.
      await expect(connect(cookieHeader('a'.repeat(43)))).rejects.toThrow(/UNAUTHENTICATED/);
    });

    it('rejects a connection whose session has expired', async () => {
      const person = await createTestIdentity('Expired');
      await testDb().session.updateMany({
        where: { userId: person.userId },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
      // Without the device cookie there is nothing left to reattach with.
      await expect(connect(cookieHeader(person.sessionToken))).rejects.toThrow(/UNAUTHENTICATED/);
    });

    it('reattaches an expired session to the same user via the device cookie (D-13)', async () => {
      const person = await createTestIdentity('Reattach');
      await testDb().session.updateMany({
        where: { userId: person.userId },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      const socket = await connect(person.cookie);
      const session = (await waitForEvent(socket, 'session:ready')) as SessionWire;

      // The same User.id: history and memberships remain reachable (D-14).
      expect(session.userId).toBe(person.userId);
    });

    it('rejects a revoked device, so "Switch User" cannot be undone with a copied cookie', async () => {
      const person = await createTestIdentity('Revoked');
      await testDb().session.deleteMany({ where: { userId: person.userId } });
      await testDb().device.updateMany({
        where: { userId: person.userId },
        data: { revokedAt: new Date() },
      });

      await expect(connect(person.cookie)).rejects.toThrow(/UNAUTHENTICATED/);
    });

    it('ignores any user id the client supplies in the handshake', async () => {
      const person = await createTestIdentity('Honest');
      const victim = await createTestIdentity('Victim');

      // A client that tries to announce itself as someone else. The handshake reads the cookie
      // and nothing else, so the claim is simply not consulted.
      const socket = await connect(`${person.cookie}; userId=${victim.userId}`);
      const session = (await waitForEvent(socket, 'session:ready')) as SessionWire;

      expect(session.userId).toBe(person.userId);
      expect(session.userId).not.toBe(victim.userId);
    });
  });

  describe('conversation rooms', () => {
    it('joins a member to their conversations automatically on connect', async () => {
      const alice = await createTestIdentity('Alice Rooms');
      const bob = await createTestIdentity('Bob Rooms');
      const conversationId = await createDirectConversation(alice.userId, bob.userId);

      const socket = await connect(alice.cookie);
      const session = (await waitForEvent(socket, 'session:ready')) as SessionWire;

      expect(session.conversationIds).toContain(conversationId);
    });

    it('lets an active member join a conversation room on request', async () => {
      const alice = await createTestIdentity('Alice Join');
      const bob = await createTestIdentity('Bob Join');
      const conversationId = await createDirectConversation(alice.userId, bob.userId);

      const socket = await connect(alice.cookie);
      const ack = await emitWithAck<{ conversationId: string; joinedAt: string }>(
        socket,
        'conversation:join',
        { conversationId },
      );

      expect(ack.ok).toBe(true);
      if (ack.ok) {
        expect(ack.data.conversationId).toBe(conversationId);
        // D-03: the client is told where its visible window starts.
        expect(new Date(ack.data.joinedAt).getTime()).toBeGreaterThan(0);
      }
    });

    it('refuses a room to a user who is not a member', async () => {
      const alice = await createTestIdentity('Alice Private');
      const bob = await createTestIdentity('Bob Private');
      const outsider = await createTestIdentity('Outsider');
      const conversationId = await createDirectConversation(alice.userId, bob.userId);

      const socket = await connect(outsider.cookie);
      const ack = await emitWithAck(socket, 'conversation:join', { conversationId });

      expect(ack.ok).toBe(false);
      if (!ack.ok) expect(ack.error.code).toBe('FORBIDDEN');

      // And the room was genuinely not joined — not merely reported as refused.
      const socketsInRoom = await server.gateway.io
        .in(rooms.conversation(conversationId))
        .fetchSockets();
      expect(socketsInRoom.map((s) => s.data.userId)).not.toContain(outsider.userId);
    });

    it('refuses a room to a member who has left', async () => {
      const owner = await createTestIdentity('Group Owner');
      const leaver = await createTestIdentity('Leaver');
      const conversationId = await createGroupConversation(owner.userId, [leaver.userId]);

      // The row is kept, with leftAt set — authorization must test leftAt, not row existence.
      await testDb().conversationMember.updateMany({
        where: { conversationId, userId: leaver.userId },
        data: { leftAt: new Date() },
      });

      const socket = await connect(leaver.cookie);
      const ack = await emitWithAck(socket, 'conversation:join', { conversationId });

      expect(ack.ok).toBe(false);
      if (!ack.ok) expect(ack.error.code).toBe('FORBIDDEN');
    });

    it('gives the same refusal for a conversation that does not exist', async () => {
      // Distinguishing the two would tell an outsider which conversation ids are real.
      const person = await createTestIdentity('Prober');
      const socket = await connect(person.cookie);

      const ack = await emitWithAck(socket, 'conversation:join', { conversationId: uuid() });

      expect(ack.ok).toBe(false);
      if (!ack.ok) expect(ack.error.code).toBe('FORBIDDEN');
    });

    it('rejects a malformed join payload', async () => {
      const person = await createTestIdentity('Malformed');
      const socket = await connect(person.cookie);

      const ack = await emitWithAck(socket, 'conversation:join', { conversationId: 'not-a-uuid' });

      expect(ack.ok).toBe(false);
      if (!ack.ok) expect(ack.error.code).toBe('INVALID_PAYLOAD');
    });

    it('does not restore rooms from a previous connection on reconnect', async () => {
      const alice = await createTestIdentity('Alice Reconnect');
      const bob = await createTestIdentity('Bob Reconnect');
      const conversationId = await createDirectConversation(alice.userId, bob.userId);

      const first = await connect(alice.cookie);
      await waitForEvent(first, 'session:ready');

      // Membership is removed while the socket is away.
      await testDb().conversationMember.updateMany({
        where: { conversationId, userId: alice.userId },
        data: { leftAt: new Date() },
      });

      first.close();
      await waitForDisconnect(first);

      // The new connection re-derives rooms from the database rather than restoring them.
      const second = await connect(alice.cookie);
      const session = (await waitForEvent(second, 'session:ready')) as SessionWire;

      expect(session.conversationIds).not.toContain(conversationId);
    });
  });

  describe('sending messages', () => {
    it('persists a message and acknowledges only after it is stored', async () => {
      const alice = await createTestIdentity('Alice Send');
      const bob = await createTestIdentity('Bob Send');
      const conversationId = await createDirectConversation(alice.userId, bob.userId);

      const socket = await connect(alice.cookie);
      const clientMessageId = uuid();

      const ack = await emitWithAck<MessageWire>(socket, 'message:send', {
        conversationId,
        body: 'Persisted before the acknowledgement.',
        clientMessageId,
      });

      expect(ack.ok).toBe(true);
      if (!ack.ok) return;

      // The row exists at the moment the acknowledgement arrives, not afterwards.
      const stored = await testDb().message.findUnique({ where: { id: ack.data.id } });
      expect(stored).not.toBeNull();
      expect(stored?.body).toBe('Persisted before the acknowledgement.');
      expect(stored?.conversationId).toBe(conversationId);

      // And the conversation's ordering column moved with it, in the same transaction.
      const conversation = await testDb().conversation.findUniqueOrThrow({
        where: { id: conversationId },
      });
      expect(conversation.lastMessageAt?.getTime()).toBe(stored?.createdAt.getTime());
    });

    it('takes senderId from the socket identity and ignores any senderId in the payload', async () => {
      const alice = await createTestIdentity('Alice Sender');
      const bob = await createTestIdentity('Bob Sender');
      const conversationId = await createDirectConversation(alice.userId, bob.userId);

      const socket = await connect(alice.cookie);

      const ack = await emitWithAck<MessageWire>(socket, 'message:send', {
        conversationId,
        body: 'Attempting to send as somebody else.',
        clientMessageId: uuid(),
        // The impersonation attempt. The schema has no such field, so it never reaches the
        // service; the sender is taken from the resolved session.
        senderId: bob.userId,
        userId: bob.userId,
      });

      expect(ack.ok).toBe(true);
      if (!ack.ok) return;

      expect(ack.data.senderId).toBe(alice.userId);
      const stored = await testDb().message.findUniqueOrThrow({ where: { id: ack.data.id } });
      expect(stored.senderId).toBe(alice.userId);
      expect(stored.senderId).not.toBe(bob.userId);
    });

    it('refuses to store a message for a conversation the sender is not in', async () => {
      const alice = await createTestIdentity('Alice Closed');
      const bob = await createTestIdentity('Bob Closed');
      const outsider = await createTestIdentity('Outsider Send');
      const conversationId = await createDirectConversation(alice.userId, bob.userId);

      const socket = await connect(outsider.cookie);

      const ack = await emitWithAck(socket, 'message:send', {
        conversationId,
        body: 'This must not be stored.',
        clientMessageId: uuid(),
      });

      expect(ack.ok).toBe(false);
      if (!ack.ok) expect(ack.error.code).toBe('FORBIDDEN');

      // Nothing was written. Authorization runs before the insert, not after.
      const count = await testDb().message.count({
        where: { conversationId, senderId: outsider.userId },
      });
      expect(count).toBe(0);
    });

    it('enforces the message length limit server-side', async () => {
      const alice = await createTestIdentity('Alice Long');
      const bob = await createTestIdentity('Bob Long');
      const conversationId = await createDirectConversation(alice.userId, bob.userId);

      const socket = await connect(alice.cookie);

      const ack = await emitWithAck(socket, 'message:send', {
        conversationId,
        body: 'x'.repeat(MAX_MESSAGE_LENGTH + 1),
        clientMessageId: uuid(),
      });

      expect(ack.ok).toBe(false);
      if (!ack.ok) expect(ack.error.code).toBe('MESSAGE_TOO_LONG');

      expect(await testDb().message.count({ where: { conversationId } })).toBe(0);
    });

    it('rejects an empty message', async () => {
      const alice = await createTestIdentity('Alice Empty');
      const bob = await createTestIdentity('Bob Empty');
      const conversationId = await createDirectConversation(alice.userId, bob.userId);

      const socket = await connect(alice.cookie);
      const ack = await emitWithAck(socket, 'message:send', {
        conversationId,
        body: '',
        clientMessageId: uuid(),
      });

      expect(ack.ok).toBe(false);
      if (!ack.ok) expect(ack.error.code).toBe('INVALID_PAYLOAD');
    });

    it('delivers a message to the other member in real time', async () => {
      const alice = await createTestIdentity('Alice Live');
      const bob = await createTestIdentity('Bob Live');
      const conversationId = await createDirectConversation(alice.userId, bob.userId);

      const aliceSocket = await connect(alice.cookie);
      const bobSocket = await connect(bob.cookie);
      await waitForEvent(bobSocket, 'session:ready');

      const delivered = waitForEvent(bobSocket, 'message:new');
      const ack = await emitWithAck<MessageWire>(aliceSocket, 'message:send', {
        conversationId,
        body: 'Live delivery.',
        clientMessageId: uuid(),
      });

      const received = (await delivered) as MessageWire;
      expect(ack.ok).toBe(true);
      if (ack.ok) expect(received.id).toBe(ack.data.id);
      expect(received.body).toBe('Live delivery.');
      expect(received.senderId).toBe(alice.userId);
    });

    it('does not deliver a message to someone outside the conversation', async () => {
      const alice = await createTestIdentity('Alice Quiet');
      const bob = await createTestIdentity('Bob Quiet');
      const outsider = await createTestIdentity('Outsider Quiet');
      const conversationId = await createDirectConversation(alice.userId, bob.userId);

      const aliceSocket = await connect(alice.cookie);
      const outsiderSocket = await connect(outsider.cookie);
      await waitForEvent(outsiderSocket, 'session:ready');

      const silence = expectNoEvent(outsiderSocket, 'message:new', {});
      await emitWithAck(aliceSocket, 'message:send', {
        conversationId,
        body: 'Not for the outsider.',
        clientMessageId: uuid(),
      });

      await expect(silence).resolves.toBeUndefined();
    });
  });

  describe('duplicate-send protection', () => {
    it('returns the existing message when the same clientMessageId is sent again', async () => {
      const alice = await createTestIdentity('Alice Retry');
      const bob = await createTestIdentity('Bob Retry');
      const conversationId = await createDirectConversation(alice.userId, bob.userId);

      const socket = await connect(alice.cookie);
      const clientMessageId = uuid();
      const payload = { conversationId, body: 'Sent once.', clientMessageId };

      const first = await emitWithAck<MessageWire>(socket, 'message:send', payload);
      // The retry a client makes after an acknowledgement is lost.
      const second = await emitWithAck<MessageWire>(socket, 'message:send', payload);

      expect(first.ok && second.ok).toBe(true);
      if (first.ok && second.ok) {
        // The same stored row, not a second one.
        expect(second.data.id).toBe(first.data.id);
        expect(second.data.createdAt).toBe(first.data.createdAt);
      }

      expect(await testDb().message.count({ where: { conversationId } })).toBe(1);
    });

    it('does not broadcast a duplicate to the room a second time', async () => {
      const alice = await createTestIdentity('Alice Once');
      const bob = await createTestIdentity('Bob Once');
      const conversationId = await createDirectConversation(alice.userId, bob.userId);

      const aliceSocket = await connect(alice.cookie);
      const bobSocket = await connect(bob.cookie);
      await waitForEvent(bobSocket, 'session:ready');

      const payload = { conversationId, body: 'Only once.', clientMessageId: uuid() };

      const delivered = waitForEvent(bobSocket, 'message:new');
      await emitWithAck(aliceSocket, 'message:send', payload);
      await delivered;

      // The retry must be silent: the recipient already has this message.
      const silence = expectNoEvent(bobSocket, 'message:new', {});
      await emitWithAck(aliceSocket, 'message:send', payload);
      await expect(silence).resolves.toBeUndefined();
    });

    it('allows two different senders to use the same clientMessageId', async () => {
      const alice = await createTestIdentity('Alice Key');
      const bob = await createTestIdentity('Bob Key');
      const conversationId = await createDirectConversation(alice.userId, bob.userId);
      const sharedKey = uuid();

      const aliceSocket = await connect(alice.cookie);
      const bobSocket = await connect(bob.cookie);

      const first = await emitWithAck<MessageWire>(aliceSocket, 'message:send', {
        conversationId,
        body: 'From Alice.',
        clientMessageId: sharedKey,
      });
      const second = await emitWithAck<MessageWire>(bobSocket, 'message:send', {
        conversationId,
        body: 'From Bob.',
        clientMessageId: sharedKey,
      });

      // The constraint is (senderId, clientMessageId): these are two different messages.
      expect(first.ok && second.ok).toBe(true);
      if (first.ok && second.ok) expect(second.data.id).not.toBe(first.data.id);
      expect(await testDb().message.count({ where: { conversationId } })).toBe(2);
    });
  });

  describe('presence', () => {
    it('reports a user online to someone who shares a conversation', async () => {
      const alice = await createTestIdentity('Alice Presence');
      const bob = await createTestIdentity('Bob Presence');
      await createDirectConversation(alice.userId, bob.userId);

      const aliceSocket = await connect(alice.cookie);
      await waitForEvent(aliceSocket, 'session:ready');

      const update = waitForEvent(aliceSocket, 'presence:update', {
        filter: (payload) => (payload as PresenceWire).userId === bob.userId,
      });

      await connect(bob.cookie);

      const presence = (await update) as PresenceWire;
      expect(presence.userId).toBe(bob.userId);
      expect(presence.online).toBe(true);
    });

    it('does not report presence to someone with no conversation in common', async () => {
      const stranger = await createTestIdentity('Stranger');
      const other = await createTestIdentity('Unrelated');

      const strangerSocket = await connect(stranger.cookie);
      await waitForEvent(strangerSocket, 'session:ready');

      // Updates about themselves are expected and ignored: every tab a user has open is told
      // about their own presence so the windows agree. What must never arrive is news about
      // someone they share no conversation with.
      const silence = expectNoEvent(strangerSocket, 'presence:update', {
        filter: (payload) => (payload as PresenceWire).userId === other.userId,
      });
      await connect(other.cookie);

      await expect(silence).resolves.toBeUndefined();
    });

    it('keeps a user online while any of their connections remains', async () => {
      const person = await createTestIdentity('Multi Tab');

      const firstTab = await connect(person.cookie);
      const secondTab = await connect(person.cookie);
      await waitForEvent(secondTab, 'session:ready');

      expect(server.gateway.presence.connectionCount(person.userId)).toBe(2);

      firstTab.close();
      await waitForDisconnect(firstTab);
      await waitFor(() => server.gateway.presence.connectionCount(person.userId) === 1);

      // Well past the grace period, and still online: the other tab is holding them there.
      await new Promise((resolve) => setTimeout(resolve, TEST_PRESENCE_GRACE_MS * 3));
      expect(server.gateway.presence.isOnline(person.userId)).toBe(true);
      expect(server.gateway.presence.connectionCount(person.userId)).toBe(1);

      void secondTab;
    });

    it('marks a user offline only after their last connection closes', async () => {
      const person = await createTestIdentity('Last Tab');

      const firstTab = await connect(person.cookie);
      const secondTab = await connect(person.cookie);
      await waitForEvent(secondTab, 'session:ready');

      firstTab.close();
      await waitForDisconnect(firstTab);
      // One tab closed: the server still holds a socket, so the user stays online.
      await waitFor(() => server.gateway.presence.connectionCount(person.userId) === 1);
      expect(server.gateway.presence.isOnline(person.userId)).toBe(true);

      secondTab.close();
      await waitForDisconnect(secondTab);

      // Only now, with the last connection gone, does the user become offline.
      await waitFor(() => !server.gateway.presence.isOnline(person.userId));
      expect(server.gateway.presence.connectionCount(person.userId)).toBe(0);
    });

    it('records lastSeenAt so presence survives a restart as "last seen"', async () => {
      const person = await createTestIdentity('Last Seen');
      const before = await testDb().user.findUniqueOrThrow({ where: { id: person.userId } });

      await new Promise((resolve) => setTimeout(resolve, 20));
      const socket = await connect(person.cookie);
      await waitForEvent(socket, 'session:ready');

      const after = await testDb().user.findUniqueOrThrow({ where: { id: person.userId } });
      expect(after.lastSeenAt.getTime()).toBeGreaterThanOrEqual(before.lastSeenAt.getTime());
    });
  });

  describe('reconnection', () => {
    it('re-resolves identity and re-authorizes rooms on a new connection', async () => {
      const alice = await createTestIdentity('Alice Rejoin');
      const bob = await createTestIdentity('Bob Rejoin');
      const conversationId = await createDirectConversation(alice.userId, bob.userId);

      const first = await connect(alice.cookie);
      await waitForEvent(first, 'session:ready');
      first.close();
      await waitForDisconnect(first);

      const second = await connect(alice.cookie);
      const session = (await waitForEvent(second, 'session:ready')) as SessionWire;

      expect(session.userId).toBe(alice.userId);
      expect(session.conversationIds).toContain(conversationId);

      // And the reconnected socket really is in the room: a message reaches it.
      const bobSocket = await connect(bob.cookie);
      const delivered = waitForEvent(second, 'message:new');
      await emitWithAck(bobSocket, 'message:send', {
        conversationId,
        body: 'After reconnect.',
        clientMessageId: uuid(),
      });

      expect(((await delivered) as MessageWire).body).toBe('After reconnect.');
    });

    it('refuses to reconnect once the identity has been revoked', async () => {
      const person = await createTestIdentity('Revoked Reconnect');
      const socket = await connect(person.cookie);
      await waitForEvent(socket, 'session:ready');
      socket.close();
      await waitForDisconnect(socket);

      // "Switch User" revoked both server-side.
      await testDb().session.deleteMany({ where: { userId: person.userId } });
      await testDb().device.updateMany({
        where: { userId: person.userId },
        data: { revokedAt: new Date() },
      });

      await expect(connect(person.cookie)).rejects.toThrow(/UNAUTHENTICATED/);
    });
  });

  describe('error handling', () => {
    it('answers an unknown event without crashing the connection', async () => {
      const person = await createTestIdentity('Unknown Event');
      const socket = await connect(person.cookie);
      await waitForEvent(socket, 'session:ready');

      // Socket.IO drops events with no handler; the important property is that the socket
      // survives and the server does not throw.
      (socket.emit as (event: string, payload: unknown) => void)('definitely:not:an:event', {
        anything: true,
      });

      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(socket.connected).toBe(true);
    });

    it('never sends internal detail to the client when the database fails', async () => {
      const alice = await createTestIdentity('Alice DbFail');
      const bob = await createTestIdentity('Bob DbFail');
      const conversationId = await createDirectConversation(alice.userId, bob.userId);
      const socket = await connect(alice.cookie);

      // A body containing a null byte is valid JSON and passes length validation, but PostgreSQL
      // rejects it in a text column — a genuine database-level failure, triggered without
      // touching the schema or the connection.
      const ack = await emitWithAck(socket, 'message:send', {
        conversationId,
        body: 'null byte: \u0000 here',
        clientMessageId: uuid(),
      });

      expect(ack.ok).toBe(false);
      if (!ack.ok) {
        expect(ack.error.code).toBe('INTERNAL_ERROR');
        // No stack trace, no SQL, no connection string, no file path.
        expect(ack.error.message).not.toMatch(/postgres|prisma|select|insert|at .*\.ts:|C:\\/i);
      }

      expect(socket.connected).toBe(true);
    });
  });
});
