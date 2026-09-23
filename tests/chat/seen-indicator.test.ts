/**
 * The "Seen" indicator, as the browser decides it (Batch 1.3).
 *
 * Pure: no database, no socket. What is under test is the rule the interface applies once the
 * server has told it who has read what — which message carries the mark, and, just as importantly,
 * which do not.
 *
 * The three things most worth getting right, and easiest to get wrong:
 *
 *   1. ONE mark, under the newest own message the other participant has reached. A watermark means
 *      everything above it is read too; stamping each bubble would repeat one fact down the screen.
 *   2. Never from the sender's own marker. Opening your own conversation must not make your own
 *      message look seen.
 *   3. Never in a group. Group watermarks are withheld by the server, and a per-member list under
 *      every message is exactly what Message info replaces.
 */

import { describe, expect, it } from 'vitest';

import {
  chatReducer,
  initialChatState,
  selectSeenMessageId,
  type ChatAction,
  type ChatState,
} from '@/lib/chat/state';
import type { ConversationWire, MessageWire, UserWire } from '@/lib/chat/wire';

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const CAROL = '44444444-4444-4444-8444-444444444444';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';

function apply(state: ChatState, ...actions: ChatAction[]): ChatState {
  return actions.reduce(chatReducer, state);
}

function user(id: string, displayName: string): UserWire {
  return { id, displayName, lastSeenAt: '2026-09-21T09:00:00.000Z' };
}

function member(userId: string, lastReadAt: string | null) {
  return { userId, role: 'MEMBER' as const, joinedAt: '2026-09-21T09:00:00.000Z', lastReadAt };
}

function conversation(overrides: Partial<ConversationWire> = {}): ConversationWire {
  return {
    id: CONVERSATION,
    type: 'DIRECT',
    name: null,
    createdAt: '2026-09-21T09:00:00.000Z',
    lastMessageAt: null,
    members: [member(ALICE, null), member(BOB, null)],
    lastMessage: null,
    unreadCount: 0,
    ...overrides,
  };
}

/**
 * A message fixture.
 *
 * `clientMessageId` is DERIVED FROM THE ID, not a constant. The reducer reconciles an optimistic
 * bubble with its stored row by idempotency key, so several fixtures sharing one key collapse into
 * a single message — which silently turned a three-message list into a one-message list and made
 * a test about "only the newest is marked" pass without ever having three messages in it.
 */
function message(overrides: Partial<MessageWire> = {}): MessageWire {
  const id = overrides.id ?? 'm1';

  return {
    id,
    conversationId: CONVERSATION,
    senderId: ALICE,
    clientMessageId: `client-${id}`,
    type: 'TEXT',
    body: 'hello',
    createdAt: '2026-09-21T10:00:00.000Z',
    attachment: null,
    replyTo: null,
    isForwarded: false,
    editedAt: null,
    pinnedAt: null,
    deletedAt: null,
    reactions: [],
    // No mentions unless a test adds them — which is every message before Batch 1.7.
    mentions: [],
    ...overrides,
  };
}

/** A workspace where Alice is the reader, with the given conversation and messages loaded. */
function workspace(conversationWire: ConversationWire, messages: MessageWire[]): ChatState {
  return apply(
    initialChatState,
    {
      type: 'identity-ready',
      userId: ALICE,
      displayName: 'Alice',
      deviceLabel: 'PC-1',
      maxFileSize: 1024,
    },
    {
      type: 'conversations-loaded',
      conversations: [conversationWire],
      users: [user(ALICE, 'Alice'), user(BOB, 'Bob'), user(CAROL, 'Carol')],
    },
    {
      type: 'history-loaded',
      conversationId: CONVERSATION,
      messages,
      hasMore: false,
      mode: 'replace',
    },
  );
}

