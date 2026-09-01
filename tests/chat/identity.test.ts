/**
 * Identity and persistence guarantees (D-02, D-11, D-13, D-14) under admin-assigned identity.
 *
 * These are the properties the whole application rests on, and they are easy to break by
 * accident in a later phase:
 *
 *   - An employee cannot create, choose or clear an identity. There is no endpoint that turns a
 *     name typed in a browser into a `User`, and this file asserts the absence rather than
 *     trusting that nobody adds one back.
 *   - A display name is a label. Two employees may share one and are two different people.
 *   - A session is temporary; the data is not. Expiring, revoking or reassigning must never
 *     delete a user, a conversation, a membership or a message.
 *   - The device cookie reattaches a browser to whoever the computer is assigned to **now**.
 */

import { afterAll, describe, expect, it } from 'vitest';

import * as sessionRoute from '@/app/api/session/route';
import { GET as getSession } from '@/app/api/session/route';
import { DEVICE_COOKIE, SESSION_COOKIE, resolveIdentity } from '@/lib/auth/session';
import { listConversationsForUser } from '@/lib/conversations/service';
import { revokeDevice } from '@/lib/devices/service';
import { listMessages, sendMessage } from '@/lib/messages/service';
import type { SessionIdentityWire } from '@/lib/chat/wire';

import {
  IDENTITY_CONFIG,
  buildRequest,
  cleanUp,
  cookieHeader,
  createTestIdentity,
  databaseConfigured,
  db,
  disconnect,
  readResponse,
  seedDirectConversation,
  uuid,
} from './harness';

const suite = databaseConfigured ? describe : describe.skip;

/**
 * The employee-facing identity surface, asserted by its absence.
 *
 * Not a database test, so it runs everywhere. If somebody adds a POST back to `/api/session` —
 * or a DELETE, which was "Switch user" — this fails immediately and says why.
 */
describe('employee identity surface', () => {
  it('exposes no endpoint for creating, changing or clearing an identity', () => {
    expect(typeof sessionRoute.GET).toBe('function');

    const handlers = Object.keys(sessionRoute).filter((key) =>
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(key),
    );

    expect(handlers).toEqual([]);
  });
});

