/**
 * Typing indicators over the real socket (Batch 1.8).
 *
 * Real Socket.IO clients, real cookies, real Prisma — the audience rules are authorization, and a
 * test that stubbed them would prove nothing. The timing rules (idle, heartbeat, expiry) are
 * covered with fake timers in typing-tracker.test.ts and typing-signal.test.ts; here the only
 * real-time wait is the one expiry test, against a server built with a short TTL.
 */

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import type { MessageWire, TypingWire } from '@/lib/chat/wire';
import { removeGroupMember } from '@/lib/conversations/service';
import { notifyConversationChanged } from '@/lib/realtime/notify';

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
  seedDirectConversation,
  seedGroupConversation,
  startTestServer,
  uuid,
  waitFor,
  waitForEvent,
  waitForReady,
} from './harness';

const suite = databaseConfigured ? describe : describe.skip;

/** Long enough that no expiry can fire inside any test that is not about expiry. */
const LONG_TTL_MS = 30_000;
const SHORT_TTL_MS = 300;

/** The next typing update on a socket that matches. */
function nextTyping(
  socket: TestClient,
  match: (payload: TypingWire) => boolean,
  timeoutMs = 3_000,
): Promise<TypingWire> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('typing:update', handler);
      reject(new Error('Timed out waiting for a matching typing:update'));
    }, timeoutMs);

    function handler(payload: TypingWire) {
      if (!match(payload)) return;
      clearTimeout(timer);
      socket.off('typing:update', handler);
      resolve(payload);
    }

    socket.on('typing:update', handler);
  });
}

/** Collects every typing update a socket receives for a while. */
async function collectTyping(socket: TestClient, windowMs = 400): Promise<TypingWire[]> {
  const received: TypingWire[] = [];
  const handler = (payload: TypingWire) => received.push(payload);
  socket.on('typing:update', handler);
  await new Promise((resolve) => setTimeout(resolve, windowMs));
  socket.off('typing:update', handler);
  return received;
}

function start(socket: TestClient, conversationId: string): void {
  socket.emit('typing:start', { conversationId });
}

function stop(socket: TestClient, conversationId: string): void {
  socket.emit('typing:stop', { conversationId });
}

