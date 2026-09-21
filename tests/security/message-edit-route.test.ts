/**
 * `PATCH /api/messages/:id`, exercised as an attacker would reach it (Batch 1.1).
 *
 * `tests/chat/message-edit.test.ts` proves the SERVICE refuses. This file proves the HTTP surface
 * in front of it refuses too — that the route takes the acting user from the cookie and never from
 * the request, that no combination of a valid session and somebody else's message id gets past it,
 * and that nothing in the request body can reach a column it has no business naming.
 *
 * A correct service behind a route that passes it a user id from the body is still a
 * vulnerability, and a route tested only through the service it calls would never show it. These
 * construct real `Request` objects and call the exported handler directly.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { PATCH as editRoute } from '@/app/api/messages/[id]/route';
import type { ApiErrorWire, MessageMutationWire } from '@/lib/chat/wire';
import { MAX_MESSAGE_LENGTH, sendMessage } from '@/lib/messages/service';

import {
  buildRequest,
  cleanUp,
  createTestIdentity,
  databaseConfigured,
  db,
  disconnect,
  params,
  readResponse,
  seedDirectConversation,
  uuid,
} from '../chat/harness';

const suite = databaseConfigured ? describe : describe.skip;

async function send(conversationId: string, senderId: string, body: string) {
  return sendMessage(db(), { senderId, conversationId, body, clientMessageId: uuid() });
}

/** One PATCH, exactly as a browser would make it. */
async function patch(
  messageId: string,
  cookie: string | undefined,
  body: unknown,
): Promise<{ status: number; body: MessageMutationWire & ApiErrorWire }> {
  return readResponse(
    await editRoute(
      buildRequest({
        url: `/api/messages/${messageId}`,
        method: 'PATCH',
        ...(cookie === undefined ? {} : { cookie }),
        body,
      }),
      params({ id: messageId }),
    ),
  );
}