suite('identity', () => {
  afterAll(async () => {
    await cleanUp();
    await disconnect();
  });

  it('gives two people with the same display name two different identities (D-02)', async () => {
    const first = await createTestIdentity('Sarah Chen');
    const second = await createTestIdentity('Sarah Chen');

    expect(first.displayName).toBe(second.displayName);
    expect(first.userId).not.toBe(second.userId);

    // And each computer's cookies resolve to their own employee, not to whichever row the name
    // happens to match.
    const one = await resolveIdentity(
      db(),
      { sessionToken: first.sessionToken, deviceToken: first.deviceToken },
      IDENTITY_CONFIG,
    );
    const two = await resolveIdentity(
      db(),
      { sessionToken: second.sessionToken, deviceToken: second.deviceToken },
      IDENTITY_CONFIG,
    );

    expect(one?.current.userId).toBe(first.userId);
    expect(two?.current.userId).toBe(second.userId);
  });

  it('reports the caller identity from the cookie, never from a request field', async () => {
    const me = await createTestIdentity('Session Reader');
    const other = await createTestIdentity('Someone Other');

    const response = await readResponse<SessionIdentityWire>(
      await getSession(
        buildRequest({
          // A query string naming somebody else changes nothing: identity comes from the cookie.
          url: `/api/session?userId=${other.userId}`,
          cookie: me.cookie,
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(response.body.userId).toBe(me.userId);
    // And it reports which computer that identity belongs to, read-only.
    expect(response.body.deviceLabel).toBe(me.deviceLabel);
  });

  it('has no identity at all on a computer that was never assigned', async () => {
    const response = await getSession(buildRequest({ url: '/api/session' }));
    expect(response.status).toBe(204);
  });

  it('reattaches a browser to the assigned employee when the session has expired (D-13)', async () => {
    const person = await createTestIdentity('Returning Person');

    // Age the session past its expiry, exactly as 24 idle hours would.
    await db().session.updateMany({
      where: { userId: person.userId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const expiredOnly = await resolveIdentity(
      db(),
      { sessionToken: person.sessionToken },
      IDENTITY_CONFIG,
    );
    expect(expiredOnly).toBeNull();

    // With the device cookie the browser is the assigned employee again, on a NEW session.
    const reattached = await resolveIdentity(
      db(),
      { sessionToken: person.sessionToken, deviceToken: person.deviceToken },
      IDENTITY_CONFIG,
    );

    expect(reattached?.current.userId).toBe(person.userId);
    expect(reattached?.renewedSessionToken).toBeDefined();
    expect(reattached?.current.deviceId).toBe(person.deviceId);
  });

  it('does not let a retired device cookie resolve, even though the row still exists', async () => {
    const person = await createTestIdentity('Retired Device');

    await revokeDevice(db(), person.deviceId);

    const device = await db().device.findUnique({ where: { id: person.deviceId } });
    // Checking the row merely exists is the bug the schema warns about; `revokedAt` is what
    // decides.
    expect(device).not.toBeNull();
    expect(device?.revokedAt).not.toBeNull();

    const attempt = await resolveIdentity(
      db(),
      { sessionToken: person.sessionToken, deviceToken: person.deviceToken },
      IDENTITY_CONFIG,
    );
    expect(attempt).toBeNull();
  });

  it('ignores a device cookie belonging to a different computer', async () => {
    const mine = await createTestIdentity('Cookie Owner');
    const theirs = await createTestIdentity('Cookie Stranger');

    const resolved = await resolveIdentity(
      db(),
      // Somebody else's device cookie must never re-point an active session.
      { sessionToken: mine.sessionToken, deviceToken: theirs.deviceToken },
      IDENTITY_CONFIG,
    );

    expect(resolved?.current.userId).toBe(mine.userId);
    expect(resolved?.current.deviceId).toBe(mine.deviceId);
  });

  it('refuses a session that is not anchored to a computer', async () => {
    const person = await createTestIdentity('Unanchored');

    // A session row with no device cannot be checked against a current assignment, so it is not
    // honoured at all. Written directly because nothing in the application can produce one.
    await db().session.updateMany({
      where: { userId: person.userId },
      data: { deviceId: null },
    });

    const resolved = await resolveIdentity(
      db(),
      { sessionToken: person.sessionToken },
      IDENTITY_CONFIG,
    );

    expect(resolved).toBeNull();
  });

  it('names its cookies as the browser will see them', () => {
    // A rename here would silently sign every computer out; stated as a test so it cannot happen
    // unnoticed.
    expect(cookieHeader('s', 'd')).toBe(`${SESSION_COOKIE}=s; ${DEVICE_COOKIE}=d`);
  });
});

suite('data persistence (D-14)', () => {
  afterAll(async () => {
    await cleanUp();
    await disconnect();
  });

  it('keeps conversations and messages when a session expires and is replaced', async () => {
    const alice = await createTestIdentity('Alice Persistent');
    const bob = await createTestIdentity('Bob Persistent');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    await sendMessage(db(), {
      senderId: alice.userId,
      conversationId,
      body: 'this must survive',
      clientMessageId: uuid(),
    });

    // Expire the session and delete it, which is what a lapse plus a sweep amounts to.
    await db().session.deleteMany({ where: { userId: alice.userId } });

    // The device cookie brings the same employee back.
    const reattached = await resolveIdentity(
      db(),
      { deviceToken: alice.deviceToken },
      IDENTITY_CONFIG,
    );
    expect(reattached?.current.userId).toBe(alice.userId);

    const conversations = await listConversationsForUser(db(), alice.userId);
    expect(conversations.map((item) => item.id)).toContain(conversationId);

    const history = await listMessages(db(), { userId: alice.userId, conversationId });
    expect(history.messages.map((message) => message.body)).toEqual(['this must survive']);
  });

  it('keeps everything when a computer is retired', async () => {
    const alice = await createTestIdentity('Alice Retiring');
    const bob = await createTestIdentity('Bob Retiring');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const message = await sendMessage(db(), {
      senderId: alice.userId,
      conversationId,
      body: 'still here afterwards',
      clientMessageId: uuid(),
    });

    await revokeDevice(db(), alice.deviceId);

    // Sessions and devices sit at the leaf of every relationship: retiring one changes one row
    // and nothing else.
    expect(await db().user.findUnique({ where: { id: alice.userId } })).not.toBeNull();
    expect(await db().conversation.findUnique({ where: { id: conversationId } })).not.toBeNull();
    expect(await db().message.findUnique({ where: { id: message.message.id } })).not.toBeNull();
    expect(
      await db().conversationMember.findUnique({
        where: { conversationId_userId: { conversationId, userId: alice.userId } },
      }),
    ).not.toBeNull();
  });

  it('recovers the same history after a simulated reconnect', async () => {
    const alice = await createTestIdentity('Alice Reconnect');
    const bob = await createTestIdentity('Bob Reconnect');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const first = await sendMessage(db(), {
      senderId: bob.userId,
      conversationId,
      body: 'before the drop',
      clientMessageId: uuid(),
    });

    // What arrived while the browser was disconnected.
    const second = await sendMessage(db(), {
      senderId: bob.userId,
      conversationId,
      body: 'during the drop',
      clientMessageId: uuid(),
    });

    // The client reconnects and asks the database what it missed, rather than replaying events.
    const backfill = await listMessages(db(), {
      userId: alice.userId,
      conversationId,
      after: first.message.id,
    });

    expect(backfill.messages.map((message) => message.id)).toEqual([second.message.id]);
  });
});
