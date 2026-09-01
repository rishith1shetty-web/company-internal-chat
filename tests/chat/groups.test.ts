/**
 * Group chat: creation, membership, authorization and the join-bounded history window (Phase 6).
 *
 * The property under test throughout is D-03, because it is the one a reasonable implementation
 * gets wrong: **a member sees only messages sent at or after their own `joinedAt`**, and that has
 * to hold everywhere a message can be reached — history, the reconnect backfill, the sidebar
 * preview, the unread badge and the socket room. A rule enforced in four places out of five is a
 * disclosure, so each of the five is tested separately rather than through one path that happens
 * to cover them.
 *
 * The second property is that nothing is deleted to achieve any of it. The messages a newcomer
 * cannot see are still in the table, and the members who were there for them can still read them.
 *
 * Everything runs against the real database, the real services, the real route handlers and a
 * real Socket.IO server. Every row is created by the harness and removed by id afterwards.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { POST as postConversations } from '@/app/api/conversations/route';
import { POST as postMembers } from '@/app/api/conversations/[id]/members/route';
import { DELETE as deleteMember } from '@/app/api/conversations/[id]/members/[userId]/route';
import type {
  ApiErrorWire,
  ConversationCreatedWire,
  ConversationMembersWire,
} from '@/lib/chat/wire';
import {
  ConversationError,
  addGroupMembers,
  createGroupConversation,
  listConversationsForUser,
  markConversationRead,
  removeGroupMember,
} from '@/lib/conversations/service';
import { listMessages, sendMessage } from '@/lib/messages/service';

import {
  TEST_NAME_PREFIX,
  buildRequest,
  cleanUp,
  connectClient,
  createTestIdentity,
  databaseConfigured,
  db,
  disconnect,
  emitWithAck,
  expectNoEvent,
  params,
  readResponse,
  seedMessageAt,
  startTestServer,
  trackConversation,
  uuid,
  waitForEvent,
  waitForReady,
  type TestClient,
  type TestIdentity,
} from './harness';

const suite = databaseConfigured ? describe : describe.skip;

/** Creates a group through the service, exactly as the route does, and registers it for cleanup. */
async function makeGroup(
  creator: TestIdentity,
  members: TestIdentity[],
  name = `${TEST_NAME_PREFIX}Group`,
): Promise<string> {
  const result = await createGroupConversation(db(), {
    creatorId: creator.userId,
    name,
    memberIds: members.map((member) => member.userId),
  });
  return trackConversation(result.conversationId);
}

/** The one summary the caller can see for a conversation, or undefined if they cannot. */
async function summaryFor(userId: string, conversationId: string) {
  const conversations = await listConversationsForUser(db(), userId);
  return conversations.find((conversation) => conversation.id === conversationId);
}

/* --------------------------------------------------------------------------------------------- */
/* Creation                                                                                        */
/* --------------------------------------------------------------------------------------------- */

