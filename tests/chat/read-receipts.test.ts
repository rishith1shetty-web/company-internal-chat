/**
 * Read receipts: direct "Seen" and group Message info (Batch 1.3).
 *
 * NO NEW TABLE IS INVOLVED. Everything here is derived from the read marker the application has
 * kept since Phase 5 — `ConversationMember.lastReadAt`, a watermark set to the `createdAt` of the
 * furthest message a member has read. These tests exist largely to prove that derivation is sound
 * and that it stays the exact complement of the unread count.
 *
 * The properties that matter most:
 *
 *   - Nothing is "read" because somebody is online, connected, or was sent a notification. The
 *     marker moves when the conversation is opened, and only then.
 *   - A sender's own marker never makes their own message look seen.
 *   - D-03 holds: somebody added to a group after a message was sent is neither "read" nor "not
 *     read" — it was never theirs to see.
 *   - Detailed group read status belongs to the sender alone.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { markConversationRead } from '@/lib/conversations/service';
import {
  deleteMessageForEveryone,
  editMessage,
  hideMessageForUser,
  setPinned,
  setReaction,
} from '@/lib/messages/actions';
import { hasReadMessage, readStatusForMessage } from '@/lib/messages/read-status';
import { sendMessage } from '@/lib/messages/service';

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

async function send(conversationId: string, senderId: string, body: string, replyToId?: string) {
  return sendMessage(db(), {
    senderId,
    conversationId,
    body,
    clientMessageId: uuid(),
    ...(replyToId === undefined ? {} : { replyToId }),
  });
}

/** The stored watermark for one member, as the server would read it. */
async function watermarkOf(conversationId: string, userId: string): Promise<Date | null> {
  const member = await db().conversationMember.findUniqueOrThrow({
    where: { conversationId_userId: { conversationId, userId } },
    select: { lastReadAt: true },
  });
  return member.lastReadAt;
}

/** Has `userId`'s marker reached this message? The question the whole feature rests on. */
async function hasSeen(
  conversationId: string,
  userId: string,
  messageCreatedAt: Date,
): Promise<boolean> {
  return hasReadMessage(await watermarkOf(conversationId, userId), messageCreatedAt);
}

/** A `FILE` message with a `READY` attachment. No bytes: read state never touches storage. */
async function seedFileMessage(conversationId: string, senderId: string, caption: string | null) {
  const message = await db().message.create({
    data: { conversationId, senderId, type: 'FILE', body: caption, clientMessageId: uuid() },
    select: { id: true, createdAt: true },
  });

  await db().attachment.create({
    data: {
      conversationId,
      messageId: message.id,
      uploaderId: senderId,
      originalFilename: 'handbook.pdf',
      storageKey: `2026/09/${uuid()}.bin`,
      byteSize: BigInt(1024),
      mimeType: 'application/pdf',
      extension: 'pdf',
      status: 'READY',
    },
  });

  return message;
}

/** Moves a member's join time backwards, so a D-03 boundary can sit between two people. */
async function backdateJoin(conversationId: string, userId: string, joinedAt: Date): Promise<void> {
  await db().conversationMember.updateMany({
    where: { conversationId, userId },
    data: { joinedAt },
  });
}

/* --------------------------------------------------------------------------------------------- */
/* Direct conversations — Seen                                                                      */
/* --------------------------------------------------------------------------------------------- */