describe('selectSeenMessageId', () => {
  it('marks nothing when the other participant has read nothing', () => {
    const state = workspace(conversation(), [message()]);
    expect(selectSeenMessageId(state, CONVERSATION, ALICE)).toBeNull();
  });

  it('marks the message once the other participant’s watermark reaches it', () => {
    const state = workspace(
      conversation({ members: [member(ALICE, null), member(BOB, '2026-09-21T10:00:00.000Z')] }),
      [message()],
    );
    expect(selectSeenMessageId(state, CONVERSATION, ALICE)).toBe('m1');
  });

  it('marks ONLY the newest read message, not every one of them', () => {
    const state = workspace(
      conversation({ members: [member(ALICE, null), member(BOB, '2026-09-21T10:02:00.000Z')] }),
      [
        message({ id: 'm1', body: 'Hello', createdAt: '2026-09-21T10:00:00.000Z' }),
        message({ id: 'm2', body: 'Are you there?', createdAt: '2026-09-21T10:01:00.000Z' }),
        message({ id: 'm3', body: 'Please check this', createdAt: '2026-09-21T10:02:00.000Z' }),
      ],
    );

    // All three are read. Only the last carries the mark — the watermark says the rest are too.
    expect(selectSeenMessageId(state, CONVERSATION, ALICE)).toBe('m3');
  });

  it('marks the newest READ message when newer ones are still unread', () => {
    const state = workspace(
      conversation({ members: [member(ALICE, null), member(BOB, '2026-09-21T10:01:00.000Z')] }),
      [
        message({ id: 'm1', createdAt: '2026-09-21T10:00:00.000Z' }),
        message({ id: 'm2', createdAt: '2026-09-21T10:01:00.000Z' }),
        message({ id: 'm3', createdAt: '2026-09-21T10:05:00.000Z' }),
      ],
    );

    expect(selectSeenMessageId(state, CONVERSATION, ALICE)).toBe('m2');
  });

  it('NEVER uses the reader’s own watermark', () => {
    // Alice has read everything; Bob has read nothing. Alice must see no mark on her own message.
    const state = workspace(
      conversation({
        members: [member(ALICE, '2026-09-21T23:00:00.000Z'), member(BOB, null)],
      }),
      [message()],
    );

    expect(selectSeenMessageId(state, CONVERSATION, ALICE)).toBeNull();
  });

  it('never marks a message somebody else sent', () => {
    const state = workspace(
      conversation({ members: [member(ALICE, null), member(BOB, '2026-09-21T23:00:00.000Z')] }),
      [message({ id: 'theirs', senderId: BOB })],
    );

    // "Seen" is about your own messages. Bob's message being read by Bob is not information.
    expect(selectSeenMessageId(state, CONVERSATION, ALICE)).toBeNull();
  });

  it('skips SYSTEM messages and tombstones', () => {
    const state = workspace(
      conversation({ members: [member(ALICE, null), member(BOB, '2026-09-21T23:00:00.000Z')] }),
      [
        message({ id: 'mine', createdAt: '2026-09-21T10:00:00.000Z' }),
        message({
          id: 'deleted',
          createdAt: '2026-09-21T10:01:00.000Z',
          body: null,
          deletedAt: '2026-09-21T10:02:00.000Z',
        }),
        message({ id: 'system', senderId: null, type: 'SYSTEM', createdAt: '2026-09-21T10:03:00.000Z' }),
      ],
    );

    // The mark falls back to the newest real message of the reader's own.
    expect(selectSeenMessageId(state, CONVERSATION, ALICE)).toBe('mine');
  });

  it('returns nothing for a GROUP, whatever the members say', () => {
    const state = workspace(
      conversation({
        type: 'GROUP',
        name: 'Project',
        // Even if a watermark somehow arrived, a group never shows the inline mark.
        members: [
          member(ALICE, null),
          member(BOB, '2026-09-21T23:00:00.000Z'),
          member(CAROL, '2026-09-21T23:00:00.000Z'),
        ],
      }),
      [message()],
    );

    expect(selectSeenMessageId(state, CONVERSATION, ALICE)).toBeNull();
  });

  it('ignores a message that is still sending', () => {
    const state = apply(
      workspace(conversation({ members: [member(ALICE, null), member(BOB, '2026-09-21T23:00:00.000Z')] }), []),
      {
        type: 'message-queued',
        conversationId: CONVERSATION,
        clientMessageId: 'pending',
        body: 'not sent yet',
        now: '2026-09-21T10:00:00.000Z',
      },
    );

    // Nothing the server has not acknowledged can have been read by anybody.
    expect(selectSeenMessageId(state, CONVERSATION, ALICE)).toBeNull();
  });
});