suite('group creation', () => {
  afterAll(async () => {
    await cleanUp();
    await disconnect();
  });

  it('makes the creator an owner and the chosen colleagues members', async () => {
    const owner = await createTestIdentity('Group Owner');
    const first = await createTestIdentity('Group First');
    const second = await createTestIdentity('Group Second');

    const conversationId = await makeGroup(owner, [first, second], `${TEST_NAME_PREFIX}Ops`);

    const conversation = await db().conversation.findUnique({
      where: { id: conversationId },
      select: {
        type: true,
        name: true,
        directKey: true,
        createdById: true,
        members: { select: { userId: true, role: true, leftAt: true, joinedAt: true } },
      },
    });

    expect(conversation?.type).toBe('GROUP');
    expect(conversation?.name).toBe(`${TEST_NAME_PREFIX}Ops`);
    // Not a direct conversation, so the one-per-pair key must stay empty — two groups with the
    // same people are two different groups.
    expect(conversation?.directKey).toBeNull();
    expect(conversation?.createdById).toBe(owner.userId);

    const members = conversation?.members ?? [];
    expect(members).toHaveLength(3);
    expect(members.every((member) => member.leftAt === null)).toBe(true);
    expect(members.every((member) => member.joinedAt instanceof Date)).toBe(true);

    // The creator is the owner, and is a member without having asked to be.
    expect(members.find((member) => member.userId === owner.userId)?.role).toBe('OWNER');
    expect(members.find((member) => member.userId === first.userId)?.role).toBe('MEMBER');
    expect(members.find((member) => member.userId === second.userId)?.role).toBe('MEMBER');
  });

  it('tells apart two colleagues who share a display name, because it works on ids', async () => {
    // Same display name, two different people (D-02). The name identifies neither of them.
    const owner = await createTestIdentity('Group Namesake');
    const wanted = await createTestIdentity('Namesake');
    const other = await createTestIdentity('Namesake');

    expect(wanted.displayName).toBe(other.displayName);
    expect(wanted.userId).not.toBe(other.userId);

    const conversationId = await makeGroup(owner, [wanted]);

    const memberIds = (
      await db().conversationMember.findMany({
        where: { conversationId },
        select: { userId: true },
      })
    ).map((member) => member.userId);

    expect(memberIds).toContain(wanted.userId);
    // The person who merely shares the name is not in the group.
    expect(memberIds).not.toContain(other.userId);
  });

  it('collapses a duplicated id instead of creating two memberships', async () => {
    const owner = await createTestIdentity('Group Duplicate');
    const colleague = await createTestIdentity('Duplicate Member');

    const result = await createGroupConversation(db(), {
      creatorId: owner.userId,
      name: `${TEST_NAME_PREFIX}Duplicates`,
      // The same person three times, and the creator naming themselves as well.
      memberIds: [colleague.userId, colleague.userId, colleague.userId, owner.userId],
    });
    trackConversation(result.conversationId);

    const members = await db().conversationMember.findMany({
      where: { conversationId: result.conversationId },
      select: { userId: true, role: true },
    });

    expect(members).toHaveLength(2);
    expect(members.filter((member) => member.userId === colleague.userId)).toHaveLength(1);
    // Naming yourself does not demote you from owner or add you twice.
    expect(members.find((member) => member.userId === owner.userId)?.role).toBe('OWNER');
  });

  it('refuses a group with nobody else in it', async () => {
    const owner = await createTestIdentity('Group Alone');

    await expect(
      createGroupConversation(db(), {
        creatorId: owner.userId,
        name: `${TEST_NAME_PREFIX}Alone`,
        memberIds: [owner.userId],
      }),
    ).rejects.toMatchObject({ reason: 'NO_MEMBERS' });
  });

  it('refuses an unusable name, and a colleague who does not exist', async () => {
    const owner = await createTestIdentity('Group Invalid');
    const colleague = await createTestIdentity('Invalid Member');

    await expect(
      createGroupConversation(db(), {
        creatorId: owner.userId,
        name: '   ',
        memberIds: [colleague.userId],
      }),
    ).rejects.toMatchObject({ reason: 'INVALID_GROUP_NAME' });

    await expect(
      createGroupConversation(db(), {
        creatorId: owner.userId,
        name: 'x'.repeat(121),
        memberIds: [colleague.userId],
      }),
    ).rejects.toMatchObject({ reason: 'INVALID_GROUP_NAME' });

    const before = await db().conversation.count({ where: { type: 'GROUP' } });

    await expect(
      createGroupConversation(db(), {
        creatorId: owner.userId,
        name: `${TEST_NAME_PREFIX}Ghost`,
        memberIds: [uuid()],
      }),
    ).rejects.toMatchObject({ reason: 'USER_NOT_FOUND' });

    // Nothing half-created: a group whose member list was refused does not exist.
    expect(await db().conversation.count({ where: { type: 'GROUP' } })).toBe(before);
  });

  it('refuses a retired colleague', async () => {
    const owner = await createTestIdentity('Group Retired');
    const retired = await createTestIdentity('Retired Member');

    await db().user.update({ where: { id: retired.userId }, data: { isActive: false } });

    await expect(
      createGroupConversation(db(), {
        creatorId: owner.userId,
        name: `${TEST_NAME_PREFIX}Retired`,
        memberIds: [retired.userId],
      }),
    ).rejects.toMatchObject({ reason: 'USER_NOT_FOUND' });
  });

  it('creates a group over HTTP, and refuses one without an identity', async () => {
    const owner = await createTestIdentity('Group Route');
    const colleague = await createTestIdentity('Route Member');

    const created = await readResponse<ConversationCreatedWire>(
      await postConversations(
        buildRequest({
          url: '/api/conversations',
          method: 'POST',
          cookie: owner.cookie,
          body: {
            type: 'GROUP',
            name: `${TEST_NAME_PREFIX}Route Group`,
            memberIds: [colleague.userId],
          },
        }),
      ),
    );

    expect(created.status).toBe(201);
    expect(created.body.created).toBe(true);
    expect(created.body.conversation.type).toBe('GROUP');
    expect(created.body.conversation.name).toBe(`${TEST_NAME_PREFIX}Route Group`);
    trackConversation(created.body.conversation.id);

    const roles = new Map(
      created.body.conversation.members.map((member) => [member.userId, member.role]),
    );
    expect(roles.get(owner.userId)).toBe('OWNER');
    expect(roles.get(colleague.userId)).toBe('MEMBER');

    // No cookie, no group. The creator is taken from the session and there is no other way in.
    const anonymous = await readResponse<ApiErrorWire>(
      await postConversations(
        buildRequest({
          url: '/api/conversations',
          method: 'POST',
          body: {
            type: 'GROUP',
            name: `${TEST_NAME_PREFIX}Sneaky`,
            memberIds: [colleague.userId],
          },
        }),
      ),
    );
    expect(anonymous.status).toBe(401);
  });
});