suite('typing indicators over the socket', () => {
  let server: RunningServer | undefined;
  const sockets: TestClient[] = [];

  /** A socket on the shared server, or on a test's own when it needs one. */
  async function open(cookie: string, on?: RunningServer): Promise<TestClient> {
    server ??= await startTestServer({ typingTtlMs: LONG_TTL_MS });
    const socket = await connectClient((on ?? server).url, cookie);
    sockets.push(socket);
    await waitForReady(socket);
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

  /* ------------------------------------------------------------------ one-to-one ---------- */

  it('tells the other participant of a direct chat, and nobody outside it', async () => {
    const alice = await createTestIdentity('Typing Alice');
    const bob = await createTestIdentity('Typing Bob');
    const outsider = await createTestIdentity('Typing Outsider');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const aliceSocket = await open(alice.cookie);
    const bobSocket = await open(bob.cookie);
    const outsiderSocket = await open(outsider.cookie);

    const outsiderHeard = collectTyping(outsiderSocket);
    const bobHears = nextTyping(bobSocket, (p) => p.conversationId === conversationId);
    start(aliceSocket, conversationId);

    expect(await bobHears).toEqual({ conversationId, userId: alice.userId, typing: true });
    expect(await outsiderHeard).toEqual([]);
  });

  it('never shows the typer their own indicator, in any of their windows', async () => {
    const alice = await createTestIdentity('Self Alice');
    const bob = await createTestIdentity('Self Bob');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const aliceTab = await open(alice.cookie);
    const aliceOtherTab = await open(alice.cookie);
    const bobSocket = await open(bob.cookie);

    const firstTabHeard = collectTyping(aliceTab);
    const otherTabHeard = collectTyping(aliceOtherTab);
    const bobHears = nextTyping(bobSocket, (p) => p.typing);
    start(aliceTab, conversationId);

    await bobHears;
    expect(await firstTabHeard).toEqual([]);
    expect(await otherTabHeard).toEqual([]);
  });

  it('clears the indicator when the typer stops', async () => {
    const alice = await createTestIdentity('Stop Alice');
    const bob = await createTestIdentity('Stop Bob');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const aliceSocket = await open(alice.cookie);
    const bobSocket = await open(bob.cookie);

    const started = nextTyping(bobSocket, (p) => p.typing);
    start(aliceSocket, conversationId);
    await started;

    const stopped = nextTyping(bobSocket, (p) => !p.typing);
    stop(aliceSocket, conversationId);
    expect(await stopped).toEqual({ conversationId, userId: alice.userId, typing: false });
    expect(server?.gateway.typing.isTyping(conversationId, alice.userId)).toBe(false);
  });

  it('clears the indicator when the message is sent, and still delivers the message', async () => {
    const alice = await createTestIdentity('Send Alice');
    const bob = await createTestIdentity('Send Bob');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const aliceSocket = await open(alice.cookie);
    const bobSocket = await open(bob.cookie);

    const started = nextTyping(bobSocket, (p) => p.typing);
    start(aliceSocket, conversationId);
    await started;

    // No explicit stop: the send alone must end it.
    const message = waitForEvent(bobSocket, 'message:new');
    const stopped = nextTyping(bobSocket, (p) => !p.typing);
    const ack = await emitWithAck<MessageWire>(aliceSocket, 'message:send', {
      conversationId,
      body: 'typed, then sent',
      clientMessageId: uuid(),
    });

    expect(ack.ok).toBe(true);
    expect((await message).body).toBe('typed, then sent');
    expect(await stopped).toEqual({ conversationId, userId: alice.userId, typing: false });
  });

  it('clears the indicator when the typer disconnects', async () => {
    const alice = await createTestIdentity('Drop Alice');
    const bob = await createTestIdentity('Drop Bob');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const aliceSocket = await open(alice.cookie);
    const bobSocket = await open(bob.cookie);

    const started = nextTyping(bobSocket, (p) => p.typing);
    start(aliceSocket, conversationId);
    await started;

    const stopped = nextTyping(bobSocket, (p) => !p.typing);
    aliceSocket.close();
    expect(await stopped).toEqual({ conversationId, userId: alice.userId, typing: false });
  });

  it('keeps a user typing while another of their windows still is', async () => {
    const alice = await createTestIdentity('Tabs Alice');
    const bob = await createTestIdentity('Tabs Bob');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const desktop = await open(alice.cookie);
    const browser = await open(alice.cookie);
    const bobSocket = await open(bob.cookie);

    const started = nextTyping(bobSocket, (p) => p.typing);
    start(desktop, conversationId);
    await started;

    // A second window joining in, then the first stopping, changes nothing for Bob. Each socket
    // is ordered on its own, so the second window's start is let land before the first stops.
    const quiet = collectTyping(bobSocket);
    start(browser, conversationId);
    await waitFor(() => server?.gateway.typing.typingSocketCount(conversationId, alice.userId) === 2);
    stop(desktop, conversationId);
    expect(await quiet).toEqual([]);
    expect(server?.gateway.typing.isTyping(conversationId, alice.userId)).toBe(true);

    // Closing the last window that was typing ends it.
    const stopped = nextTyping(bobSocket, (p) => !p.typing);
    browser.close();
    expect((await stopped).userId).toBe(alice.userId);
  });

  it('expires a typing state nobody stopped', async () => {
    const alice = await createTestIdentity('Stale Alice');
    const bob = await createTestIdentity('Stale Bob');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const shortLived = await startTestServer({ typingTtlMs: SHORT_TTL_MS });
    try {
      const aliceSocket = await open(alice.cookie, shortLived);
      const bobSocket = await open(bob.cookie, shortLived);

      const started = nextTyping(bobSocket, (p) => p.typing);
      start(aliceSocket, conversationId);
      await started;

      // No stop, no send, still connected: only the expiry can end it.
      const expired = await nextTyping(bobSocket, (p) => !p.typing, SHORT_TTL_MS + 2_000);
      expect(expired).toEqual({ conversationId, userId: alice.userId, typing: false });
    } finally {
      while (sockets.length > 0) sockets.pop()?.close();
      await shortLived.close();
    }
  });

  /* ------------------------------------------------------------------ authorization ------- */

  it('ignores a typing signal for a conversation the sender is not in', async () => {
    const alice = await createTestIdentity('Authz Alice');
    const bob = await createTestIdentity('Authz Bob');
    const intruder = await createTestIdentity('Authz Intruder');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const aliceSocket = await open(alice.cookie);
    const bobSocket = await open(bob.cookie);
    const intruderSocket = await open(intruder.cookie);

    const aliceHeard = collectTyping(aliceSocket, 600);
    const bobHeard = collectTyping(bobSocket, 600);
    start(intruderSocket, conversationId);
    // A made-up conversation and a malformed payload are ignored the same way.
    start(intruderSocket, uuid());
    intruderSocket.emit('typing:start', { conversationId: 'not-a-uuid', userId: alice.userId });

    expect(await aliceHeard).toEqual([]);
    expect(await bobHeard).toEqual([]);
    expect(server?.gateway.typing.isTyping(conversationId, intruder.userId)).toBe(false);
  });

  /* ------------------------------------------------------------------ groups -------------- */

  it('tells every other active member of a group, and reports several typers', async () => {
    const owner = await createTestIdentity('Group Owner');
    const rahul = await createTestIdentity('Group Rahul');
    const priya = await createTestIdentity('Group Priya');
    const conversationId = await seedGroupConversation(owner.userId, [
      { userId: rahul.userId },
      { userId: priya.userId },
    ]);

    const ownerSocket = await open(owner.cookie);
    const rahulSocket = await open(rahul.cookie);
    const priyaSocket = await open(priya.cookie);

    const ownerHearsRahul = nextTyping(ownerSocket, (p) => p.userId === rahul.userId && p.typing);
    const priyaHearsRahul = nextTyping(priyaSocket, (p) => p.userId === rahul.userId && p.typing);
    start(rahulSocket, conversationId);
    await ownerHearsRahul;
    await priyaHearsRahul;

    const ownerHearsPriya = nextTyping(ownerSocket, (p) => p.userId === priya.userId && p.typing);
    start(priyaSocket, conversationId);
    await ownerHearsPriya;

    expect(server?.gateway.typing.typingUserIds(conversationId).sort()).toEqual(
      [rahul.userId, priya.userId].sort(),
    );
  });

  it('stops telling a removed member, and ignores their own typing', async () => {
    const owner = await createTestIdentity('Removal Owner');
    const stayer = await createTestIdentity('Removal Stayer');
    const leaver = await createTestIdentity('Removal Leaver');
    const conversationId = await seedGroupConversation(owner.userId, [
      { userId: stayer.userId },
      { userId: leaver.userId },
    ]);

    // Its own server: the realtime notifier is process-wide and belongs to the gateway created
    // last, so the removal below must reach THIS gateway and not one another test started.
    const own = await startTestServer({ typingTtlMs: LONG_TTL_MS });
    try {
      const ownerSocket = await open(owner.cookie, own);
      const stayerSocket = await open(stayer.cookie, own);
      const leaverSocket = await open(leaver.cookie, own);

      // The leaver is typing when they are removed: that ends with the membership.
      const leaverStarted = nextTyping(ownerSocket, (p) => p.userId === leaver.userId && p.typing);
      start(leaverSocket, conversationId);
      await leaverStarted;

      const leaverStopped = nextTyping(ownerSocket, (p) => p.userId === leaver.userId && !p.typing);
      const change = await removeGroupMember(db(), {
        actorId: owner.userId,
        conversationId,
        targetUserId: leaver.userId,
      });
      // What the route does after the commit.
      notifyConversationChanged({
        conversationId: change.conversationId,
        memberIds: change.memberIds,
        removedIds: change.removedIds,
      });
      await leaverStopped;

      // Somebody still in the group types: the removed member hears nothing.
      const leaverHeard = collectTyping(leaverSocket, 600);
      const ownerHearsStayer = nextTyping(
        ownerSocket,
        (p) => p.userId === stayer.userId && p.typing,
      );
      start(stayerSocket, conversationId);
      await ownerHearsStayer;
      expect(await leaverHeard).toEqual([]);

      // And the removed member can no longer broadcast into it. Waits out the per-socket start
      // throttle first, so the start is refused for not being a member rather than for being
      // too frequent.
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const ownerHeard = collectTyping(ownerSocket, 600);
      start(leaverSocket, conversationId);
      expect(await ownerHeard).toEqual([]);
      expect(own.gateway.typing.isTyping(conversationId, leaver.userId)).toBe(false);
    } finally {
      while (sockets.length > 0) sockets.pop()?.close();
      await own.close();
    }
  });

  /* ------------------------------------------------------------------ conversation switch - */

  it('switching conversation ends the old one and never leaks into another', async () => {
    const alice = await createTestIdentity('Switch Alice');
    const bob = await createTestIdentity('Switch Bob');
    const carol = await createTestIdentity('Switch Carol');
    const withBob = await seedDirectConversation(alice.userId, bob.userId);
    const withCarol = await seedDirectConversation(alice.userId, carol.userId);

    const aliceSocket = await open(alice.cookie);
    const bobSocket = await open(bob.cookie);
    const carolSocket = await open(carol.cookie);

    const bobStarted = nextTyping(bobSocket, (p) => p.typing);
    start(aliceSocket, withBob);
    await bobStarted;

    // What the composer does on a switch: its unmount stops the old conversation, and the new
    // composer starts the new one.
    const bobStopped = nextTyping(bobSocket, (p) => !p.typing);
    const carolStarted = nextTyping(carolSocket, (p) => p.typing);
    const bobHeardAfter = collectTyping(bobSocket, 600);
    stop(aliceSocket, withBob);
    start(aliceSocket, withCarol);

    expect(await bobStopped).toEqual({ conversationId: withBob, userId: alice.userId, typing: false });
    expect(await carolStarted).toEqual({ conversationId: withCarol, userId: alice.userId, typing: true });
    // Bob hears only the stop for his own conversation — nothing about Carol's.
    expect((await bobHeardAfter).every((p) => p.conversationId === withBob)).toBe(true);
  });

  /* ------------------------------------------------------------------ no persistence ------ */

  it('writes nothing to the database', async () => {
    const alice = await createTestIdentity('NoWrite Alice');
    const bob = await createTestIdentity('NoWrite Bob');
    const conversationId = await seedGroupConversation(alice.userId, [{ userId: bob.userId }]);

    const aliceSocket = await open(alice.cookie);
    const bobSocket = await open(bob.cookie);

    async function snapshot() {
      const [conversation, members, messages, mentions, reactions, users] = await Promise.all([
        db().conversation.findUniqueOrThrow({ where: { id: conversationId } }),
        db().conversationMember.findMany({ where: { conversationId }, orderBy: { userId: 'asc' } }),
        db().message.count({ where: { conversationId } }),
        db().messageMention.count({ where: { message: { conversationId } } }),
        db().messageReaction.count({ where: { message: { conversationId } } }),
        db().user.findMany({
          where: { id: { in: [alice.userId, bob.userId] } },
          orderBy: { id: 'asc' },
        }),
      ]);
      return { conversation, members, messages, mentions, reactions, users };
    }

    const before = await snapshot();

    const started = nextTyping(bobSocket, (p) => p.typing);
    start(aliceSocket, conversationId);
    await started;
    const stopped = nextTyping(bobSocket, (p) => !p.typing);
    stop(aliceSocket, conversationId);
    await stopped;

    expect(await snapshot()).toEqual(before);
  });

  it('forgets everything when the server restarts', async () => {
    const alice = await createTestIdentity('Restart Alice');
    const bob = await createTestIdentity('Restart Bob');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const restartable = await startTestServer({ typingTtlMs: LONG_TTL_MS });
    try {
      const aliceSocket = await connectClient(restartable.url, alice.cookie);
      const bobSocket = await connectClient(restartable.url, bob.cookie);
      sockets.push(aliceSocket, bobSocket);
      await waitForReady(aliceSocket);
      await waitForReady(bobSocket);

      const started = nextTyping(bobSocket, (p) => p.typing);
      start(aliceSocket, conversationId);
      await started;
      expect(restartable.gateway.typing.isTyping(conversationId, alice.userId)).toBe(true);
    } finally {
      await restartable.close();
    }

    const fresh = await startTestServer({ typingTtlMs: LONG_TTL_MS });
    try {
      await waitFor(() => !fresh.gateway.typing.isTyping(conversationId, alice.userId));
      expect(fresh.gateway.typing.typingUserIds(conversationId)).toEqual([]);
    } finally {
      await fresh.close();
    }
  });
});
