/**
 * `GET /api/messages/:id/info`, exercised as an attacker would reach it (Batch 1.3).
 *
 * `tests/chat/read-receipts.test.ts` proves the SERVICE refuses. This file proves the HTTP surface
 * in front of it refuses too — that the acting user comes from the cookie and never the request,
 * and that no combination of a valid session and somebody else's message id gets past it.
 *
 * THE THREAT THIS ENDPOINT WOULD BE, DONE BADLY. Read status is the one thing in this application
 * that describes what a colleague has been DOING rather than what they wrote. An endpoint that
 * answered for anybody's message would be an employee-monitoring tool built by accident. So the
 * tests below are mostly about who is refused.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { GET as messageInfo } from '@/app/api/messages/[id]/info/route';
import type { ApiErrorWire, MessageReadStatusWire } from '@/lib/chat/wire';
import { markConversationRead } from '@/lib/conversations/service';
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
  seedGroupConversation,
  uuid,
} from '../chat/harness';

const suite = databaseConfigured ? describe : describe.skip;

async function send(conversationId: string, senderId: string, body: string) {
  return sendMessage(db(), { senderId, conversationId, body, clientMessageId: uuid() });
}

async function info(
  messageId: string,
  cookie: string | undefined,
): Promise<{ status: number; body: MessageReadStatusWire & ApiErrorWire }> {
  return readResponse(
    await messageInfo(
      buildRequest({
        url: `/api/messages/${messageId}/info`,
        ...(cookie === undefined ? {} : { cookie }),
      }),
      params({ id: messageId }),
    ),
  );
}

suite('GET /api/messages/:id/info', () => {
  afterAll(async () => {
    await cleanUp();
    await disconnect();
  });

  it('refuses without a session', async () => {
    expect((await info(uuid(), undefined)).status).toBe(401);
  });

  it('answers for the sender’s own group message', async () => {
    const owner = await createTestIdentity('Owner InfoRoute');
    const reader = await createTestIdentity('Reader InfoRoute');
    const idler = await createTestIdentity('Idler InfoRoute');

    const conversation = await seedGroupConversation(owner.userId, [
      { userId: reader.userId },
      { userId: idler.userId },
    ]);
    const { message } = await send(conversation, owner.userId, 'team update');
    await markConversationRead(db(), reader.userId, conversation, message.id);

    const response = await info(message.id, owner.cookie);

    expect(response.status).toBe(200);
    expect(response.body.messageId).toBe(message.id);
    expect(response.body.readBy.map((entry) => entry.userId)).toEqual([reader.userId]);
    expect(response.body.notReadBy.map((entry) => entry.userId)).toEqual([idler.userId]);

    // Names come back so the panel can show people rather than ids.
    expect(response.body.users.map((user) => user.id).sort()).toEqual(
      [reader.userId, idler.userId].sort(),
    );
  });

  it('exposes NOTHING technical about a person', async () => {
    const owner = await createTestIdentity('Owner Privacy');
    const member = await createTestIdentity('Member Privacy');

    const conversation = await seedGroupConversation(owner.userId, [{ userId: member.userId }]);
    const { message } = await send(conversation, owner.userId, 'hello');

    const response = await info(message.id, owner.cookie);
    const serialized = JSON.stringify(response.body);

    /*
     * A read-status endpoint is a natural place for somebody to add "helpful" diagnostics. It
     * must carry display names and nothing else about a person: no device, no session, no token,
     * no address.
     */
    for (const forbidden of ['deviceId', 'sessionId', 'tokenHash', 'userAgent', 'ipAddress', 'lastReadAt']) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
    // And no read TIMES, which the read marker cannot honestly provide.
    expect(serialized).not.toContain('readAt');
  });

  it('REFUSES a member of the group who did not send the message', async () => {
    const owner = await createTestIdentity('Owner NotYours');
    const member = await createTestIdentity('Member NotYours');

    const conversation = await seedGroupConversation(owner.userId, [{ userId: member.userId }]);
    const { message } = await send(conversation, owner.userId, 'mine');

    // A legitimate member. Read status is "who has seen what I said", not a way to watch people.
    expect((await info(message.id, member.cookie)).status).toBe(403);
  });

  it('refuses somebody outside the conversation, and tells them nothing', async () => {
    const owner = await createTestIdentity('Owner IDOR');
    const member = await createTestIdentity('Member IDOR');
    const outsider = await createTestIdentity('Outsider IDOR');

    const conversation = await seedGroupConversation(owner.userId, [{ userId: member.userId }]);
    const { message } = await send(conversation, owner.userId, 'private to this group');

    const real = await info(message.id, outsider.cookie);
    const invented = await info(uuid(), outsider.cookie);

    /*
     * Identical status AND identical body. A difference of any kind would answer "does this
     * message exist?" for anybody holding a session — an id-enumeration oracle across every
     * conversation in the company.
     */
    expect(real.status).toBe(403);
    expect(invented.status).toBe(403);
    expect(JSON.stringify(real.body)).toBe(JSON.stringify(invented.body));
  });

  it('cannot be pointed at another conversation, because it accepts no conversation id', async () => {
    const alice = await createTestIdentity('Alice Cross');
    const bob = await createTestIdentity('Bob Cross');
    const mallory = await createTestIdentity('Mallory Cross');

    const privateChat = await seedDirectConversation(alice.userId, bob.userId);
    const { message } = await send(privateChat, alice.userId, 'not for mallory');

    // Mallory has a group of her own, so she is a legitimate member of SOMETHING — the classic
    // setup for pairing "a conversation I am in" with "a message over there". The route derives
    // the conversation from the message, so there is nothing to pair.
    await seedGroupConversation(mallory.userId, []);

    expect((await info(message.id, mallory.cookie)).status).toBe(403);
  });

  it('refuses a message id that is not a uuid', async () => {
    const alice = await createTestIdentity('Alice BadId13');

    for (const id of ['not-a-uuid', "1' OR '1'='1", '../../admin']) {
      const response = await readResponse<ApiErrorWire>(
        await messageInfo(
          buildRequest({
            url: `/api/messages/${encodeURIComponent(id)}/info`,
            cookie: alice.cookie,
          }),
          params({ id }),
        ),
      );
      expect(response.status, id).toBe(400);
    }
  });

  it('answers for a DIRECT message too, since the sender may ask about their own', async () => {
    const alice = await createTestIdentity('Alice DirectInfo');
    const bob = await createTestIdentity('Bob DirectInfo');

    const conversation = await seedDirectConversation(alice.userId, bob.userId);
    const { message } = await send(conversation, alice.userId, 'just us');

    /*
     * The INTERFACE offers Message info only in groups — a direct chat says everything it has to
     * say with the inline "Seen". The endpoint does not refuse a direct message, though: there is
     * nothing to protect, since the only other participant is the one the Seen mark already
     * describes, and a route that refused would be enforcing a presentation choice rather than a
     * rule.
     */
    const response = await info(message.id, alice.cookie);
    expect(response.status).toBe(200);
    expect(response.body.notReadBy.map((entry) => entry.userId)).toEqual([bob.userId]);
  });
});