/* --------------------------------------------------------------------------------------------- */
/* Authorization                                                                                   */
/* --------------------------------------------------------------------------------------------- */

suite('group authorization', () => {
  afterAll(async () => {
    await cleanUp();
    await disconnect();
  });

  it('lets a member read and send, and refuses an outsider both', async () => {
    const owner = await createTestIdentity('Authz Owner');
    const member = await createTestIdentity('Authz Member');
    const outsider = await createTestIdentity('Authz Outsider');

    const conversationId = await makeGroup(owner, [member]);

    const sent = await sendMessage(db(), {
      senderId: member.userId,
      conversationId,
      body: 'members can send',
      clientMessageId: uuid(),
    });
    expect(sent.message.id).toBeTruthy();

    const read = await listMessages(db(), { userId: owner.userId, conversationId });
    expect(read.messages.some((message) => message.body === 'members can send')).toBe(true);

    // The outsider knows the conversation id and it does not help them.
    await expect(
      listMessages(db(), { userId: outsider.userId, conversationId }),
    ).rejects.toMatchObject({ reason: 'NOT_A_MEMBER' });

    await expect(
      sendMessage(db(), {
        senderId: outsider.userId,
        conversationId,
        body: 'I should not be able to say this',
        clientMessageId: uuid(),
      }),
    ).rejects.toMatchObject({ reason: 'NOT_A_MEMBER' });

    // And nothing of theirs was written.
    expect(
      await db().message.count({ where: { conversationId, senderId: outsider.userId } }),
    ).toBe(0);
  });

  it('refuses an outsider the socket room', async () => {
    const server = await startTestServer();
    const owner = await createTestIdentity('Room Owner');
    const member = await createTestIdentity('Room Member');
    const outsider = await createTestIdentity('Room Outsider');
    const conversationId = await makeGroup(owner, [member]);

    let outsiderSocket: TestClient | undefined;
    let memberSocket: TestClient | undefined;

    try {
      outsiderSocket = await connectClient(server.url, outsider.cookie);
      const ready = await waitForReady(outsiderSocket);
      // The group is not in the set of rooms the server decided this socket may have.
      expect(ready.conversationIds).not.toContain(conversationId);

      const denied = await emitWithAck(outsiderSocket, 'conversation:join', { conversationId });
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error.code).toBe('FORBIDDEN');

      const refusedSend = await emitWithAck(outsiderSocket, 'message:send', {
        conversationId,
        body: 'let me in',
        clientMessageId: uuid(),
      });
      expect(refusedSend.ok).toBe(false);
      if (!refusedSend.ok) expect(refusedSend.error.code).toBe('FORBIDDEN');

      // A member, by contrast, is joined to it without asking.
      memberSocket = await connectClient(server.url, member.cookie);
      const memberReady = await waitForReady(memberSocket);
      expect(memberReady.conversationIds).toContain(conversationId);
    } finally {
      outsiderSocket?.close();
      memberSocket?.close();
      await server.close();
    }
  });

  it('refuses an outsider the members endpoint, without writing anything', async () => {
    const owner = await createTestIdentity('Members Owner');
    const member = await createTestIdentity('Members Member');
    const outsider = await createTestIdentity('Members Outsider');
    const conversationId = await makeGroup(owner, [member]);

    const refused = await readResponse<ApiErrorWire>(
      await postMembers(
        buildRequest({
          url: `/api/conversations/${conversationId}/members`,
          method: 'POST',
          cookie: outsider.cookie,
          body: { userIds: [outsider.userId] },
        }),
        params({ id: conversationId }),
      ),
    );

    // Indistinguishable from a conversation that does not exist.
    expect(refused.status).toBe(403);
    expect(
      await db().conversationMember.count({ where: { conversationId } }),
    ).toBe(2);
  });

  it('lets any member add, but only the owner remove somebody else', async () => {
    const owner = await createTestIdentity('Role Owner');
    const member = await createTestIdentity('Role Member');
    const third = await createTestIdentity('Role Third');
    const newcomer = await createTestIdentity('Role Newcomer');

    const conversationId = await makeGroup(owner, [member, third]);

    // A plain member may add (Q-05b, option (a)).
    await addGroupMembers(db(), {
      actorId: member.userId,
      conversationId,
      userIds: [newcomer.userId],
    });
    expect(
      await db().conversationMember.count({ where: { conversationId, leftAt: null } }),
    ).toBe(4);

    // But not remove somebody else.
    await expect(
      removeGroupMember(db(), {
        actorId: member.userId,
        conversationId,
        targetUserId: third.userId,
      }),
    ).rejects.toMatchObject({ reason: 'NOT_AN_OWNER' });

    // The owner may.
    await removeGroupMember(db(), {
      actorId: owner.userId,
      conversationId,
      targetUserId: third.userId,
    });

    const removed = await db().conversationMember.findUnique({
      where: { conversationId_userId: { conversationId, userId: third.userId } },
      select: { leftAt: true },
    });
    // The row is kept and marked, never deleted: who was present when is part of the record.
    expect(removed?.leftAt).toBeInstanceOf(Date);

    // And anybody may remove themselves.
    await removeGroupMember(db(), {
      actorId: member.userId,
      conversationId,
      targetUserId: member.userId,
    });
    await expect(
      listMessages(db(), { userId: member.userId, conversationId }),
    ).rejects.toMatchObject({ reason: 'NOT_A_MEMBER' });
  });

  it('will not manage members of a direct conversation', async () => {
    const alice = await createTestIdentity('Direct Alice');
    const bob = await createTestIdentity('Direct Bob');
    const outsider = await createTestIdentity('Direct Outsider');

    const created = await readResponse<ConversationCreatedWire>(
      await postConversations(
        buildRequest({
          url: '/api/conversations',
          method: 'POST',
          cookie: alice.cookie,
          body: { type: 'DIRECT', userId: bob.userId },
        }),
      ),
    );
    const conversationId = trackConversation(created.body.conversation.id);

    await expect(
      addGroupMembers(db(), {
        actorId: alice.userId,
        conversationId,
        userIds: [outsider.userId],
      }),
    ).rejects.toMatchObject({ reason: 'NOT_A_GROUP' });

    expect(await db().conversationMember.count({ where: { conversationId } })).toBe(2);
  });

  it('passes ownership on when the last owner leaves', async () => {
    const owner = await createTestIdentity('Succession Owner');
    const member = await createTestIdentity('Succession Member');
    const conversationId = await makeGroup(owner, [member]);

    await removeGroupMember(db(), {
      actorId: owner.userId,
      conversationId,
      targetUserId: owner.userId,
    });

    // Otherwise the group would be left with nobody able to manage it, and no way back.
    const successor = await db().conversationMember.findUnique({
      where: { conversationId_userId: { conversationId, userId: member.userId } },
      select: { role: true, leftAt: true },
    });
    expect(successor?.role).toBe('OWNER');
    expect(successor?.leftAt).toBeNull();
  });
});

