/**
 * The message-action endpoints, exercised as an attacker would reach them (Batch 1).
 *
 * `tests/chat/message-actions.test.ts` proves the SERVICE refuses. This file proves the HTTP
 * surface in front of it refuses too — that the route handlers take the acting user from the
 * cookie and never from the request, and that no combination of a valid session and somebody
 * else's message id gets past them.
 *
 * Why both. A service that is correct behind a route that passes it a user id from the body is
 * still a vulnerability, and a route tested only through the service it calls would never show
 * it. These construct real `Request` objects and call the exported handlers directly.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { POST as deleteMessage } from '@/app/api/messages/[id]/delete/route';
import { POST as forwardMessage } from '@/app/api/messages/[id]/forward/route';
import { POST as pinMessage } from '@/app/api/messages/[id]/pin/route';
import { PUT as putReaction, DELETE as deleteReaction } from '@/app/api/messages/[id]/reactions/route';
import { GET as listPins } from '@/app/api/conversations/[id]/pins/route';
import type { ApiErrorWire, MessageMutationWire, PinnedMessagesWire } from '@/lib/chat/wire';
import { sendMessage } from '@/lib/messages/service';

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

suite('message action endpoints', () => {
  afterAll(async () => {
    await cleanUp();
    await disconnect();
  });

  /* ------------------------------------------------------------------------------------------ */
  /* Authentication                                                                               */
  /* ------------------------------------------------------------------------------------------ */

  it('refuses every action without a session', async () => {
    const id = uuid();

    const calls = [
      putReaction(
        buildRequest({
          url: `/api/messages/${id}/reactions`,
          method: 'PUT',
          body: { emoji: '👍' },
        }),
        params({ id }),
      ),
      deleteReaction(
        buildRequest({ url: `/api/messages/${id}/reactions`, method: 'DELETE' }),
        params({ id }),
      ),
      pinMessage(buildRequest({ url: `/api/messages/${id}/pin`, method: 'POST' }), params({ id })),
      deleteMessage(
        buildRequest({ url: `/api/messages/${id}/delete`, method: 'POST', body: { scope: 'ME' } }),
        params({ id }),
      ),
      forwardMessage(
        buildRequest({
          url: `/api/messages/${id}/forward`,
          method: 'POST',
          body: { destinations: [{ conversationId: uuid(), clientMessageId: uuid() }] },
        }),
        params({ id }),
      ),
    ];

    for (const call of calls) {
      const response = await readResponse<ApiErrorWire>(await call);
      expect(response.status).toBe(401);
    }
  });

  /* ------------------------------------------------------------------------------------------ */
  /* Authorization — the IDOR surface                                                             */
  /* ------------------------------------------------------------------------------------------ */

  it('refuses a reaction on a message in somebody else’s conversation', async () => {
    const alice = await createTestIdentity('Alice Route');
    const bob = await createTestIdentity('Bob Route');
    const outsider = await createTestIdentity('Outsider Route');

    const conversation = await seedDirectConversation(alice.userId, bob.userId);
    const { message } = await send(conversation, alice.userId, 'private');

    /*
     * A real session, a real message id, a well-formed request. Everything an attacker who had
     * seen the id over somebody's shoulder would have.
     */
    const response = await readResponse<ApiErrorWire>(
      await putReaction(
        buildRequest({
          url: `/api/messages/${message.id}/reactions`,
          method: 'PUT',
          cookie: outsider.cookie,
          body: { emoji: '👍' },
        }),
        params({ id: message.id }),
      ),
    );

    expect(response.status).toBe(403);
    expect(await db().messageReaction.count({ where: { messageId: message.id } })).toBe(0);
  });

  it('refuses DELETE FOR EVERYONE from a member who did not send the message', async () => {
    const alice = await createTestIdentity('Alice Owner');
    const bob = await createTestIdentity('Bob Member');

    const conversation = await seedDirectConversation(alice.userId, bob.userId);
    const { message } = await send(conversation, alice.userId, 'alice wrote this');

    // Bob is a legitimate member of the conversation — this is not an access problem, it is an
    // ownership one, and the route must not confuse the two.
    const response = await readResponse<ApiErrorWire>(
      await deleteMessage(
        buildRequest({
          url: `/api/messages/${message.id}/delete`,
          method: 'POST',
          cookie: bob.cookie,
          body: { scope: 'EVERYONE' },
        }),
        params({ id: message.id }),
      ),
    );

    expect(response.status).toBe(403);

    const row = await db().message.findUniqueOrThrow({ where: { id: message.id } });
    expect(row.deletedAt).toBeNull();
    expect(row.body).toBe('alice wrote this');
  });

  it('allows DELETE FOR ME on a message somebody else sent', async () => {
    const alice = await createTestIdentity('Alice Hider');
    const bob = await createTestIdentity('Bob Hider');

    const conversation = await seedDirectConversation(alice.userId, bob.userId);
    const { message } = await send(conversation, alice.userId, 'bob may hide this');

    const response = await readResponse<null>(
      await deleteMessage(
        buildRequest({
          url: `/api/messages/${message.id}/delete`,
          method: 'POST',
          cookie: bob.cookie,
          body: { scope: 'ME' },
        }),
        params({ id: message.id }),
      ),
    );

    expect(response.status).toBe(204);
    // Hidden for Bob; still there for everyone, including in the database.
    expect(
      await db().messageHide.count({ where: { messageId: message.id, userId: bob.userId } }),
    ).toBe(1);
    expect(await db().message.findUnique({ where: { id: message.id } })).not.toBeNull();
  });

  it('refuses a forward into a conversation the caller is not in', async () => {
    const alice = await createTestIdentity('Alice Fwd');
    const bob = await createTestIdentity('Bob Fwd');
    const carol = await createTestIdentity('Carol Fwd');
    const dave = await createTestIdentity('Dave Fwd');

    const source = await seedDirectConversation(alice.userId, bob.userId);
    const theirs = await seedDirectConversation(carol.userId, dave.userId);
    const { message } = await send(source, alice.userId, 'not for them');

    const response = await readResponse<{ messages: unknown[]; failures: unknown[] }>(
      await forwardMessage(
        buildRequest({
          url: `/api/messages/${message.id}/forward`,
          method: 'POST',
          cookie: alice.cookie,
          body: { destinations: [{ conversationId: theirs, clientMessageId: uuid() }] },
        }),
        params({ id: message.id }),
      ),
    );

    // 207: nothing was delivered, and the caller is told which destination was refused rather
    // than being given a blanket failure.
    expect(response.status).toBe(207);
    expect(response.body?.messages).toHaveLength(0);
    expect(response.body?.failures).toEqual([
      { conversationId: theirs, reason: 'FORBIDDEN' },
    ]);
    expect(await db().message.count({ where: { conversationId: theirs } })).toBe(0);
  });

  it('refuses to pin a message the caller cannot see', async () => {
    const alice = await createTestIdentity('Alice PinRoute');
    const bob = await createTestIdentity('Bob PinRoute');
    const outsider = await createTestIdentity('Outsider PinRoute');

    const conversation = await seedDirectConversation(alice.userId, bob.userId);
    const { message } = await send(conversation, alice.userId, 'theirs');

    const response = await readResponse<ApiErrorWire>(
      await pinMessage(
        buildRequest({
          url: `/api/messages/${message.id}/pin`,
          method: 'POST',
          cookie: outsider.cookie,
        }),
        params({ id: message.id }),
      ),
    );

    expect(response.status).toBe(403);
    expect(
      (await db().message.findUniqueOrThrow({ where: { id: message.id } })).pinnedAt,
    ).toBeNull();
  });

  it('refuses the pinned list for a conversation the caller is not in', async () => {
    const alice = await createTestIdentity('Alice PinList');
    const bob = await createTestIdentity('Bob PinList');
    const outsider = await createTestIdentity('Outsider PinList');

    const conversation = await seedDirectConversation(alice.userId, bob.userId);

    const response = await readResponse<ApiErrorWire>(
      await listPins(
        buildRequest({
          url: `/api/conversations/${conversation}/pins`,
          cookie: outsider.cookie,
        }),
        params({ id: conversation }),
      ),
    );

    expect(response.status).toBe(403);
  });

  /* ------------------------------------------------------------------------------------------ */
  /* Input validation                                                                             */
  /* ------------------------------------------------------------------------------------------ */

  it('refuses an emoji outside the server allow-list', async () => {
    const alice = await createTestIdentity('Alice Emoji');
    const bob = await createTestIdentity('Bob Emoji');
    const conversation = await seedDirectConversation(alice.userId, bob.userId);
    const { message } = await send(conversation, alice.userId, 'hello');

    const response = await readResponse<ApiErrorWire>(
      await putReaction(
        buildRequest({
          url: `/api/messages/${message.id}/reactions`,
          method: 'PUT',
          cookie: alice.cookie,
          // Not an emoji at all. The column is free text, so the allow-list is the only thing
          // stopping arbitrary strings being stored as "reactions".
          body: { emoji: '<img src=x onerror=alert(1)>' },
        }),
        params({ id: message.id }),
      ),
    );

    expect(response.status).toBe(400);
    expect(await db().messageReaction.count({ where: { messageId: message.id } })).toBe(0);
  });

  it('refuses a message id that is not a uuid', async () => {
    const alice = await createTestIdentity('Alice Bad');

    const response = await readResponse<ApiErrorWire>(
      await pinMessage(
        buildRequest({
          url: '/api/messages/not-a-uuid/pin',
          method: 'POST',
          cookie: alice.cookie,
        }),
        params({ id: 'not-a-uuid' }),
      ),
    );

    expect(response.status).toBe(400);
  });

  /* ------------------------------------------------------------------------------------------ */
  /* The happy path, so the refusals above are known to be specific                               */
  /* ------------------------------------------------------------------------------------------ */

  it('lets a member react to, pin and list a message in their own conversation', async () => {
    const alice = await createTestIdentity('Alice Happy');
    const bob = await createTestIdentity('Bob Happy');
    const conversation = await seedDirectConversation(alice.userId, bob.userId);
    const { message } = await send(conversation, alice.userId, 'ordinary message');

    const reacted = await readResponse<MessageMutationWire>(
      await putReaction(
        buildRequest({
          url: `/api/messages/${message.id}/reactions`,
          method: 'PUT',
          cookie: bob.cookie,
          body: { emoji: '🙏' },
        }),
        params({ id: message.id }),
      ),
    );
    expect(reacted.status).toBe(200);
    expect(reacted.body?.message.reactions).toEqual([
      { emoji: '🙏', count: 1, userIds: [bob.userId] },
    ]);

    const pinned = await readResponse<MessageMutationWire>(
      await pinMessage(
        buildRequest({
          url: `/api/messages/${message.id}/pin`,
          method: 'POST',
          cookie: bob.cookie,
        }),
        params({ id: message.id }),
      ),
    );
    expect(pinned.status).toBe(200);
    expect(pinned.body?.message.pinnedAt).not.toBeNull();

    const pins = await readResponse<PinnedMessagesWire>(
      await listPins(
        buildRequest({ url: `/api/conversations/${conversation}/pins`, cookie: alice.cookie }),
        params({ id: conversation }),
      ),
    );
    expect(pins.status).toBe(200);
    expect(pins.body?.messages.map((m) => m.id)).toEqual([message.id]);
  });
});
