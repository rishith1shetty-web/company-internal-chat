/**
 * Mention authorization, storage and recipients (Batch 1.7).
 *
 * THE FILE THAT MATTERS FOR THIS BATCH. Mentions are metadata a browser proposes about who should
 * be told something, so every interesting failure is a forged payload rather than a broken
 * button: claiming somebody outside the group, somebody who left, an invented id, a span that
 * does not match the text, or an `@everyone` in a conversation where it has no meaning.
 *
 * Everything runs against the real database through the real services. Nothing is mocked — a test
 * that stubbed the membership check it is meant to be proving would prove nothing.
 *
 * The seeded world:
 *
 *   ALICE   — the sender, owner of the group
 *   BOB     — an active member
 *   CAROL   — an active member, renamed later in one test
 *   DAN     — WAS a member and LEFT
 *   MALLORY — never in the group at all
 *
 *   group "zzmention Team"  — Alice, Bob, Carol active; Dan departed
 *   direct(Alice, Bob)      — where mentions must not exist at all
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  deleteMessageForEveryone,
  editMessage,
  forwardMessage,
  hideMessageForUser,
} from '@/lib/messages/actions';
import {
  MAX_MENTIONS_PER_MESSAGE,
  MentionError,
  resolveMentionRecipients,
  validateMentions,
  type MentionInput,
} from '@/lib/messages/mentions';
import { sendMessage } from '@/lib/messages/service';

import {
  cleanUp,
  createTestIdentity,
  databaseConfigured,
  db,
  disconnect,
  seedDirectConversation,
  trackConversation,
  uuid,
} from './harness';

const suite = databaseConfigured ? describe : describe.skip;

const TAG = 'zzmention';

/**
 * Forwarding copies bytes, so it needs somewhere to put them — even for a text message, which
 * writes none. A throwaway directory keeps this test off the real upload store entirely.
 */
const storage = {
  uploadDir: mkdtempSync(join(tmpdir(), 'zz-test-mentions-')),
  maxFileSize: 1024 * 1024,
};

interface World {
  alice: string;
  bob: string;
  carol: string;
  dan: string;
  mallory: string;
  group: string;
  direct: string;
  bobName: string;
  carolName: string;
  danName: string;
}

let world: World;

/** Sends as Alice into the group, with whatever mentions are given. */
async function send(body: string, mentions: MentionInput[] = [], conversationId?: string) {
  return sendMessage(db(), {
    senderId: world.alice,
    conversationId: conversationId ?? world.group,
    body,
    clientMessageId: uuid(),
    mentions,
  });
}

/** The span of `needle` inside `body`, as the composer would have resolved it. */
function spanOf(body: string, needle: string): { startOffset: number; endOffset: number } {
  const at = body.indexOf(needle);
  if (at === -1) throw new Error(`"${needle}" is not in "${body}"`);
  return { startOffset: at, endOffset: at + needle.length };
}

async function storedMentions(messageId: string) {
  return db().messageMention.findMany({
    where: { messageId },
    select: { kind: true, mentionedUserId: true, startOffset: true, endOffset: true },
    orderBy: { startOffset: 'asc' },
  });
}

