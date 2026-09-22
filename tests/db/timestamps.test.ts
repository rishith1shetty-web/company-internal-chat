/**
 * Timestamps are stored as the instants they claim to be (Maintenance Batch).
 *
 * Real Prisma, real PostgreSQL, on the isolated cluster. These are the tests that would have
 * caught the bug they exist for, and none of the application's existing tests could have.
 *
 * WHY NOT, precisely — because it is the reason this file is shaped the way it is. Prisma handed
 * the driver a naive `2026-09-22 16:00:00` for the instant `16:00Z`; PostgreSQL attached the
 * SESSION zone's offset (`America/New_York` on this machine) and stored `20:00Z`. Reading it back
 * applied the same rule in reverse, so `16:00Z` came out again. Every test that wrote a value and
 * read it back passed. Every comparison the application makes — ordering, unread counts, read
 * watermarks, session expiry — is between two values carrying the identical error, so those
 * passed too. The data was four hours wrong and nothing in the suite could see it.
 *
 * So the assertions here deliberately do NOT round-trip through Prisma. They ask PostgreSQL what
 * instant it is actually holding, as text it renders itself, and compare that against the instant
 * the application meant to write. That is the only question that was going unasked.
 *
 * The second half of the file re-proves the behaviour that depended on the broken values — Seen,
 * unread counts, group Message info, session expiry — now that the values are correct.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { resolveIdentity, sessionExpiry } from '@/lib/auth/session';
import { listConversationsForUser, markConversationRead } from '@/lib/conversations/service';
import { DATABASE_SESSION_OPTIONS } from '@/lib/db/prisma';
import { editMessage } from '@/lib/messages/actions';
import { readStatusForMessage } from '@/lib/messages/read-status';
import { sendMessage } from '@/lib/messages/service';

import {
  IDENTITY_CONFIG,
  cleanUp,
  createTestIdentity,
  databaseConfigured,
  db,
  disconnect,
  seedDirectConversation,
  seedGroupConversation,
  uuid,
} from '../chat/harness';

const suite = databaseConfigured ? describe : describe.skip;

/** A known absolute instant in EDT, and its twin in EST. Neither is near a DST boundary. */
const SUMMER = new Date('2026-07-15T16:00:00.000Z');
const WINTER = new Date('2026-01-15T16:00:00.000Z');

/**
 * The instant PostgreSQL is actually holding, as PostgreSQL itself renders it.
 *
 * `to_char(... AT TIME ZONE 'UTC')` on the server, returned as TEXT. Nothing parses a naive
 * timestamp on the way out, which matters: the `pg` driver reads a `timestamp without time zone`
 * as a LOCAL time, so asking this question through a typed column re-introduces the very shift
 * being measured. (That mistake was made while investigating this bug and reported a skew twice
 * the real one.)
 */
async function heldInstant(table: string, column: string, id: string): Promise<string> {
  const rows = await db().$queryRawUnsafe<{ t: string }[]>(
    `SELECT to_char("${column}" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t
       FROM "${table}" WHERE id = $1::uuid`,
    id,
  );
  const value = rows[0]?.t;
  if (value === undefined) throw new Error(`no ${table}.${column} row for ${id}`);
  return value;
}