suite('direct conversations: Seen', () => {
  afterAll(async () => {
    await cleanUp();
    await disconnect();
  });

  it('is not seen before the recipient opens the conversation', async () => {
    const alice = await createTestIdentity('Alice Seen');
    const bob = await createTestIdentity('Bob Seen');
    const conversation = await seedDirectConversation(alice.userId, bob.userId);

    const { message } = await send(conversation, alice.userId, 'are you there?');

    // Bob exists, is a member, and has a session. None of that is reading.
    expect(await watermarkOf(conversation, bob.userId)).toBeNull();
    expect(await hasSeen(conversation, bob.userId, message.createdAt)).toBe(false);
  });

  it('becomes seen once the recipient opens the conversation', async () => {
    const alice = await createTestIdentity('Alice Open');
    const bob = await createTestIdentity('Bob Open');
    const conversation = await seedDirectConversation(alice.userId, bob.userId);

    const { message } = await send(conversation, alice.userId, 'please check this');

    // Exactly what the browser does when the conversation is on screen.
    await markConversationRead(db(), bob.userId, conversation, message.id);

    expect(await hasSeen(conversation, bob.userId, message.createdAt)).toBe(true);
  });

  it('THE SENDER’S OWN MARKER DOES NOT COUNT', async () => {
    const alice = await createTestIdentity('Alice Own');
    const bob = await createTestIdentity('Bob Own');
    const conversation = await seedDirectConversation(alice.userId, bob.userId);

    const { message } = await send(conversation, alice.userId, 'talking to myself');

    // Alice opens her own conversation. That is her reading her own message, which says nothing
    // about Bob — and a "Seen" derived from it would be a lie told to the person who wrote it.
    await markConversationRead(db(), alice.userId, conversation, message.id);

    expect(await hasSeen(conversation, alice.userId, message.createdAt)).toBe(true);
    expect(await hasSeen(conversation, bob.userId, message.createdAt)).toBe(false);
  });

  it('marks EVERYTHING above the watermark as read, not just the message marked', async () => {
    const alice = await createTestIdentity('Alice Water');
    const bob = await createTestIdentity('Bob Water');
    const conversation = await seedDirectConversation(alice.userId, bob.userId);

    const first = await send(conversation, alice.userId, 'one');
    const second = await send(conversation, alice.userId, 'two');
    const third = await send(conversation, alice.userId, 'three');

    // The browser marks with the NEWEST message in view; the older two come with it. This is the
    // whole reason one watermark can answer for a conversation's entire history.
    await markConversationRead(db(), bob.userId, conversation, third.message.id);

    for (const sent of [first, second, third]) {
      expect(await hasSeen(conversation, bob.userId, sent.message.createdAt)).toBe(true);
    }
  });

  it('a message sent AFTER the marker moved is not seen', async () => {
    const alice = await createTestIdentity('Alice After');
    const bob = await createTestIdentity('Bob After');
    const conversation = await seedDirectConversation(alice.userId, bob.userId);

    const first = await send(conversation, alice.userId, 'read this');
    await markConversationRead(db(), bob.userId, conversation, first.message.id);

    const later = await send(conversation, alice.userId, 'and this one is new');

    expect(await hasSeen(conversation, bob.userId, first.message.createdAt)).toBe(true);
    expect(await hasSeen(conversation, bob.userId, later.message.createdAt)).toBe(false);
  });

  it('a FILE message becomes seen without the file being downloaded', async () => {
    const alice = await createTestIdentity('Alice File');
    const bob = await createTestIdentity('Bob File');
    const conversation = await seedDirectConversation(alice.userId, bob.userId);

    const message = await seedFileMessage(conversation, alice.userId, 'the handbook');

    /*
     * Reading the CONVERSATION is what counts. Requiring a download would mean a file message
     * never showed as seen for somebody who read the caption and moved on — and would tie a read
     * receipt to an attachment fetch, which is a different thing entirely.
     */
    await markConversationRead(db(), bob.userId, conversation, message.id);

    expect(await hasSeen(conversation, bob.userId, message.createdAt)).toBe(true);
    // No download happened: the attachment is untouched.
    const attachment = await db().attachment.findUniqueOrThrow({
      where: { messageId: message.id },
      select: { status: true },
    });
    expect(attachment.status).toBe('READY');
  });

  it('the marker only ever moves forward', async () => {
    const alice = await createTestIdentity('Alice Fwd');
    const bob = await createTestIdentity('Bob Fwd');
    const conversation = await seedDirectConversation(alice.userId, bob.userId);

    const first = await send(conversation, alice.userId, 'one');
    const second = await send(conversation, alice.userId, 'two');

    await markConversationRead(db(), bob.userId, conversation, second.message.id);
    const after = await watermarkOf(conversation, bob.userId);

    // A stale request from a second tab naming an older message must not un-see anything.
    const result = await markConversationRead(db(), bob.userId, conversation, first.message.id);

    expect(result.moved).toBe(false);
    expect((await watermarkOf(conversation, bob.userId))?.getTime()).toBe(after?.getTime());
    expect(await hasSeen(conversation, bob.userId, second.message.createdAt)).toBe(true);
  });

  it('reports whether the marker moved, so a no-op announces nothing', async () => {
    const alice = await createTestIdentity('Alice Moved');
    const bob = await createTestIdentity('Bob Moved');
    const conversation = await seedDirectConversation(alice.userId, bob.userId);

    const { message } = await send(conversation, alice.userId, 'hello');

    expect((await markConversationRead(db(), bob.userId, conversation, message.id)).moved).toBe(true);
    // Re-opening a conversation already read to the end changes nothing and must not be broadcast.
    expect((await markConversationRead(db(), bob.userId, conversation, message.id)).moved).toBe(false);
  });
});