suite('group mentions', () => {
  beforeAll(async () => {
    const alice = await createTestIdentity(`${TAG}-Alice`);
    const bob = await createTestIdentity(`${TAG}-Bob`);
    const carol = await createTestIdentity(`${TAG}-Carol`);
    const dan = await createTestIdentity(`${TAG}-Dan`);
    const mallory = await createTestIdentity(`${TAG}-Mallory`);

    const group = await db().conversation.create({
      data: {
        type: 'GROUP',
        name: `${TAG} Team`,
        createdById: alice.userId,
        members: {
          create: [
            { userId: alice.userId, role: 'OWNER' },
            { userId: bob.userId },
            { userId: carol.userId },
            // Departed: the row is kept, the access is not.
            { userId: dan.userId, leftAt: new Date() },
          ],
        },
      },
      select: { id: true },
    });
    trackConversation(group.id);

    const direct = await seedDirectConversation(alice.userId, bob.userId);

    const names = await db().user.findMany({
      where: { id: { in: [bob.userId, carol.userId, dan.userId] } },
      select: { id: true, displayName: true },
    });
    const nameOf = (id: string) => names.find((n) => n.id === id)?.displayName ?? '';

    world = {
      alice: alice.userId,
      bob: bob.userId,
      carol: carol.userId,
      dan: dan.userId,
      mallory: mallory.userId,
      group: group.id,
      direct,
      bobName: nameOf(bob.userId),
      carolName: nameOf(carol.userId),
      danName: nameOf(dan.userId),
    };
  });

  afterAll(async () => {
    await cleanUp();
    await disconnect();
  });

  /* ------------------------------------------------------------------------------------------ */
  /* 1, 19 — a USER mention is stored against a stable identity                                   */
  /* ------------------------------------------------------------------------------------------ */

  describe('storing a mention', () => {
    it('stores the user id, the kind and the span', async () => {
      const body = `Hi @${world.bobName} can you review this?`;
      const result = await send(body, [
        { kind: 'USER', userId: world.bob, ...spanOf(body, `@${world.bobName}`) },
      ]);

      expect(await storedMentions(result.message.id)).toEqual([
        {
          kind: 'USER',
          mentionedUserId: world.bob,
          ...spanOf(body, `@${world.bobName}`),
        },
      ]);
    });

    it('works for a display name containing SPACES', async () => {
      // The whole name is one mention; nothing splits it at the first space.
      const spaced = await createTestIdentity(`${TAG}-Sumit Vishwakarma Extra`);
      await db().conversationMember.create({
        data: { conversationId: world.group, userId: spaced.userId },
      });
      const name = (
        await db().user.findUniqueOrThrow({
          where: { id: spaced.userId },
          select: { displayName: true },
        })
      ).displayName;

      expect(name).toContain(' ');

      const body = `please cc @${name} on this`;
      const result = await send(body, [
        { kind: 'USER', userId: spaced.userId, ...spanOf(body, `@${name}`) },
      ]);

      const rows = await storedMentions(result.message.id);
      expect(rows).toHaveLength(1);
      expect(body.slice(rows[0]!.startOffset, rows[0]!.endOffset)).toBe(`@${name}`);
    });

    it('carries the mentions back on the sent message', async () => {
      const body = `@${world.bobName} hello`;
      const result = await send(body, [
        { kind: 'USER', userId: world.bob, ...spanOf(body, `@${world.bobName}`) },
      ]);

      // Same read, same payload: there is no second query and no second event for mentions.
      expect(result.message.mentions).toHaveLength(1);
      expect(result.message.mentions[0]?.mentionedUserId).toBe(world.bob);
    });

    it('a message with no mentions stores none, exactly as before this batch', async () => {
      const result = await send('just an ordinary message');
      expect(await storedMentions(result.message.id)).toEqual([]);
      expect(result.message.mentions).toEqual([]);
    });

    it('stores TWO rows when the same person is mentioned twice', async () => {
      // Both occurrences are highlighted where they were written; recipients are deduped later.
      const body = `@${world.bobName} please ask @${world.bobName}`;
      const first = spanOf(body, `@${world.bobName}`);
      const secondAt = body.lastIndexOf(`@${world.bobName}`);

      const result = await send(body, [
        { kind: 'USER', userId: world.bob, ...first },
        {
          kind: 'USER',
          userId: world.bob,
          startOffset: secondAt,
          endOffset: secondAt + world.bobName.length + 1,
        },
      ]);

      expect(await storedMentions(result.message.id)).toHaveLength(2);
    });
  });

  /* ------------------------------------------------------------------------------------------ */
  /* 2, 10 — @everyone                                                                            */
  /* ------------------------------------------------------------------------------------------ */

  describe('@everyone', () => {
    it('stores one row with no user id', async () => {
      const body = '@everyone meeting starts in 10 minutes';
      const result = await send(body, [{ kind: 'EVERYONE', ...spanOf(body, '@everyone') }]);

      expect(await storedMentions(result.message.id)).toEqual([
        { kind: 'EVERYONE', mentionedUserId: null, startOffset: 0, endOffset: 9 },
      ]);
    });

    it('works in the middle of a sentence', async () => {
      const body = 'quick reminder for @everyone about Friday';
      const result = await send(body, [{ kind: 'EVERYONE', ...spanOf(body, '@everyone') }]);
      expect(await storedMentions(result.message.id)).toHaveLength(1);
    });

    it('resolves to the ACTIVE members, excluding the sender and the departed one', async () => {
      const recipients = await resolveMentionRecipients(db(), {
        conversationId: world.group,
        senderId: world.alice,
        mentions: [{ kind: 'EVERYONE', mentionedUserId: null }],
      });

      expect(recipients).toContain(world.bob);
      expect(recipients).toContain(world.carol);
      expect(recipients).not.toContain(world.dan);
      expect(recipients).not.toContain(world.alice);
      expect(recipients).not.toContain(world.mallory);
    });

    it('a forged EVERYONE row carrying a user id is refused', async () => {
      const body = '@everyone hello';
      await expect(
        send(body, [
          { kind: 'EVERYONE', userId: world.mallory, ...spanOf(body, '@everyone') },
        ]),
      ).rejects.toBeInstanceOf(MentionError);
    });

    it('a forged EVERYONE row cannot target anyone by pointing at other text', async () => {
      // The span must literally read "@everyone"; nothing else can be labelled as one.
      const body = 'hello @everybody';
      await expect(
        send(body, [{ kind: 'EVERYONE', ...spanOf(body, '@everybody') }]),
      ).rejects.toBeInstanceOf(MentionError);
    });
  });

  /* ------------------------------------------------------------------------------------------ */
  /* 3, 4, 5, 6, 23 — authorization                                                               */
  /* ------------------------------------------------------------------------------------------ */

  describe('who may be mentioned', () => {
    it('REFUSES somebody who is not in the group', async () => {
      const body = `hello @${TAG}-Mallory`;
      await expect(
        send(body, [{ kind: 'USER', userId: world.mallory, ...spanOf(body, `@${TAG}-Mallory`) }]),
      ).rejects.toMatchObject({ code: 'NOT_A_MEMBER' });
    });

    it('REFUSES somebody who has left the group', async () => {
      const body = `hello @${world.danName}`;
      await expect(
        send(body, [{ kind: 'USER', userId: world.dan, ...spanOf(body, `@${world.danName}`) }]),
      ).rejects.toMatchObject({ code: 'NOT_A_MEMBER' });
    });

    it('the departed member still HAS a membership row — so this is leftAt, not absence', async () => {
      const row = await db().conversationMember.findUnique({
        where: { conversationId_userId: { conversationId: world.group, userId: world.dan } },
        select: { leftAt: true },
      });
      expect(row).not.toBeNull();
      expect(row?.leftAt).not.toBeNull();
    });

    it('REFUSES an invented user id', async () => {
      const body = '@Nobody hello';
      await expect(
        send(body, [{ kind: 'USER', userId: uuid(), ...spanOf(body, '@Nobody') }]),
      ).rejects.toMatchObject({ code: 'NOT_A_MEMBER' });
    });

    it('REFUSES mentions in a DIRECT conversation', async () => {
      const body = `@${world.bobName} hello`;
      await expect(
        send(
          body,
          [{ kind: 'USER', userId: world.bob, ...spanOf(body, `@${world.bobName}`) }],
          world.direct,
        ),
      ).rejects.toMatchObject({ code: 'NOT_A_GROUP' });
    });

    it('an ordinary direct message still sends perfectly well', async () => {
      // The refusal above is about mention METADATA, not about the "@" character.
      const result = await sendMessage(db(), {
        senderId: world.alice,
        conversationId: world.direct,
        body: 'email me at someone@example.com',
        clientMessageId: uuid(),
      });
      expect(result.message.body).toContain('@example.com');
      expect(result.message.mentions).toEqual([]);
    });

    it('refuses the whole message rather than storing part of it', async () => {
      const body = `@${world.bobName} and @${TAG}-Mallory`;
      const before = await db().message.count({ where: { conversationId: world.group } });

      await expect(
        send(body, [
          { kind: 'USER', userId: world.bob, ...spanOf(body, `@${world.bobName}`) },
          { kind: 'USER', userId: world.mallory, ...spanOf(body, `@${TAG}-Mallory`) },
        ]),
      ).rejects.toBeInstanceOf(MentionError);

      // Validation happens before the transaction: nothing was written at all.
      expect(await db().message.count({ where: { conversationId: world.group } })).toBe(before);
    });
  });

  /* ------------------------------------------------------------------------------------------ */
  /* 21, 22, 24 — malformed metadata                                                              */
  /* ------------------------------------------------------------------------------------------ */

  describe('malformed metadata is refused', () => {
    it('refuses a span that does not match the text', async () => {
      const body = `@${world.bobName} hello`;
      // Claims Bob, but points at "hello".
      await expect(
        send(body, [{ kind: 'USER', userId: world.bob, ...spanOf(body, 'hello') }]),
      ).rejects.toMatchObject({ code: 'TEXT_MISMATCH' });
    });

    it('refuses a span naming the WRONG person', async () => {
      /*
       * The spoofing case: text that reads "@Bob" while the metadata notifies Carol. The name,
       * the id and the span all have to agree at send time.
       */
      const body = `@${world.bobName} hello`;
      await expect(
        send(body, [{ kind: 'USER', userId: world.carol, ...spanOf(body, `@${world.bobName}`) }]),
      ).rejects.toMatchObject({ code: 'TEXT_MISMATCH' });
    });

    it('refuses ranges outside the body', async () => {
      const body = 'short';
      for (const mention of [
        { kind: 'USER' as const, userId: world.bob, startOffset: 0, endOffset: 500 },
        { kind: 'USER' as const, userId: world.bob, startOffset: -1, endOffset: 3 },
        { kind: 'USER' as const, userId: world.bob, startOffset: 3, endOffset: 3 },
        { kind: 'USER' as const, userId: world.bob, startOffset: 4, endOffset: 2 },
        { kind: 'USER' as const, userId: world.bob, startOffset: 0.5, endOffset: 3 },
      ]) {
        await expect(send(body, [mention])).rejects.toBeInstanceOf(MentionError);
      }
    });

    it('refuses OVERLAPPING ranges', async () => {
      const body = `@${world.bobName} @${world.carolName}`;
      await expect(
        send(body, [
          { kind: 'USER', userId: world.bob, startOffset: 0, endOffset: 8 },
          { kind: 'USER', userId: world.carol, startOffset: 4, endOffset: 12 },
        ]),
      ).rejects.toMatchObject({ code: 'OVERLAPPING_RANGES' });
    });

    it('refuses duplicate metadata for the same span', async () => {
      const body = `@${world.bobName} hello`;
      const span = spanOf(body, `@${world.bobName}`);
      await expect(
        send(body, [
          { kind: 'USER', userId: world.bob, ...span },
          { kind: 'USER', userId: world.bob, ...span },
        ]),
      ).rejects.toMatchObject({ code: 'DUPLICATE_MENTION' });
    });

    it('refuses an absurd number of mentions', async () => {
      const body = `@${world.bobName} `.repeat(MAX_MENTIONS_PER_MESSAGE + 5).trim();
      const mentions: MentionInput[] = [];
      const step = world.bobName.length + 2;
      for (let index = 0; index < MAX_MENTIONS_PER_MESSAGE + 5; index += 1) {
        mentions.push({
          kind: 'USER',
          userId: world.bob,
          startOffset: index * step,
          endOffset: index * step + world.bobName.length + 1,
        });
      }

      await expect(send(body, mentions)).rejects.toMatchObject({ code: 'TOO_MANY_MENTIONS' });
    });

    it('text containing "@" is NOT a mention on its own', async () => {
      const result = await send('write to me at alice@example.com or @ the desk');
      expect(await storedMentions(result.message.id)).toEqual([]);
    });

    it('validateMentions makes no database call when the list is empty', async () => {
      // Proven by handing it a client object with no `conversationMember` at all.
      const nothing = {} as never;
      await expect(
        validateMentions(nothing, {
          conversationId: world.group,
          conversationType: 'GROUP',
          body: 'hello',
          mentions: [],
        }),
      ).resolves.toEqual([]);
    });
  });

  /* ------------------------------------------------------------------------------------------ */
  /* 7, 8, 9 — who gets notified                                                                  */
  /* ------------------------------------------------------------------------------------------ */

  describe('notification recipients', () => {
    it('names a repeated mention ONCE', async () => {
      const recipients = await resolveMentionRecipients(db(), {
        conversationId: world.group,
        senderId: world.alice,
        mentions: [
          { kind: 'USER', mentionedUserId: world.bob },
          { kind: 'USER', mentionedUserId: world.bob },
        ],
      });

      expect(recipients).toEqual([world.bob]);
    });

    it('does not double-count somebody covered by BOTH @everyone and @name', async () => {
      const recipients = await resolveMentionRecipients(db(), {
        conversationId: world.group,
        senderId: world.alice,
        mentions: [
          { kind: 'EVERYONE', mentionedUserId: null },
          { kind: 'USER', mentionedUserId: world.bob },
        ],
      });

      expect(recipients.filter((id) => id === world.bob)).toHaveLength(1);
      expect(new Set(recipients).size).toBe(recipients.length);
    });

    it('NEVER includes the sender, even from a forged self-mention', async () => {
      const recipients = await resolveMentionRecipients(db(), {
        conversationId: world.group,
        senderId: world.alice,
        mentions: [{ kind: 'USER', mentionedUserId: world.alice }],
      });

      expect(recipients).toEqual([]);
    });

    it('is empty when a message mentions nobody', async () => {
      await expect(
        resolveMentionRecipients(db(), {
          conversationId: world.group,
          senderId: world.alice,
          mentions: [],
        }),
      ).resolves.toEqual([]);
    });
  });

  /* ------------------------------------------------------------------------------------------ */
  /* 14, 15, 16 — editing                                                                         */
  /* ------------------------------------------------------------------------------------------ */

  describe('editing', () => {
    it('REMOVES the mention when the edited text no longer contains it', async () => {
      const body = `@${world.bobName} please review this`;
      const sent = await send(body, [
        { kind: 'USER', userId: world.bob, ...spanOf(body, `@${world.bobName}`) },
      ]);
      expect(await storedMentions(sent.message.id)).toHaveLength(1);

      await editMessage(db(), {
        userId: world.alice,
        messageId: sent.message.id,
        body: 'please review this',
        mentions: [],
      });

      expect(await storedMentions(sent.message.id)).toEqual([]);
    });

    it('ADDS a mention when the edited text gains one', async () => {
      const sent = await send('please review this');
      expect(await storedMentions(sent.message.id)).toEqual([]);

      const edited = `@${world.carolName} please review this`;
      await editMessage(db(), {
        userId: world.alice,
        messageId: sent.message.id,
        body: edited,
        mentions: [
          { kind: 'USER', userId: world.carol, ...spanOf(edited, `@${world.carolName}`) },
        ],
      });

      expect(await storedMentions(sent.message.id)).toEqual([
        { kind: 'USER', mentionedUserId: world.carol, startOffset: 0, endOffset: world.carolName.length + 1 },
      ]);
    });

    it('an edit does NOT move the conversation or look like a new message', async () => {
      /*
       * The rule that keeps an edit from behaving like a send: `lastMessageAt` is the column the
       * sidebar orders by and the unread model hangs off. Editing must not touch it, mention or
       * no mention — which is why editing writes `body` and `editedAt` and nothing else.
       */
      const before = await db().conversation.findUniqueOrThrow({
        where: { id: world.group },
        select: { lastMessageAt: true },
      });

      const sent = await send('a message to edit later');
      const after = await db().conversation.findUniqueOrThrow({
        where: { id: world.group },
        select: { lastMessageAt: true },
      });
      expect(after.lastMessageAt).not.toEqual(before.lastMessageAt);

      const edited = `@${world.bobName} a message edited later`;
      await editMessage(db(), {
        userId: world.alice,
        messageId: sent.message.id,
        body: edited,
        mentions: [{ kind: 'USER', userId: world.bob, ...spanOf(edited, `@${world.bobName}`) }],
      });

      const afterEdit = await db().conversation.findUniqueOrThrow({
        where: { id: world.group },
        select: { lastMessageAt: true },
      });
      // Unchanged by the edit: the mention was added, the conversation did not resurface.
      expect(afterEdit.lastMessageAt).toEqual(after.lastMessageAt);
    });

    it('refuses an edit whose mentions name a non-member, leaving the message as it was', async () => {
      const sent = await send('a message about nothing');

      await expect(
        editMessage(db(), {
          userId: world.alice,
          messageId: sent.message.id,
          body: `@${TAG}-Mallory look`,
          mentions: [
            {
              kind: 'USER',
              userId: world.mallory,
              startOffset: 0,
              endOffset: `@${TAG}-Mallory`.length,
            },
          ],
        }),
      ).rejects.toBeInstanceOf(MentionError);

      const row = await db().message.findUniqueOrThrow({
        where: { id: sent.message.id },
        select: { body: true, editedAt: true },
      });
      expect(row.body).toBe('a message about nothing');
      expect(row.editedAt).toBeNull();
    });
  });

  /* ------------------------------------------------------------------------------------------ */
  /* 12, 13, 17 — delete, hide, forward                                                           */
  /* ------------------------------------------------------------------------------------------ */

  describe('delete, hide and forward', () => {
    it('delete-for-everyone REMOVES the mention rows', async () => {
      const body = `@${world.bobName} secret plan`;
      const sent = await send(body, [
        { kind: 'USER', userId: world.bob, ...spanOf(body, `@${world.bobName}`) },
      ]);

      await deleteMessageForEveryone(db(), { userId: world.alice, messageId: sent.message.id });

      expect(await storedMentions(sent.message.id)).toEqual([]);
      const row = await db().message.findUniqueOrThrow({
        where: { id: sent.message.id },
        select: { body: true, deletedAt: true },
      });
      expect(row.body).toBeNull();
      expect(row.deletedAt).not.toBeNull();
    });

    it('delete-for-me leaves the rows alone and hides the whole message instead', async () => {
      const body = `@${world.carolName} just for you`;
      const sent = await send(body, [
        { kind: 'USER', userId: world.carol, ...spanOf(body, `@${world.carolName}`) },
      ]);

      await hideMessageForUser(db(), { messageId: sent.message.id, userId: world.carol });

      // The shared row is untouched; Carol simply cannot see the message at all.
      expect(await storedMentions(sent.message.id)).toHaveLength(1);
      expect(
        await db().messageHide.count({
          where: { messageId: sent.message.id, userId: world.carol },
        }),
      ).toBe(1);
    });

    it('a FORWARDED copy carries no mention rows', async () => {
      /*
       * The forwarded text may still read "@Bob" as plain content, but it must not mention the
       * original Bob, notify him, or resolve into a member of the destination group.
       */
      const destination = await db().conversation.create({
        data: {
          type: 'GROUP',
          name: `${TAG} Elsewhere`,
          createdById: world.alice,
          members: { create: [{ userId: world.alice, role: 'OWNER' }, { userId: world.carol }] },
        },
        select: { id: true },
      });
      trackConversation(destination.id);

      const body = `@${world.bobName} please look`;
      const sent = await send(body, [
        { kind: 'USER', userId: world.bob, ...spanOf(body, `@${world.bobName}`) },
      ]);

      const forwarded = await forwardMessage(db(), storage, {
        userId: world.alice,
        messageId: sent.message.id,
        destinations: [{ conversationId: destination.id, clientMessageId: uuid() }],
      });

      const copyId = forwarded.delivered[0]?.message.id;
      expect(copyId).toBeTruthy();

      // The text came across…
      const copy = await db().message.findUniqueOrThrow({
        where: { id: copyId as string },
        select: { body: true },
      });
      expect(copy.body).toContain(`@${world.bobName}`);

      // …the mention did not.
      expect(await storedMentions(copyId as string)).toEqual([]);

      // And the original is untouched.
      expect(await storedMentions(sent.message.id)).toHaveLength(1);
    });
  });

  /* ------------------------------------------------------------------------------------------ */
  /* 20 — renaming                                                                                */
  /* ------------------------------------------------------------------------------------------ */

  describe('a rename does not rewrite history', () => {
    it('keeps the user id and the ORIGINAL text after the person is renamed', async () => {
      const renamed = await createTestIdentity(`${TAG}-Before Rename`);
      await db().conversationMember.create({
        data: { conversationId: world.group, userId: renamed.userId },
      });

      const oldName = (
        await db().user.findUniqueOrThrow({
          where: { id: renamed.userId },
          select: { displayName: true },
        })
      ).displayName;

      const body = `@${oldName} please check`;
      const sent = await send(body, [
        { kind: 'USER', userId: renamed.userId, ...spanOf(body, `@${oldName}`) },
      ]);

      await db().user.update({
        where: { id: renamed.userId },
        data: { displayName: `${TAG}-After Rename`, normalizedName: `${TAG}-after rename` },
      });

      const row = await db().message.findUniqueOrThrow({
        where: { id: sent.message.id },
        select: { body: true },
      });
      const rows = await storedMentions(sent.message.id);

      // The identity is stable…
      expect(rows[0]?.mentionedUserId).toBe(renamed.userId);
      // …and the message still says exactly what was sent. Nothing was silently rewritten.
      expect(row.body).toBe(body);
      expect(row.body).toContain(oldName);
      expect(row.body).not.toContain('After Rename');

      // The mention still resolves to a real recipient, by id rather than by name.
      await expect(
        resolveMentionRecipients(db(), {
          conversationId: world.group,
          senderId: world.alice,
          mentions: rows,
        }),
      ).resolves.toContain(renamed.userId);
    });
  });
});
