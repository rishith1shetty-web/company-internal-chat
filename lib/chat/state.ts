/**
 * Chat UI state: one reducer plus pure selectors. No React, no data access, no `process.env`.
 *
 * Keeping the state transitions here rather than inside components means the interaction rules
 * are readable in one place and remain unit-testable when Vitest arrives, and it gives Phase 4/5
 * a single seam to replace: today an action mutates local state, later the same action dispatches
 * a request or a socket emit and the reducer applies the server's answer.
 *
 * PHASE 2 SCOPE. Nothing here persists anything. Values that must not vary between renders —
 * ids and timestamps — are supplied by the caller so the reducer stays pure.
 */

import { hasNameCollision, userDiscriminator } from '@/lib/chat/format';
import type {
  ChatMessage,
  Conversation,
  ConversationMember,
  UserSummary,
} from '@/lib/chat/types';
import { createSeedDirectory, createSeedWorkspace, SEED_CURRENT_USER_ID } from '@/lib/mock/chat-seed';

/** Which top-level screen is showing. Identity gating only; there is no session behind it. */
export type Screen = 'name-entry' | 'workspace';

export interface ChatState {
  screen: Screen;
  currentUser: UserSummary | null;
  /** Known users other than the current one — the Phase 5 `GET /api/users` directory. */
  directory: UserSummary[];
  conversations: Conversation[];
  messagesByConversation: Record<string, ChatMessage[]>;
  selectedConversationId: string | null;
  searchTerm: string;
  /**
   * The illustrative workspace is offered once, on first entry. After "Switch User" the next
   * identity starts empty, because a new identity must never inherit the previous person's
   * conversations (handover §5).
   */
  seedAvailable: boolean;
}

export type ChatAction =
  | { type: 'enter'; userId: string; displayName: string; now: string }
  | { type: 'switch-user' }
  | { type: 'select-conversation'; conversationId: string }
  | { type: 'set-search'; term: string }
  | {
      type: 'send-message';
      conversationId: string;
      body: string;
      messageId: string;
      clientMessageId: string;
      now: string;
    }
  | { type: 'start-direct-conversation'; otherUserId: string; conversationId: string; now: string }
  | {
      type: 'create-group';
      conversationId: string;
      name: string;
      memberIds: string[];
      systemMessageId: string;
      now: string;
    };

export const initialChatState: ChatState = {
  screen: 'name-entry',
  currentUser: null,
  directory: [],
  conversations: [],
  messagesByConversation: {},
  selectedConversationId: null,
  searchTerm: '',
  seedAvailable: true,
};

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'enter':
      return enterApplication(state, action);

    case 'switch-user':
      return switchUser(state);

    case 'select-conversation':
      return {
        ...state,
        selectedConversationId: action.conversationId,
        // Opening a conversation clears its badge. Phase 5 replaces this with
        // POST /api/conversations/:id/read.
        conversations: state.conversations.map((conversation) =>
          conversation.id === action.conversationId
            ? { ...conversation, unreadCount: 0 }
            : conversation,
        ),
      };

    case 'set-search':
      return { ...state, searchTerm: action.term };

    case 'send-message':
      return sendMessage(state, action);

    case 'start-direct-conversation':
      return startDirectConversation(state, action);

    case 'create-group':
      return createGroup(state, action);

    default:
      return state;
  }
}

function enterApplication(
  state: ChatState,
  action: Extract<ChatAction, { type: 'enter' }>,
): ChatState {
  const now = new Date(action.now);

  const currentUser: UserSummary = {
    // A display name is a label; the id is the identity (D-02). The two are never conflated,
    // which is why entering the same name twice produces two different users.
    //
    // On first entry the id is the one the illustrative workspace is built around, so the
    // seeded memberships belong to this user. Every later entry uses a freshly generated id.
    id: state.seedAvailable ? SEED_CURRENT_USER_ID : action.userId,
    displayName: action.displayName,
    presence: 'ONLINE',
    lastSeenAt: action.now,
  };

  if (!state.seedAvailable) {
    // A fresh identity: the mock directory is still visible so a chat can be started, but no
    // conversation, message or membership carries over from the previous user.
    return {
      ...state,
      screen: 'workspace',
      currentUser,
      directory: state.directory,
      conversations: [],
      messagesByConversation: {},
      selectedConversationId: null,
      searchTerm: '',
    };
  }

  const seed = createSeedWorkspace(now);
  const conversations = sortConversations(seed.conversations);

  return {
    ...state,
    screen: 'workspace',
    currentUser,
    directory: seed.directory,
    conversations,
    messagesByConversation: seed.messagesByConversation,
    selectedConversationId: conversations[0]?.id ?? null,
    searchTerm: '',
    seedAvailable: false,
  };
}