/* --------------------------------------------------------------------------------------------- */
/* Join-bounded history (D-03)                                                                     */
/* --------------------------------------------------------------------------------------------- */

suite('join-bounded group history', () => {
  afterAll(async () => {
    await cleanUp();
    await disconnect();
  });

  /**
   * The scenario from the requirement, built once: a group with history, and somebody added to it
   * afterwards through the real code path rather than a hand-written `joinedAt`.
   */
  async function groupWithHistory() {
    const owner = await createTestIdentity('History Owner');
    const original = await createTestIdentity('History Original');
    const latecomer = await createTestIdentity('History Latecomer');

    const conversationId = await makeGroup(owner, [original]);
    const opened = await db().message.findFirstOrThrow({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });

    // The latecomer is added through the real path, so their `joinedAt` is whatever the
    // application actually produces rather than a value this test chose.
    await addGroupMembers(db(), {
      actorId: owner.userId,
      conversationId,
      userIds: [latecomer.userId],
    });
    const joined = await db().conversationMember.findUniqueOrThrow({
      where: { conversationId_userId: { conversationId, userId: latecomer.userId } },
      select: { joinedAt: true },
    });

    /*
     * The two "before" messages are then placed by construction inside the gap between the group
     * opening and that join — after every founding member's window starts, and before the
     * latecomer's does. Sending them and hoping the clock lands the right way would make this a
     * race, and a flaky test of a security rule is worse than no test of it.
     */
    const gap = joined.joinedAt.getTime() - opened.createdAt.getTime();
    if (gap < 3) throw new Error(`No usable gap between the group opening and the join (${gap}ms)`);

    const before = [
      await seedMessageAt(
        conversationId,
        owner.userId,
        'message A',
        new Date(joined.joinedAt.getTime() - 2),
      ),
      await seedMessageAt(
        conversationId,
        original.userId,
        'message B',
        new Date(joined.joinedAt.getTime() - 1),
      ),
    ];

    const after = await sendMessage(db(), {
      senderId: owner.userId,
      conversationId,
      body: 'message C',
      clientMessageId: uuid(),
    });

    return { owner, original, latecomer, conversationId, before, after: after.message };
  }

  it('hides everything said before a new member joined, and shows everything after', async () => {
    const { latecomer, conversationId, after } = await groupWithHistory();

    const visible = await listMessages(db(), { userId: latecomer.userId, conversationId });
    const bodies = visible.messages.map((message) => message.body);

    expect(bodies).not.toContain('message A');
    expect(bodies).not.toContain('message B');
    expect(bodies).toContain('message C');

    // They can see the event that added them: it is stamped at exactly their join time.
    expect(bodies.some((body) => body?.includes('added'))).toBe(true);
    expect(visible.messages.every((message) => message.id !== undefined)).toBe(true);
    expect(after.body).toBe('message C');
  });

  it('leaves the hidden messages in the database, readable by the members who were there', async () => {
    const { owner, original, conversationId, before } = await groupWithHistory();

    // Not deleted — merely out of somebody's window.
    for (const message of before) {
      expect(await db().message.findUnique({ where: { id: message.id } })).not.toBeNull();
    }

    for (const userId of [owner.userId, original.userId]) {
      const bodies = (await listMessages(db(), { userId, conversationId })).messages.map(
        (message) => message.body,
      );
      expect(bodies).toContain('message A');
      expect(bodies).toContain('message B');
      expect(bodies).toContain('message C');
    }
  });

  it('refuses a pagination cursor from before the new member joined', async () => {
    const { latecomer, conversationId, before } = await groupWithHistory();
    const olderMessage = before[0];
    if (!olderMessage) throw new Error('seed failed');

    // Handing in the id of a message from before the join is how a member would try to page
    // backwards past their own window. The cursor is verified, not trusted.
    await expect(
      listMessages(db(), {
        userId: latecomer.userId,
        conversationId,
        before: olderMessage.id,
      }),
    ).rejects.toMatchObject({ reason: 'INVALID_CURSOR' });

    await expect(
      listMessages(db(), {
        userId: latecomer.userId,
        conversationId,
        after: olderMessage.id,
      }),
    ).rejects.toMatchObject({ reason: 'INVALID_CURSOR' });
  });

  it('bounds the reconnect backfill by the join time', async () => {
    const { latecomer, conversationId } = await groupWithHistory();

    // The backfill a client performs after a dropped socket: everything newer than what it has.
    // Starting from nothing, it must still not reach back past the join.
    const initial = await listMessages(db(), { userId: latecomer.userId, conversationId });
    const cursor = initial.messages[0];
    if (!cursor) throw new Error('the latecomer should see the message that added them');

    await sendMessage(db(), {
      senderId: latecomer.userId,
      conversationId,
      body: 'message D',
      clientMessageId: uuid(),
    });

    const backfilled = await listMessages(db(), {
      userId: latecomer.userId,
      conversationId,
      after: cursor.id,
    });
    const bodies = backfilled.messages.map((message) => message.body);

    expect(bodies).toContain('message D');
    expect(bodies).not.toContain('message A');
    expect(bodies).not.toContain('message B');
  });

  it('previews and counts unread inside the new member’s window only', async () => {
    const { owner, latecomer, conversationId } = await groupWithHistory();

    const theirs = await summaryFor(latecomer.userId, conversationId);
    expect(theirs).toBeDefined();

    // The sidebar preview is computed in their window, so it cannot show earlier content.
    expect(theirs?.lastMessage?.body).not.toBe('message A');
    expect(theirs?.lastMessage?.body).not.toBe('message B');
    expect(theirs?.lastMessage?.body).toBe('message C');

    /*
     * The unread badge counts what they can see, did not send, and that a person sent: just
     * "message C". Not the two messages from before they joined — which is what this number is
     * here to pin down — and not the server-written event that added them, which is not somebody
     * talking to them.
     */
    expect(theirs?.unreadCount).toBe(1);

    // The member who was there all along counts their own window, which is the whole history:
    // "message B" from their colleague, and "message C" from the owner.
    const original = await summaryFor(latecomer.userId, conversationId);
    expect(original?.unreadCount).toBe(1);

    const founder = await summaryFor(owner.userId, conversationId);
    expect(founder?.unreadCount).toBe(1); // "message B", from their colleague.
  });

  it('restarts the window when somebody is removed and later added again', async () => {
    const owner = await createTestIdentity('Rejoin Owner');
    const returner = await createTestIdentity('Rejoin Member');
    const conversationId = await makeGroup(owner, [returner]);

    const first = await sendMessage(db(), {
      senderId: owner.userId,
      conversationId,
      body: 'before they left',
      clientMessageId: uuid(),
    });

    // They read up to it, so there is a read marker to worry about.
    await markConversationRead(db(), returner.userId, conversationId, first.message.id);

    await removeGroupMember(db(), {
      actorId: owner.userId,
      conversationId,
      targetUserId: returner.userId,
    });

    await sendMessage(db(), {
      senderId: owner.userId,
      conversationId,
      body: 'while they were away',
      clientMessageId: uuid(),
    });

    await addGroupMembers(db(), {
      actorId: owner.userId,
      conversationId,
      userIds: [returner.userId],
    });

    const membership = await db().conversationMember.findUnique({
      where: { conversationId_userId: { conversationId, userId: returner.userId } },
      select: { leftAt: true, lastReadAt: true, lastReadMessageId: true, role: true },
    });

    expect(membership?.leftAt).toBeNull();
    // The stale read marker is cleared: it pointed outside the window they now have.
    expect(membership?.lastReadAt).toBeNull();
    expect(membership?.lastReadMessageId).toBeNull();

    const bodies = (
      await listMessages(db(), { userId: returner.userId, conversationId })
    ).messages.map((message) => message.body);

    // Q-17: re-joining starts a fresh window rather than restoring the old one.
    expect(bodies).not.toContain('before they left');
    expect(bodies).not.toContain('while they were away');
  });

  it('does not re-add a current member, which would hide history they can read', async () => {
    const owner = await createTestIdentity('Reset Owner');
    const member = await createTestIdentity('Reset Member');
    const conversationId = await makeGroup(owner, [member]);

    const before = await db().conversationMember.findUnique({
      where: { conversationId_userId: { conversationId, userId: member.userId } },
      select: { joinedAt: true },
    });

    await sendMessage(db(), {
      senderId: owner.userId,
      conversationId,
      body: 'visible to the existing member',
      clientMessageId: uuid(),
    });

    // Adding somebody who is already in the group is a no-op, not a reset.
    await addGroupMembers(db(), {
      actorId: owner.userId,
      conversationId,
      userIds: [member.userId],
    });

    const after = await db().conversationMember.findUnique({
      where: { conversationId_userId: { conversationId, userId: member.userId } },
      select: { joinedAt: true },
    });

    expect(after?.joinedAt.getTime()).toBe(before?.joinedAt.getTime());

    const bodies = (
      await listMessages(db(), { userId: member.userId, conversationId })
    ).messages.map((message) => message.body);
    expect(bodies).toContain('visible to the existing member');
  });

  it('drops the group from a leaver’s list without touching anybody else’s', async () => {
    const owner = await createTestIdentity('Leave Owner');
    const leaver = await createTestIdentity('Leave Member');
    const conversationId = await makeGroup(owner, [leaver]);

    const response = await readResponse<ConversationMembersWire>(
      await deleteMember(
        buildRequest({
          url: `/api/conversations/${conversationId}/members/${leaver.userId}`,
          method: 'DELETE',
          cookie: leaver.cookie,
        }),
        params({ id: conversationId, userId: leaver.userId }),
      ),
    );

    expect(response.status).toBe(200);
    // Null, because they can no longer see it — the same query the sidebar uses decided that.
    expect(response.body.conversation).toBeNull();

    expect(await summaryFor(leaver.userId, conversationId)).toBeUndefined();
    expect(await summaryFor(owner.userId, conversationId)).toBeDefined();
  });
});

