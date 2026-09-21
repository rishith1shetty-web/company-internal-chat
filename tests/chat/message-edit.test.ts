/**
 * Editing a message (Batch 1.1).
 *
 * These exercise the SERVICE, which is where every authorization decision is made. The context
 * menu decides what to offer and decides nothing about what is allowed, so a test driving the
 * interface would prove far less than these do — `tests/security/message-edit-route.test.ts`
 * covers the HTTP surface in front of them.
 *
 * Editing is the only action in the system that changes what a message SAYS, which makes it the
 * one where getting authorization wrong rewrites history in somebody else's name. The properties
 * this file is mostly about:
 *
 *   - Only the original sender, proved from the stored `senderId` rather than from the request.
 *   - D-03 still holds: a message from before you joined is not yours to reach, edit included.
 *   - An edit changes `body` and `editedAt` and NOTHING else — not the id, the timestamp, the
 *     sender, the conversation, the reply target, the forward flag, the attachment, the pin, the
 *     reactions or anybody's hide.
 *   - An edit is not a new message: no unread, no `lastMessageAt`, no reordering.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { listConversationsForUser } from '@/lib/conversations/service';
import {
  MessageActionError,
  deleteMessageForEveryone,
  editMessage,
  hideMessageForUser,
  setPinned,
  setReaction,
} from '@/lib/messages/actions';
import { MAX_MESSAGE_LENGTH, listMessages, sendMessage } from '@/lib/messages/service';
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

async function send(conversationId: string, senderId: string, body: string, replyToId?: string) {
  return sendMessage(db(), {
    senderId,
    conversationId,
    body,
    clientMessageId: uuid(),
    ...(replyToId === undefined ? {} : { replyToId }),
  });
}

/** Captures the refusal a call is expected to make, narrowed so its reason can be compared. */
async function refusalOf(promise: Promise<unknown>): Promise<MessageActionError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof MessageActionError) return error;
    throw error;
  }
  throw new Error('expected the call to be refused, but it succeeded');
}

/**
 * Moves a member's join time backwards.
 *
 * `seedGroupConversation` stamps the owner's join at "now", so a message seeded in the past would
 * be outside the OWNER's window too — and a test meaning to prove the latecomer is excluded would
 * pass for the wrong reason, excluding everybody.
 */
async function backdateJoin(conversationId: string, userId: string, joinedAt: Date): Promise<void> {
  await db().conversationMember.updateMany({
    where: { conversationId, userId },
    data: { joinedAt },
  });
}

/**
 * A `FILE` message with a caption and a `READY` attachment row.
 *
 * No bytes are written: editing never touches storage, and a test that wrote a file to prove that
 * would be testing the filesystem rather than the rule.
 */
async function seedFileMessage(
  conversationId: string,
  senderId: string,
  caption: string | null,
): Promise<{ messageId: string; attachmentId: string; storageKey: string }> {
  const storageKey = `2026/09/${uuid()}.bin`;

  const message = await db().message.create({
    data: {
      conversationId,
      senderId,
      type: 'FILE',
      body: caption,
      clientMessageId: uuid(),
    },
    select: { id: true },
  });

  const attachment = await db().attachment.create({
    data: {
      conversationId,
      messageId: message.id,
      uploaderId: senderId,
      originalFilename: 'quarterly-report.pdf',
      storageKey,
      byteSize: BigInt(2048),
      mimeType: 'application/pdf',
      extension: 'pdf',
      checksumSha256: 'a'.repeat(64),
      status: 'READY',
    },
    select: { id: true },
  });

  return { messageId: message.id, attachmentId: attachment.id, storageKey };
}