/**
 * "Switch User / Clear Device Identity" (F-19).
 *
 * In Phase 2 this only drops local state and returns to the name screen. The real control
 * revokes the `Session` and `Device` rows server-side before clearing the cookies
 * (docs/01-architecture.md §5) — clearing the browser alone is not sufficient, because a copied
 * cookie would still resolve.
 *
 * What it does demonstrate correctly is the rule that matters for shared computers: the next
 * identity starts with nothing, and never inherits the previous person's conversations.
 */
function switchUser(state: ChatState): ChatState {
  const previousUser = state.currentUser;

  return {
    ...initialChatState,
    seedAvailable: false,
    // The previous identity remains a known user, as it would in the database — which is also
    // how a same-name collision becomes visible in the picker.
    directory: previousUser
      ? [...state.directory, { ...previousUser, presence: 'OFFLINE' as const }]
      : state.directory.length > 0
        ? state.directory
        : createSeedDirectory(new Date()),
  };
}

function sendMessage(
  state: ChatState,
  action: Extract<ChatAction, { type: 'send-message' }>,
): ChatState {
  const body = action.body.trim();
  const sender = state.currentUser;
  if (!sender || body.length === 0) return state;

  const conversation = state.conversations.find((item) => item.id === action.conversationId);
  if (!conversation) return state;

  const message: ChatMessage = {
    id: action.messageId,
    clientMessageId: action.clientMessageId,
    conversationId: action.conversationId,
    senderId: sender.id,
    kind: 'TEXT',
    body,
    createdAt: action.now,
    // Phase 4 flips this to SENT on the server acknowledgement. Here nothing is transmitted,
    // so the message is marked SENT immediately rather than faking a pending state.
    deliveryState: 'SENT',
    attachment: null,
  };

  const existing = state.messagesByConversation[action.conversationId] ?? [];

  return {
    ...state,
    messagesByConversation: {
      ...state.messagesByConversation,
      [action.conversationId]: [...existing, message],
    },
    conversations: sortConversations(
      state.conversations.map((item) =>
        item.id === action.conversationId ? { ...item, lastMessageAt: action.now } : item,
      ),
    ),
  };
}

function startDirectConversation(
  state: ChatState,
  action: Extract<ChatAction, { type: 'start-direct-conversation' }>,
): ChatState {
  const currentUser = state.currentUser;
  if (!currentUser || action.otherUserId === currentUser.id) return state;

  const existing = state.conversations.find(
    (conversation) =>
      conversation.type === 'DIRECT' &&
      conversation.members.some((item) => item.userId === action.otherUserId),
  );

  if (existing) {
    return chatReducer(state, { type: 'select-conversation', conversationId: existing.id });
  }

  const conversation: Conversation = {
    id: action.conversationId,
    type: 'DIRECT',
    name: null,
    createdAt: action.now,
    lastMessageAt: null,
    // Both members join at creation, so a direct conversation has no join-window gap (D-03).
    members: [
      { userId: currentUser.id, role: 'MEMBER', joinedAt: action.now },
      { userId: action.otherUserId, role: 'MEMBER', joinedAt: action.now },
    ],
    unreadCount: 0,
  };

  return {
    ...state,
    conversations: sortConversations([conversation, ...state.conversations]),
    messagesByConversation: { ...state.messagesByConversation, [conversation.id]: [] },
    selectedConversationId: conversation.id,
    searchTerm: '',
  };
}

function createGroup(
  state: ChatState,
  action: Extract<ChatAction, { type: 'create-group' }>,
): ChatState {
  const currentUser = state.currentUser;
  const name = action.name.trim();
  if (!currentUser || name.length === 0 || action.memberIds.length === 0) return state;

  const members: ConversationMember[] = [
    { userId: currentUser.id, role: 'OWNER', joinedAt: action.now },
    ...action.memberIds
      .filter((userId) => userId !== currentUser.id)
      .map((userId) => ({ userId, role: 'MEMBER' as const, joinedAt: action.now })),
  ];

  const conversation: Conversation = {
    id: action.conversationId,
    type: 'GROUP',
    name,
    createdAt: action.now,
    lastMessageAt: action.now,
    members,
    unreadCount: 0,
  };

  const systemMessage: ChatMessage = {
    id: action.systemMessageId,
    clientMessageId: action.systemMessageId,
    conversationId: conversation.id,
    senderId: null,
    kind: 'SYSTEM',
    body: `You created the group "${name}".`,
    createdAt: action.now,
    deliveryState: 'SENT',
    attachment: null,
  };

  return {
    ...state,
    conversations: sortConversations([conversation, ...state.conversations]),
    messagesByConversation: {
      ...state.messagesByConversation,
      [conversation.id]: [systemMessage],
    },
    selectedConversationId: conversation.id,
    searchTerm: '',
  };
}

/* ------------------------------------------------------------------------------------------- */
/* Selectors                                                                                     */
/* ------------------------------------------------------------------------------------------- */

