/**
 * Message actions: reply, react, forward, pin and delete (Batch 1).
 *
 * These exercise the SERVICE layer, which is where every authorization decision is made. The
 * interface decides what to offer; it decides nothing about what is allowed, so a test that
 * drove the interface would prove much less than these do.
 *
 * The properties that matter, and which most of this file is about:
 *
 *   - A message id from a caller is a request, never a permission. Every action re-derives the
 *     conversation from the message row and re-proves membership of THAT conversation.
 *   - D-03 holds for actions as it does for reads: a group member cannot react to, pin, forward
 *     or quote anything sent before they joined.
 *   - "Delete for everyone" belongs to the sender alone, enforced from the stored `senderId`.
 *   - A forwarded file is an INDEPENDENT file. Deleting the original must not break the copy.
 */

import { afterAll, describe, expect, it } from 'vitest';

import {
  ALLOWED_REACTIONS,
  MessageActionError,
  clearReaction,
  deleteMessageForEveryone,
  forwardMessage,
  hideMessageForUser,
  listPinnedMessages,
  loadAccessibleMessage,
  setPinned,
  setReaction,
} from '@/lib/messages/actions';
import { SendMessageError, listMessages, sendMessage } from '@/lib/messages/service';
import { toMessageWire } from '@/lib/realtime/events';

import {
  cleanUp,
  createTestIdentity,
  databaseConfigured,
  db,
  disconnect,
  seedDirectConversation,
  seedGroupConversation,
  seedMessageAt,
  uuid,
} from './harness';

const suite = databaseConfigured ? describe : describe.skip;

/** Storage the forwarding tests write into. A temp directory, never the configured upload dir. */
import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const storage = {
  uploadDir: mkdtempSync(join(tmpdir(), 'zz-test-forward-')),
  maxFileSize: 1024 * 1024,
};

/** Writes bytes at a storage key and returns it, as an upload would have left them. */
async function seedStoredFile(contents: string): Promise<string> {
  const storageKey = `2026/09/${uuid()}.bin`;
  const path = join(storage.uploadDir, storageKey);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, 'utf8');
  return storageKey;
}

/** A `FILE` message with a real attachment row and real bytes behind it. */
async function seedFileMessage(
  conversationId: string,
  senderId: string,
  filename = 'report.pdf',
  contents = 'file-contents',
): Promise<{ messageId: string; attachmentId: string; storageKey: string }> {
  const storageKey = await seedStoredFile(contents);

  const message = await db().message.create({
    data: {
      conversationId,
      senderId,
      type: 'FILE',
      body: null,
      clientMessageId: uuid(),
    },
    select: { id: true },
  });

  const attachment = await db().attachment.create({
    data: {
      conversationId,
      messageId: message.id,
      uploaderId: senderId,
      originalFilename: filename,
      storageKey,
      byteSize: BigInt(Buffer.byteLength(contents)),
      mimeType: 'application/pdf',
      extension: 'pdf',
      status: 'READY',
    },
    select: { id: true },
  });

  return { messageId: message.id, attachmentId: attachment.id, storageKey };
}

/**
 * Moves a membership's `joinedAt` backwards.
 *
 * `seedGroupConversation` stamps the owner's join at "now", so a message seeded in the past would
 * be outside the OWNER's window too — and a test meaning to prove the latecomer is excluded would
 * pass for the wrong reason, excluding everybody. Backdating the owner makes the boundary lie
 * between the two people, which is the thing being tested.
 */
async function backdateJoin(conversationId: string, userId: string, joinedAt: Date): Promise<void> {
  await db().conversationMember.updateMany({
    where: { conversationId, userId },
    data: { joinedAt },
  });
}

async function send(conversationId: string, senderId: string, body: string, replyToId?: string) {
  return sendMessage(db(), {
    senderId,
    conversationId,
    body,
    clientMessageId: uuid(),
    ...(replyToId === undefined ? {} : { replyToId }),
  });
}

