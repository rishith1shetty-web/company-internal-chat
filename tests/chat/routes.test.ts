/**
 * The Phase 5 REST endpoints, exercised as route handlers with real `Request` objects.
 *
 * These call the same functions Next.js calls, with the same cookie headers a browser sends, so
 * what is under test is the real authorization path rather than a service call that happens to
 * sit behind it. The properties that matter: no endpoint answers without an identity, no endpoint
 * accepts an identity from the request, and a conversation id in a path is a request rather than
 * a permission.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { GET as getConversations, POST as postConversation } from '@/app/api/conversations/route';
import { GET as getMessages } from '@/app/api/conversations/[id]/messages/route';
import { POST as postRead } from '@/app/api/conversations/[id]/read/route';
import { GET as getUsers } from '@/app/api/users/route';
import { sendMessage } from '@/lib/messages/service';
import type {
  ApiErrorWire,
  ConversationCreatedWire,
  ConversationListWire,
  DirectoryWire,
  MessagePageWire,
  ReadReceiptWire,
} from '@/lib/chat/wire';

import {
  TEST_NAME_PREFIX,
  buildRequest,
  cleanUp,
  createTestIdentity,
  databaseConfigured,
  db,
  disconnect,
  params,
  readResponse,
  seedDirectConversation,
  trackConversation,
  uuid,
} from './harness';

const suite = databaseConfigured ? describe : describe.skip;

suite('GET /api/users', () => {
  afterAll(async () => {
    await cleanUp();
    await disconnect();
  });

  it('refuses a request with no identity', async () => {
    const response = await readResponse<ApiErrorWire>(
      await getUsers(buildRequest({ url: '/api/users' })),
    );

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('refuses a forged cookie value', async () => {
    const response = await readResponse<ApiErrorWire>(
      await getUsers(
        buildRequest({ url: '/api/users', cookie: 'cic_session=not-a-real-token' }),
      ),
    );

    expect(response.status).toBe(401);
  });

  it('returns colleagues, never the caller, and never their presence', async () => {
    const me = await createTestIdentity('Route Caller');
    const other = await createTestIdentity('Route Colleague');

    const response = await readResponse<DirectoryWire>(
      await getUsers(
        buildRequest({ url: `/api/users?q=${TEST_NAME_PREFIX}Route`, cookie: me.cookie }),
      ),
    );

    expect(response.status).toBe(200);

    const ids = response.body.users.map((user) => user.id);
    expect(ids).toContain(other.userId);
    expect(ids).not.toContain(me.userId);

    // Presence is scoped to shared conversations and travels over the socket. A REST response
    // that published who is online would leak it to anyone with a session.
    for (const user of response.body.users) {
      expect(user).not.toHaveProperty('online');
      expect(user).not.toHaveProperty('presence');
    }
  });

  it('rejects an over-long search term instead of running it', async () => {
    const me = await createTestIdentity('Route Search');

    const response = await readResponse<ApiErrorWire>(
      await getUsers(
        buildRequest({ url: `/api/users?q=${'a'.repeat(500)}`, cookie: me.cookie }),
      ),
    );

    expect(response.status).toBe(400);
  });
});

suite('POST /api/conversations', () => {
  afterAll(async () => {
    await cleanUp();
    await disconnect();
  });

  it('creates a direct conversation, then returns the same one', async () => {
    const alice = await createTestIdentity('Alice Route');
    const bob = await createTestIdentity('Bob Route');

    const first = await readResponse<ConversationCreatedWire>(
      await postConversation(
        buildRequest({
          url: '/api/conversations',
          method: 'POST',
          cookie: alice.cookie,
          body: { type: 'DIRECT', userId: bob.userId },
        }),
      ),
    );

    expect(first.status).toBe(201);
    expect(first.body.created).toBe(true);
    trackConversation(first.body.conversation.id);

    const again = await readResponse<ConversationCreatedWire>(
      await postConversation(
        buildRequest({
          url: '/api/conversations',
          method: 'POST',
          cookie: alice.cookie,
          body: { type: 'DIRECT', userId: bob.userId },
        }),
      ),
    );

    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(again.body.conversation.id).toBe(first.body.conversation.id);
  });

  it('always makes the caller a member, whoever they name', async () => {
    const alice = await createTestIdentity('Alice Member');
    const bob = await createTestIdentity('Bob Member');

    const result = await readResponse<ConversationCreatedWire>(
      await postConversation(
        buildRequest({
          url: '/api/conversations',
          method: 'POST',
          cookie: alice.cookie,
          body: { type: 'DIRECT', userId: bob.userId },
        }),
      ),
    );

    trackConversation(result.body.conversation.id);

    const memberIds = result.body.conversation.members.map((member) => member.userId);
    expect(new Set(memberIds)).toEqual(new Set([alice.userId, bob.userId]));
  });

  it('ignores extra fields that try to name a different creator or member', async () => {
    const alice = await createTestIdentity('Alice Inject');
    const bob = await createTestIdentity('Bob Inject');
    const victim = await createTestIdentity('Victim Inject');

    const result = await readResponse<ConversationCreatedWire>(
      await postConversation(
        buildRequest({
          url: '/api/conversations',
          method: 'POST',
          cookie: alice.cookie,
          body: {
            type: 'DIRECT',
            userId: bob.userId,
            // None of these exist in the schema, so Zod drops them before anything reads them.
            createdById: victim.userId,
            members: [{ userId: victim.userId, role: 'OWNER' }],
            role: 'OWNER',
          },
        }),
      ),
    );

    trackConversation(result.body.conversation.id);

    const memberIds = result.body.conversation.members.map((member) => member.userId);
    expect(memberIds).not.toContain(victim.userId);

    const stored = await db().conversation.findUnique({
      where: { id: result.body.conversation.id },
      select: { createdById: true },
    });
    expect(stored?.createdById).toBe(alice.userId);
  });

  it('refuses group creation, which is Phase 6', async () => {
    const alice = await createTestIdentity('Alice Group Attempt');
    const bob = await createTestIdentity('Bob Group Attempt');

    const response = await readResponse<ApiErrorWire>(
      await postConversation(
        buildRequest({
          url: '/api/conversations',
          method: 'POST',
          cookie: alice.cookie,
          body: { type: 'GROUP', userId: bob.userId, name: 'Not yet' },
        }),
      ),
    );

    expect(response.status).toBe(400);
  });

  it('refuses a conversation with a non-existent user', async () => {
    const alice = await createTestIdentity('Alice Ghost Route');

    const response = await readResponse<ApiErrorWire>(
      await postConversation(
        buildRequest({
          url: '/api/conversations',
          method: 'POST',
          cookie: alice.cookie,
          body: { type: 'DIRECT', userId: uuid() },
        }),
      ),
    );

    expect(response.status).toBe(400);
  });

  it('refuses a malformed body', async () => {
    const alice = await createTestIdentity('Alice Malformed');

    const response = await readResponse<ApiErrorWire>(
      await postConversation(
        buildRequest({
          url: '/api/conversations',
          method: 'POST',
          cookie: alice.cookie,
          body: { type: 'DIRECT', userId: 'not-a-uuid' },
        }),
      ),
    );

    expect(response.status).toBe(400);
  });
});

suite('GET /api/conversations', () => {
  afterAll(async () => {
    await cleanUp();
    await disconnect();
  });

  it('lists the caller conversations with their members named', async () => {
    const alice = await createTestIdentity('Alice Listing');
    const bob = await createTestIdentity('Bob Listing');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    await sendMessage(db(), {
      senderId: bob.userId,
      conversationId,
      body: 'hello there',
      clientMessageId: uuid(),
    });

    const response = await readResponse<ConversationListWire>(
      await getConversations(buildRequest({ url: '/api/conversations', cookie: alice.cookie })),
    );

    expect(response.status).toBe(200);

    const conversation = response.body.conversations.find((item) => item.id === conversationId);
    expect(conversation?.lastMessage?.body).toBe('hello there');
    expect(conversation?.unreadCount).toBe(1);

    // The users needed to render the list come with it, so the sidebar never has to guess who
    // an id belongs to.
    expect(response.body.users.map((user) => user.id)).toContain(bob.userId);
  });

  it('never includes a conversation the caller is not in', async () => {
    const alice = await createTestIdentity('Alice Private');
    const bob = await createTestIdentity('Bob Private');
    const outsider = await createTestIdentity('Outsider Private');

    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const response = await readResponse<ConversationListWire>(
      await getConversations(buildRequest({ url: '/api/conversations', cookie: outsider.cookie })),
    );

    expect(response.body.conversations.map((item) => item.id)).not.toContain(conversationId);
  });
});

suite('GET /api/conversations/:id/messages', () => {
  afterAll(async () => {
    await cleanUp();
    await disconnect();
  });

  it('returns history to a member', async () => {
    const alice = await createTestIdentity('Alice Msg Route');
    const bob = await createTestIdentity('Bob Msg Route');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    await sendMessage(db(), {
      senderId: bob.userId,
      conversationId,
      body: 'persisted',
      clientMessageId: uuid(),
    });

    const response = await readResponse<MessagePageWire>(
      await getMessages(
        buildRequest({
          url: `/api/conversations/${conversationId}/messages`,
          cookie: alice.cookie,
        }),
        params({ id: conversationId }),
      ),
    );

    expect(response.status).toBe(200);
    expect(response.body.messages.map((message) => message.body)).toEqual(['persisted']);
  });

  it('refuses a conversation the caller is not a member of', async () => {
    const alice = await createTestIdentity('Alice Denied');
    const bob = await createTestIdentity('Bob Denied');
    const outsider = await createTestIdentity('Outsider Denied');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    await sendMessage(db(), {
      senderId: alice.userId,
      conversationId,
      body: 'not for you',
      clientMessageId: uuid(),
    });

    const response = await readResponse<ApiErrorWire>(
      await getMessages(
        buildRequest({
          url: `/api/conversations/${conversationId}/messages`,
          cookie: outsider.cookie,
        }),
        params({ id: conversationId }),
      ),
    );

    expect(response.status).toBe(403);
    // The body must not hint that the conversation exists.
    expect(JSON.stringify(response.body)).not.toContain(conversationId);
  });

  it('answers a conversation that does not exist exactly the same way', async () => {
    const alice = await createTestIdentity('Alice Nonexistent');
    const missing = uuid();

    const response = await readResponse<ApiErrorWire>(
      await getMessages(
        buildRequest({ url: `/api/conversations/${missing}/messages`, cookie: alice.cookie }),
        params({ id: missing }),
      ),
    );

    expect(response.status).toBe(403);
  });

  it('rejects a malformed conversation id before authorizing anything', async () => {
    const alice = await createTestIdentity('Alice Bad Id');

    const response = await readResponse<ApiErrorWire>(
      await getMessages(
        buildRequest({ url: '/api/conversations/../../etc/passwd/messages', cookie: alice.cookie }),
        params({ id: '../../etc/passwd' }),
      ),
    );

    expect(response.status).toBe(400);
  });

  it('rejects asking for older and newer messages at once', async () => {
    const alice = await createTestIdentity('Alice Both');
    const bob = await createTestIdentity('Bob Both');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const response = await readResponse<ApiErrorWire>(
      await getMessages(
        buildRequest({
          url: `/api/conversations/${conversationId}/messages?before=${uuid()}&after=${uuid()}`,
          cookie: alice.cookie,
        }),
        params({ id: conversationId }),
      ),
    );

    expect(response.status).toBe(400);
  });

  it('refuses without an identity', async () => {
    const conversationId = uuid();

    const response = await readResponse<ApiErrorWire>(
      await getMessages(
        buildRequest({ url: `/api/conversations/${conversationId}/messages` }),
        params({ id: conversationId }),
      ),
    );

    expect(response.status).toBe(401);
  });
});

suite('POST /api/conversations/:id/read', () => {
  afterAll(async () => {
    await cleanUp();
    await disconnect();
  });

  it('moves the read marker and returns the recomputed count', async () => {
    const alice = await createTestIdentity('Alice Marker');
    const bob = await createTestIdentity('Bob Marker');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const message = await sendMessage(db(), {
      senderId: bob.userId,
      conversationId,
      body: 'read me',
      clientMessageId: uuid(),
    });

    const response = await readResponse<ReadReceiptWire>(
      await postRead(
        buildRequest({
          url: `/api/conversations/${conversationId}/read`,
          method: 'POST',
          cookie: alice.cookie,
          body: { messageId: message.message.id },
        }),
        params({ id: conversationId }),
      ),
    );

    expect(response.status).toBe(200);
    expect(response.body.unreadCount).toBe(0);
    expect(response.body.lastReadMessageId).toBe(message.message.id);
  });

  it('refuses a non-member', async () => {
    const alice = await createTestIdentity('Alice Marker Denied');
    const bob = await createTestIdentity('Bob Marker Denied');
    const outsider = await createTestIdentity('Outsider Marker');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    const message = await sendMessage(db(), {
      senderId: bob.userId,
      conversationId,
      body: 'private',
      clientMessageId: uuid(),
    });

    const response = await readResponse<ApiErrorWire>(
      await postRead(
        buildRequest({
          url: `/api/conversations/${conversationId}/read`,
          method: 'POST',
          cookie: outsider.cookie,
          body: { messageId: message.message.id },
        }),
        params({ id: conversationId }),
      ),
    );

    expect(response.status).toBe(403);
  });

  it('refuses a message id belonging to another conversation', async () => {
    const alice = await createTestIdentity('Alice Cross Marker');
    const bob = await createTestIdentity('Bob Cross Marker');
    const carol = await createTestIdentity('Carol Cross Marker');

    const mine = await seedDirectConversation(alice.userId, bob.userId);
    const elsewhere = await seedDirectConversation(alice.userId, carol.userId);

    const foreign = await sendMessage(db(), {
      senderId: carol.userId,
      conversationId: elsewhere,
      body: 'elsewhere',
      clientMessageId: uuid(),
    });

    const response = await readResponse<ApiErrorWire>(
      await postRead(
        buildRequest({
          url: `/api/conversations/${mine}/read`,
          method: 'POST',
          cookie: alice.cookie,
          body: { messageId: foreign.message.id },
        }),
        params({ id: mine }),
      ),
    );

    expect(response.status).toBe(403);
  });
});
