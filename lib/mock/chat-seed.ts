/**
 * =============================================================================================
 * TEMPORARY MOCK DATA — PHASE 2 ONLY. REMOVED WHEN PHASE 5 CONNECTS THE REAL API.
 * =============================================================================================
 *
 * This module exists so the Phase 2 interface can be seen and exercised before there is a
 * database (Phase 3) or a real-time layer (Phase 4). It is NOT a data-access layer, NOT a fake
 * repository, and deliberately imitates no part of PostgreSQL or Prisma (handover §22).
 * It is a plain builder returning one illustrative workspace.
 *
 * Nothing here is persisted. Reloading the page returns to this seed and discards anything the
 * user typed — the honest behaviour for a phase with no storage.
 *
 * Two details are deliberate rather than decorative:
 *
 *   - Two different users are both called "Sarah Chen". Display names are not unique (D-02),
 *     so the interface must tell same-named people apart by their server-issued id. Seeding
 *     the collision means the discriminator is exercised rather than assumed.
 *   - Some group members carry a `joinedAt` later than the group's creation, because group
 *     history is join-bounded (D-03). Phase 6 enforces that server-side; the field is carried
 *     here so the UI already shows what it will need to show.
 *
 * Timestamps are built relative to the moment the user enters the application, so the seeded
 * conversation reads naturally ("Today", "Yesterday"). `createSeedWorkspace` is called only
 * from a browser event handler, never during server rendering.
 */

import type { ChatMessage, Conversation, ConversationMember, UserSummary } from '@/lib/chat/types';

/** Identity the seeded conversations belong to. The display name is supplied by the user. */
export const SEED_CURRENT_USER_ID = 'usr-0a41d7e3';

const PRIYA = 'usr-3c8b21f9';
const DANIEL = 'usr-91ee45ab';
const SARAH_OPERATIONS = 'usr-52d0c7b4';
const SARAH_FINANCE = 'usr-c6183fda';
const MARCUS = 'usr-77b4e0a1';
const AISHA = 'usr-1d9f6c58';

export interface SeedWorkspace {
  /** Everyone known to the application except the current user (the Phase 5 user directory). */
  directory: UserSummary[];
  conversations: Conversation[];
  messagesByConversation: Record<string, ChatMessage[]>;
}

function minutesAgo(now: Date, minutes: number): string {
  return new Date(now.getTime() - minutes * 60_000).toISOString();
}

function daysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

/** Users other than the current one. Presence is fixed here; Phase 4 derives it from sockets. */
export function createSeedDirectory(now: Date): UserSummary[] {
  return [
    { id: PRIYA, displayName: 'Priya Nair', presence: 'ONLINE', lastSeenAt: minutesAgo(now, 1) },
    { id: DANIEL, displayName: 'Daniel Roy', presence: 'ONLINE', lastSeenAt: minutesAgo(now, 2) },
    {
      id: SARAH_OPERATIONS,
      displayName: 'Sarah Chen',
      presence: 'OFFLINE',
      lastSeenAt: minutesAgo(now, 95),
    },
    {
      id: SARAH_FINANCE,
      displayName: 'Sarah Chen',
      presence: 'ONLINE',
      lastSeenAt: minutesAgo(now, 4),
    },
    { id: MARCUS, displayName: 'Marcus Weber', presence: 'OFFLINE', lastSeenAt: daysAgo(now, 2) },
    { id: AISHA, displayName: 'Aisha Khan', presence: 'ONLINE', lastSeenAt: minutesAgo(now, 12) },
  ];
}

function member(
  userId: string,
  joinedAt: string,
  role: ConversationMember['role'] = 'MEMBER',
): ConversationMember {
  return { userId, role, joinedAt };
}

function textMessage(
  id: string,
  conversationId: string,
  senderId: string,
  body: string,
  createdAt: string,
): ChatMessage {
  return {
    id,
    clientMessageId: `seed-${id}`,
    conversationId,
    senderId,
    kind: 'TEXT',
    body,
    createdAt,
    deliveryState: 'SENT',
    attachment: null,
  };
}