suite('timestamps are absolute instants', () => {
  afterAll(async () => {
    await cleanUp();
    await disconnect();
  });

  /* ------------------------------------------------------------------------------------------ */
  /* The connection                                                                               */
  /* ------------------------------------------------------------------------------------------ */

  it('opens every connection with the session pinned to UTC', async () => {
    const [row] = await db().$queryRaw<{ TimeZone: string }[]>`SHOW TimeZone`;

    /*
     * This is the fix itself, asserted directly. The cluster's own default is whatever `initdb`
     * inherited from the operating system — `America/New_York` on the company server — so the
     * application cannot rely on the server being configured correctly. It states what it needs.
     */
    expect(row?.TimeZone).toBe('UTC');
    expect(DATABASE_SESSION_OPTIONS).toBe('-c timezone=UTC');
  });

  it('agrees with PostgreSQL about what time it is now', async () => {
    const before = Date.now();
    const [row] = await db().$queryRaw<{ t: string }[]>`
      SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t`;
    const after = Date.now();

    const database = Date.parse(row?.t ?? '');

    /*
     * Node and PostgreSQL share this machine's clock, so the only thing that can separate them is
     * a timezone mistake — and a timezone mistake is never a few milliseconds, it is whole hours.
     * A generous tolerance therefore costs nothing and keeps the test from being a clock-skew
     * flake detector.
     */
    expect(database).toBeGreaterThanOrEqual(before - 5_000);
    expect(database).toBeLessThanOrEqual(after + 5_000);
  });

  /* ------------------------------------------------------------------------------------------ */
  /* Write, then ask the database what it kept                                                    */
  /* ------------------------------------------------------------------------------------------ */

  it('stores the instant it was given, in summer AND in winter', async () => {
    for (const instant of [SUMMER, WINTER]) {
      const user = await db().user.create({
        data: {
          displayName: 'zz-test-p5-tz',
          normalizedName: `zz-test-p5-tz-${uuid()}`,
          createdAt: instant,
          lastSeenAt: instant,
        },
        select: { id: true, createdAt: true },
      });

      /*
       * The assertion that was missing. Before the fix this read four hours later for the summer
       * instant and FIVE for the winter one — which is also why no single interval could have
       * repaired the stored data.
       */
      expect(await heldInstant('User', 'createdAt', user.id)).toBe(instant.toISOString());

      // And the round-trip, which was always faithful and must stay that way.
      expect(user.createdAt.getTime()).toBe(instant.getTime());

      await db().user.delete({ where: { id: user.id } });
    }
  });

  it('stores a DST-boundary instant faithfully', async () => {
    /*
     * 06:30Z on 8 March 2026 is 01:30 EST — and its naive UTC wall clock, `02:30`, is a local
     * time that DOES NOT EXIST in New York that morning. Under the old behaviour PostgreSQL had
     * to invent an interpretation for it, and the value did not come back the same.
     *
     * Two messages are written in that window, in order, and must still be in order.
     */
    const gapStart = new Date('2026-03-08T06:30:00.000Z');
    const gapEnd = new Date('2026-03-08T06:45:00.000Z');

    const alice = await createTestIdentity('Alice DST');
    const bob = await createTestIdentity('Bob DST');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const first = await db().message.create({
      data: {
        conversationId,
        senderId: alice.userId,
        type: 'TEXT',
        body: 'during the gap',
        clientMessageId: uuid(),
        createdAt: gapStart,
      },
      select: { id: true, createdAt: true },
    });
    const second = await db().message.create({
      data: {
        conversationId,
        senderId: alice.userId,
        type: 'TEXT',
        body: 'still during the gap',
        clientMessageId: uuid(),
        createdAt: gapEnd,
      },
      select: { id: true, createdAt: true },
    });

    expect(await heldInstant('Message', 'createdAt', first.id)).toBe(gapStart.toISOString());
    expect(await heldInstant('Message', 'createdAt', second.id)).toBe(gapEnd.toISOString());

    // Ordering, which is what the application actually depends on.
    const ordered = await db().message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    expect(ordered.map((row) => row.id)).toEqual([first.id, second.id]);
  });

  it('stores a message sent NOW at the real current instant', async () => {
    const alice = await createTestIdentity('Alice Now');
    const bob = await createTestIdentity('Bob Now');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const before = Date.now();
    const { message } = await sendMessage(db(), {
      senderId: alice.userId,
      conversationId,
      body: 'what time is it',
      clientMessageId: uuid(),
    });
    const after = Date.now();

    /*
     * `Message.createdAt` has `@default(now())` in the schema, but Prisma fills it client-side
     * rather than letting the column default fire — so it went through the broken path like
     * everything else, and lands four hours in the FUTURE when the session zone is wrong.
     */
    const held = Date.parse(await heldInstant('Message', 'createdAt', message.id));
    expect(held).toBeGreaterThanOrEqual(before - 5_000);
    expect(held).toBeLessThanOrEqual(after + 5_000);
  });

  it('stores User.lastSeenAt and Session.lastSeenAt at the real current instant', async () => {
    const alice = await createTestIdentity('Alice Seen');

    const identity = await resolveIdentity(
      db(),
      { sessionToken: alice.sessionToken, deviceToken: alice.deviceToken },
      IDENTITY_CONFIG,
    );
    expect(identity?.current.userId).toBe(alice.userId);

    const now = Date.now();

    const userHeld = Date.parse(await heldInstant('User', 'lastSeenAt', alice.userId));
    expect(Math.abs(userHeld - now)).toBeLessThan(120_000);

    const session = await db().session.findFirstOrThrow({
      where: { userId: alice.userId },
      select: { id: true },
    });
    const sessionHeld = Date.parse(await heldInstant('Session', 'lastSeenAt', session.id));

    // Two minutes of slack for a slow suite; the failure this guards against is four HOURS.
    expect(Math.abs(sessionHeld - now)).toBeLessThan(120_000);
  });

  it('stores Session.expiresAt exactly one TTL ahead of the real clock', async () => {
    const alice = await createTestIdentity('Alice Expiry');
    const session = await db().session.findFirstOrThrow({
      where: { userId: alice.userId },
      select: { id: true },
    });

    const held = Date.parse(await heldInstant('Session', 'expiresAt', session.id));
    const expected = sessionExpiry(IDENTITY_CONFIG).getTime();

    /*
     * The one that would have been a real security question. A `expiresAt` stored four hours late
     * is a session that outlives its 24-hour idle window by four hours — and the reason nobody
     * could see it is that the check reads the value back through the same shift.
     */
    expect(Math.abs(held - expected)).toBeLessThan(120_000);
  });

  it('stores ConversationMember.lastReadAt as the message instant it copies', async () => {
    const alice = await createTestIdentity('Alice Watermark');
    const bob = await createTestIdentity('Bob Watermark');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const { message } = await sendMessage(db(), {
      senderId: alice.userId,
      conversationId,
      body: 'read this',
      clientMessageId: uuid(),
    });
    await markConversationRead(db(), bob.userId, conversationId, message.id);

    const [row] = await db().$queryRaw<{ read: string; created: string }[]>`
      SELECT to_char(m."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created,
             to_char(c."lastReadAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS read
        FROM "Message" m
        JOIN "ConversationMember" c
          ON c."conversationId" = m."conversationId" AND c."userId" = ${bob.userId}::uuid
       WHERE m.id = ${message.id}::uuid`;

    // The watermark IS the message time. Both are now correct, and they still match exactly.
    expect(row?.read).toBe(row?.created);
    expect(row?.read).toBe(message.createdAt.toISOString());
  });
});