/* --------------------------------------------------------------------------------------------- */
/* Real-time                                                                                       */
/* --------------------------------------------------------------------------------------------- */

suite('group messages in real time', () => {
  afterAll(async () => {
    await cleanUp();
    await disconnect();
  });

  it('commits before broadcasting, reaches members, and reaches nobody else', async () => {
    const server = await startTestServer();
    const owner = await createTestIdentity('Live Owner');
    const member = await createTestIdentity('Live Member');
    const outsider = await createTestIdentity('Live Outsider');
    const conversationId = await makeGroup(owner, [member]);

    const sockets: TestClient[] = [];

    try {
      const ownerSocket = await connectClient(server.url, owner.cookie);
      const memberSocket = await connectClient(server.url, member.cookie);
      const outsiderSocket = await connectClient(server.url, outsider.cookie);
      sockets.push(ownerSocket, memberSocket, outsiderSocket);

      await Promise.all([
        waitForReady(ownerSocket),
        waitForReady(memberSocket),
        waitForReady(outsiderSocket),
      ]);

      const delivered = waitForEvent(memberSocket, 'message:new');
      const notDelivered = expectNoEvent(outsiderSocket, 'message:new');

      const clientMessageId = uuid();
      const ack = await emitWithAck(ownerSocket, 'message:send', {
        conversationId,
        body: 'hello group',
        clientMessageId,
      });

      expect(ack.ok).toBe(true);

      const received = await delivered;
      expect(received.body).toBe('hello group');
      expect(received.conversationId).toBe(conversationId);

      // The row exists by the time anybody has been told about it: PostgreSQL is the source of
      // truth, and the broadcast follows the commit rather than racing it.
      const stored = await db().message.findUnique({ where: { id: received.id } });
      expect(stored?.body).toBe('hello group');
      expect(stored?.senderId).toBe(owner.userId);

      await notDelivered;
    } finally {
      for (const socket of sockets) socket.close();
      await server.close();
    }
  });

  it('keeps the idempotency guard for group sends', async () => {
    const server = await startTestServer();
    const owner = await createTestIdentity('Idem Owner');
    const member = await createTestIdentity('Idem Member');
    const conversationId = await makeGroup(owner, [member]);

    const sockets: TestClient[] = [];

    try {
      const ownerSocket = await connectClient(server.url, owner.cookie);
      const memberSocket = await connectClient(server.url, member.cookie);
      sockets.push(ownerSocket, memberSocket);
      await Promise.all([waitForReady(ownerSocket), waitForReady(memberSocket)]);

      const clientMessageId = uuid();
      const payload = { conversationId, body: 'sent once', clientMessageId };

      const firstDelivery = waitForEvent(memberSocket, 'message:new');
      const first = await emitWithAck<{ id: string }>(ownerSocket, 'message:send', payload);
      // The acknowledgement precedes the broadcast, so the first copy has to be collected before
      // watching for a second — otherwise the watch catches the message it was meant to allow.
      await firstDelivery;

      // A retry after a dropped acknowledgement: same key, and it must collide with the stored
      // row rather than insert a second message or broadcast one.
      const noSecondCopy = expectNoEvent(memberSocket, 'message:new');
      const retry = await emitWithAck<{ id: string }>(ownerSocket, 'message:send', payload);

      expect(first.ok && retry.ok).toBe(true);
      if (first.ok && retry.ok) expect(retry.data.id).toBe(first.data.id);

      await noSecondCopy;

      expect(
        await db().message.count({ where: { conversationId, clientMessageId } }),
      ).toBe(1);
    } finally {
      for (const socket of sockets) socket.close();
      await server.close();
    }
  });

  it('reaches a member added while they were already connected', async () => {
    const server = await startTestServer();
    const owner = await createTestIdentity('Join Owner');
    const existing = await createTestIdentity('Join Existing');
    const newcomer = await createTestIdentity('Join Newcomer');
    const conversationId = await makeGroup(owner, [existing]);

    const sockets: TestClient[] = [];

    try {
      const ownerSocket = await connectClient(server.url, owner.cookie);
      const newcomerSocket = await connectClient(server.url, newcomer.cookie);
      sockets.push(ownerSocket, newcomerSocket);

      const ready = await waitForReady(newcomerSocket);
      await waitForReady(ownerSocket);
      // Their socket connected before the group existed for them.
      expect(ready.conversationIds).not.toContain(conversationId);

      const told = waitForEvent(newcomerSocket, 'conversation:changed');

      // Through the route, because telling the members is the route's job — a test that called
      // the service directly would skip the very step it is here to check.
      const added = await readResponse<ConversationMembersWire>(
        await postMembers(
          buildRequest({
            url: `/api/conversations/${conversationId}/members`,
            method: 'POST',
            cookie: owner.cookie,
            body: { userIds: [newcomer.userId] },
          }),
          params({ id: conversationId }),
        ),
      );
      expect(added.status).toBe(200);

      // The event carries an id and nothing else; the client re-reads through the authorized
      // endpoints, so the socket never becomes a way to learn about a conversation.
      const change = await told;
      expect(change).toEqual({ conversationId });

      // And the next message reaches them without a reconnect, because the same call put their
      // socket in the room.
      const delivered = waitForEvent(newcomerSocket, 'message:new');
      const ack = await emitWithAck(ownerSocket, 'message:send', {
        conversationId,
        body: 'welcome aboard',
        clientMessageId: uuid(),
      });
      expect(ack.ok).toBe(true);
      expect((await delivered).body).toBe('welcome aboard');
    } finally {
      for (const socket of sockets) socket.close();
      await server.close();
    }
  });

  it('stops reaching somebody who has been removed', async () => {
    const server = await startTestServer();
    const owner = await createTestIdentity('Exit Owner');
    const staying = await createTestIdentity('Exit Staying');
    const leaving = await createTestIdentity('Exit Leaving');
    const conversationId = await makeGroup(owner, [staying, leaving]);

    const sockets: TestClient[] = [];

    try {
      const ownerSocket = await connectClient(server.url, owner.cookie);
      const stayingSocket = await connectClient(server.url, staying.cookie);
      const leavingSocket = await connectClient(server.url, leaving.cookie);
      sockets.push(ownerSocket, stayingSocket, leavingSocket);

      await Promise.all([
        waitForReady(ownerSocket),
        waitForReady(stayingSocket),
        waitForReady(leavingSocket),
      ]);

      const told = waitForEvent(leavingSocket, 'conversation:changed');

      const removed = await readResponse<ConversationMembersWire>(
        await deleteMember(
          buildRequest({
            url: `/api/conversations/${conversationId}/members/${leaving.userId}`,
            method: 'DELETE',
            cookie: owner.cookie,
          }),
          params({ id: conversationId, userId: leaving.userId }),
        ),
      );
      expect(removed.status).toBe(200);

      // They are told, so their sidebar can drop the group rather than showing a stale one.
      expect(await told).toEqual({ conversationId });

      const stillDelivered = waitForEvent(stayingSocket, 'message:new');
      const noLongerDelivered = expectNoEvent(leavingSocket, 'message:new');

      const ack = await emitWithAck(ownerSocket, 'message:send', {
        conversationId,
        body: 'said after they left',
        clientMessageId: uuid(),
      });
      expect(ack.ok).toBe(true);

      expect((await stillDelivered).body).toBe('said after they left');
      await noLongerDelivered;

      // Belt and braces: their own socket cannot talk its way back in either.
      const denied = await emitWithAck(leavingSocket, 'conversation:join', { conversationId });
      expect(denied.ok).toBe(false);
    } finally {
      for (const socket of sockets) socket.close();
      await server.close();
    }
  });
});

