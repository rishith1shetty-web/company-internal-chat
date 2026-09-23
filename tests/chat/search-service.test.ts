/**
 * Global search authorization (Batch 1.6).
 *
 * THIS IS THE FILE THAT MATTERS. Search is the one feature that reads across every conversation
 * at once, so a missing predicate here does not produce a visible bug — it produces a quiet
 * disclosure that nobody notices until somebody finds a sentence they were never meant to read.
 *
 * Everything runs against the real database through the real service. Nothing is mocked: a test
 * that stubs the membership check it is meant to be proving proves nothing.
 *
 * The seeded world, built once and reused, because the interesting assertions are all about ONE
 * searcher looking at it from ONE position:
 *
 *   ALICE   — the searcher
 *   BOB     — a direct chat with Alice
 *   CAROL   — in a group with Alice; also has a direct chat with Bob that Alice cannot see
 *   MALLORY — shares nothing with Alice at all
 *
 *   direct(Alice, Bob)        — ordinary messages, an attachment, a hidden one, a deleted one
 *   group "Monthly Reports"   — Alice joined LATE; messages exist on both sides of her boundary
 *   group "Secret Committee"  — Alice is not in it
 *   group "Old Team"          — Alice was a member and LEFT
 *   direct(Bob, Carol)        — Alice is not in it
 *
 * Every word searched for is prefixed so these tests cannot match rows left by anything else.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deleteMessageForEveryone, editMessage, hideMessageForUser } from '@/lib/messages/actions';
import {
  emptySearchResults,
  escapeLikePattern,
  normalizeSearchQuery,
  searchEverything,
  SEARCH_CATEGORY_LIMIT,
  SEARCH_MAX_QUERY_LENGTH,
  SEARCH_MIN_QUERY_LENGTH,
} from '@/lib/search/service';

import { directKeyFor } from '@/lib/conversations/service';

import {
  cleanUp,
  createTestIdentity,
  databaseConfigured,
  db,
  disconnect,
  seedMessageAt,
  trackConversation,
  uuid,
} from './harness';

const suite = databaseConfigured ? describe : describe.skip;

/** Every searchable word in this file carries this, so nothing else in the database can match. */
const TAG = 'zzsearch';

/**
 * The seeded world is dated in the PAST, so `joinedAt` must be set explicitly for every member.
 *
 * Memberships default `joinedAt` to now, and under D-03 a member sees only `createdAt >=
 * joinedAt` — so a member created with the default would see none of the history seeded below,
 * and every assertion here would pass for entirely the wrong reason.
 */
const EPOCH = new Date('2026-01-01T09:00:00.000Z');
const BEFORE = new Date('2026-01-10T09:00:00.000Z');
const JOIN = new Date('2026-06-01T09:00:00.000Z');
const AFTER = new Date('2026-08-15T09:00:00.000Z');

interface World {
  alice: string;
  bob: string;
  carol: string;
  mallory: string;
  direct: string;
  reports: string;
  secret: string;
  oldTeam: string;
  bobCarol: string;
  /** The message Alice may NOT see, in the group she joined late. */
  preJoinMessageId: string;
  postJoinMessageId: string;
  hiddenMessageId: string;
  deletedMessageId: string;
  editedMessageId: string;
}

let world: World;

/**
 * A direct conversation whose members joined at a chosen time.
 *
 * The harness's own `seedDirectConversation` lets `joinedAt` default to now, which is right for
 * tests that send messages as they run and wrong for one that dates its history months back.
 */
async function seedDirectAt(userIdA: string, userIdB: string, joinedAt: Date): Promise<string> {
  const conversation = await db().conversation.create({
    data: {
      type: 'DIRECT',
      directKey: directKeyFor(userIdA, userIdB),
      createdById: userIdA,
      members: { create: [{ userId: userIdA, joinedAt }, { userId: userIdB, joinedAt }] },
    },
    select: { id: true },
  });

  return trackConversation(conversation.id);
}

