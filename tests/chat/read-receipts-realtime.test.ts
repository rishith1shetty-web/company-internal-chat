/**
 * Read receipts over the real socket (Batch 1.3).
 *
 * Real Socket.IO clients, real cookies, real Prisma. Two questions are answered here that the
 * service tests cannot answer:
 *
 *   1. **What must NOT count as reading.** Being online, being connected, and having a message
 *      delivered are all things that happen without anybody looking at the conversation. If any
 *      of them moved the marker, "Seen" would be a lie — and the only way to show they do not is
 *      to connect a real socket, deliver a real message, and find the marker still untouched.
 *   2. **Does the sender's screen change without a refresh**, and does it change quietly — no new
 *      message, no unread, no reordering.
 */

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { listConversationsForUser, markConversationRead, readAnnouncementFor } from '@/lib/conversations/service';
import { sendMessage } from '@/lib/messages/service';
import { notifyConversationRead } from '@/lib/realtime/notify';
import type { ConversationReadWire } from '@/lib/chat/wire';

import {
  type RunningServer,
  type TestClient,
  cleanUp,
  connectClient,
  emitWithAck,
  createTestIdentity,
  databaseConfigured,
  db,
  disconnect,
  expectNoEvent,
  seedDirectConversation,
  seedGroupConversation,
  startTestServer,
  uuid,
  waitForEvent,
  waitForReady,
} from './harness';

const suite = databaseConfigured ? describe : describe.skip;