describe('the conversation-read reducer', () => {
  const base = () =>
    workspace(conversation(), [message({ id: 'm1', createdAt: '2026-09-21T10:00:00.000Z' })]);

  it('records the watermark and makes the message seen', () => {
    const state = apply(base(), {
      type: 'conversation-read',
      conversationId: CONVERSATION,
      userId: BOB,
      lastReadAt: '2026-09-21T10:00:00.000Z',
    });

    expect(selectSeenMessageId(state, CONVERSATION, ALICE)).toBe('m1');
  });

  it('CHANGES NOTHING ELSE — no unread, no reordering, no message touched', () => {
    const before = base();
    const after = apply(before, {
      type: 'conversation-read',
      conversationId: CONVERSATION,
      userId: BOB,
      lastReadAt: '2026-09-21T10:00:00.000Z',
    });

    const conversationBefore = before.conversations[0]!;
    const conversationAfter = after.conversations[0]!;

    /*
     * Somebody reading is not an event in the conversation. If any of these moved, a read receipt
     * would look like a new message: a badge, a jump to the top of the sidebar, a changed preview.
     */
    expect(conversationAfter.unreadCount).toBe(conversationBefore.unreadCount);
    expect(conversationAfter.lastMessageAt).toBe(conversationBefore.lastMessageAt);
    expect(conversationAfter.lastMessage).toEqual(conversationBefore.lastMessage);
    expect(after.messagesByConversation).toEqual(before.messagesByConversation);
    expect(after.conversations).toHaveLength(before.conversations.length);
  });

  it('only ever moves the watermark forward', () => {
    const state = apply(
      base(),
      {
        type: 'conversation-read',
        conversationId: CONVERSATION,
        userId: BOB,
        lastReadAt: '2026-09-21T12:00:00.000Z',
      },
      // A stale event arriving after a reconnect must not un-see anything.
      {
        type: 'conversation-read',
        conversationId: CONVERSATION,
        userId: BOB,
        lastReadAt: '2026-09-21T08:00:00.000Z',
      },
    );

    const bob = state.conversations[0]!.members.find((entry) => entry.userId === BOB);
    expect(bob?.lastReadAt).toBe('2026-09-21T12:00:00.000Z');
  });

  it('ignores a null watermark, which is what a group sends', () => {
    const before = apply(base(), {
      type: 'conversation-read',
      conversationId: CONVERSATION,
      userId: BOB,
      lastReadAt: '2026-09-21T10:00:00.000Z',
    });

    // The group nudge carries no read state. It must not erase a value the list legitimately had.
    const after = apply(before, {
      type: 'conversation-read',
      conversationId: CONVERSATION,
      userId: BOB,
      lastReadAt: null,
    });

    expect(after).toBe(before);
  });

  it('ignores an event for a conversation or member it does not know', () => {
    const before = base();

    expect(
      apply(before, {
        type: 'conversation-read',
        conversationId: 'not-a-conversation-here',
        userId: BOB,
        lastReadAt: '2026-09-21T10:00:00.000Z',
      }),
    ).toBe(before);

    expect(
      apply(before, {
        type: 'conversation-read',
        conversationId: CONVERSATION,
        userId: CAROL,
        lastReadAt: '2026-09-21T10:00:00.000Z',
      }),
    ).toBe(before);
  });
});