/* --------------------------------------------------------------------------------------------- */
/* Seen survives the Batch 1 / 1.1 message actions                                                  */
/* --------------------------------------------------------------------------------------------- */

suite('Seen is not disturbed by other message actions', () => {
  afterAll(async () => {
    await cleanUp();
    await disconnect();
  });

  async function readConversation() {
    const alice = await createTestIdentity('Alice Compat');
    const bob = await createTestIdentity('Bob Compat');
    const conversation = await seedDirectConversation(alice.userId, bob.userId);
    const { message } = await send(conversation, alice.userId, 'original text');
    await markConversationRead(db(), bob.userId, conversation, message.id);
    return { alice, bob, conversation, message };
  }

  it('EDITING does not reset it, and creates no unread', async () => {
    const { alice, bob, conversation, message } = await readConversation();
    const before = await watermarkOf(conversation, bob.userId);

    await editMessage(db(), {
      userId: alice.userId,
      messageId: message.id,
      body: 'corrected text',
    });

    /*
     * An edit changes `body` and `editedAt` and nothing else — in particular not `createdAt`,
     * which is what the watermark is compared against. So a message already read stays read, and
     * editing cannot resurrect it as unread in somebody's sidebar.
     */
    expect((await watermarkOf(conversation, bob.userId))?.getTime()).toBe(before?.getTime());
    expect(await hasSeen(conversation, bob.userId, message.createdAt)).toBe(true);
  });

  it('a REACTION does not affect it', async () => {
    const { bob, conversation, message } = await readConversation();
    await setReaction(db(), { userId: bob.userId, messageId: message.id, emoji: '👍' });
    expect(await hasSeen(conversation, bob.userId, message.createdAt)).toBe(true);
  });

  it('a PIN does not affect it', async () => {
    const { bob, conversation, message } = await readConversation();
    await setPinned(db(), { userId: bob.userId, messageId: message.id, pinned: true });
    expect(await hasSeen(conversation, bob.userId, message.createdAt)).toBe(true);
  });

  it('DELETE FOR ME by one person does not touch anybody’s read state', async () => {
    const { alice, bob, conversation, message } = await readConversation();
    const aliceBefore = await watermarkOf(conversation, alice.userId);

    await hideMessageForUser(db(), { userId: bob.userId, messageId: message.id });

    // Bob's own hide is a view preference. It changes neither his watermark nor Alice's.
    expect(await hasSeen(conversation, bob.userId, message.createdAt)).toBe(true);
    expect((await watermarkOf(conversation, alice.userId))?.getTime()).toBe(aliceBefore?.getTime());
  });

  it('a REPLY gets its own read state, independent of what it quotes', async () => {
    const { alice, bob, conversation, message } = await readConversation();

    const reply = await send(conversation, alice.userId, 'and one more thing', message.id);

    // The quoted message is read; the reply is a new message and is not.
    expect(await hasSeen(conversation, bob.userId, message.createdAt)).toBe(true);
    expect(await hasSeen(conversation, bob.userId, reply.message.createdAt)).toBe(false);
  });

  it('a FORWARDED copy gets its own read state in its own conversation', async () => {
    const alice = await createTestIdentity('Alice FwdRead');
    const bob = await createTestIdentity('Bob FwdRead');
    const carol = await createTestIdentity('Carol FwdRead');

    const first = await seedDirectConversation(alice.userId, bob.userId);
    const second = await seedDirectConversation(alice.userId, carol.userId);

    const original = await send(first, alice.userId, 'worth passing on');
    await markConversationRead(db(), bob.userId, first, original.message.id);

    const copy = await db().message.create({
      data: {
        conversationId: second,
        senderId: alice.userId,
        type: 'TEXT',
        body: 'worth passing on',
        clientMessageId: uuid(),
        isForwarded: true,
      },
      select: { id: true, createdAt: true },
    });

    // Bob read the original. Carol has read nothing: the copy is an independent message in an
    // independent conversation, and read state does not travel with a forward.
    expect(await hasSeen(first, bob.userId, original.message.createdAt)).toBe(true);
    expect(await hasSeen(second, carol.userId, copy.createdAt)).toBe(false);
  });
});

/* --------------------------------------------------------------------------------------------- */
/* Groups — Message info                                                                            */
/* --------------------------------------------------------------------------------------------- */