/* -------------------------------------------------------------------------------------------- */
/* The behaviour that was riding on the skewed values                                             */
/* -------------------------------------------------------------------------------------------- */

suite('behaviour that depends on timestamps, with correct timestamps', () => {
  afterAll(async () => {
    await cleanUp();
    await disconnect();
  });

  it('keeps the read watermark comparison exact', async () => {
    const alice = await createTestIdentity('Alice Cmp');
    const bob = await createTestIdentity('Bob Cmp');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const first = await sendMessage(db(), {
      senderId: alice.userId, conversationId, body: 'one', clientMessageId: uuid(),
    });
    const second = await sendMessage(db(), {
      senderId: alice.userId, conversationId, body: 'two', clientMessageId: uuid(),
    });

    await markConversationRead(db(), bob.userId, conversationId, first.message.id);

    const member = await db().conversationMember.findUniqueOrThrow({
      where: { conversationId_userId: { conversationId, userId: bob.userId } },
      select: { lastReadAt: true },
    });

    // `lastReadAt >= createdAt` — the exact predicate read receipts are built on.
    expect(member.lastReadAt!.getTime()).toBeGreaterThanOrEqual(first.message.createdAt.getTime());
    expect(member.lastReadAt!.getTime()).toBeLessThan(second.message.createdAt.getTime());
  });

  it('keeps the unread count the complement of the watermark', async () => {
    const alice = await createTestIdentity('Alice Unread');
    const bob = await createTestIdentity('Bob Unread');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const first = await sendMessage(db(), {
      senderId: alice.userId, conversationId, body: 'one', clientMessageId: uuid(),
    });
    await sendMessage(db(), {
      senderId: alice.userId, conversationId, body: 'two', clientMessageId: uuid(),
    });
    await sendMessage(db(), {
      senderId: alice.userId, conversationId, body: 'three', clientMessageId: uuid(),
    });

    const before = (await listConversationsForUser(db(), bob.userId)).find(
      (item) => item.id === conversationId,
    );
    expect(before?.unreadCount).toBe(3);

    await markConversationRead(db(), bob.userId, conversationId, first.message.id);

    const after = (await listConversationsForUser(db(), bob.userId)).find(
      (item) => item.id === conversationId,
    );
    expect(after?.unreadCount).toBe(2);
  });

  it('keeps group Read by / Not read by correct', async () => {
    const owner = await createTestIdentity('Owner Info');
    const reader = await createTestIdentity('Reader Info');
    const idler = await createTestIdentity('Idler Info');

    const conversationId = await seedGroupConversation(owner.userId, [
      { userId: reader.userId },
      { userId: idler.userId },
    ]);
    const { message } = await sendMessage(db(), {
      senderId: owner.userId, conversationId, body: 'team update', clientMessageId: uuid(),
    });

    await markConversationRead(db(), reader.userId, conversationId, message.id);

    const status = await readStatusForMessage(db(), {
      userId: owner.userId,
      messageId: message.id,
    });

    expect(status.readBy.map((entry) => entry.userId)).toEqual([reader.userId]);
    expect(status.notReadBy.map((entry) => entry.userId)).toEqual([idler.userId]);
  });

  it('does not let an EDIT un-read a message', async () => {
    const alice = await createTestIdentity('Alice Edit');
    const bob = await createTestIdentity('Bob Edit');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const { message } = await sendMessage(db(), {
      senderId: alice.userId, conversationId, body: 'original', clientMessageId: uuid(),
    });
    await markConversationRead(db(), bob.userId, conversationId, message.id);

    await editMessage(db(), { userId: alice.userId, messageId: message.id, body: 'corrected' });

    const after = await db().message.findUniqueOrThrow({
      where: { id: message.id },
      select: { createdAt: true, editedAt: true },
    });
    const member = await db().conversationMember.findUniqueOrThrow({
      where: { conversationId_userId: { conversationId, userId: bob.userId } },
      select: { lastReadAt: true },
    });

    /*
     * Editing stamps `editedAt` and leaves `createdAt` alone, so the watermark still covers the
     * message and the Seen mark stays. An edit that moved `createdAt` would silently un-see every
     * message it touched.
     */
    expect(after.createdAt.getTime()).toBe(message.createdAt.getTime());
    expect(after.editedAt).not.toBeNull();
    expect(member.lastReadAt!.getTime()).toBeGreaterThanOrEqual(after.createdAt.getTime());

    // And `editedAt` is itself a correct instant.
    const held = Date.parse(await heldInstant('Message', 'editedAt', message.id));
    expect(Math.abs(held - Date.now())).toBeLessThan(120_000);
  });

  it('keeps an active session active and an expired one expired', async () => {
    const alice = await createTestIdentity('Alice Live');

    // Active: the session just created by enrolment.
    const live = await resolveIdentity(
      db(),
      { sessionToken: alice.sessionToken, deviceToken: alice.deviceToken },
      IDENTITY_CONFIG,
    );
    expect(live?.current.userId).toBe(alice.userId);

    // Expired: the same session, backdated past its window.
    const session = await db().session.findFirstOrThrow({
      where: { userId: alice.userId },
      select: { id: true },
    });
    await db().session.update({
      where: { id: session.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    /*
     * The SESSION cookie alone. Sending the device cookie too would exercise the re-issue path
     * — an enrolled computer with a dead session is given a fresh one by design — and this test
     * is about whether the expiry itself is honoured.
     */
    const dead = await resolveIdentity(db(), { sessionToken: alice.sessionToken }, IDENTITY_CONFIG);

    /*
     * One minute in the past, not one hour: under the old behaviour the stored value was four
     * hours ahead of where it was meant to be, so a session expired by less than four hours still
     * resolved. A test using a large margin would have passed then too.
     */
    expect(dead).toBeNull();
  });
});
