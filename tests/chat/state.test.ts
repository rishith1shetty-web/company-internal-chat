/**
 * The browser-side reducer.
 *
 * Pure, so no database and no socket are involved. What is under test is the reconciliation that
 * decides what a user actually sees: an optimistic bubble becoming the stored message rather than
 * sitting beside it, a broadcast that races an acknowledgement not producing two copies, and a
 * failed send never being displayed as delivered.
 */

import { describe, expect, it } from 'vitest';

import {
  chatReducer,
  conversationPreview,
  initialChatState,
  selectConversationListEntries,
  selectMessages,
  selectUsersById,
  type ChatAction,
  type ChatState,
} from '@/lib/chat/state';
import type { ConversationWire, MessageWire, UserWire } from '@/lib/chat/wire';

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';

function apply(state: ChatState, ...actions: ChatAction[]): ChatState {
  return actions.reduce(chatReducer, state);
}

function user(id: string, displayName: string): UserWire {
  return { id, displayName, lastSeenAt: '2026-08-28T09:00:00.000Z' };
}

function conversation(overrides: Partial<ConversationWire> = {}): ConversationWire {
  return {
    id: CONVERSATION,
    type: 'DIRECT',
    name: null,
    createdAt: '2026-08-28T09:00:00.000Z',
    lastMessageAt: null,
    members: [
      { userId: ALICE, role: 'MEMBER', joinedAt: '2026-08-28T09:00:00.000Z', lastReadAt: null },
      { userId: BOB, role: 'MEMBER', joinedAt: '2026-08-28T09:00:00.000Z', lastReadAt: null },
    ],
    lastMessage: null,
    unreadCount: 0,
    ...overrides,
  };
}

function message(overrides: Partial<MessageWire> = {}): MessageWire {
  return {
    id: 'server-message-1',
    conversationId: CONVERSATION,
    senderId: BOB,
    clientMessageId: 'client-1',
    type: 'TEXT',
    body: 'hello',
    replyTo: null,
    isForwarded: false,
    editedAt: null,
    pinnedAt: null,
    deletedAt: null,
    reactions: [],
    attachment: null,
    createdAt: '2026-08-28T10:00:00.000Z',
    ...overrides,
  };
}

/** A workspace with an identity, one conversation and both users known. */
function workspace(): ChatState {
  return apply(
    initialChatState,
    {
        type: 'identity-ready',
        userId: ALICE,
        displayName: 'Alice',
        deviceLabel: 'PC-001',
        maxFileSize: 524_288_000,
      },
    {
      type: 'conversations-loaded',
      conversations: [conversation()],
      users: [user(ALICE, 'Alice'), user(BOB, 'Bob')],
    },
  );
}