suite('read receipts over the socket', () => {
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

  async function watermarkOf(conversationId: string, userId: string): Promise<Date | null> {
    const member = await db().conversationMember.findUniqueOrThrow({
      where: { conversationId_userId: { conversationId, userId } },
      select: { lastReadAt: true },
    });
    return member.lastReadAt;
  }

  /** Does what the read route does: move the marker, then announce it if it moved. */
  async function readAndAnnounce(conversationId: string, userId: string, messageId: string) {
    const result = await markConversationRead(db(), userId, conversationId, messageId);
    if (!result.moved) return result;

    const audience = await readAnnouncementFor(db(), conversationId);
    notifyConversationRead({
      conversationId,
      userId,
      lastReadAt: audience.type === 'DIRECT' ? result.lastReadAt : null,
      audienceIds: audience.audienceIds,
    });
    return result;
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
  /* What is NOT reading                                                                          */
  /* ------------------------------------------------------------------------------------------ */

  it('BEING ONLINE does not mark anything read', async () => {
    const alice = await createTestIdentity('Alice Online');
    const bob = await createTestIdentity('Bob Online');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    // Bob is connected, authenticated, and visibly online to Alice.
    const bobSocket = await open(bob.cookie);
    await waitForReady(bobSocket);

    await send(conversationId, alice.userId, 'are you at your desk?');

    /*
     * Presence says a browser is open. It says nothing about whether anybody looked at this
     * conversation — and a "Seen" built on presence would tell Alice her colleague had read a
     * message they have not seen.
     */
    expect(await watermarkOf(conversationId, bob.userId)).toBeNull();
  });

  it('SOCKET DELIVERY does not mark anything read', async () => {
    const alice = await createTestIdentity('Alice Deliver');
    const bob = await createTestIdentity('Bob Deliver');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const bobSocket = await open(bob.cookie);
    await waitForReady(bobSocket);
    await emitWithAck(bobSocket, 'conversation:join', { conversationId });

    const aliceSocket = await open(alice.cookie);
    await waitForReady(aliceSocket);

    // Bob's client genuinely receives the message.
    const delivered = waitForEvent(bobSocket, 'message:new');
    await emitWithAck(aliceSocket, 'message:send', {
      conversationId,
      body: 'delivered, but not read',
      clientMessageId: uuid(),
    });
    await delivered;

    // Delivery is transport. The marker is untouched, because nobody opened anything.
    expect(await watermarkOf(conversationId, bob.userId)).toBeNull();
  });

  /* ------------------------------------------------------------------------------------------ */
  /* Delivery of the receipt                                                                      */
  /* ------------------------------------------------------------------------------------------ */

  it('tells the sender, in real time, when the other participant reads', async () => {
    const alice = await createTestIdentity('Alice Live');
    const bob = await createTestIdentity('Bob Live');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const aliceSocket = await open(alice.cookie);
    await waitForReady(aliceSocket);

    const { message } = await send(conversationId, alice.userId, 'did you see this?');

    const read = waitForEvent(aliceSocket, 'conversation:read');
    await readAndAnnounce(conversationId, bob.userId, message.id);

    const wire = (await read) as ConversationReadWire;
    expect(wire.conversationId).toBe(conversationId);
    expect(wire.userId).toBe(bob.userId);
    // A direct conversation carries the watermark, which is what the Seen mark is computed from.
    expect(wire.lastReadAt).toBe(message.createdAt.toISOString());
  });

  it('WITHHOLDS the watermark in a group', async () => {
    const owner = await createTestIdentity('Owner LiveGroup');
    const reader = await createTestIdentity('Reader LiveGroup');
    const conversationId = await seedGroupConversation(owner.userId, [{ userId: reader.userId }]);

    const ownerSocket = await open(owner.cookie);
    await waitForReady(ownerSocket);

    const { message } = await send(conversationId, owner.userId, 'team, please read');

    const read = waitForEvent(ownerSocket, 'conversation:read');
    await readAndAnnounce(conversationId, reader.userId, message.id);

    /*
     * A bare nudge. Broadcasting group watermarks would let any member compute per-member read
     * status for anybody's messages — the exact capability `GET /api/messages/:id/info` restricts
     * to the sender. An open Message info panel answers this by re-reading through that endpoint.
     */
    const wire = (await read) as ConversationReadWire;
    expect(wire.userId).toBe(reader.userId);
    expect(wire.lastReadAt).toBeNull();
  });

  it('does not send the reader their own receipt', async () => {
    const alice = await createTestIdentity('Alice Self');
    const bob = await createTestIdentity('Bob Self');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const bobSocket = await open(bob.cookie);
    await waitForReady(bobSocket);

    const { message } = await send(conversationId, alice.userId, 'hello');

    // Bob reads. Bob already knows; his own tabs learn it from the HTTP response.
    const noEcho = expectNoEvent(bobSocket, 'conversation:read');
    await readAndAnnounce(conversationId, bob.userId, message.id);
    await noEcho;
  });

  it('says nothing at all when the marker did not move', async () => {
    const alice = await createTestIdentity('Alice Noop13');
    const bob = await createTestIdentity('Bob Noop13');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const aliceSocket = await open(alice.cookie);
    await waitForReady(aliceSocket);

    const { message } = await send(conversationId, alice.userId, 'once');

    // The first read DOES announce. It is awaited here rather than ignored: leaving it in flight
    // would let it land inside the silence window below and fail the test for the wrong reason.
    const first = waitForEvent(aliceSocket, 'conversation:read');
    await readAndAnnounce(conversationId, bob.userId, message.id);
    await first;

    // Re-opening a conversation already read to the end. One event per MOVE, never one per open.
    const quiet = expectNoEvent(aliceSocket, 'conversation:read');
    await readAndAnnounce(conversationId, bob.userId, message.id);
    await quiet;
  });

  /* ------------------------------------------------------------------------------------------ */
  /* A receipt is not a message                                                                   */
  /* ------------------------------------------------------------------------------------------ */

  it('creates no message, no unread and no reordering', async () => {
    const alice = await createTestIdentity('Alice Calm');
    const bob = await createTestIdentity('Bob Calm');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const aliceSocket = await open(alice.cookie);
    await waitForReady(aliceSocket);

    const { message } = await send(conversationId, alice.userId, 'one message');

    const before = (await listConversationsForUser(db(), alice.userId)).find(
      (item) => item.id === conversationId,
    );
    const messagesBefore = await db().message.count({ where: { conversationId } });

    /*
     * `message:new` is the event the client feeds to the notification policy. A receipt arriving
     * on it would make Alice's colleague appear to have messaged her: a sound, a toast, a badge.
     */
    const noNewMessage = expectNoEvent(aliceSocket, 'message:new');
    await readAndAnnounce(conversationId, bob.userId, message.id);
    await noNewMessage;

    const after = (await listConversationsForUser(db(), alice.userId)).find(
      (item) => item.id === conversationId,
    );

    expect(await db().message.count({ where: { conversationId } })).toBe(messagesBefore);
    expect(after?.unreadCount).toBe(before?.unreadCount);
    expect(after?.lastMessageAt?.getTime()).toBe(before?.lastMessageAt?.getTime());
    expect(after?.lastMessage?.id).toBe(before?.lastMessage?.id);
  });
});