suite('editing a message', () => {
  afterAll(async () => {
    await cleanUp();
    await disconnect();
  });

  /* ------------------------------------------------------------------------------------------ */
  /* What can be edited                                                                           */
  /* ------------------------------------------------------------------------------------------ */

  it('rewrites the sender’s own text message and stamps editedAt', async () => {
    const alice = await createTestIdentity('Alice Edit');
    const bob = await createTestIdentity('Bob Edit');
    const conversation = await seedDirectConversation(alice.userId, bob.userId);

    const { message } = await send(conversation, alice.userId, 'origianl typo');
    expect(message.editedAt).toBeNull();

    const { message: edited } = await editMessage(db(), {
      userId: alice.userId,
      messageId: message.id,
      body: 'original, corrected',
    });

    expect(edited.body).toBe('original, corrected');
    expect(edited.editedAt).not.toBeNull();
  });

  it('rewrites the caption of a file message and leaves the file alone', async () => {
    const alice = await createTestIdentity('Alice Caption');
    const bob = await createTestIdentity('Bob Caption');
    const conversation = await seedDirectConversation(alice.userId, bob.userId);

    const { messageId, attachmentId, storageKey } = await seedFileMessage(
      conversation,
      alice.userId,
      'Q3 numbres',
    );

    const { message } = await editMessage(db(), {
      userId: alice.userId,
      messageId,
      body: 'Q3 numbers',
    });

    expect(message.body).toBe('Q3 numbers');
    expect(message.attachment?.id).toBe(attachmentId);

    // The attachment row is byte-for-byte what it was: same file, same key, same status.
    const attachment = await db().attachment.findUniqueOrThrow({ where: { id: attachmentId } });
    expect(attachment.storageKey).toBe(storageKey);
    expect(attachment.status).toBe('READY');
    expect(attachment.originalFilename).toBe('quarterly-report.pdf');
    expect(attachment.byteSize).toBe(BigInt(2048));
  });

  it('edits a forwarded message without touching the source or its forward flag', async () => {
    const alice = await createTestIdentity('Alice Fwd');
    const bob = await createTestIdentity('Bob Fwd');
    const conversation = await seedDirectConversation(alice.userId, bob.userId);

    const { message: source } = await send(conversation, alice.userId, 'the original wording');

    // The destination copy is an independent message in its own right, which is the whole reason
    // it can be edited at all.
    const copy = await db().message.create({
      data: {
        conversationId: conversation,
        senderId: alice.userId,
        type: 'TEXT',
        body: 'the original wording',
        clientMessageId: uuid(),
        isForwarded: true,
      },
      select: { id: true },
    });

    const { message: edited } = await editMessage(db(), {
      userId: alice.userId,
      messageId: copy.id,
      body: 'my own words now',
    });

    expect(edited.body).toBe('my own words now');
    // The "Forwarded" label stays: where it came from did not change because its text did.
    expect(edited.isForwarded).toBe(true);

    // And the message it was copied from is untouched.
    const original = await db().message.findUniqueOrThrow({ where: { id: source.id } });
    expect(original.body).toBe('the original wording');
    expect(original.editedAt).toBeNull();
  });

  it('edits a reply, and edits a message that has replies pointing at it', async () => {
    const alice = await createTestIdentity('Alice Thread');
    const bob = await createTestIdentity('Bob Thread');
    const conversation = await seedDirectConversation(alice.userId, bob.userId);

    const { message: parent } = await send(conversation, alice.userId, 'the qeustion');
    const { message: reply } = await send(conversation, bob.userId, 'my anwser', parent.id);

    // The reply is Bob's, and he can edit it. Its link to the parent survives.
    const { message: editedReply } = await editMessage(db(), {
      userId: bob.userId,
      messageId: reply.id,
      body: 'my answer',
    });
    expect(editedReply.body).toBe('my answer');
    expect(editedReply.replyTo?.id).toBe(parent.id);

    // The parent is Alice's, and having a reply hanging off it does not make it uneditable.
    const { message: editedParent } = await editMessage(db(), {
      userId: alice.userId,
      messageId: parent.id,
      body: 'the question',
    });
    expect(editedParent.body).toBe('the question');

    // The reply still points where it did.
    const replyRow = await db().message.findUniqueOrThrow({ where: { id: reply.id } });
    expect(replyRow.replyToId).toBe(parent.id);
  });

  /* ------------------------------------------------------------------------------------------ */
  /* What an edit must not disturb                                                                */
  /* ------------------------------------------------------------------------------------------ */

  it('changes the text and nothing else about the row', async () => {
    const alice = await createTestIdentity('Alice Intact');
    const bob = await createTestIdentity('Bob Intact');
    const conversation = await seedDirectConversation(alice.userId, bob.userId);

    const { message: parent } = await send(conversation, bob.userId, 'something to answer');
    const { message } = await send(conversation, alice.userId, 'befoer', parent.id);

    const before = await db().message.findUniqueOrThrow({ where: { id: message.id } });
    await db().message.update({ where: { id: message.id }, data: { isForwarded: true } });

    await editMessage(db(), { userId: alice.userId, messageId: message.id, body: 'after' });

    const after = await db().message.findUniqueOrThrow({ where: { id: message.id } });

    expect(after.id).toBe(before.id);
    expect(after.createdAt.getTime()).toBe(before.createdAt.getTime());
    expect(after.senderId).toBe(before.senderId);
    expect(after.conversationId).toBe(before.conversationId);
    expect(after.clientMessageId).toBe(before.clientMessageId);
    expect(after.replyToId).toBe(parent.id);
    expect(after.isForwarded).toBe(true);
    expect(after.deletedAt).toBeNull();
    expect(after.type).toBe('TEXT');

    // The two that are supposed to change.
    expect(after.body).toBe('after');
    expect(after.editedAt).not.toBeNull();
  });

  it('preserves reactions, the pin, and other people’s delete-for-me', async () => {
    const alice = await createTestIdentity('Alice Keep');
    const bob = await createTestIdentity('Bob Keep');
    const conversation = await seedDirectConversation(alice.userId, bob.userId);

    const { message } = await send(conversation, alice.userId, 'decorated');

    await setReaction(db(), { userId: bob.userId, messageId: message.id, emoji: '👍' });
    await setPinned(db(), { userId: bob.userId, messageId: message.id, pinned: true });
    await hideMessageForUser(db(), { userId: bob.userId, messageId: message.id });

    const { message: edited } = await editMessage(db(), {
      userId: alice.userId,
      messageId: message.id,
      body: 'still decorated',
    });

    expect(edited.reactions).toHaveLength(1);
    expect(edited.reactions[0]?.emoji).toBe('👍');
    expect(edited.pinnedAt).not.toBeNull();

    // Bob hid it for himself before the edit; editing must not push it back into his view.
    expect(await db().messageHide.count({ where: { messageId: message.id, userId: bob.userId } }))
      .toBe(1);
    const bobsView = await listMessages(db(), { userId: bob.userId, conversationId: conversation });
    expect(bobsView.messages.some((item) => item.id === message.id)).toBe(false);
  });

  it('can still be deleted for everyone after being edited', async () => {
    const alice = await createTestIdentity('Alice Then Delete');
    const bob = await createTestIdentity('Bob Then Delete');
    const conversation = await seedDirectConversation(alice.userId, bob.userId);

    const { message } = await send(conversation, alice.userId, 'first version');
    await editMessage(db(), { userId: alice.userId, messageId: message.id, body: 'second' });

    const deleted = await deleteMessageForEveryone(db(), {
      userId: alice.userId,
      messageId: message.id,
    });

    expect(deleted.message.deletedAt).not.toBeNull();
    expect(deleted.message.body).toBeNull();
  });

  /* ------------------------------------------------------------------------------------------ */
  /* Who may edit                                                                                 */
  /* ------------------------------------------------------------------------------------------ */

  it('refuses a member of the same conversation who did not send it', async () => {
    const alice = await createTestIdentity('Alice Owner E');
    const bob = await createTestIdentity('Bob Member E');
    const conversation = await seedDirectConversation(alice.userId, bob.userId);

    const { message } = await send(conversation, alice.userId, 'alice wrote this');

    // Bob is a legitimate member. This is not an access problem, it is an ownership one.
    await expect(
      editMessage(db(), { userId: bob.userId, messageId: message.id, body: 'bob rewrote it' }),
    ).rejects.toMatchObject({ reason: 'NOT_THE_SENDER' });

    const row = await db().message.findUniqueOrThrow({ where: { id: message.id } });
    expect(row.body).toBe('alice wrote this');
    expect(row.editedAt).toBeNull();
  });

  it('refuses somebody who is not in the conversation at all', async () => {
    const alice = await createTestIdentity('Alice Private E');
    const bob = await createTestIdentity('Bob Private E');
    const outsider = await createTestIdentity('Outsider E');
    const conversation = await seedDirectConversation(alice.userId, bob.userId);

    const { message } = await send(conversation, alice.userId, 'private');

    // The same answer a non-existent id gets: an outsider must not learn that this one is real.
    await expect(
      editMessage(db(), { userId: outsider.userId, messageId: message.id, body: 'hello' }),
    ).rejects.toMatchObject({ reason: 'NOT_ACCESSIBLE' });
  });

  it('gives an unknown message id the same answer as an inaccessible one', async () => {
    const alice = await createTestIdentity('Alice Oracle');
    const bob = await createTestIdentity('Bob Oracle');
    const conversation = await seedDirectConversation(alice.userId, bob.userId);
    const { message } = await send(conversation, alice.userId, 'real message');

    const outsider = await createTestIdentity('Outsider Oracle');

    const forReal = await refusalOf(
      editMessage(db(), { userId: outsider.userId, messageId: message.id, body: 'x' }),
    );
    const forNothing = await refusalOf(
      editMessage(db(), { userId: outsider.userId, messageId: uuid(), body: 'x' }),
    );

    // Identical reason AND identical text: anything that differed would answer "does this id
    // exist?" for somebody with no right to ask.
    expect(forReal.reason).toBe('NOT_ACCESSIBLE');
    expect(forNothing.reason).toBe('NOT_ACCESSIBLE');
    expect(forReal.message).toBe(forNothing.message);
  });

  it('refuses a message sent before the editor joined the group', async () => {
    const owner = await createTestIdentity('Owner Window E');
    const latecomer = await createTestIdentity('Latecomer Window E');

    const joinedAt = new Date();
    const conversation = await seedGroupConversation(owner.userId, [
      { userId: latecomer.userId, joinedAt },
    ]);
    await backdateJoin(conversation, owner.userId, new Date(joinedAt.getTime() - 3_600_000));

    // Written by the LATECOMER but stamped before their join: contrived, and exactly the case
    // that separates "is it yours" from "may you reach it". Ownership alone must not be enough.
    const old = await seedMessageAt(
      conversation,
      latecomer.userId,
      'from before the window',
      new Date(joinedAt.getTime() - 60_000),
    );

    await expect(
      editMessage(db(), { userId: latecomer.userId, messageId: old.id, body: 'reaching back' }),
    ).rejects.toMatchObject({ reason: 'NOT_ACCESSIBLE' });

    const row = await db().message.findUniqueOrThrow({ where: { id: old.id } });
    expect(row.body).toBe('from before the window');
  });

  /* ------------------------------------------------------------------------------------------ */
  /* What cannot be edited                                                                        */
  /* ------------------------------------------------------------------------------------------ */

  it('refuses a message that was deleted for everyone', async () => {
    const alice = await createTestIdentity('Alice Tomb');
    const bob = await createTestIdentity('Bob Tomb');
    const conversation = await seedDirectConversation(alice.userId, bob.userId);

    const { message } = await send(conversation, alice.userId, 'about to go');
    await deleteMessageForEveryone(db(), { userId: alice.userId, messageId: message.id });

    await expect(
      editMessage(db(), { userId: alice.userId, messageId: message.id, body: 'back again' }),
    ).rejects.toMatchObject({ reason: 'NOT_ACTIONABLE' });

    // The tombstone is still a tombstone: an edit must not resurrect cleared text.
    const row = await db().message.findUniqueOrThrow({ where: { id: message.id } });
    expect(row.body).toBeNull();
    expect(row.deletedAt).not.toBeNull();
  });

  it('refuses a SYSTEM message', async () => {
    const owner = await createTestIdentity('Owner System E');
    const member = await createTestIdentity('Member System E');
    const conversation = await seedGroupConversation(owner.userId, [{ userId: member.userId }]);

    // A SYSTEM row has no sender, so nobody can be its sender. Nobody puts words in the server's
    // mouth — not the group's owner either.
    const system = await seedMessageAt(conversation, null, 'Member joined the group', new Date());

    await expect(
      editMessage(db(), { userId: owner.userId, messageId: system.id, body: 'rewritten history' }),
    ).rejects.toMatchObject({ reason: 'NOT_ACTIONABLE' });

    const row = await db().message.findUniqueOrThrow({ where: { id: system.id } });
    expect(row.body).toBe('Member joined the group');
  });

  it('refuses a file message that has no caption to edit', async () => {
    const alice = await createTestIdentity('Alice Bare File');
    const bob = await createTestIdentity('Bob Bare File');
    const conversation = await seedDirectConversation(alice.userId, bob.userId);

    const { messageId } = await seedFileMessage(conversation, alice.userId, null);

    // The menu hides Edit here, and the server agrees rather than being more permissive than the
    // menu: adding a caption after the fact is a different feature.
    await expect(
      editMessage(db(), { userId: alice.userId, messageId, body: 'a caption, belatedly' }),
    ).rejects.toMatchObject({ reason: 'NOT_ACTIONABLE' });
  });

  /* ------------------------------------------------------------------------------------------ */
  /* Content rules                                                                                */
  /* ------------------------------------------------------------------------------------------ */

  it('refuses emptying a text message, including with whitespace', async () => {
    const alice = await createTestIdentity('Alice Empty');
    const bob = await createTestIdentity('Bob Empty');
    const conversation = await seedDirectConversation(alice.userId, bob.userId);

    const { message } = await send(conversation, alice.userId, 'has words');

    for (const body of ['', '   ', '\n\n', '\t \r\n ']) {
      await expect(
        editMessage(db(), { userId: alice.userId, messageId: message.id, body }),
      ).rejects.toMatchObject({ reason: 'EMPTY_BODY' });
    }

    const row = await db().message.findUniqueOrThrow({ where: { id: message.id } });
    expect(row.body).toBe('has words');
    expect(row.editedAt).toBeNull();
  });

  it('allows clearing a file caption, leaving an attachment-only message', async () => {
    const alice = await createTestIdentity('Alice Clear');
    const bob = await createTestIdentity('Bob Clear');
    const conversation = await seedDirectConversation(alice.userId, bob.userId);

    const { messageId, attachmentId } = await seedFileMessage(
      conversation,
      alice.userId,
      'a caption nobody wanted',
    );

    const { message } = await editMessage(db(), {
      userId: alice.userId,
      messageId,
      body: '   ',
    });

    // Null rather than an empty string: "no caption" is what a file sent without typing anything
    // produces, and an edited one must be indistinguishable from it.
    expect(message.body).toBeNull();
    expect(message.editedAt).not.toBeNull();
    expect(message.attachment?.id).toBe(attachmentId);
  });

  it('applies the same length limit as sending', async () => {
    const alice = await createTestIdentity('Alice Long');
    const bob = await createTestIdentity('Bob Long');
    const conversation = await seedDirectConversation(alice.userId, bob.userId);

    const { message } = await send(conversation, alice.userId, 'short');

    await expect(
      editMessage(db(), {
        userId: alice.userId,
        messageId: message.id,
        body: 'x'.repeat(MAX_MESSAGE_LENGTH + 1),
      }),
    ).rejects.toMatchObject({ reason: 'BODY_TOO_LONG' });

    // The boundary itself is allowed, so the limit is "at most", not "fewer than".
    const { message: edited } = await editMessage(db(), {
      userId: alice.userId,
      messageId: message.id,
      body: 'y'.repeat(MAX_MESSAGE_LENGTH),
    });
    expect(edited.body).toHaveLength(MAX_MESSAGE_LENGTH);
  });

  it('trims exactly as sending does, and stores text as text', async () => {
    const alice = await createTestIdentity('Alice Normalize');
    const bob = await createTestIdentity('Bob Normalize');
    const conversation = await seedDirectConversation(alice.userId, bob.userId);

    const { message } = await send(conversation, alice.userId, 'plain');

    // Markup is content, not code. It is stored as typed and rendered as text by React, which
    // escapes it — there is no template here to inject into (docs/04-security.md).
    const hostile = '  <script>alert(1)</script> & "quotes"  ';
    const { message: edited } = await editMessage(db(), {
      userId: alice.userId,
      messageId: message.id,
      body: hostile,
    });

    expect(edited.body).toBe('<script>alert(1)</script> & "quotes"');

    // Newlines inside the text survive; only the ends are trimmed.
    const { message: multiline } = await editMessage(db(), {
      userId: alice.userId,
      messageId: message.id,
      body: '  line one\nline two\n\nline four  ',
    });
    expect(multiline.body).toBe('line one\nline two\n\nline four');
  });

  it('treats saving unchanged text as a no-op rather than an edit', async () => {
    const alice = await createTestIdentity('Alice Noop');
    const bob = await createTestIdentity('Bob Noop');
    const conversation = await seedDirectConversation(alice.userId, bob.userId);

    const { message } = await send(conversation, alice.userId, 'unchanged');

    const { message: saved } = await editMessage(db(), {
      userId: alice.userId,
      messageId: message.id,
      body: 'unchanged',
    });

    // A permanent "edited" label on a message whose text never changed would be visible to
    // everybody and impossible for the sender to take back.
    expect(saved.editedAt).toBeNull();
    expect(saved.body).toBe('unchanged');
  });

  /* ------------------------------------------------------------------------------------------ */
  /* An edit is not a new message                                                                 */
  /* ------------------------------------------------------------------------------------------ */

  it('leaves lastMessageAt, the unread count and the sidebar order alone', async () => {
    const alice = await createTestIdentity('Alice Quiet');
    const bob = await createTestIdentity('Bob Quiet');
    const conversation = await seedDirectConversation(alice.userId, bob.userId);

    // Two messages, so the edited one is deliberately NOT the newest: an edit to something said
    // earlier must not drag the conversation to the top of anybody's list.
    const { message: first } = await send(conversation, alice.userId, 'the first thing');
    await send(conversation, alice.userId, 'the latest thing');

    const before = (await listConversationsForUser(db(), bob.userId)).find(
      (item) => item.id === conversation,
    );

    await editMessage(db(), {
      userId: alice.userId,
      messageId: first.id,
      body: 'the first thing, revised',
    });

    const after = (await listConversationsForUser(db(), bob.userId)).find(
      (item) => item.id === conversation,
    );

    expect(after?.lastMessageAt?.getTime()).toBe(before?.lastMessageAt?.getTime());
    expect(after?.unreadCount).toBe(before?.unreadCount);
    // The sidebar preview still describes the newest message, not the edited one.
    expect(after?.lastMessage?.id).toBe(before?.lastMessage?.id);
  });

  it('does not create a message', async () => {
    const alice = await createTestIdentity('Alice Count');
    const bob = await createTestIdentity('Bob Count');
    const conversation = await seedDirectConversation(alice.userId, bob.userId);

    const { message } = await send(conversation, alice.userId, 'one message');
    const before = await db().message.count({ where: { conversationId: conversation } });

    await editMessage(db(), { userId: alice.userId, messageId: message.id, body: 'still one' });

    expect(await db().message.count({ where: { conversationId: conversation } })).toBe(before);
  });

  /* ------------------------------------------------------------------------------------------ */
  /* Serialization and replies                                                                    */
  /* ------------------------------------------------------------------------------------------ */

  it('serializes editedAt for the reader, and never under a tombstone', async () => {
    const alice = await createTestIdentity('Alice Wire');
    const bob = await createTestIdentity('Bob Wire');
    const conversation = await seedDirectConversation(alice.userId, bob.userId);

    const { message, viewerJoinedAt } = await send(conversation, alice.userId, 'v1');

    // An old message that has never been edited carries null, so messages written before this
    // feature existed render exactly as they always did.
    expect(toMessageWire(message, viewerJoinedAt).editedAt).toBeNull();

    const { message: edited } = await editMessage(db(), {
      userId: alice.userId,
      messageId: message.id,
      body: 'v2',
    });

    const wire = toMessageWire(edited, viewerJoinedAt);
    expect(wire.editedAt).toBe(edited.editedAt?.toISOString());
    expect(wire.body).toBe('v2');

    // Deleted for everyone afterwards: the tombstone says it was deleted and nothing more.
    const { message: tombstone } = await deleteMessageForEveryone(db(), {
      userId: alice.userId,
      messageId: message.id,
    });
    const tombstoneWire = toMessageWire(tombstone, viewerJoinedAt);
    expect(tombstoneWire.editedAt).toBeNull();
    expect(tombstoneWire.body).toBeNull();
  });

  it('shows the current text in a reply preview after the quoted message is edited', async () => {
    const alice = await createTestIdentity('Alice Quote');
    const bob = await createTestIdentity('Bob Quote');
    const conversation = await seedDirectConversation(alice.userId, bob.userId);

    const { message: quoted } = await send(conversation, alice.userId, 'the old wording');
    await send(conversation, bob.userId, 'agreed', quoted.id);

    await editMessage(db(), {
      userId: alice.userId,
      messageId: quoted.id,
      body: 'the new wording',
    });

    // The preview is a live join on the quoted row, so it follows the edit without anything
    // being copied forward — there is no stale duplicate of the original text to go out of date.
    const page = await listMessages(db(), { userId: bob.userId, conversationId: conversation });
    const reply = page.messages.find((item) => item.replyTo !== null);
    expect(reply?.replyTo?.body).toBe('the new wording');

    const wire = toMessageWire(reply!, page.viewerJoinedAt);
    expect(wire.replyTo?.body).toBe('the new wording');
  });

  it('still hides an edited quote from a reader outside their window', async () => {
    const owner = await createTestIdentity('Owner Quote Window');
    const latecomer = await createTestIdentity('Latecomer Quote Window');

    const joinedAt = new Date();
    const conversation = await seedGroupConversation(owner.userId, [
      { userId: latecomer.userId, joinedAt },
    ]);
    await backdateJoin(conversation, owner.userId, new Date(joinedAt.getTime() - 3_600_000));

    const old = await seedMessageAt(
      conversation,
      owner.userId,
      'said before you arrived',
      new Date(joinedAt.getTime() - 60_000),
    );

    // The owner edits it — it is inside THEIR window — and then replies to it.
    await editMessage(db(), {
      userId: owner.userId,
      messageId: old.id,
      body: 'edited, still before you arrived',
    });
    const { message: reply } = await send(conversation, owner.userId, 'following up', old.id);

    // Editing must not become a way around D-03: the latecomer sees the reply and an unavailable
    // quote, never the text — not the original wording and not the edited wording.
    const wire = toMessageWire(reply, joinedAt);
    expect(wire.replyTo?.unavailable).toBe(true);
    expect(wire.replyTo?.body).toBeNull();
    expect(wire.replyTo?.deleted).toBe(false);
  });
});