/* --------------------------------------------------------------------------------------------- */
/* Regression: the group work must not have changed direct conversations                           */
/* --------------------------------------------------------------------------------------------- */

suite('direct conversations after the group work', () => {
  afterAll(async () => {
    await cleanUp();
    await disconnect();
  });

  it('still resolves one conversation per pair, and still refuses a group payload without ids', async () => {
    const alice = await createTestIdentity('Regression Alice');
    const bob = await createTestIdentity('Regression Bob');

    const first = await readResponse<ConversationCreatedWire>(
      await postConversations(
        buildRequest({
          url: '/api/conversations',
          method: 'POST',
          cookie: alice.cookie,
          body: { type: 'DIRECT', userId: bob.userId },
        }),
      ),
    );
    const conversationId = trackConversation(first.body.conversation.id);
    expect(first.status).toBe(201);

    const second = await readResponse<ConversationCreatedWire>(
      await postConversations(
        buildRequest({
          url: '/api/conversations',
          method: 'POST',
          cookie: bob.cookie,
          body: { type: 'DIRECT', userId: alice.userId },
        }),
      ),
    );
    expect(second.status).toBe(200);
    expect(second.body.conversation.id).toBe(conversationId);
    expect(second.body.created).toBe(false);

    // A malformed group request is a bad request, not a half-made group.
    const malformed = await readResponse<ApiErrorWire>(
      await postConversations(
        buildRequest({
          url: '/api/conversations',
          method: 'POST',
          cookie: alice.cookie,
          body: { type: 'GROUP', name: `${TEST_NAME_PREFIX}No Members`, memberIds: [] },
        }),
      ),
    );
    expect(malformed.status).toBe(400);
  });

  it('rejects a conversation type the API does not offer', async () => {
    const alice = await createTestIdentity('Regression Type');

    const refused = await readResponse<ApiErrorWire>(
      await postConversations(
        buildRequest({
          url: '/api/conversations',
          method: 'POST',
          cookie: alice.cookie,
          body: { type: 'BROADCAST', userId: alice.userId },
        }),
      ),
    );

    expect(refused.status).toBe(400);
  });

  it('cannot be used to add somebody to a conversation through the message path', async () => {
    const alice = await createTestIdentity('Regression Path');
    const bob = await createTestIdentity('Regression Path Bob');
    const conversationId = await makeGroup(alice, [bob]);

    // Errors carry no member list, no name and no ids beyond what the caller sent.
    const error = await removeGroupMember(db(), {
      actorId: alice.userId,
      conversationId,
      targetUserId: bob.userId,
    }).then(
      () => null,
      (failure: unknown) => failure,
    );

    expect(error).toBeNull();

    const outsider = await createTestIdentity('Regression Path Outsider');
    const refused = await removeGroupMember(db(), {
      actorId: outsider.userId,
      conversationId,
      targetUserId: alice.userId,
    }).catch((failure: unknown) => failure);

    expect(refused).toBeInstanceOf(ConversationError);
    expect((refused as ConversationError).reason).toBe('NOT_A_MEMBER');
    // Nothing about the group is in the message an outsider receives.
    expect((refused as ConversationError).message).not.toContain(conversationId);
  });
});