function systemMessage(
  id: string,
  conversationId: string,
  body: string,
  createdAt: string,
): ChatMessage {
  return {
    id,
    clientMessageId: `seed-${id}`,
    conversationId,
    senderId: null,
    kind: 'SYSTEM',
    body,
    createdAt,
    deliveryState: 'SENT',
    attachment: null,
  };
}

/** Builds the illustrative workspace shown after the current user enters a display name. */
export function createSeedWorkspace(now: Date = new Date()): SeedWorkspace {
  const me = SEED_CURRENT_USER_ID;

  const directPriya: Conversation = {
    id: 'cnv-direct-priya',
    type: 'DIRECT',
    name: null,
    createdAt: daysAgo(now, 9),
    lastMessageAt: minutesAgo(now, 8),
    members: [member(me, daysAgo(now, 9)), member(PRIYA, daysAgo(now, 9))],
    unreadCount: 0,
  };

  const directDaniel: Conversation = {
    id: 'cnv-direct-daniel',
    type: 'DIRECT',
    name: null,
    createdAt: daysAgo(now, 4),
    lastMessageAt: minutesAgo(now, 41),
    members: [member(me, daysAgo(now, 4)), member(DANIEL, daysAgo(now, 4))],
    unreadCount: 2,
  };

  const directSarah: Conversation = {
    id: 'cnv-direct-sarah',
    type: 'DIRECT',
    name: null,
    createdAt: daysAgo(now, 6),
    lastMessageAt: daysAgo(now, 1),
    members: [member(me, daysAgo(now, 6)), member(SARAH_FINANCE, daysAgo(now, 6))],
    unreadCount: 0,
  };

  const operations: Conversation = {
    id: 'cnv-group-operations',
    type: 'GROUP',
    name: 'Operations Team',
    createdAt: daysAgo(now, 21),
    lastMessageAt: minutesAgo(now, 24),
    members: [
      member(PRIYA, daysAgo(now, 21), 'OWNER'),
      member(me, daysAgo(now, 21)),
      member(DANIEL, daysAgo(now, 21)),
      member(SARAH_OPERATIONS, daysAgo(now, 20)),
      // Joined late: under D-03 this member sees nothing sent before this point.
      member(AISHA, daysAgo(now, 2)),
    ],
    unreadCount: 3,
  };

  const rollout: Conversation = {
    id: 'cnv-group-rollout',
    type: 'GROUP',
    name: 'Warehouse System Rollout',
    createdAt: daysAgo(now, 12),
    lastMessageAt: daysAgo(now, 1),
    members: [
      member(me, daysAgo(now, 12), 'OWNER'),
      member(MARCUS, daysAgo(now, 12)),
      member(SARAH_OPERATIONS, daysAgo(now, 11)),
      member(DANIEL, daysAgo(now, 5)),
    ],
    unreadCount: 0,
  };

  const messagesByConversation: Record<string, ChatMessage[]> = {
    [directPriya.id]: [
      textMessage(
        'msg-priya-1',
        directPriya.id,
        PRIYA,
        'Morning. Did the stock reconciliation figures come through from the warehouse?',
        minutesAgo(now, 74),
      ),
      textMessage(
        'msg-priya-2',
        directPriya.id,
        me,
        'They did, about an hour ago. Two lines still need a manual check but the rest balances.',
        minutesAgo(now, 66),
      ),
      textMessage(
        'msg-priya-3',
        directPriya.id,
        PRIYA,
        'Good. Send me the summary once those two are settled and I will take it to the Friday review.',
        minutesAgo(now, 61),
      ),
      textMessage(
        'msg-priya-4',
        directPriya.id,
        me,
        'Will do. It should be ready well before then.',
        minutesAgo(now, 55),
      ),
      textMessage(
        'msg-priya-5',
        directPriya.id,
        PRIYA,
        'Thanks. One more thing, can you join the handover call at four?',
        minutesAgo(now, 8),
      ),
    ],
    [directDaniel.id]: [
      textMessage(
        'msg-daniel-1',
        directDaniel.id,
        me,
        'Are the new supplier contacts already in the shared list?',
        daysAgo(now, 1),
      ),
      textMessage(
        'msg-daniel-2',
        directDaniel.id,
        DANIEL,
        'Added them this morning. Three new entries under the Pune region.',
        minutesAgo(now, 48),
      ),
      textMessage(
        'msg-daniel-3',
        directDaniel.id,
        DANIEL,
        'Let me know if anything looks wrong and I will correct it before the list goes out.',
        minutesAgo(now, 41),
      ),
    ],
    [directSarah.id]: [
      textMessage(
        'msg-sarah-1',
        directSarah.id,
        SARAH_FINANCE,
        'Quick question on the quarterly figures. Are the freight costs in the operations budget or ours?',
        daysAgo(now, 1),
      ),
      textMessage(
        'msg-sarah-2',
        directSarah.id,
        me,
        'Operations, same as last quarter. I can send the breakdown if that helps.',
        daysAgo(now, 1),
      ),
    ],
    [operations.id]: [
      systemMessage(
        'msg-ops-0',
        operations.id,
        'Priya Nair created the group "Operations Team".',
        daysAgo(now, 21),
      ),
      textMessage(
        'msg-ops-1',
        operations.id,
        PRIYA,
        'Reminder: the weekly operations report is due tomorrow at noon.',
        daysAgo(now, 1),
      ),
      textMessage(
        'msg-ops-2',
        operations.id,
        DANIEL,
        'Mine is ready. Waiting on the dispatch numbers from the second shift.',
        minutesAgo(now, 180),
      ),
      systemMessage(
        'msg-ops-3',
        operations.id,
        'Priya Nair added Aisha Khan to the group.',
        daysAgo(now, 2),
      ),
      textMessage(
        'msg-ops-4',
        operations.id,
        AISHA,
        'Thanks for adding me. I will pick up the dispatch summary from this week onwards.',
        minutesAgo(now, 96),
      ),
      textMessage(
        'msg-ops-5',
        operations.id,
        SARAH_OPERATIONS,
        'The second shift numbers are in the shared folder now.',
        minutesAgo(now, 31),
      ),
      textMessage(
        'msg-ops-6',
        operations.id,
        PRIYA,
        'Good. Then we can close the report by the end of the day.',
        minutesAgo(now, 24),
      ),
    ],
    [rollout.id]: [
      systemMessage(
        'msg-rollout-0',
        rollout.id,
        'You created the group "Warehouse System Rollout".',
        daysAgo(now, 12),
      ),
      textMessage(
        'msg-rollout-1',
        rollout.id,
        me,
        'Starting this group for the rollout so decisions stop getting lost in separate chats.',
        daysAgo(now, 12),
      ),
      textMessage(
        'msg-rollout-2',
        rollout.id,
        MARCUS,
        'Agreed. Scanner training for the first floor team is booked for next Tuesday.',
        daysAgo(now, 11),
      ),
      systemMessage(
        'msg-rollout-3',
        rollout.id,
        'You added Daniel Roy to the group.',
        daysAgo(now, 5),
      ),
      textMessage(
        'msg-rollout-4',
        rollout.id,
        DANIEL,
        'I can cover the second session if the first floor group is too large for one room.',
        daysAgo(now, 1),
      ),
    ],
  };

  // Sorted rather than assumed: date separators and message grouping both read the order, and
  // the server will return history ordered by `createdAt` too.
  for (const messages of Object.values(messagesByConversation)) {
    messages.sort(
      (left, right) =>
        new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
    );
  }

  return {
    directory: createSeedDirectory(now),
    conversations: [directPriya, directDaniel, operations, rollout, directSarah],
    messagesByConversation,
  };
}