/** Creates a group with a chosen name and chosen join times. */
async function seedNamedGroup(
  name: string,
  members: { userId: string; joinedAt?: Date; leftAt?: Date; owner?: boolean }[],
): Promise<string> {
  const conversation = await db().conversation.create({
    data: {
      type: 'GROUP',
      name,
      createdById: members[0]?.userId ?? null,
      members: {
        create: members.map((member) => ({
          userId: member.userId,
          role: member.owner ? ('OWNER' as const) : ('MEMBER' as const),
          ...(member.joinedAt ? { joinedAt: member.joinedAt } : {}),
          ...(member.leftAt ? { leftAt: member.leftAt } : {}),
        })),
      },
    },
    select: { id: true },
  });

  return trackConversation(conversation.id);
}

/** Attaches a READY file to an existing message. */
async function seedAttachment(
  conversationId: string,
  messageId: string,
  uploaderId: string,
  filename: string,
  createdAt: Date,
  status: 'READY' | 'DELETED' = 'READY',
): Promise<string> {
  const row = await db().attachment.create({
    data: {
      conversationId,
      messageId,
      uploaderId,
      originalFilename: filename,
      storageKey: `2026/09/${uuid()}.bin`,
      byteSize: BigInt(1024),
      mimeType: 'application/pdf',
      extension: 'pdf',
      status,
      createdAt,
    },
    select: { id: true },
  });

  return row.id;
}

async function search(userId: string, query: string) {
  return searchEverything(db(), userId, query);
}