suite('PATCH /api/messages/:id', () => {
  afterAll(async () => {
    await cleanUp();
    await disconnect();
  });

  it('refuses without a session', async () => {
    const response = await patch(uuid(), undefined, { body: 'anything' });
    expect(response.status).toBe(401);
  });

  it('edits the caller’s own message', async () => {
    const alice = await createTestIdentity('Alice PatchOK');
    const bob = await createTestIdentity('Bob PatchOK');
    const conversation = await seedDirectConversation(alice.userId, bob.userId);
    const { message } = await send(conversation, alice.userId, 'before');

    const response = await patch(message.id, alice.cookie, { body: 'after' });

    expect(response.status).toBe(200);
    expect(response.body.message.id).toBe(message.id);
    expect(response.body.message.body).toBe('after');
    expect(response.body.message.editedAt).not.toBeNull();
    // The id and timestamp a browser sees are the ones it had: an edit is the same message.
    expect(response.body.message.createdAt).toBe(message.createdAt.toISOString());
  });

  it('refuses a member of the conversation who did not send the message', async () => {
    const alice = await createTestIdentity('Alice PatchOwn');
    const bob = await createTestIdentity('Bob PatchOther');
    const conversation = await seedDirectConversation(alice.userId, bob.userId);
    const { message } = await send(conversation, alice.userId, 'alice wrote this');

    const response = await patch(message.id, bob.cookie, { body: 'bob rewrote it' });

    expect(response.status).toBe(403);
    const row = await db().message.findUniqueOrThrow({ where: { id: message.id } });
    expect(row.body).toBe('alice wrote this');
    expect(row.editedAt).toBeNull();
  });

  it('refuses somebody outside the conversation, and tells them nothing', async () => {
    const alice = await createTestIdentity('Alice PatchPriv');
    const bob = await createTestIdentity('Bob PatchPriv');
    const outsider = await createTestIdentity('Outsider Patch');
    const conversation = await seedDirectConversation(alice.userId, bob.userId);
    const { message } = await send(conversation, alice.userId, 'private');

    const real = await patch(message.id, outsider.cookie, { body: 'x' });
    const invented = await patch(uuid(), outsider.cookie, { body: 'x' });

    /*
     * Identical status AND identical body.
     *
     * If the answer for a real message id differed in any way from the answer for one that does
     * not exist, this endpoint would answer "does this message exist?" for anybody holding a
     * session — which is an id-enumeration oracle over every conversation in the company.
     */
    expect(real.status).toBe(403);
    expect(invented.status).toBe(403);
    expect(JSON.stringify(real.body)).toBe(JSON.stringify(invented.body));
  });

  /* ------------------------------------------------------------------------------------------ */
  /* Mass assignment                                                                              */
  /* ------------------------------------------------------------------------------------------ */

  it('refuses a request that tries to set anything but the text', async () => {
    const alice = await createTestIdentity('Alice Mass');
    const bob = await createTestIdentity('Bob Mass');
    const victim = await createTestIdentity('Victim Mass');
    const other = await seedDirectConversation(alice.userId, victim.userId);
    const conversation = await seedDirectConversation(alice.userId, bob.userId);

    const { message } = await send(conversation, alice.userId, 'original');
    const before = await db().message.findUniqueOrThrow({ where: { id: message.id } });

    /*
     * Every column an attacker would most want to reach, tried one at a time. Each is a field the
     * database has and the request has no business naming.
     */
    const attempts: Record<string, unknown>[] = [
      { body: 'x', senderId: bob.userId },
      { body: 'x', conversationId: other },
      { body: 'x', createdAt: '2020-01-01T00:00:00.000Z' },
      { body: 'x', editedAt: '2020-01-01T00:00:00.000Z' },
      { body: 'x', deletedAt: null },
      { body: 'x', replyToId: uuid() },
      { body: 'x', isForwarded: true },
      { body: 'x', pinnedAt: new Date().toISOString() },
      { body: 'x', type: 'SYSTEM' },
      { body: 'x', clientMessageId: uuid() },
      { body: 'x', attachment: { id: uuid() } },
      { body: 'x', attachmentId: uuid() },
      { body: 'x', reactions: [{ emoji: '👍' }] },
      { body: 'x', id: uuid() },
    ];

    for (const attempt of attempts) {
      const response = await patch(message.id, alice.cookie, attempt);
      expect(response.status, JSON.stringify(attempt)).toBe(400);
    }

    // Refused outright rather than accepted-with-the-extras-ignored, so nothing changed at all —
    // not even the text, which the caller was otherwise entitled to change.
    const after = await db().message.findUniqueOrThrow({ where: { id: message.id } });
    expect(after.body).toBe(before.body);
    expect(after.senderId).toBe(before.senderId);
    expect(after.conversationId).toBe(before.conversationId);
    expect(after.createdAt.getTime()).toBe(before.createdAt.getTime());
    expect(after.editedAt).toBeNull();
    expect(after.replyToId).toBeNull();
    expect(after.isForwarded).toBe(false);
    expect(after.pinnedAt).toBeNull();
    expect(after.type).toBe('TEXT');
  });

  /* ------------------------------------------------------------------------------------------ */
  /* Malformed input                                                                              */
  /* ------------------------------------------------------------------------------------------ */

  it('refuses a malformed request', async () => {
    const alice = await createTestIdentity('Alice Malformed');
    const bob = await createTestIdentity('Bob Malformed');
    const conversation = await seedDirectConversation(alice.userId, bob.userId);
    const { message } = await send(conversation, alice.userId, 'intact');

    const bad: unknown[] = [
      {},                                        // no text at all
      { body: 42 },                              // not a string
      { body: null },
      { body: ['an', 'array'] },
      { body: { nested: 'object' } },
      { body: 'x'.repeat(MAX_MESSAGE_LENGTH + 1) }, // past the ceiling
      'a bare string',
      [],
    ];

    for (const payload of bad) {
      const response = await patch(message.id, alice.cookie, payload);
      expect(response.status, JSON.stringify(payload)).toBe(400);
    }

    const row = await db().message.findUniqueOrThrow({ where: { id: message.id } });
    expect(row.body).toBe('intact');
    expect(row.editedAt).toBeNull();
  });

  it('refuses a message id that is not a uuid, without reaching the database', async () => {
    const alice = await createTestIdentity('Alice BadId');

    for (const id of ['not-a-uuid', '../../etc/passwd', "1' OR '1'='1", '00000000']) {
      const response = await readResponse<ApiErrorWire>(
        await editRoute(
          buildRequest({
            url: `/api/messages/${encodeURIComponent(id)}`,
            method: 'PATCH',
            cookie: alice.cookie,
            body: { body: 'x' },
          }),
          params({ id }),
        ),
      );
      expect(response.status, id).toBe(400);
    }
  });

  it('refuses emptying a text message but accepts clearing a file caption', async () => {
    const alice = await createTestIdentity('Alice EmptyRoute');
    const bob = await createTestIdentity('Bob EmptyRoute');
    const conversation = await seedDirectConversation(alice.userId, bob.userId);

    const { message } = await send(conversation, alice.userId, 'has words');
    expect((await patch(message.id, alice.cookie, { body: '   ' })).status).toBe(400);

    // The same empty string on a file message is a legitimate edit: it clears the caption and
    // leaves the file. The route does not decide this — the service does, from the message.
    const file = await db().message.create({
      data: {
        conversationId: conversation,
        senderId: alice.userId,
        type: 'FILE',
        body: 'a caption',
        clientMessageId: uuid(),
      },
      select: { id: true },
    });
    await db().attachment.create({
      data: {
        conversationId: conversation,
        messageId: file.id,
        uploaderId: alice.userId,
        originalFilename: 'notes.txt',
        storageKey: `2026/09/${uuid()}.bin`,
        byteSize: BigInt(12),
        mimeType: 'text/plain',
        extension: 'txt',
        status: 'READY',
      },
    });

    const cleared = await patch(file.id, alice.cookie, { body: '' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.message.body).toBeNull();
    expect(cleared.body.message.attachment).not.toBeNull();
  });
});