suite('message actions', () => {
  afterAll(async () => {
    await cleanUp();
    await disconnect();
  });

  /* ------------------------------------------------------------------------------------------ */
  /* Access — the gate every action shares                                                        */
  /* ------------------------------------------------------------------------------------------ */

  describe('loadAccessibleMessage', () => {
    it('refuses a message in a conversation the caller is not in', async () => {
      const alice = await createTestIdentity('Alice');
      const bob = await createTestIdentity('Bob');
      const outsider = await createTestIdentity('Outsider');

      const conversation = await seedDirectConversation(alice.userId, bob.userId);
      const { message } = await send(conversation, alice.userId, 'private');

      await expect(
        loadAccessibleMessage(db(), outsider.userId, message.id),
      ).rejects.toMatchObject({ reason: 'NOT_ACCESSIBLE' });
    });

    it('refuses a message sent before the caller joined the group (D-03)', async () => {
      const owner = await createTestIdentity('Owner');
      const latecomer = await createTestIdentity('Latecomer');

      const joinedAt = new Date();
      const conversation = await seedGroupConversation(owner.userId, [
        { userId: latecomer.userId, joinedAt },
      ]);
      await backdateJoin(conversation, owner.userId, new Date(joinedAt.getTime() - 3_600_000));

      // Written before the latecomer's join time, so it is outside their window — but after the
      // owner's, so it is inside theirs.
      const old = await seedMessageAt(
        conversation,
        owner.userId,
        'before you arrived',
        new Date(joinedAt.getTime() - 60_000),
      );

      await expect(
        loadAccessibleMessage(db(), latecomer.userId, old.id),
      ).rejects.toMatchObject({ reason: 'NOT_ACCESSIBLE' });

      // And the owner, who was there, can still reach it — so this is a window check and not a
      // blanket refusal.
      await expect(loadAccessibleMessage(db(), owner.userId, old.id)).resolves.toMatchObject({
        message: { id: old.id },
      });
    });

    it('refuses a member who has left', async () => {
      const owner = await createTestIdentity('Owner');
      const leaver = await createTestIdentity('Leaver');

      const conversation = await seedGroupConversation(owner.userId, [{ userId: leaver.userId }]);
      const { message } = await send(conversation, owner.userId, 'still here?');

      await db().conversationMember.updateMany({
        where: { conversationId: conversation, userId: leaver.userId },
        data: { leftAt: new Date() },
      });

      await expect(
        loadAccessibleMessage(db(), leaver.userId, message.id),
      ).rejects.toMatchObject({ reason: 'NOT_ACCESSIBLE' });
    });
  });

  /* ------------------------------------------------------------------------------------------ */
  /* Reply                                                                                        */
  /* ------------------------------------------------------------------------------------------ */

  describe('reply', () => {
    it('persists the relationship and renders a quoted preview', async () => {
      const alice = await createTestIdentity('Alice');
      const bob = await createTestIdentity('Bob');
      const conversation = await seedDirectConversation(alice.userId, bob.userId);

      const original = await send(conversation, alice.userId, 'the original question');
      const reply = await send(conversation, bob.userId, 'the answer', original.message.id);

      expect(reply.message.replyTo).toMatchObject({
        id: original.message.id,
        senderId: alice.userId,
        body: 'the original question',
      });

      const wire = toMessageWire(reply.message, reply.viewerJoinedAt);
      expect(wire.replyTo).toMatchObject({
        id: original.message.id,
        body: 'the original question',
        deleted: false,
        unavailable: false,
      });
    });

    it('REFUSES a reply target from another conversation', async () => {
      const alice = await createTestIdentity('Alice');
      const bob = await createTestIdentity('Bob');
      const carol = await createTestIdentity('Carol');

      const priv = await seedDirectConversation(alice.userId, carol.userId);
      const shared = await seedDirectConversation(alice.userId, bob.userId);

      const secret = await send(priv, carol.userId, 'a secret Bob may not see');

      /*
       * The attack this closes: quoting a message out of a conversation Bob has no access to
       * into one he does. The quoted text would then be rendered to him.
       */
      await expect(send(shared, alice.userId, 'look', secret.message.id)).rejects.toBeInstanceOf(
        SendMessageError,
      );
    });

    it('REFUSES a reply target from before the sender joined', async () => {
      const owner = await createTestIdentity('Owner');
      const latecomer = await createTestIdentity('Latecomer');

      const joinedAt = new Date();
      const conversation = await seedGroupConversation(owner.userId, [
        { userId: latecomer.userId, joinedAt },
      ]);
      const old = await seedMessageAt(
        conversation,
        owner.userId,
        'ancient history',
        new Date(joinedAt.getTime() - 60_000),
      );

      await expect(
        send(conversation, latecomer.userId, 'quoting that', old.id),
      ).rejects.toMatchObject({ reason: 'REPLY_TARGET_INVALID' });
    });

    it('hides the quoted body from a reader outside the original message window', async () => {
      const owner = await createTestIdentity('Owner');
      const latecomer = await createTestIdentity('Latecomer');

      const joinedAt = new Date();
      const conversation = await seedGroupConversation(owner.userId, [
        { userId: latecomer.userId, joinedAt },
      ]);
      const ownerJoinedAt = new Date(joinedAt.getTime() - 3_600_000);
      await backdateJoin(conversation, owner.userId, ownerJoinedAt);

      const old = await seedMessageAt(
        conversation,
        owner.userId,
        'confidential earlier message',
        new Date(joinedAt.getTime() - 60_000),
      );
      const reply = await send(conversation, owner.userId, 'replying to it', old.id);

      // The owner was there, so they see the quote in full.
      const forOwner = toMessageWire(reply.message, ownerJoinedAt);
      expect(forOwner.replyTo?.body).toBe('confidential earlier message');

      /*
       * The latecomer must not. Serialized against THEIR window, the quote collapses to
       * "unavailable" and carries no body and no sender — and note it is not reported as
       * "deleted" either, because even that would say something about a message they may not see.
       *
       * This is why `toMessageWire` takes the reader's window, and why a reply is emitted per
       * member instead of broadcast once into the conversation room.
       */
      const forLatecomer = toMessageWire(reply.message, joinedAt);
      expect(forLatecomer.replyTo).toMatchObject({ unavailable: true, body: null, deleted: false });
      expect(forLatecomer.replyTo?.senderId).toBeNull();
      expect(forLatecomer.replyTo?.attachmentFilename).toBeNull();
    });

    it('survives the original being deleted for everyone', async () => {
      const alice = await createTestIdentity('Alice');
      const bob = await createTestIdentity('Bob');
      const conversation = await seedDirectConversation(alice.userId, bob.userId);

      const original = await send(conversation, alice.userId, 'delete me later');
      const reply = await send(conversation, bob.userId, 'a reply', original.message.id);

      await deleteMessageForEveryone(db(), {
        userId: alice.userId,
        messageId: original.message.id,
      });

      const page = await listMessages(db(), { userId: bob.userId, conversationId: conversation });
      const stored = page.messages.find((message) => message.id === reply.message.id);

      // The relationship is intact — not orphaned by a cascade — and reads as deleted.
      expect(stored?.replyTo?.id).toBe(original.message.id);

      const wire = toMessageWire(stored!, page.viewerJoinedAt);
      expect(wire.replyTo).toMatchObject({ deleted: true, body: null, unavailable: false });
    });

    it('can reply to a file message', async () => {
      const alice = await createTestIdentity('Alice');
      const bob = await createTestIdentity('Bob');
      const conversation = await seedDirectConversation(alice.userId, bob.userId);

      const file = await seedFileMessage(conversation, alice.userId, 'budget.pdf');
      const reply = await send(conversation, bob.userId, 'got it', file.messageId);

      const wire = toMessageWire(reply.message, reply.viewerJoinedAt);
      expect(wire.replyTo).toMatchObject({ attachmentFilename: 'budget.pdf', body: null });
    });
  });

  /* ------------------------------------------------------------------------------------------ */
  /* Reactions                                                                                    */
  /* ------------------------------------------------------------------------------------------ */

  describe('reactions', () => {
    it('adds, aggregates and removes', async () => {
      const alice = await createTestIdentity('Alice');
      const bob = await createTestIdentity('Bob');
      const conversation = await seedDirectConversation(alice.userId, bob.userId);
      const { message } = await send(conversation, alice.userId, 'react to me');

      await setReaction(db(), { userId: alice.userId, messageId: message.id, emoji: '👍' });
      const both = await setReaction(db(), {
        userId: bob.userId,
        messageId: message.id,
        emoji: '👍',
      });

      const wire = toMessageWire(both.message, both.membership.joinedAt);
      expect(wire.reactions).toHaveLength(1);
      expect(wire.reactions[0]).toMatchObject({ emoji: '👍', count: 2 });
      expect(wire.reactions[0]?.userIds).toEqual(
        expect.arrayContaining([alice.userId, bob.userId]),
      );

      const after = await clearReaction(db(), { userId: bob.userId, messageId: message.id });
      expect(toMessageWire(after.message, after.membership.joinedAt).reactions[0]).toMatchObject({
        count: 1,
        userIds: [alice.userId],
      });
    });

    it('keeps ONE reaction per person — choosing another replaces it', async () => {
      const alice = await createTestIdentity('Alice');
      const bob = await createTestIdentity('Bob');
      const conversation = await seedDirectConversation(alice.userId, bob.userId);
      const { message } = await send(conversation, alice.userId, 'pick one');

      await setReaction(db(), { userId: alice.userId, messageId: message.id, emoji: '👍' });
      const changed = await setReaction(db(), {
        userId: alice.userId,
        messageId: message.id,
        emoji: '😂',
      });

      const wire = toMessageWire(changed.message, changed.membership.joinedAt);
      expect(wire.reactions).toHaveLength(1);
      expect(wire.reactions[0]).toMatchObject({ emoji: '😂', count: 1 });

      // And the database agrees: the constraint, not the application, is what guarantees this.
      const rows = await db().messageReaction.count({
        where: { messageId: message.id, userId: alice.userId },
      });
      expect(rows).toBe(1);
    });

    it('is idempotent — reacting twice with the same emoji creates one row', async () => {
      const alice = await createTestIdentity('Alice');
      const bob = await createTestIdentity('Bob');
      const conversation = await seedDirectConversation(alice.userId, bob.userId);
      const { message } = await send(conversation, alice.userId, 'double tap');

      await setReaction(db(), { userId: alice.userId, messageId: message.id, emoji: '❤️' });
      await setReaction(db(), { userId: alice.userId, messageId: message.id, emoji: '❤️' });

      expect(await db().messageReaction.count({ where: { messageId: message.id } })).toBe(1);
    });

    it('refuses an emoji that is not on the server allow-list', async () => {
      const alice = await createTestIdentity('Alice');
      const bob = await createTestIdentity('Bob');
      const conversation = await seedDirectConversation(alice.userId, bob.userId);
      const { message } = await send(conversation, alice.userId, 'hello');

      await expect(
        setReaction(db(), { userId: alice.userId, messageId: message.id, emoji: '<script>' }),
      ).rejects.toMatchObject({ reason: 'INVALID_EMOJI' });

      expect(await db().messageReaction.count({ where: { messageId: message.id } })).toBe(0);
    });

    it('accepts every emoji the picker offers', () => {
      expect(ALLOWED_REACTIONS).toEqual(['👍', '❤️', '😂', '😮', '😢', '🙏']);
    });

    it('refuses a reaction from somebody outside the conversation', async () => {
      const alice = await createTestIdentity('Alice');
      const bob = await createTestIdentity('Bob');
      const outsider = await createTestIdentity('Outsider');
      const conversation = await seedDirectConversation(alice.userId, bob.userId);
      const { message } = await send(conversation, alice.userId, 'not yours');

      await expect(
        setReaction(db(), { userId: outsider.userId, messageId: message.id, emoji: '👍' }),
      ).rejects.toMatchObject({ reason: 'NOT_ACCESSIBLE' });
    });

    it('cannot remove somebody else’s reaction', async () => {
      const alice = await createTestIdentity('Alice');
      const bob = await createTestIdentity('Bob');
      const conversation = await seedDirectConversation(alice.userId, bob.userId);
      const { message } = await send(conversation, alice.userId, 'mine');

      await setReaction(db(), { userId: alice.userId, messageId: message.id, emoji: '👍' });

      // Bob asks to clear "the reaction" on this message. The query is scoped to him, so
      // Alice's survives — there is no request shape that could have removed it.
      await clearReaction(db(), { userId: bob.userId, messageId: message.id });

      expect(
        await db().messageReaction.count({ where: { messageId: message.id, userId: alice.userId } }),
      ).toBe(1);
    });

    it('refuses to react to a deleted message', async () => {
      const alice = await createTestIdentity('Alice');
      const bob = await createTestIdentity('Bob');
      const conversation = await seedDirectConversation(alice.userId, bob.userId);
      const { message } = await send(conversation, alice.userId, 'going away');

      await deleteMessageForEveryone(db(), { userId: alice.userId, messageId: message.id });

      await expect(
        setReaction(db(), { userId: bob.userId, messageId: message.id, emoji: '👍' }),
      ).rejects.toMatchObject({ reason: 'NOT_ACTIONABLE' });
    });
  });

  /* ------------------------------------------------------------------------------------------ */
  /* Pinning                                                                                      */
  /* ------------------------------------------------------------------------------------------ */

  describe('pinning', () => {
    it('pins and unpins for the whole conversation', async () => {
      const alice = await createTestIdentity('Alice');
      const bob = await createTestIdentity('Bob');
      const conversation = await seedDirectConversation(alice.userId, bob.userId);
      const { message } = await send(conversation, alice.userId, 'important');

      const pinned = await setPinned(db(), {
        userId: alice.userId,
        messageId: message.id,
        pinned: true,
      });
      expect(pinned.message.pinnedAt).not.toBeNull();

      // Visible to the other member, not just the pinner — pinning is conversation-level.
      const seenByBob = await listPinnedMessages(db(), {
        userId: bob.userId,
        conversationId: conversation,
      });
      expect(seenByBob.messages.map((m) => m.id)).toEqual([message.id]);

      // And any member may unpin.
      await setPinned(db(), { userId: bob.userId, messageId: message.id, pinned: false });
      const after = await listPinnedMessages(db(), {
        userId: alice.userId,
        conversationId: conversation,
      });
      expect(after.messages).toHaveLength(0);
    });

    it('supports several pinned messages, newest pin first', async () => {
      const alice = await createTestIdentity('Alice');
      const bob = await createTestIdentity('Bob');
      const conversation = await seedDirectConversation(alice.userId, bob.userId);

      const first = await send(conversation, alice.userId, 'one');
      const second = await send(conversation, alice.userId, 'two');

      await setPinned(db(), { userId: alice.userId, messageId: first.message.id, pinned: true });
      await setPinned(db(), { userId: alice.userId, messageId: second.message.id, pinned: true });

      const pins = await listPinnedMessages(db(), {
        userId: alice.userId,
        conversationId: conversation,
      });
      expect(pins.messages.map((m) => m.id)).toEqual([second.message.id, first.message.id]);
    });

    it('drops the pin when the message is deleted for everyone', async () => {
      const alice = await createTestIdentity('Alice');
      const bob = await createTestIdentity('Bob');
      const conversation = await seedDirectConversation(alice.userId, bob.userId);
      const { message } = await send(conversation, alice.userId, 'pinned then deleted');

      await setPinned(db(), { userId: alice.userId, messageId: message.id, pinned: true });
      const deleted = await deleteMessageForEveryone(db(), {
        userId: alice.userId,
        messageId: message.id,
      });

      // A tombstone must never remain as active pinned content.
      expect(deleted.message.pinnedAt).toBeNull();
      const pins = await listPinnedMessages(db(), {
        userId: bob.userId,
        conversationId: conversation,
      });
      expect(pins.messages).toHaveLength(0);
    });

    it('refuses to pin a deleted message', async () => {
      const alice = await createTestIdentity('Alice');
      const bob = await createTestIdentity('Bob');
      const conversation = await seedDirectConversation(alice.userId, bob.userId);
      const { message } = await send(conversation, alice.userId, 'gone');

      await deleteMessageForEveryone(db(), { userId: alice.userId, messageId: message.id });

      await expect(
        setPinned(db(), { userId: bob.userId, messageId: message.id, pinned: true }),
      ).rejects.toMatchObject({ reason: 'NOT_ACTIONABLE' });
    });

    it('hides a pinned message from a member who joined after it', async () => {
      const owner = await createTestIdentity('Owner');
      const latecomer = await createTestIdentity('Latecomer');

      const joinedAt = new Date();
      const conversation = await seedGroupConversation(owner.userId, [
        { userId: latecomer.userId, joinedAt },
      ]);
      await backdateJoin(conversation, owner.userId, new Date(joinedAt.getTime() - 3_600_000));

      const old = await seedMessageAt(
        conversation,
        owner.userId,
        'pinned before they joined',
        new Date(joinedAt.getTime() - 60_000),
      );

      await setPinned(db(), { userId: owner.userId, messageId: old.id, pinned: true });

      // The owner sees it pinned.
      const forOwner = await listPinnedMessages(db(), {
        userId: owner.userId,
        conversationId: conversation,
      });
      expect(forOwner.messages.map((m) => m.id)).toEqual([old.id]);

      const forLatecomer = await listPinnedMessages(db(), {
        userId: latecomer.userId,
        conversationId: conversation,
      });
      expect(forLatecomer.messages).toHaveLength(0);
    });

    it('does not move the conversation or create a message', async () => {
      const alice = await createTestIdentity('Alice');
      const bob = await createTestIdentity('Bob');
      const conversation = await seedDirectConversation(alice.userId, bob.userId);
      const { message } = await send(conversation, alice.userId, 'quiet pin');

      const before = await db().conversation.findUniqueOrThrow({
        where: { id: conversation },
        select: { lastMessageAt: true },
      });
      const countBefore = await db().message.count({ where: { conversationId: conversation } });

      await setPinned(db(), { userId: bob.userId, messageId: message.id, pinned: true });

      const after = await db().conversation.findUniqueOrThrow({
        where: { id: conversation },
        select: { lastMessageAt: true },
      });

      // If either of these changed, pinning would push the conversation up the sidebar and
      // could produce an unread badge for something nobody said.
      expect(after.lastMessageAt?.toISOString()).toBe(before.lastMessageAt?.toISOString());
      expect(await db().message.count({ where: { conversationId: conversation } })).toBe(
        countBefore,
      );
    });
  });

  /* ------------------------------------------------------------------------------------------ */
  /* Delete                                                                                       */
  /* ------------------------------------------------------------------------------------------ */

  describe('delete for me', () => {
    it('hides the message for one person only', async () => {
      const alice = await createTestIdentity('Alice');
      const bob = await createTestIdentity('Bob');
      const conversation = await seedDirectConversation(alice.userId, bob.userId);
      const { message } = await send(conversation, alice.userId, 'only bob hides this');

      await hideMessageForUser(db(), { userId: bob.userId, messageId: message.id });

      const forBob = await listMessages(db(), {
        userId: bob.userId,
        conversationId: conversation,
      });
      const forAlice = await listMessages(db(), {
        userId: alice.userId,
        conversationId: conversation,
      });

      expect(forBob.messages.map((m) => m.id)).not.toContain(message.id);
      expect(forAlice.messages.map((m) => m.id)).toContain(message.id);

      // The shared row is untouched: this is a view preference, not a deletion.
      expect(await db().message.findUnique({ where: { id: message.id } })).not.toBeNull();
    });

    it('can hide somebody else’s message, and is idempotent', async () => {
      const alice = await createTestIdentity('Alice');
      const bob = await createTestIdentity('Bob');
      const conversation = await seedDirectConversation(alice.userId, bob.userId);
      const { message } = await send(conversation, alice.userId, 'hide me twice');

      await hideMessageForUser(db(), { userId: bob.userId, messageId: message.id });
      await hideMessageForUser(db(), { userId: bob.userId, messageId: message.id });

      expect(await db().messageHide.count({ where: { messageId: message.id } })).toBe(1);
    });

    it('refuses to hide a message the caller cannot see', async () => {
      const alice = await createTestIdentity('Alice');
      const bob = await createTestIdentity('Bob');
      const outsider = await createTestIdentity('Outsider');
      const conversation = await seedDirectConversation(alice.userId, bob.userId);
      const { message } = await send(conversation, alice.userId, 'not yours to hide');

      await expect(
        hideMessageForUser(db(), { userId: outsider.userId, messageId: message.id }),
      ).rejects.toMatchObject({ reason: 'NOT_ACCESSIBLE' });
    });
  });

  describe('delete for everyone', () => {
    it('is refused for anybody but the sender', async () => {
      const alice = await createTestIdentity('Alice');
      const bob = await createTestIdentity('Bob');
      const conversation = await seedDirectConversation(alice.userId, bob.userId);
      const { message } = await send(conversation, alice.userId, 'alice wrote this');

      /*
       * The IDOR this closes. Bob is a legitimate member with a valid session and the real
       * message id — everything a crafted request would have — and is still refused, because the
       * check is against the STORED sender.
       */
      await expect(
        deleteMessageForEveryone(db(), { userId: bob.userId, messageId: message.id }),
      ).rejects.toMatchObject({ reason: 'NOT_THE_SENDER' });

      const untouched = await db().message.findUniqueOrThrow({ where: { id: message.id } });
      expect(untouched.deletedAt).toBeNull();
      expect(untouched.body).toBe('alice wrote this');
    });

    it('clears the body, the pin and the reactions, and leaves a tombstone', async () => {
      const alice = await createTestIdentity('Alice');
      const bob = await createTestIdentity('Bob');
      const conversation = await seedDirectConversation(alice.userId, bob.userId);
      const { message } = await send(conversation, alice.userId, 'sensitive text');

      await setReaction(db(), { userId: bob.userId, messageId: message.id, emoji: '👍' });
      await setPinned(db(), { userId: bob.userId, messageId: message.id, pinned: true });

      const result = await deleteMessageForEveryone(db(), {
        userId: alice.userId,
        messageId: message.id,
      });

      expect(result.message.deletedAt).not.toBeNull();
      expect(result.message.body).toBeNull();
      expect(result.message.pinnedAt).toBeNull();
      expect(result.message.reactions).toHaveLength(0);

      // The row survives, so ordering, replies and read markers stay valid.
      const row = await db().message.findUniqueOrThrow({ where: { id: message.id } });
      expect(row.body).toBeNull();
      expect(row.deletedById).toBe(alice.userId);

      const wire = toMessageWire(result.message, result.membership.joinedAt);
      expect(wire.body).toBeNull();
      expect(wire.deletedAt).not.toBeNull();
    });

    it('refuses to delete a SYSTEM message', async () => {
      const owner = await createTestIdentity('Owner');
      const member = await createTestIdentity('Member');
      const conversation = await seedGroupConversation(owner.userId, [{ userId: member.userId }]);

      const system = await seedMessageAt(conversation, null, 'Member joined', new Date());

      await expect(
        deleteMessageForEveryone(db(), { userId: owner.userId, messageId: system.id }),
      ).rejects.toMatchObject({ reason: 'NOT_THE_SENDER' });
    });

    it('marks the attachment DELETED and reports its bytes for removal', async () => {
      const alice = await createTestIdentity('Alice');
      const bob = await createTestIdentity('Bob');
      const conversation = await seedDirectConversation(alice.userId, bob.userId);
      const file = await seedFileMessage(conversation, alice.userId);

      const result = await deleteMessageForEveryone(db(), {
        userId: alice.userId,
        messageId: file.messageId,
      });

      expect(result.orphanedStorageKey).toBe(file.storageKey);

      const attachment = await db().attachment.findUniqueOrThrow({
        where: { id: file.attachmentId },
      });
      expect(attachment.status).toBe('DELETED');

      // And the wire no longer offers it, so the interface cannot render a download link.
      expect(toMessageWire(result.message, result.membership.joinedAt).attachment).toBeNull();
    });

    it('is idempotent and does not report the same file twice', async () => {
      const alice = await createTestIdentity('Alice');
      const bob = await createTestIdentity('Bob');
      const conversation = await seedDirectConversation(alice.userId, bob.userId);
      const file = await seedFileMessage(conversation, alice.userId);

      const first = await deleteMessageForEveryone(db(), {
        userId: alice.userId,
        messageId: file.messageId,
      });
      const second = await deleteMessageForEveryone(db(), {
        userId: alice.userId,
        messageId: file.messageId,
      });

      expect(first.orphanedStorageKey).toBe(file.storageKey);
      // A retry must not try to delete the bytes a second time.
      expect(second.orphanedStorageKey).toBeNull();
    });
  });

  /* ------------------------------------------------------------------------------------------ */
  /* Forward                                                                                      */
  /* ------------------------------------------------------------------------------------------ */

  describe('forward', () => {
    it('copies a text message into another conversation and marks it forwarded', async () => {
      const alice = await createTestIdentity('Alice');
      const bob = await createTestIdentity('Bob');
      const carol = await createTestIdentity('Carol');

      const source = await seedDirectConversation(alice.userId, bob.userId);
      const destination = await seedDirectConversation(alice.userId, carol.userId);
      const { message } = await send(source, bob.userId, 'worth sharing');

      const result = await forwardMessage(db(), storage, {
        userId: alice.userId,
        messageId: message.id,
        destinations: [{ conversationId: destination, clientMessageId: uuid() }],
      });

      expect(result.failures).toHaveLength(0);
      expect(result.delivered).toHaveLength(1);

      const forwarded = result.delivered[0]!.message;
      expect(forwarded.body).toBe('worth sharing');
      expect(forwarded.isForwarded).toBe(true);
      // The forwarder is the sender of the copy — it is their act, in their conversation.
      expect(forwarded.senderId).toBe(alice.userId);
      expect(forwarded.conversationId).toBe(destination);
    });

    it('forwards into a group', async () => {
      const alice = await createTestIdentity('Alice');
      const bob = await createTestIdentity('Bob');
      const carol = await createTestIdentity('Carol');

      const source = await seedDirectConversation(alice.userId, bob.userId);
      const group = await seedGroupConversation(alice.userId, [{ userId: carol.userId }]);
      const { message } = await send(source, bob.userId, 'for the team');

      const result = await forwardMessage(db(), storage, {
        userId: alice.userId,
        messageId: message.id,
        destinations: [{ conversationId: group, clientMessageId: uuid() }],
      });

      expect(result.delivered[0]?.conversationId).toBe(group);

      // Carol, a member of the group, can read it.
      const page = await listMessages(db(), { userId: carol.userId, conversationId: group });
      expect(page.messages.map((m) => m.body)).toContain('for the team');
    });

    it('creates a REAL, INDEPENDENT attachment — new row, new key, real bytes', async () => {
      const alice = await createTestIdentity('Alice');
      const bob = await createTestIdentity('Bob');
      const carol = await createTestIdentity('Carol');

      const source = await seedDirectConversation(alice.userId, bob.userId);
      const destination = await seedDirectConversation(alice.userId, carol.userId);
      const file = await seedFileMessage(source, bob.userId, 'contract.pdf', 'the-real-bytes');

      const result = await forwardMessage(db(), storage, {
        userId: alice.userId,
        messageId: file.messageId,
        destinations: [{ conversationId: destination, clientMessageId: uuid() }],
      });

      const copy = await db().attachment.findUniqueOrThrow({
        where: { messageId: result.delivered[0]!.message.id },
      });

      // A different row, a different key, in the destination conversation.
      expect(copy.id).not.toBe(file.attachmentId);
      expect(copy.storageKey).not.toBe(file.storageKey);
      expect(copy.conversationId).toBe(destination);
      expect(copy.originalFilename).toBe('contract.pdf');
      expect(copy.status).toBe('READY');

      // Real bytes, and a checksum measured over the copy rather than inherited.
      const bytes = await readFile(join(storage.uploadDir, copy.storageKey), 'utf8');
      expect(bytes).toBe('the-real-bytes');
      expect(copy.checksumSha256).not.toBeNull();
      expect(Number(copy.byteSize)).toBe(Buffer.byteLength('the-real-bytes'));
    });

    it('DELETING THE ORIGINAL DOES NOT BREAK THE FORWARDED COPY', async () => {
      const alice = await createTestIdentity('Alice');
      const bob = await createTestIdentity('Bob');
      const carol = await createTestIdentity('Carol');

      const source = await seedDirectConversation(alice.userId, bob.userId);
      const destination = await seedDirectConversation(alice.userId, carol.userId);
      const file = await seedFileMessage(source, alice.userId, 'shared.pdf', 'keep-these-bytes');

      const forwarded = await forwardMessage(db(), storage, {
        userId: alice.userId,
        messageId: file.messageId,
        destinations: [{ conversationId: destination, clientMessageId: uuid() }],
      });
      const copy = await db().attachment.findUniqueOrThrow({
        where: { messageId: forwarded.delivered[0]!.message.id },
      });

      // Alice deletes the original for everyone, and its bytes are removed.
      const deleted = await deleteMessageForEveryone(db(), {
        userId: alice.userId,
        messageId: file.messageId,
      });
      expect(deleted.orphanedStorageKey).toBe(file.storageKey);

      /*
       * The copy is untouched: still READY, still its own key, and its bytes are still there.
       * This is the whole reason forwarding copies the file instead of sharing it.
       */
      const after = await db().attachment.findUniqueOrThrow({ where: { id: copy.id } });
      expect(after.status).toBe('READY');
      expect(await stat(join(storage.uploadDir, after.storageKey))).toBeDefined();
      expect(await readFile(join(storage.uploadDir, after.storageKey), 'utf8')).toBe(
        'keep-these-bytes',
      );
    });

    it('refuses a destination the caller is not a member of, without failing the others', async () => {
      const alice = await createTestIdentity('Alice');
      const bob = await createTestIdentity('Bob');
      const carol = await createTestIdentity('Carol');
      const dave = await createTestIdentity('Dave');

      const source = await seedDirectConversation(alice.userId, bob.userId);
      const allowed = await seedDirectConversation(alice.userId, carol.userId);
      // Alice is not in this one.
      const forbidden = await seedDirectConversation(bob.userId, dave.userId);

      const { message } = await send(source, bob.userId, 'partial forward');

      const result = await forwardMessage(db(), storage, {
        userId: alice.userId,
        messageId: message.id,
        destinations: [
          { conversationId: allowed, clientMessageId: uuid() },
          { conversationId: forbidden, clientMessageId: uuid() },
        ],
      });

      expect(result.delivered.map((d) => d.conversationId)).toEqual([allowed]);
      expect(result.failures).toEqual([{ conversationId: forbidden, reason: 'FORBIDDEN' }]);

      // Nothing was written into the conversation she may not reach.
      const written = await db().message.count({
        where: { conversationId: forbidden, body: 'partial forward' },
      });
      expect(written).toBe(0);
    });

    it('refuses to forward a message the caller cannot see', async () => {
      const alice = await createTestIdentity('Alice');
      const bob = await createTestIdentity('Bob');
      const outsider = await createTestIdentity('Outsider');

      const source = await seedDirectConversation(alice.userId, bob.userId);
      const theirs = await seedDirectConversation(outsider.userId, bob.userId);
      const { message } = await send(source, alice.userId, 'not for the outsider');

      await expect(
        forwardMessage(db(), storage, {
          userId: outsider.userId,
          messageId: message.id,
          destinations: [{ conversationId: theirs, clientMessageId: uuid() }],
        }),
      ).rejects.toMatchObject({ reason: 'NOT_ACCESSIBLE' });
    });

    it('refuses to forward a deleted message', async () => {
      const alice = await createTestIdentity('Alice');
      const bob = await createTestIdentity('Bob');
      const carol = await createTestIdentity('Carol');

      const source = await seedDirectConversation(alice.userId, bob.userId);
      const destination = await seedDirectConversation(alice.userId, carol.userId);
      const { message } = await send(source, alice.userId, 'gone');

      await deleteMessageForEveryone(db(), { userId: alice.userId, messageId: message.id });

      await expect(
        forwardMessage(db(), storage, {
          userId: alice.userId,
          messageId: message.id,
          destinations: [{ conversationId: destination, clientMessageId: uuid() }],
        }),
      ).rejects.toMatchObject({ reason: 'NOT_ACTIONABLE' });
    });

    it('can forward a message that was itself forwarded, and one that is a reply', async () => {
      const alice = await createTestIdentity('Alice');
      const bob = await createTestIdentity('Bob');
      const carol = await createTestIdentity('Carol');

      const source = await seedDirectConversation(alice.userId, bob.userId);
      const middle = await seedDirectConversation(alice.userId, carol.userId);

      const original = await send(source, bob.userId, 'the original');
      const reply = await send(source, alice.userId, 'a reply to it', original.message.id);

      const once = await forwardMessage(db(), storage, {
        userId: alice.userId,
        messageId: reply.message.id,
        destinations: [{ conversationId: middle, clientMessageId: uuid() }],
      });
      expect(once.delivered).toHaveLength(1);

      const twice = await forwardMessage(db(), storage, {
        userId: alice.userId,
        messageId: once.delivered[0]!.message.id,
        destinations: [{ conversationId: source, clientMessageId: uuid() }],
      });

      expect(twice.delivered).toHaveLength(1);
      expect(twice.delivered[0]?.message.isForwarded).toBe(true);
      /*
       * The copy does NOT carry the reply relationship. A forwarded message is a standalone
       * message in a new conversation — quoting the original would show people a message from a
       * conversation they may not be in.
       */
      expect(twice.delivered[0]?.message.replyTo).toBeNull();
    });

    it('is idempotent per destination', async () => {
      const alice = await createTestIdentity('Alice');
      const bob = await createTestIdentity('Bob');
      const carol = await createTestIdentity('Carol');

      const source = await seedDirectConversation(alice.userId, bob.userId);
      const destination = await seedDirectConversation(alice.userId, carol.userId);
      const { message } = await send(source, bob.userId, 'retry me');

      const key = uuid();
      const first = await forwardMessage(db(), storage, {
        userId: alice.userId,
        messageId: message.id,
        destinations: [{ conversationId: destination, clientMessageId: key }],
      });
      const retry = await forwardMessage(db(), storage, {
        userId: alice.userId,
        messageId: message.id,
        destinations: [{ conversationId: destination, clientMessageId: key }],
      });

      expect(retry.delivered[0]?.message.id).toBe(first.delivered[0]?.message.id);
      expect(
        await db().message.count({ where: { conversationId: destination, body: 'retry me' } }),
      ).toBe(1);
    });

    it('refuses an empty destination list', async () => {
      const alice = await createTestIdentity('Alice');
      const bob = await createTestIdentity('Bob');
      const conversation = await seedDirectConversation(alice.userId, bob.userId);
      const { message } = await send(conversation, alice.userId, 'nowhere');

      await expect(
        forwardMessage(db(), storage, {
          userId: alice.userId,
          messageId: message.id,
          destinations: [],
        }),
      ).rejects.toBeInstanceOf(MessageActionError);
    });
  });

  /* ------------------------------------------------------------------------------------------ */
  /* Messages written before this feature existed                                                 */
  /* ------------------------------------------------------------------------------------------ */

  describe('backwards compatibility', () => {
    it('renders a message that predates the migration', async () => {
      const alice = await createTestIdentity('Alice');
      const bob = await createTestIdentity('Bob');
      const conversation = await seedDirectConversation(alice.userId, bob.userId);

      /*
       * Exactly what an existing production row looks like after migration #3: every new column
       * at its default, and no rows in either new table. It must render as an ordinary message.
       */
      const old = await seedMessageAt(conversation, alice.userId, 'from before', new Date());

      const page = await listMessages(db(), {
        userId: bob.userId,
        conversationId: conversation,
      });
      const stored = page.messages.find((m) => m.id === old.id);

      expect(stored).toBeDefined();
      expect(stored?.replyTo).toBeNull();
      expect(stored?.isForwarded).toBe(false);
      expect(stored?.pinnedAt).toBeNull();
      expect(stored?.deletedAt).toBeNull();
      expect(stored?.reactions).toEqual([]);

      const wire = toMessageWire(stored!, page.viewerJoinedAt);
      expect(wire).toMatchObject({
        body: 'from before',
        replyTo: null,
        isForwarded: false,
        pinnedAt: null,
        deletedAt: null,
        reactions: [],
      });

      // And every action still works on it.
      await setReaction(db(), { userId: bob.userId, messageId: old.id, emoji: '👍' });
      await setPinned(db(), { userId: bob.userId, messageId: old.id, pinned: true });
      await send(conversation, bob.userId, 'replying to an old message', old.id);
    });
  });
});