suite('global search authorization', () => {
  beforeAll(async () => {
    const alice = await createTestIdentity(`${TAG}-Alice`);
    const bob = await createTestIdentity(`${TAG}-Bob`);
    const carol = await createTestIdentity(`${TAG}-Carol`);
    const mallory = await createTestIdentity(`${TAG}-Mallory`);

    const direct = await seedDirectAt(alice.userId, bob.userId, EPOCH);
    const bobCarol = await seedDirectAt(bob.userId, carol.userId, EPOCH);

    const reports = await seedNamedGroup(`${TAG} Monthly Reports`, [
      { userId: bob.userId, owner: true, joinedAt: EPOCH },
      { userId: carol.userId, joinedAt: EPOCH },
      // Alice joined in June; January is not hers to read.
      { userId: alice.userId, joinedAt: JOIN },
    ]);

    const secret = await seedNamedGroup(`${TAG} Secret Committee`, [
      { userId: bob.userId, owner: true, joinedAt: EPOCH },
      { userId: carol.userId, joinedAt: EPOCH },
    ]);

    const oldTeam = await seedNamedGroup(`${TAG} Old Team`, [
      { userId: bob.userId, owner: true, joinedAt: EPOCH },
      // Alice was here and left: the row remains, the access does not.
      { userId: alice.userId, joinedAt: EPOCH, leftAt: AFTER },
    ]);

    /* ---- the direct chat Alice can see ---------------------------------------------------- */

    const visible = await seedMessageAt(direct, bob.userId, `${TAG} quarterly numbers`, AFTER);
    await seedAttachment(direct, visible.id, bob.userId, `${TAG}-budget.pdf`, AFTER);

    const hidden = await seedMessageAt(direct, bob.userId, `${TAG} hidden note`, AFTER);
    await hideMessageForUser(db(), { messageId: hidden.id, userId: alice.userId });

    const deleted = await seedMessageAt(direct, bob.userId, `${TAG} regrettable`, AFTER);
    await seedAttachment(direct, deleted.id, bob.userId, `${TAG}-regrettable.pdf`, AFTER);
    await deleteMessageForEveryone(db(), { messageId: deleted.id, userId: bob.userId });

    const edited = await seedMessageAt(direct, alice.userId, `${TAG} original wording`, AFTER);
    await editMessage(db(), {
      messageId: edited.id,
      userId: alice.userId,
      body: `${TAG} corrected wording`,
    });

    // A system message, which search excludes deliberately.
    await seedMessageAt(direct, null, `${TAG} joined the conversation`, AFTER);

    /* ---- the group Alice joined late ------------------------------------------------------ */

    const preJoin = await seedMessageAt(reports, bob.userId, `${TAG} january secret`, BEFORE);
    await seedAttachment(reports, preJoin.id, bob.userId, `${TAG}-january.pdf`, BEFORE);

    const postJoin = await seedMessageAt(reports, bob.userId, `${TAG} august update`, AFTER);
    await seedAttachment(reports, postJoin.id, bob.userId, `${TAG}-august.pdf`, AFTER);

    /* ---- what Alice must never reach ------------------------------------------------------ */

    const secretMessage = await seedMessageAt(secret, bob.userId, `${TAG} committee minutes`, AFTER);
    await seedAttachment(secret, secretMessage.id, bob.userId, `${TAG}-minutes.pdf`, AFTER);

    const oldMessage = await seedMessageAt(oldTeam, bob.userId, `${TAG} after she left`, AFTER);
    await seedAttachment(oldTeam, oldMessage.id, bob.userId, `${TAG}-afterleft.pdf`, AFTER);

    await seedMessageAt(bobCarol, bob.userId, `${TAG} private to carol`, AFTER);

    world = {
      alice: alice.userId,
      bob: bob.userId,
      carol: carol.userId,
      mallory: mallory.userId,
      direct,
      reports,
      secret,
      oldTeam,
      bobCarol,
      preJoinMessageId: preJoin.id,
      postJoinMessageId: postJoin.id,
      hiddenMessageId: hidden.id,
      deletedMessageId: deleted.id,
      editedMessageId: edited.id,
    };
  });

  afterAll(async () => {
    await cleanUp();
    await disconnect();
  });

  /* ------------------------------------------------------------------------------------------ */
  /* 9, 10, 16 — conversation authorization                                                       */
  /* ------------------------------------------------------------------------------------------ */

  describe('a conversation the searcher is not in is invisible', () => {
    it('does NOT return a message from a group Alice is not a member of', async () => {
      const results = await search(world.alice, `${TAG} committee minutes`);
      expect(results.messages).toEqual([]);
    });

    it('does not return that group itself, even by exact name', async () => {
      const results = await search(world.alice, `${TAG} Secret Committee`);
      expect(results.groups).toEqual([]);
    });

    it('does not return a direct conversation between two other people', async () => {
      const results = await search(world.alice, `${TAG} private to carol`);
      expect(results.messages).toEqual([]);
    });

    it('but Bob, who IS in it, finds the same message', async () => {
      // The control. Without this the test above could pass because the row does not exist.
      const results = await search(world.bob, `${TAG} committee minutes`);
      expect(results.messages.map((m) => m.conversationId)).toContain(world.secret);
    });

    it('someone who shares nothing finds nothing at all', async () => {
      const results = await search(world.mallory, TAG);
      expect(results.messages).toEqual([]);
      expect(results.files).toEqual([]);
      expect(results.groups).toEqual([]);
    });
  });

  /* ------------------------------------------------------------------------------------------ */
  /* 11 — the joinedAt boundary (D-03)                                                            */
  /* ------------------------------------------------------------------------------------------ */

  describe('D-03: history from before you joined stays unreadable', () => {
    it('does NOT return a message sent before Alice joined the group', async () => {
      const results = await search(world.alice, `${TAG} january secret`);
      expect(results.messages).toEqual([]);
    });

    it('DOES return a message sent after she joined', async () => {
      const results = await search(world.alice, `${TAG} august update`);
      expect(results.messages.map((m) => m.id)).toEqual([world.postJoinMessageId]);
    });

    it('applies the boundary PER CONVERSATION, not one boundary for all of them', async () => {
      /*
       * The bug this exists to catch: taking the earliest joinedAt across every membership and
       * applying it everywhere. Alice joined her direct chat long before she joined the group, so
       * a single global boundary would let January's group message through.
       */
      const results = await search(world.alice, TAG);
      const ids = results.messages.map((m) => m.id);

      expect(ids).not.toContain(world.preJoinMessageId);
      expect(ids).toContain(world.postJoinMessageId);
    });

    it('Bob, who was there in January, still sees it', async () => {
      const results = await search(world.bob, `${TAG} january secret`);
      expect(results.messages.map((m) => m.id)).toEqual([world.preJoinMessageId]);
    });

    it('hides a FILE from before the boundary as firmly as the message', async () => {
      /*
       * The schema warns about exactly this: stopping at `conversationId` would let a newly added
       * member pull every file ever shared by asking for the file instead of the message.
       */
      const results = await search(world.alice, `${TAG}-january`);
      expect(results.files).toEqual([]);

      const forBob = await search(world.bob, `${TAG}-january`);
      expect(forBob.files).toHaveLength(1);
    });

    it('returns a file from after the boundary', async () => {
      const results = await search(world.alice, `${TAG}-august`);
      expect(results.files.map((f) => f.messageId)).toEqual([world.postJoinMessageId]);
    });
  });

  /* ------------------------------------------------------------------------------------------ */
  /* 12 — leftAt                                                                                  */
  /* ------------------------------------------------------------------------------------------ */

  describe('leaving a group ends access to it', () => {
    it('does not return messages from a group Alice left', async () => {
      const results = await search(world.alice, `${TAG} after she left`);
      expect(results.messages).toEqual([]);
    });

    it('does not return the group itself once she has left', async () => {
      const results = await search(world.alice, `${TAG} Old Team`);
      expect(results.groups).toEqual([]);
    });

    it('does not return its files either', async () => {
      const results = await search(world.alice, `${TAG}-afterleft`);
      expect(results.files).toEqual([]);
    });

    it('the membership row still exists — so this is `leftAt`, not a deletion', async () => {
      // Proves the test above is testing the rule rather than an absent row.
      const row = await db().conversationMember.findUnique({
        where: { conversationId_userId: { conversationId: world.oldTeam, userId: world.alice } },
        select: { leftAt: true },
      });

      expect(row).not.toBeNull();
      expect(row?.leftAt).not.toBeNull();
    });
  });

  /* ------------------------------------------------------------------------------------------ */
  /* 13, 14, 15 — hidden, deleted, edited                                                         */
  /* ------------------------------------------------------------------------------------------ */

  describe('hidden and deleted content', () => {
    it('does not return a message Alice deleted for herself', async () => {
      const results = await search(world.alice, `${TAG} hidden note`);
      expect(results.messages).toEqual([]);
    });

    it('but Bob, who did not hide it, still finds it', async () => {
      const results = await search(world.bob, `${TAG} hidden note`);
      expect(results.messages.map((m) => m.id)).toEqual([world.hiddenMessageId]);
    });

    it('never returns the text of a delete-for-everyone message, for ANYONE', async () => {
      for (const [who, id] of [
        ['alice', world.alice],
        ['bob', world.bob],
      ] as const) {
        const results = await search(id, `${TAG} regrettable`);
        expect(results.messages, who).toEqual([]);
      }
    });

    it('never returns the FILENAME of a deleted attachment', async () => {
      // The body is cleared by the tombstone, but a file is found by name — so it needs its own rule.
      const results = await search(world.alice, `${TAG}-regrettable`);
      expect(results.files).toEqual([]);
    });

    it('searches the CURRENT text of an edited message', async () => {
      const results = await search(world.alice, `${TAG} corrected wording`);
      expect(results.messages.map((m) => m.id)).toEqual([world.editedMessageId]);
    });

    it('does not return the text an edited message used to have', async () => {
      const results = await search(world.alice, `${TAG} original wording`);
      expect(results.messages).toEqual([]);
    });

    it('excludes system messages', async () => {
      const results = await search(world.alice, `${TAG} joined the conversation`);
      expect(results.messages).toEqual([]);
    });
  });

  /* ------------------------------------------------------------------------------------------ */
  /* 4, 5, 6, 7, 8 — the categories themselves                                                    */
  /* ------------------------------------------------------------------------------------------ */

  describe('what search finds', () => {
    it('finds PEOPLE by display name', async () => {
      const results = await search(world.alice, `${TAG}-Bob`);
      expect(results.people.map((p) => p.id)).toContain(world.bob);
    });

    it('never returns the searcher themselves', async () => {
      const results = await search(world.alice, `${TAG}-Alice`);
      expect(results.people.map((p) => p.id)).not.toContain(world.alice);
    });

    it('finds people the searcher shares no conversation with', async () => {
      // The directory is company-wide by design: you must be able to start a first chat.
      const results = await search(world.alice, `${TAG}-Mallory`);
      expect(results.people.map((p) => p.id)).toContain(world.mallory);
    });

    it('finds GROUPS the searcher belongs to, by name', async () => {
      const results = await search(world.alice, `${TAG} Monthly Reports`);
      expect(results.groups.map((g) => g.conversationId)).toEqual([world.reports]);
    });

    it('finds MESSAGES by body text', async () => {
      const results = await search(world.alice, `${TAG} quarterly numbers`);
      expect(results.messages).toHaveLength(1);
      expect(results.messages[0]?.conversationId).toBe(world.direct);
    });

    it('finds FILES by filename', async () => {
      const results = await search(world.alice, `${TAG}-budget`);
      expect(results.files.map((f) => f.filename)).toEqual([`${TAG}-budget.pdf`]);
    });

    it('matches case-insensitively', async () => {
      const lower = await search(world.alice, `${TAG} quarterly`);
      const upper = await search(world.alice, `${TAG.toUpperCase()} QUARTERLY`);
      const mixed = await search(world.alice, `${TAG} QuArTeRlY`);

      expect(upper.messages.map((m) => m.id)).toEqual(lower.messages.map((m) => m.id));
      expect(mixed.messages.map((m) => m.id)).toEqual(lower.messages.map((m) => m.id));
      expect(lower.messages).not.toHaveLength(0);
    });

    it('matches a substring in the middle of a word', async () => {
      const results = await search(world.alice, 'uarterl');
      expect(results.messages.map((m) => m.id)).toContain(
        (await search(world.alice, `${TAG} quarterly numbers`)).messages[0]?.id,
      );
    });

    it('carries enough to navigate, and nothing more', async () => {
      const results = await search(world.alice, `${TAG}-budget`);
      const file = results.files[0];

      expect(file).toMatchObject({
        conversationId: world.direct,
        filename: `${TAG}-budget.pdf`,
      });
      expect(file?.messageId).toBeTruthy();

      // No storage key, no path, no byte size, no MIME type.
      const serialised = JSON.stringify(results);
      expect(serialised).not.toContain('storageKey');
      expect(serialised).not.toContain('.bin');
      expect(serialised).not.toContain('application/pdf');
    });

    it('names the sender and the group for a message result', async () => {
      const results = await search(world.alice, `${TAG} august update`);
      expect(results.messages[0]).toMatchObject({
        conversationType: 'GROUP',
        conversationName: `${TAG} Monthly Reports`,
        senderId: world.bob,
      });
      expect(results.messages[0]?.senderName).toContain('Bob');
    });
  });

  /* ------------------------------------------------------------------------------------------ */
  /* 18, 19 — bounds                                                                              */
  /* ------------------------------------------------------------------------------------------ */

  describe('nothing is unbounded', () => {
    it('caps each category at the limit', async () => {
      // Comfortably more rows than the limit, all matching one term.
      const bulk = `${TAG}bulk`;
      for (let index = 0; index < SEARCH_CATEGORY_LIMIT + 5; index += 1) {
        await seedMessageAt(world.direct, world.bob, `${bulk} ${index}`, AFTER);
      }

      const results = await search(world.alice, bulk);
      expect(results.messages).toHaveLength(SEARCH_CATEGORY_LIMIT);
    });

    it('the limit is a small, stated number', () => {
      expect(SEARCH_CATEGORY_LIMIT).toBeGreaterThanOrEqual(10);
      expect(SEARCH_CATEGORY_LIMIT).toBeLessThanOrEqual(20);
    });

    it('returns newest messages first', async () => {
      const results = await search(world.alice, `${TAG}bulk`);
      const times = results.messages.map((m) => m.createdAt.getTime());
      expect(times).toEqual([...times].sort((a, b) => b - a));
    });
  });

  /* ------------------------------------------------------------------------------------------ */
  /* 1 — query validation                                                                         */
  /* ------------------------------------------------------------------------------------------ */

  describe('query validation', () => {
    it('refuses to run a query below the minimum, without touching the database', async () => {
      for (const term of ['', ' ', 'r', '  x  ']) {
        expect(normalizeSearchQuery(term), term).toBeNull();
        await expect(search(world.alice, term)).resolves.toEqual(emptySearchResults());
      }
    });

    it('accepts exactly the minimum length', () => {
      expect(normalizeSearchQuery('re')).toBe('re');
      expect(SEARCH_MIN_QUERY_LENGTH).toBe(2);
    });

    it('trims before measuring', () => {
      expect(normalizeSearchQuery('  report  ')).toBe('report');
    });

    it('refuses a non-string', () => {
      expect(normalizeSearchQuery(null)).toBeNull();
      expect(normalizeSearchQuery(undefined)).toBeNull();
    });

    it('states a maximum length', () => {
      expect(SEARCH_MAX_QUERY_LENGTH).toBe(64);
    });

    it('treats SQL text as literal characters, not as SQL', async () => {
      /*
       * Prisma binds the term as a parameter, so none of this is interpreted. The assertion that
       * matters is the one after the loop: the table is still there.
       */
      for (const term of ["'; DROP TABLE \"Message\"; --", "' OR 1=1 --", '\x27']) {
        const results = await search(world.alice, term);
        expect(results.messages, term).toEqual([]);
        expect(results.files, term).toEqual([]);
      }

      expect(await db().message.count({ where: { conversationId: world.direct } })).toBeGreaterThan(
        0,
      );
    });

    it('treats LIKE wildcards as ordinary characters', async () => {
      /*
       * The bug this catches: Prisma's `contains` drops the term INSIDE an ILIKE pattern, where
       * `%` and `_` keep their wildcard meaning. Unescaped, `%` matches every message the caller
       * can see — not a disclosure, but a way to enumerate a whole corpus one page at a time.
       *
       * Alice has plenty of visible messages, so a wildcard that still worked would return some.
       */
      expect((await search(world.alice, `${TAG} quarterly`)).messages).not.toHaveLength(0);

      for (const term of ['%%', '%%%%', '____', '%a%']) {
        const results = await search(world.alice, term);
        expect(results.messages, term).toEqual([]);
        expect(results.files, term).toEqual([]);
      }
    });

    it('finds a literal percent sign when one was actually sent', async () => {
      await seedMessageAt(world.direct, world.bob, `${TAG} 50% discount`, AFTER);

      const results = await search(world.alice, '50% discount');
      expect(results.messages.map((m) => m.body)).toEqual([`${TAG} 50% discount`]);
    });

    it('escapeLikePattern escapes the backslash first', () => {
      /*
       * `String.raw` throughout, because the thing being asserted IS the backslashes and ordinary
       * string literals would hide one level of them.
       *
       * Backslash must be escaped before `%` and `_`, or it would go on to escape the escapes
       * added after it: "50%" would become "50\\%" — a literal backslash followed by a wildcard —
       * which is the opposite of what is wanted.
       */
      expect(escapeLikePattern('100%')).toBe(String.raw`100\%`);
      expect(escapeLikePattern('a_b')).toBe(String.raw`a\_b`);
      expect(escapeLikePattern(String.raw`c:\temp`)).toBe(String.raw`c:\\temp`);
      expect(escapeLikePattern(String.raw`\%`)).toBe(String.raw`\\\%`);
      expect(escapeLikePattern('plain')).toBe('plain');
    });
  });
});