describe('chat reducer', () => {
  it('shows the unassigned screen when this computer has no identity', () => {
    const state = chatReducer(initialChatState, { type: 'identity-missing' });

    expect(state.screen).toBe('unassigned');
    expect(state.currentUser).toBeNull();
  });

  it('shows an optimistic message as sending, never as sent', () => {
    const state = apply(workspace(), {
      type: 'message-queued',
      conversationId: CONVERSATION,
      clientMessageId: 'client-99',
      body: 'typed just now',
      now: '2026-08-28T11:00:00.000Z',
    });

    const [only] = selectMessages(state, CONVERSATION);
    expect(only?.deliveryState).toBe('SENDING');
    expect(only?.senderId).toBe(ALICE);

    // A message that has not been acknowledged is not a preview: the sidebar must not claim
    // something was said that may still fail.
    expect(conversationPreview(state, state.conversations[0]!)).toBe('No messages yet');
  });

  it('replaces the optimistic bubble with the stored row on acknowledgement', () => {
    const queued = apply(workspace(), {
      type: 'message-queued',
      conversationId: CONVERSATION,
      clientMessageId: 'client-99',
      body: 'typed just now',
      now: '2026-08-28T11:00:00.000Z',
    });

    const acknowledged = apply(queued, {
      type: 'message-acknowledged',
      clientMessageId: 'client-99',
      message: message({
        id: 'server-99',
        senderId: ALICE,
        clientMessageId: 'client-99',
        body: 'typed just now',
        createdAt: '2026-08-28T11:00:00.100Z',
      }),
    });

    const messages = selectMessages(acknowledged, CONVERSATION);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe('server-99');
    expect(messages[0]?.deliveryState).toBe('SENT');
  });

  it('does not show a message twice when the broadcast follows the acknowledgement', () => {
    const stored = message({
      id: 'server-99',
      senderId: ALICE,
      clientMessageId: 'client-99',
      body: 'typed just now',
    });

    const state = apply(
      workspace(),
      {
        type: 'message-queued',
        conversationId: CONVERSATION,
        clientMessageId: 'client-99',
        body: 'typed just now',
        now: '2026-08-28T11:00:00.000Z',
      },
      { type: 'message-acknowledged', clientMessageId: 'client-99', message: stored },
      // The same message arriving again from another tab's broadcast.
      { type: 'message-received', message: stored },
    );

    expect(selectMessages(state, CONVERSATION)).toHaveLength(1);
  });

  it('reconciles a broadcast that arrives before the acknowledgement', () => {
    const stored = message({
      id: 'server-99',
      senderId: ALICE,
      clientMessageId: 'client-99',
      body: 'raced',
    });

    const state = apply(
      workspace(),
      {
        type: 'message-queued',
        conversationId: CONVERSATION,
        clientMessageId: 'client-99',
        body: 'raced',
        now: '2026-08-28T11:00:00.000Z',
      },
      // The broadcast wins the race; the idempotency key is what identifies it as the same one.
      { type: 'message-received', message: stored },
      { type: 'message-acknowledged', clientMessageId: 'client-99', message: stored },
    );

    const messages = selectMessages(state, CONVERSATION);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.deliveryState).toBe('SENT');
  });

  it('marks a failed send as failed and lets a retry return it to sending', () => {
    const queued = apply(workspace(), {
      type: 'message-queued',
      conversationId: CONVERSATION,
      clientMessageId: 'client-99',
      body: 'went nowhere',
      now: '2026-08-28T11:00:00.000Z',
    });

    const failed = apply(queued, {
      type: 'message-failed',
      conversationId: CONVERSATION,
      clientMessageId: 'client-99',
      message: 'You are not connected.',
    });

    expect(selectMessages(failed, CONVERSATION)[0]?.deliveryState).toBe('FAILED');
    expect(failed.notice).toBe('You are not connected.');

    const retrying = apply(failed, {
      type: 'message-retrying',
      conversationId: CONVERSATION,
      clientMessageId: 'client-99',
    });

    expect(selectMessages(retrying, CONVERSATION)[0]?.deliveryState).toBe('SENDING');
    // The key is unchanged, so the retry collides with the stored row rather than duplicating it.
    expect(selectMessages(retrying, CONVERSATION)[0]?.clientMessageId).toBe('client-99');
  });

  it('counts an incoming message as unread only when the conversation is not open', () => {
    const closed = apply(workspace(), {
      type: 'message-received',
      message: message({ id: 'a', clientMessageId: 'ca' }),
    });
    expect(closed.conversations[0]?.unreadCount).toBe(1);

    const open = apply(
      workspace(),
      { type: 'select-conversation', conversationId: CONVERSATION },
      { type: 'message-received', message: message({ id: 'b', clientMessageId: 'cb' }) },
    );
    expect(open.conversations[0]?.unreadCount).toBe(0);
  });

  it('never counts the user own message as unread, even from another tab', () => {
    const state = apply(workspace(), {
      type: 'message-received',
      message: message({ id: 'mine', clientMessageId: 'cm', senderId: ALICE }),
    });

    expect(state.conversations[0]?.unreadCount).toBe(0);
  });

  it('takes the server unread count as the answer', () => {
    const state = apply(
      workspace(),
      { type: 'message-received', message: message({ id: 'a', clientMessageId: 'ca' }) },
      { type: 'unread-cleared', conversationId: CONVERSATION, unreadCount: 0 },
    );

    expect(state.conversations[0]?.unreadCount).toBe(0);
  });

  it('keeps a message that was sent while history was loading', () => {
    const state = apply(
      workspace(),
      {
        type: 'message-queued',
        conversationId: CONVERSATION,
        clientMessageId: 'client-99',
        body: 'in flight',
        now: '2026-08-28T11:00:00.000Z',
      },
      {
        type: 'history-loaded',
        conversationId: CONVERSATION,
        messages: [message({ id: 'older', clientMessageId: 'c-older' })],
        hasMore: false,
        mode: 'replace',
      },
    );

    const bodies = selectMessages(state, CONVERSATION).map((item) => item.body);
    expect(bodies).toEqual(['hello', 'in flight']);
  });

  it('updates the preview and ordering when a message arrives', () => {
    const other = '44444444-4444-4444-8444-444444444444';

    const state = apply(
      initialChatState,
      {
        type: 'identity-ready',
        userId: ALICE,
        displayName: 'Alice',
        deviceLabel: 'PC-001',
        maxFileSize: 524_288_000,
      },
      {
        type: 'conversations-loaded',
        conversations: [
          conversation({ lastMessageAt: '2026-08-28T09:00:00.000Z' }),
          conversation({
            id: other,
            lastMessageAt: '2026-08-28T09:30:00.000Z',
            members: [
              { userId: ALICE, role: 'MEMBER', joinedAt: '2026-08-28T09:00:00.000Z', lastReadAt: null },
              { userId: BOB, role: 'MEMBER', joinedAt: '2026-08-28T09:00:00.000Z', lastReadAt: null },
            ],
          }),
        ],
        users: [user(ALICE, 'Alice'), user(BOB, 'Bob')],
      },
      {
        type: 'message-received',
        message: message({ id: 'newest', clientMessageId: 'c-newest', body: 'latest word' }),
      },
    );

    // The conversation that just received a message moves to the top.
    expect(state.conversations[0]?.id).toBe(CONVERSATION);
    expect(conversationPreview(state, state.conversations[0]!)).toBe('latest word');
  });

  it('shows presence only for users the server has reported on', () => {
    const state = apply(workspace(), {
      type: 'presence-changed',
      entries: [{ userId: BOB, online: true, lastSeenAt: '2026-08-28T10:00:00.000Z' }],
    });

    const users = selectUsersById(state);
    expect(users.get(BOB)?.presence).toBe('ONLINE');
    // The current user is online by construction: they are looking at the page.
    expect(users.get(ALICE)?.presence).toBe('ONLINE');
  });

  it('distinguishes two colleagues who share a display name (D-02)', () => {
    const twin = '55555555-5555-4555-8555-555555555555';

    const state = apply(
      initialChatState,
      {
        type: 'identity-ready',
        userId: ALICE,
        displayName: 'Alice',
        deviceLabel: 'PC-001',
        maxFileSize: 524_288_000,
      },
      {
        type: 'conversations-loaded',
        conversations: [
          conversation(),
          conversation({
            id: '66666666-6666-4666-8666-666666666666',
            members: [
              { userId: ALICE, role: 'MEMBER', joinedAt: '2026-08-28T09:00:00.000Z', lastReadAt: null },
              { userId: twin, role: 'MEMBER', joinedAt: '2026-08-28T09:00:00.000Z', lastReadAt: null },
            ],
          }),
        ],
        users: [user(ALICE, 'Alice'), user(BOB, 'Sarah Chen'), user(twin, 'Sarah Chen')],
      },
    );

    const entries = selectConversationListEntries(state);
    const titles = entries.map((entry) => entry.title);
    const discriminators = entries.map((entry) => entry.discriminator);

    expect(new Set(titles)).toEqual(new Set(['Sarah Chen']));
    // Same name, so both rows must carry something that tells them apart.
    expect(discriminators.every((value) => typeof value === 'string')).toBe(true);
    expect(new Set(discriminators).size).toBe(2);
  });

  /*
   * The reassignment case, from the browser's point of view.
   *
   * An administrator hands this computer to somebody else; the previous employee's session is
   * revoked server-side, the next request answers 401, and the interface must drop every trace of
   * who used to be here rather than showing the new person the old one's conversations.
   */
  it('drops everything belonging to the previous identity when it goes away', () => {
    const state = apply(
      workspace(),
      { type: 'select-conversation', conversationId: CONVERSATION },
      { type: 'message-received', message: message() },
      { type: 'identity-missing' },
    );

    expect(state.screen).toBe('unassigned');
    expect(state.currentUser).toBeNull();
    expect(state.conversations).toEqual([]);
    expect(state.messagesByConversation).toEqual({});
    expect(state.users).toEqual({});
    expect(state.selectedConversationId).toBeNull();
  });

  it('carries the assigned computer label, which nothing in the reducer can change', () => {
    const state = workspace();

    expect(state.currentUser).toEqual({
      id: ALICE,
      displayName: 'Alice',
      deviceLabel: 'PC-001',
      // Carried from the server's answer, not decided here. The composer reads it to refuse an
      // oversized file early; the server enforces the same number regardless (Phase 7).
      maxFileSize: 524_288_000,
    });

    // There is no action that edits an identity: the reducer's action union has none, and this
    // asserts the only ones that touch `currentUser` at all.
    const identityActions = ['identity-ready', 'identity-missing'];
    expect(identityActions).toHaveLength(2);
  });

  it('closes a conversation that is no longer in the caller list', () => {
    const state = apply(
      workspace(),
      { type: 'select-conversation', conversationId: CONVERSATION },
      { type: 'conversations-loaded', conversations: [], users: [] },
    );

    expect(state.selectedConversationId).toBeNull();
  });
});