suite('groups: message info', () => {
  afterAll(async () => {
    await cleanUp();
    await disconnect();
  });

  it('splits the group into read and not-read, excluding the sender', async () => {
    const owner = await createTestIdentity('Owner Info');
    const reader = await createTestIdentity('Reader Info');
    const idler = await createTestIdentity('Idler Info');

    const conversation = await seedGroupConversation(owner.userId, [
      { userId: reader.userId },
      { userId: idler.userId },
    ]);

    const { message } = await send(conversation, owner.userId, 'morning everyone');
    await markConversationRead(db(), reader.userId, conversation, message.id);

    const status = await readStatusForMessage(db(), {
      userId: owner.userId,
      messageId: message.id,
    });

    expect(status.readBy.map((entry) => entry.userId)).toEqual([reader.userId]);
    expect(status.notReadBy.map((entry) => entry.userId)).toEqual([idler.userId]);

    // The sender appears in neither list: "have I read my own message" is not a question.
    const everyone = [...status.readBy, ...status.notReadBy].map((entry) => entry.userId);
    expect(everyone).not.toContain(owner.userId);
  });

  it('EXCLUDES somebody who joined after the message was sent', async () => {
    const owner = await createTestIdentity('Owner Late');
    const early = await createTestIdentity('Early Late');
    const latecomer = await createTestIdentity('Latecomer Late');

    const joinedAt = new Date();
    const conversation = await seedGroupConversation(owner.userId, [
      { userId: early.userId, joinedAt: new Date(joinedAt.getTime() - 3_600_000) },
      { userId: latecomer.userId, joinedAt },
    ]);
    await backdateJoin(conversation, owner.userId, new Date(joinedAt.getTime() - 3_600_000));

    const old = await seedMessageAt(
      conversation,
      owner.userId,
      'said before the latecomer arrived',
      new Date(joinedAt.getTime() - 60_000),
    );

    const status = await readStatusForMessage(db(), { userId: owner.userId, messageId: old.id });
    const everyone = [...status.readBy, ...status.notReadBy].map((entry) => entry.userId);

    /*
     * The latecomer is NOT "not read". The message was never theirs to see (D-03), so reporting
     * them as not having read it would both misdescribe them and disclose the shape of history
     * they have no access to.
     */
    expect(everyone).not.toContain(latecomer.userId);
    expect(everyone).toContain(early.userId);
  });

  it('keeps a departed member in Read by, and out of Not read by', async () => {
    const owner = await createTestIdentity('Owner Left');
    const leaver = await createTestIdentity('Leaver Left');
    const stayer = await createTestIdentity('Stayer Left');

    const conversation = await seedGroupConversation(owner.userId, [
      { userId: leaver.userId },
      { userId: stayer.userId },
    ]);

    const { message } = await send(conversation, owner.userId, 'before anyone left');
    await markConversationRead(db(), leaver.userId, conversation, message.id);

    // Leaving sets `leftAt` and clears nothing, so the watermark survives the departure.
    await db().conversationMember.updateMany({
      where: { conversationId: conversation, userId: leaver.userId },
      data: { leftAt: new Date() },
    });

    const status = await readStatusForMessage(db(), {
      userId: owner.userId,
      messageId: message.id,
    });

    // They read it. That stayed true when they left, and it is reported — flagged, so the sender
    // is not left wondering why a former colleague is in the list.
    expect(status.readBy).toEqual([{ userId: leaver.userId, stillMember: false }]);
    // And they are not held in "Not read by" for ever: they are not going to read it now.
    expect(status.notReadBy.map((entry) => entry.userId)).toEqual([stayer.userId]);
  });

  it('drops a departed member who never read it from both lists', async () => {
    const owner = await createTestIdentity('Owner Gone');
    const gone = await createTestIdentity('Gone Gone');

    const conversation = await seedGroupConversation(owner.userId, [{ userId: gone.userId }]);
    const { message } = await send(conversation, owner.userId, 'unread and then they left');

    await db().conversationMember.updateMany({
      where: { conversationId: conversation, userId: gone.userId },
      data: { leftAt: new Date() },
    });

    const status = await readStatusForMessage(db(), {
      userId: owner.userId,
      messageId: message.id,
    });

    expect(status.readBy).toEqual([]);
    expect(status.notReadBy).toEqual([]);
  });

  it('REFUSES a request for somebody else’s message', async () => {
    const owner = await createTestIdentity('Owner Refuse');
    const member = await createTestIdentity('Member Refuse');

    const conversation = await seedGroupConversation(owner.userId, [{ userId: member.userId }]);
    const { message } = await send(conversation, owner.userId, 'mine, not yours');

    // A legitimate member of the group. This is not an access problem, it is an ownership one —
    // read status is "who has seen what I said", never a way to watch colleagues.
    await expect(
      readStatusForMessage(db(), { userId: member.userId, messageId: message.id }),
    ).rejects.toMatchObject({ reason: 'NOT_THE_SENDER' });
  });

  it('refuses somebody outside the conversation entirely', async () => {
    const owner = await createTestIdentity('Owner Outside');
    const member = await createTestIdentity('Member Outside');
    const outsider = await createTestIdentity('Outsider Outside');

    const conversation = await seedGroupConversation(owner.userId, [{ userId: member.userId }]);
    const { message } = await send(conversation, owner.userId, 'private to this group');

    await expect(
      readStatusForMessage(db(), { userId: outsider.userId, messageId: message.id }),
    ).rejects.toMatchObject({ reason: 'NOT_ACCESSIBLE' });
  });

  it('refuses a deleted message rather than describing it', async () => {
    const owner = await createTestIdentity('Owner Tomb');
    const member = await createTestIdentity('Member Tomb');

    const conversation = await seedGroupConversation(owner.userId, [{ userId: member.userId }]);
    const { message } = await send(conversation, owner.userId, 'about to be deleted');
    await deleteMessageForEveryone(db(), { userId: owner.userId, messageId: message.id });

    await expect(
      readStatusForMessage(db(), { userId: owner.userId, messageId: message.id }),
    ).rejects.toMatchObject({ reason: 'NOT_ACTIONABLE' });
  });

  it('an EDIT preserves who had already read it', async () => {
    const owner = await createTestIdentity('Owner EditInfo');
    const reader = await createTestIdentity('Reader EditInfo');

    const conversation = await seedGroupConversation(owner.userId, [{ userId: reader.userId }]);
    const { message } = await send(conversation, owner.userId, 'first wording');
    await markConversationRead(db(), reader.userId, conversation, message.id);

    await editMessage(db(), {
      userId: owner.userId,
      messageId: message.id,
      body: 'second wording',
    });

    const status = await readStatusForMessage(db(), {
      userId: owner.userId,
      messageId: message.id,
    });
    expect(status.readBy.map((entry) => entry.userId)).toEqual([reader.userId]);
    expect(status.notReadBy).toEqual([]);
  });

  it('gives an unknown message id the same refusal as an inaccessible one', async () => {
    const outsider = await createTestIdentity('Outsider Oracle13');
    const owner = await createTestIdentity('Owner Oracle13');
    const member = await createTestIdentity('Member Oracle13');

    const conversation = await seedGroupConversation(owner.userId, [{ userId: member.userId }]);
    const { message } = await send(conversation, owner.userId, 'real');

    const forReal = await readStatusForMessage(db(), {
      userId: outsider.userId,
      messageId: message.id,
    }).catch((error: unknown) => error);
    const forNothing = await readStatusForMessage(db(), {
      userId: outsider.userId,
      messageId: uuid(),
    }).catch((error: unknown) => error);

    // Identical reason AND identical text: anything that differed would answer "does this id
    // exist?" for somebody with no right to ask.
    expect(forReal).toMatchObject({ reason: 'NOT_ACCESSIBLE' });
    expect(forNothing).toMatchObject({ reason: 'NOT_ACCESSIBLE' });
    expect((forReal as Error).message).toBe((forNothing as Error).message);
  });

  it('reading does not change the unread count of anybody else, or create a message', async () => {
    const owner = await createTestIdentity('Owner Quiet13');
    const reader = await createTestIdentity('Reader Quiet13');
    const other = await createTestIdentity('Other Quiet13');

    const conversation = await seedGroupConversation(owner.userId, [
      { userId: reader.userId },
      { userId: other.userId },
    ]);
    const { message } = await send(conversation, owner.userId, 'one message only');

    const before = await db().message.count({ where: { conversationId: conversation } });
    const otherBefore = await watermarkOf(conversation, other.userId);

    await markConversationRead(db(), reader.userId, conversation, message.id);

    // Reading is not sending: no row is written, and nobody else's state moves.
    expect(await db().message.count({ where: { conversationId: conversation } })).toBe(before);
    expect(await watermarkOf(conversation, other.userId)).toBe(otherBefore);
  });
});