/** Most recent activity first; conversations without messages fall back to creation time. */
export function sortConversations(conversations: readonly Conversation[]): Conversation[] {
  return [...conversations].sort(
    (left, right) =>
      new Date(right.lastMessageAt ?? right.createdAt).getTime() -
      new Date(left.lastMessageAt ?? left.createdAt).getTime(),
  );
}

/** Every user the interface can name, including the current one. Keyed by id, never by name. */
export function selectUsersById(state: ChatState): Map<string, UserSummary> {
  const users = new Map<string, UserSummary>();
  for (const user of state.directory) users.set(user.id, user);
  if (state.currentUser) users.set(state.currentUser.id, state.currentUser);
  return users;
}

export function selectAllUsers(state: ChatState): UserSummary[] {
  return [...selectUsersById(state).values()];
}

export function selectSelectedConversation(state: ChatState): Conversation | null {
  if (!state.selectedConversationId) return null;
  return state.conversations.find((item) => item.id === state.selectedConversationId) ?? null;
}

export function selectMessages(state: ChatState, conversationId: string): ChatMessage[] {
  return state.messagesByConversation[conversationId] ?? [];
}

/** The other participant of a direct conversation, from the current user's point of view. */
export function selectDirectCounterpart(
  conversation: Conversation,
  currentUserId: string,
  usersById: Map<string, UserSummary>,
): UserSummary | null {
  if (conversation.type !== 'DIRECT') return null;
  const other = conversation.members.find((member) => member.userId !== currentUserId);
  return other ? (usersById.get(other.userId) ?? null) : null;
}

/** Group name, or the counterpart's display name for a direct conversation. */
export function conversationTitle(
  conversation: Conversation,
  currentUserId: string,
  usersById: Map<string, UserSummary>,
): string {
  if (conversation.type === 'GROUP') return conversation.name ?? 'Untitled group';
  const counterpart = selectDirectCounterpart(conversation, currentUserId, usersById);
  return counterpart?.displayName ?? 'Unknown user';
}

/** Single-line preview for the conversation list. */
export function conversationPreview(state: ChatState, conversation: Conversation): string {
  const messages = selectMessages(state, conversation.id);
  const last = messages[messages.length - 1];
  if (!last) return 'No messages yet';

  if (last.kind === 'SYSTEM') return last.body ?? '';
  if (last.kind === 'FILE') return 'Sent a file';

  const usersById = selectUsersById(state);
  const isMine = last.senderId === state.currentUser?.id;
  const senderName = isMine
    ? 'You'
    : (usersById.get(last.senderId ?? '')?.displayName ?? 'Unknown user');

  const prefix = conversation.type === 'GROUP' || isMine ? `${senderName}: ` : '';
  return `${prefix}${last.body ?? ''}`;
}

/**
 * Conversations matching the sidebar search, by conversation name or participant name.
 *
 * Matching a participant by name is a search convenience only. It never resolves identity:
 * every result is still keyed on conversation and user ids (D-02).
 */
export function selectVisibleConversations(state: ChatState): Conversation[] {
  const term = state.searchTerm.trim().toLowerCase();
  if (term.length === 0) return state.conversations;

  const usersById = selectUsersById(state);
  const currentUserId = state.currentUser?.id ?? '';

  return state.conversations.filter((conversation) => {
    const title = conversationTitle(conversation, currentUserId, usersById).toLowerCase();
    if (title.includes(term)) return true;

    return conversation.members.some((member) => {
      const user = usersById.get(member.userId);
      return user ? user.displayName.toLowerCase().includes(term) : false;
    });
  });
}

/**
 * Everything the sidebar needs to render one conversation row, resolved once here so the list
 * components stay presentational and never look users up themselves.
 */
export interface ConversationListEntry {
  id: string;
  type: Conversation['type'];
  title: string;
  preview: string;
  /** ISO-8601 UTC of the last activity, or null for a conversation with no messages. */
  timestamp: string | null;
  unreadCount: number;
  /** Direct conversations only: the counterpart, for the avatar and presence dot. */
  counterpart: UserSummary | null;
  memberCount: number;
  /** Set when another known user shares this title, to tell same-named people apart (D-02). */
  discriminator: string | null;
}

export function selectConversationListEntries(state: ChatState): ConversationListEntry[] {
  const usersById = selectUsersById(state);
  const allUsers = [...usersById.values()];
  const currentUserId = state.currentUser?.id ?? '';

  return selectVisibleConversations(state).map((conversation) => {
    const counterpart = selectDirectCounterpart(conversation, currentUserId, usersById);

    return {
      id: conversation.id,
      type: conversation.type,
      title: conversationTitle(conversation, currentUserId, usersById),
      preview: conversationPreview(state, conversation),
      timestamp: conversation.lastMessageAt,
      unreadCount: conversation.unreadCount,
      counterpart,
      memberCount: conversation.members.length,
      discriminator:
        counterpart && hasNameCollision(allUsers, counterpart)
          ? userDiscriminator(counterpart.id)
          : null,
    };
  });
}
