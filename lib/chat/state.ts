/**
 * Chat UI state: one reducer plus pure selectors. No React, no data access, no `process.env`.
 *
 * Everything here is a projection of what the server said. The reducer applies answers — a
 * conversation list, a page of history, an acknowledged message, a presence event — and computes
 * nothing the server is responsible for. Where a value looks like it is being decided locally
 * (an unread badge on `select-conversation`, a `lastMessage` after a send) it is an optimistic
 * echo of a decision the server has already taken or is about to confirm, and the next server
 * answer overwrites it.
 *
 * PHASE 5. The one genuinely local piece of state is a message's `deliveryState`, which exists
 * only in this browser: the server has no concept of "sending", because from its point of view a
 * message either committed or did not.
 *
 * Purity is kept deliberately: ids and timestamps that must not vary between renders are supplied
 * by the caller, so the reducer can be tested without a clock or a socket.
 */

import { hasNameCollision, userDiscriminator } from '@/lib/chat/format';
import type { ConnectionState } from '@/lib/chat/socket';
import type {
  ChatMessage,
  Conversation,
  DeliveryState,
  PendingUpload,
  ReplyPreview,
  SharedFile,
  UserSummary,
} from '@/lib/chat/types';
import type {
  ConversationWire,
  MessageWire,
  PresenceWire,
  UserWire,
} from '@/lib/chat/wire';

/**
 * Which top-level screen is showing.
 *
 * `unassigned` replaced the old name-entry screen. It is not a form and has no action on it: a
 * computer that has not been assigned to an employee is something only an administrator can fix
 * (docs/12-admin-device-identity.md).
 */
export type Screen = 'loading' | 'unassigned' | 'workspace';

/** A user as the directory and conversation lists know them. Presence is tracked separately. */
export interface DirectoryUser {
  id: string;
  displayName: string;
  lastSeenAt: string | null;
}

export interface PresenceRecord {
  online: boolean;
  lastSeenAt: string | null;
}

/** What is known about one conversation's history, so the UI can show honest loading states. */
export interface HistoryState {
  loading: boolean;
  loaded: boolean;
  /** Older messages exist before the oldest one loaded. */
  hasMore: boolean;
}

const EMPTY_HISTORY: HistoryState = { loading: false, loaded: false, hasMore: false };

export interface ChatState {
  screen: Screen;
  /**
   * The identity this computer is assigned to. `id` is the identity; `displayName` is only a
   * label (D-02), and `deviceLabel` is the administrator's name for the machine, shown read-only.
   *
   * Nothing in the interface can change any of the three.
   */
  currentUser: {
    id: string;
    displayName: string;
    deviceLabel: string;
    /** The server's upload ceiling in bytes. Not decided here, only carried. */
    maxFileSize: number;
  } | null;
  /** Every user the interface can name, keyed by id — never by name. */
  users: Record<string, DirectoryUser>;
  /** Live presence, from the socket. Absent means "not known to be online". */
  presence: Record<string, PresenceRecord>;
  conversations: Conversation[];
  messagesByConversation: Record<string, ChatMessage[]>;
  history: Record<string, HistoryState>;
  selectedConversationId: string | null;
  searchTerm: string;
  connection: ConnectionState;
  /**
   * Files this browser is currently uploading, keyed by their idempotency key.
   *
   * Local only, and deliberately not modelled as optimistic messages: an upload that has not
   * committed is not a message, and showing it as one would claim a colleague can see a file that
   * is still going up the wire. It becomes a real message when the server says so.
   */
  uploads: Record<string, PendingUpload>;
  /**
   * The Shared files list per conversation, as the server last answered it.
   *
   * Kept separately from messages rather than derived from them: the panel shows every file in
   * the caller's window, and the message list holds only the pages that have been read. Deriving
   * it from what happens to be loaded would make the panel change as somebody scrolled.
   */
  attachments: Record<string, { loading: boolean; files: SharedFile[] }>;
  /**
   * Pinned messages per conversation, newest pin first.
   *
   * Kept separately from `messagesByConversation` for the same reason the file panel is: a pinned
   * message can be far outside the pages of history that happen to be loaded, and deriving the
   * banner from what is on screen would make pins appear and disappear as somebody scrolled.
   *
   * Maintained live by the reducer rather than re-fetched on every change — a pin or an unpin
   * arrives as `message:updated`, which carries everything needed to add or remove the entry.
   */
  pinnedByConversation: Record<string, ChatMessage[]>;
  /** A failure the user should be told about, cleared when it stops being true. */
  notice: string | null;
}

export type ChatAction =
  | { type: 'identity-missing' }
  | {
      type: 'identity-ready';
      userId: string;
      displayName: string;
      deviceLabel: string;
      maxFileSize: number;
    }
  | { type: 'directory-loaded'; users: UserWire[] }
  | { type: 'conversations-loaded'; conversations: ConversationWire[]; users: UserWire[] }
  | { type: 'conversation-opened'; conversation: ConversationWire; users: UserWire[] }
  | { type: 'select-conversation'; conversationId: string | null }
  | { type: 'set-search'; term: string }
  | { type: 'history-loading'; conversationId: string }
  | {
      type: 'history-loaded';
      conversationId: string;
      messages: MessageWire[];
      hasMore: boolean;
      /** `replace` for an initial load, `merge` for a reconnect backfill or an older page. */
      mode: 'replace' | 'merge';
    }
  | { type: 'history-failed'; conversationId: string; message: string }
  | {
      type: 'message-queued';
      conversationId: string;
      clientMessageId: string;
      body: string;
      now: string;
      /** The quoted message, so the optimistic bubble shows the reply before the server answers. */
      replyTo?: ReplyPreview | null;
    }
  | { type: 'message-acknowledged'; clientMessageId: string; message: MessageWire }
  | { type: 'message-retrying'; conversationId: string; clientMessageId: string }
  | { type: 'message-failed'; conversationId: string; clientMessageId: string; message: string }
  | { type: 'message-received'; message: MessageWire }
  /**
   * A message that is already on screen changed — a reaction, a pin, or a delete-for-everyone.
   *
   * Never bumps an unread count and never reorders the sidebar: reacting to or pinning something
   * is not a new message, and treating it as one would put a badge on a conversation nobody wrote
   * in.
   */
  | { type: 'message-updated'; message: MessageWire }
  /** This user hid a message for themselves, here or in another of their windows. */
  | { type: 'message-hidden'; conversationId: string; messageId: string }
  | { type: 'presence-changed'; entries: PresenceWire[] }
  | { type: 'connection-changed'; connection: ConnectionState }
  | { type: 'unread-cleared'; conversationId: string; unreadCount: number }
  | {
      type: 'upload-started';
      clientMessageId: string;
      conversationId: string;
      filename: string;
      byteSize: number;
    }
  | { type: 'upload-progress'; clientMessageId: string; progress: number }
  | { type: 'upload-failed'; clientMessageId: string; message: string }
  | { type: 'upload-finished'; clientMessageId: string }
  | { type: 'attachments-loading'; conversationId: string }
  | { type: 'attachments-loaded'; conversationId: string; files: SharedFile[] }
  | { type: 'pins-loaded'; conversationId: string; messages: MessageWire[] }
  | { type: 'notice'; message: string | null };

export const initialChatState: ChatState = {
  screen: 'loading',
  currentUser: null,
  users: {},
  presence: {},
  conversations: [],
  messagesByConversation: {},
  history: {},
  selectedConversationId: null,
  searchTerm: '',
  connection: 'connecting',
  uploads: {},
  attachments: {},
  pinnedByConversation: {},
  notice: null,
};

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    /*
     * No assigned identity: an unset-up computer, or one whose assignment was retired.
     *
     * Everything the previous identity could see is dropped from memory. Nothing is deleted on
     * the server — conversations and messages belong to their `User` and survive (D-14). This is
     * also where a reassignment lands: the browser asks who it is, is told nothing, and shows the
     * unassigned screen until the new employee's session is established on the next request.
     */
    case 'identity-missing':
      return { ...initialChatState, screen: 'unassigned' };

    case 'identity-ready':
      return {
        ...state,
        screen: 'workspace',
        currentUser: {
          id: action.userId,
          displayName: action.displayName,
          deviceLabel: action.deviceLabel,
          maxFileSize: action.maxFileSize,
        },
        notice: null,
      };

    case 'directory-loaded':
      return { ...state, users: mergeUsers(state.users, action.users) };

    case 'conversations-loaded':
      return applyConversationList(state, action.conversations, action.users);

    case 'conversation-opened':
      return openConversation(state, action.conversation, action.users);

    case 'select-conversation':
      return selectConversation(state, action.conversationId);

    case 'set-search':
      return { ...state, searchTerm: action.term };

    case 'history-loading':
      return {
        ...state,
        history: {
          ...state.history,
          [action.conversationId]: {
            ...(state.history[action.conversationId] ?? EMPTY_HISTORY),
            loading: true,
          },
        },
      };

    case 'history-loaded':
      return applyHistory(state, action);

    case 'history-failed':
      return {
        ...state,
        notice: action.message,
        history: {
          ...state.history,
          [action.conversationId]: {
            ...(state.history[action.conversationId] ?? EMPTY_HISTORY),
            loading: false,
          },
        },
      };

    case 'message-queued':
      return queueMessage(state, action);

    case 'message-acknowledged':
      return acknowledgeMessage(state, action.clientMessageId, action.message);

    case 'message-retrying':
      return setDeliveryState(state, action.conversationId, action.clientMessageId, 'SENDING');

    case 'message-failed':
      return {
        ...setDeliveryState(state, action.conversationId, action.clientMessageId, 'FAILED'),
        notice: action.message,
      };

    case 'message-updated':
      return updateMessage(state, action.message);
    case 'message-hidden':
      return hideMessage(state, action.conversationId, action.messageId);
    case 'message-received':
      return receiveMessage(state, action.message);

    case 'presence-changed':
      return applyPresence(state, action.entries);

    case 'connection-changed':
      return { ...state, connection: action.connection };

    case 'unread-cleared':
      return {
        ...state,
        conversations: state.conversations.map((conversation) =>
          conversation.id === action.conversationId
            ? { ...conversation, unreadCount: action.unreadCount }
            : conversation,
        ),
      };

    case 'upload-started':
      return {
        ...state,
        uploads: {
          ...state.uploads,
          [action.clientMessageId]: {
            clientMessageId: action.clientMessageId,
            conversationId: action.conversationId,
            filename: action.filename,
            byteSize: action.byteSize,
            progress: 0,
            state: 'UPLOADING',
            error: null,
          },
        },
      };

    case 'upload-progress': {
      const existing = state.uploads[action.clientMessageId];
      if (!existing) return state;
      return {
        ...state,
        uploads: {
          ...state.uploads,
          [action.clientMessageId]: { ...existing, progress: action.progress },
        },
      };
    }

    case 'upload-failed': {
      const existing = state.uploads[action.clientMessageId];
      if (!existing) return state;
      return {
        ...state,
        uploads: {
          ...state.uploads,
          [action.clientMessageId]: {
            ...existing,
            state: 'FAILED',
            error: action.message,
          },
        },
      };
    }

    case 'upload-finished': {
      // Removed rather than marked done: the committed message is what represents it now, and
      // leaving a finished card beside its own message would show the file twice.
      if (!(action.clientMessageId in state.uploads)) return state;
      const uploads = { ...state.uploads };
      delete uploads[action.clientMessageId];
      return { ...state, uploads };
    }

    case 'attachments-loading':
      return {
        ...state,
        attachments: {
          ...state.attachments,
          [action.conversationId]: {
            loading: true,
            files: state.attachments[action.conversationId]?.files ?? [],
          },
        },
      };

    case 'attachments-loaded':
      return {
        ...state,
        attachments: {
          ...state.attachments,
          [action.conversationId]: { loading: false, files: action.files },
        },
      };

    case 'pins-loaded':
      return {
        ...state,
        pinnedByConversation: {
          ...state.pinnedByConversation,
          [action.conversationId]: action.messages.map((wire) => toChatMessage(wire)),
        },
      };
    case 'notice':
      return { ...state, notice: action.message };

    default:
      return state;
  }
}

/* ------------------------------------------------------------------------------------------- */
/* Wire → view model                                                                             */
/* ------------------------------------------------------------------------------------------- */

export function toChatMessage(wire: MessageWire, deliveryState: DeliveryState = 'SENT'): ChatMessage {
  return {
    id: wire.id,
    clientMessageId: wire.clientMessageId,
    conversationId: wire.conversationId,
    senderId: wire.senderId,
    kind: wire.type,
    body: wire.body,
    createdAt: wire.createdAt,
    deliveryState,
    attachment: wire.attachment,
    replyTo: wire.replyTo,
    isForwarded: wire.isForwarded,
    pinnedAt: wire.pinnedAt,
    deletedAt: wire.deletedAt,
    reactions: wire.reactions,
  };
}

export function toConversation(wire: ConversationWire): Conversation {
  return {
    id: wire.id,
    type: wire.type,
    name: wire.name,
    createdAt: wire.createdAt,
    lastMessageAt: wire.lastMessageAt,
    members: wire.members.map((member) => ({
      userId: member.userId,
      role: member.role,
      joinedAt: member.joinedAt,
    })),
    lastMessage: wire.lastMessage
      ? {
          id: wire.lastMessage.id,
          senderId: wire.lastMessage.senderId,
          kind: wire.lastMessage.type,
          body: wire.lastMessage.body,
          createdAt: wire.lastMessage.createdAt,
          attachmentFilename: wire.lastMessage.attachmentFilename,
        }
      : null,
    unreadCount: wire.unreadCount,
  };
}

function mergeUsers(
  existing: Record<string, DirectoryUser>,
  incoming: readonly UserWire[],
): Record<string, DirectoryUser> {
  if (incoming.length === 0) return existing;

  const merged = { ...existing };
  for (const user of incoming) {
    merged[user.id] = {
      id: user.id,
      displayName: user.displayName,
      lastSeenAt: user.lastSeenAt,
    };
  }
  return merged;
}

/* ------------------------------------------------------------------------------------------- */
/* Transitions                                                                                   */
/* ------------------------------------------------------------------------------------------- */

function applyConversationList(
  state: ChatState,
  wires: readonly ConversationWire[],
  users: readonly UserWire[],
): ChatState {
  const conversations = sortConversations(wires.map(toConversation));
  const selectedStillExists = conversations.some(
    (conversation) => conversation.id === state.selectedConversationId,
  );

  return {
    ...state,
    users: mergeUsers(state.users, users),
    conversations,
    // A conversation that has gone (or was never the caller's) must not stay open.
    selectedConversationId: selectedStillExists ? state.selectedConversationId : null,
  };
}

function openConversation(
  state: ChatState,
  wire: ConversationWire,
  users: readonly UserWire[],
): ChatState {
  const conversation = toConversation(wire);
  const others = state.conversations.filter((item) => item.id !== conversation.id);

  return {
    ...state,
    users: mergeUsers(state.users, users),
    conversations: sortConversations([conversation, ...others]),
    selectedConversationId: conversation.id,
    searchTerm: '',
  };
}

function selectConversation(state: ChatState, conversationId: string | null): ChatState {
  if (conversationId === null) {
    return { ...state, selectedConversationId: null };
  }

  return {
    ...state,
    selectedConversationId: conversationId,
    // The badge clears immediately; the server is told separately and its count wins.
    conversations: state.conversations.map((conversation) =>
      conversation.id === conversationId ? { ...conversation, unreadCount: 0 } : conversation,
    ),
  };
}

function applyHistory(
  state: ChatState,
  action: Extract<ChatAction, { type: 'history-loaded' }>,
): ChatState {
  const incoming = action.messages.map((message) => toChatMessage(message));
  const existing = state.messagesByConversation[action.conversationId] ?? [];

  /*
   * `replace` still merges rather than overwriting: a message the user sent while the page of
   * history was in flight is in `existing` and must not be thrown away. What `replace` decides is
   * the `hasMore` flag and that this conversation is now considered loaded.
   */
  const messages = mergeMessageLists(existing, incoming);

  return {
    ...state,
    messagesByConversation: { ...state.messagesByConversation, [action.conversationId]: messages },
    history: {
      ...state.history,
      [action.conversationId]: {
        loading: false,
        loaded: true,
        hasMore:
          action.mode === 'replace'
            ? action.hasMore
            : (state.history[action.conversationId]?.hasMore ?? action.hasMore),
      },
    },
    conversations: refreshConversationTail(state.conversations, action.conversationId, messages),
  };
}

function queueMessage(
  state: ChatState,
  action: Extract<ChatAction, { type: 'message-queued' }>,
): ChatState {
  const sender = state.currentUser;
  const body = action.body.trim();
  if (!sender || body.length === 0) return state;

  const optimistic: ChatMessage = {
    // Until the server answers there is no server id, so the idempotency key stands in as the
    // React key. It is replaced by the stored row's id on acknowledgement.
    id: action.clientMessageId,
    clientMessageId: action.clientMessageId,
    conversationId: action.conversationId,
    senderId: sender.id,
    kind: 'TEXT',
    body,
    createdAt: action.now,
    deliveryState: 'SENDING',
    attachment: null,
    /*
     * The optimistic bubble carries the reply preview the composer was showing, so a reply does
     * not visibly "become" a reply a moment after it is sent. Everything else starts empty: a
     * message cannot be forwarded, pinned, deleted or reacted to before it exists.
     */
    replyTo: action.replyTo ?? null,
    isForwarded: false,
    pinnedAt: null,
    deletedAt: null,
    reactions: [],
  };

  return insertMessage(state, optimistic, { countAsUnread: false });
}

function acknowledgeMessage(
  state: ChatState,
  clientMessageId: string,
  wire: MessageWire,
): ChatState {
  const existing = state.messagesByConversation[wire.conversationId] ?? [];
  const stored = toChatMessage(wire, 'SENT');

  // Replace the optimistic bubble in place, so the message does not jump position when the
  // server's timestamp differs from the browser's by a few milliseconds.
  const replaced = existing.map((message) =>
    message.clientMessageId === clientMessageId ? stored : message,
  );

  const messages = sortMessages(
    replaced.some((message) => message.clientMessageId === clientMessageId)
      ? replaced
      : [...existing, stored],
  );

  return {
    ...state,
    messagesByConversation: { ...state.messagesByConversation, [wire.conversationId]: messages },
    conversations: refreshConversationTail(state.conversations, wire.conversationId, messages),
  };
}

/** Flips one optimistic message between `SENDING` and `FAILED`. Server rows are never touched. */
function setDeliveryState(
  state: ChatState,
  conversationId: string,
  clientMessageId: string,
  deliveryState: DeliveryState,
): ChatState {
  const existing = state.messagesByConversation[conversationId];
  if (!existing) return state;

  return {
    ...state,
    messagesByConversation: {
      ...state.messagesByConversation,
      [conversationId]: existing.map((message) =>
        message.clientMessageId === clientMessageId ? { ...message, deliveryState } : message,
      ),
    },
  };
}

function receiveMessage(state: ChatState, wire: MessageWire): ChatState {
  const isMine = wire.senderId !== null && wire.senderId === state.currentUser?.id;
  const isOpen = wire.conversationId === state.selectedConversationId;

  return insertMessage(state, toChatMessage(wire, 'SENT'), {
    // A message counts as unread when it arrives for a conversation the user is not looking at
    // and did not send themselves (a broadcast to their own other tab).
    countAsUnread: !isMine && !isOpen,
  });
}

/**
 * Replaces one message in place.
 *
 * Deliberately a no-op when the message is not loaded: an update for a conversation whose history
 * this window has never opened has nothing to update, and inserting it would put a message on
 * screen out of order and without the page of context around it.
 *
 * The conversation tail is refreshed but the unread count is not touched, so a message deleted
 * for everyone updates the sidebar preview to its tombstone without marking anything unread.
 */
function updateMessage(state: ChatState, wire: MessageWire): ChatState {
  const existing = state.messagesByConversation[wire.conversationId];
  if (!existing?.some((item) => item.id === wire.id)) return state;

  const messages = existing.map((item) =>
    item.id === wire.id
      ? // The local delivery state is kept: the server has no opinion about whether this
        // browser's own send has been acknowledged, and a reaction must not reset that.
        { ...toChatMessage(wire, item.deliveryState) }
      : item,
  );

  return {
    ...state,
    messagesByConversation: { ...state.messagesByConversation, [wire.conversationId]: messages },
    conversations: refreshConversationTail(state.conversations, wire.conversationId, messages),
    pinnedByConversation: applyPinChange(state.pinnedByConversation, toChatMessage(wire)),
  };
}

/**
 * Adds, updates or removes a message in the pinned list for its conversation.
 *
 * Driven entirely by the message that just arrived, so a pin made in another window appears here
 * without a re-fetch. A tombstone is removed rather than kept: a message deleted for everyone
 * loses its pin server-side, and leaving it in the banner would show a pinned "This message was
 * deleted" — exactly the misleading pinned content the requirement rules out.
 */
function applyPinChange(
  pinned: Record<string, ChatMessage[]>,
  message: ChatMessage,
): Record<string, ChatMessage[]> {
  const current = pinned[message.conversationId];
  // Nothing loaded for this conversation yet: the next `pins-loaded` is authoritative, and
  // inventing a list here would show a partial banner built from whatever happened to arrive.
  if (!current) return pinned;

  const without = current.filter((item) => item.id !== message.id);
  const stillPinned = message.pinnedAt !== null && message.deletedAt === null;

  return {
    ...pinned,
    [message.conversationId]: stillPinned
      ? [message, ...without].sort((a, b) => comparePinAge(a, b))
      : without,
  };
}

/** Newest pin first. Both are pinned, so the timestamps are present. */
function comparePinAge(a: ChatMessage, b: ChatMessage): number {
  return (b.pinnedAt ?? '').localeCompare(a.pinnedAt ?? '');
}

/**
 * Removes a message this user hid for themselves.
 *
 * Only their own view changes; the row is still in the conversation for everybody else. The
 * unread count is deliberately left alone — hiding a message is not reading it.
 */
function hideMessage(state: ChatState, conversationId: string, messageId: string): ChatState {
  const existing = state.messagesByConversation[conversationId];
  if (!existing?.some((item) => item.id === messageId)) return state;

  const messages = existing.filter((item) => item.id !== messageId);
  const pinned = state.pinnedByConversation[conversationId];

  return {
    ...state,
    messagesByConversation: { ...state.messagesByConversation, [conversationId]: messages },
    conversations: refreshConversationTail(state.conversations, conversationId, messages),
    // A message hidden for this person leaves their pinned banner too. It is still pinned for
    // everybody else, which is exactly what "delete for me" means.
    pinnedByConversation: pinned
      ? {
          ...state.pinnedByConversation,
          [conversationId]: pinned.filter((item) => item.id !== messageId),
        }
      : state.pinnedByConversation,
  };
}

function insertMessage(
  state: ChatState,
  message: ChatMessage,
  options: { countAsUnread: boolean },
): ChatState {
  const existing = state.messagesByConversation[message.conversationId] ?? [];

  // Already known, by server id or by idempotency key. The second case is what stops a message
  // appearing twice when a broadcast races the acknowledgement of the same send.
  if (
    existing.some(
      (item) =>
        (item.id === message.id && item.deliveryState !== 'SENDING') ||
        item.clientMessageId === message.clientMessageId,
    )
  ) {
    return state;
  }

  const messages = sortMessages([...existing, message]);

  return {
    ...state,
    messagesByConversation: { ...state.messagesByConversation, [message.conversationId]: messages },
    conversations: refreshConversationTail(state.conversations, message.conversationId, messages, {
      bumpUnread: options.countAsUnread,
    }),
  };
}

/**
 * Keeps a conversation's ordering fields in step with its newest delivered message.
 *
 * The sidebar shows a preview and an activity time for conversations whose history has not been
 * opened, so those values live on the conversation rather than being derived from a message list
 * that may not exist. This is the local echo; `GET /api/conversations` overwrites it.
 */
function refreshConversationTail(
  conversations: readonly Conversation[],
  conversationId: string,
  messages: readonly ChatMessage[],
  options: { bumpUnread?: boolean } = {},
): Conversation[] {
  const newest = lastDeliveredMessage(messages);
  if (!newest) return [...conversations];

  return sortConversations(
    conversations.map((conversation) =>
      conversation.id === conversationId
        ? {
            ...conversation,
            lastMessageAt: newest.createdAt,
            lastMessage: {
              id: newest.id,
              senderId: newest.senderId,
              kind: newest.kind,
              body: newest.body,
              createdAt: newest.createdAt,
              attachmentFilename: newest.attachment?.filename ?? null,
            },
            unreadCount: options.bumpUnread
              ? conversation.unreadCount + 1
              : conversation.unreadCount,
          }
        : conversation,
    ),
  );
}

function lastDeliveredMessage(messages: readonly ChatMessage[]): ChatMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && message.deliveryState === 'SENT') return message;
  }
  return undefined;
}

function applyPresence(state: ChatState, entries: readonly PresenceWire[]): ChatState {
  if (entries.length === 0) return state;

  const presence = { ...state.presence };
  for (const entry of entries) {
    presence[entry.userId] = { online: entry.online, lastSeenAt: entry.lastSeenAt };
  }

  return { ...state, presence };
}

/* ------------------------------------------------------------------------------------------- */
/* Message list maintenance                                                                      */
/* ------------------------------------------------------------------------------------------- */

/** Chronological, with the message id breaking ties — the same order the server pages in. */
function sortMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return [...messages].sort((left, right) => {
    const difference =
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
    return difference !== 0 ? difference : left.id.localeCompare(right.id);
  });
}

/**
 * Merges a page of server messages into what is already on screen.
 *
 * Reconciliation is on the server id first and the `clientMessageId` second. The second key is
 * what makes an optimistic bubble become the stored message rather than sitting next to it.
 */
function mergeMessageLists(
  existing: readonly ChatMessage[],
  incoming: readonly ChatMessage[],
): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  const byClientId = new Map<string, string>();

  for (const message of existing) {
    byId.set(message.id, message);
    byClientId.set(message.clientMessageId, message.id);
  }

  for (const message of incoming) {
    const previousId = byClientId.get(message.clientMessageId);
    // The stored row supersedes the optimistic one, which was keyed on the idempotency key.
    if (previousId !== undefined && previousId !== message.id) byId.delete(previousId);

    byId.set(message.id, message);
    byClientId.set(message.clientMessageId, message.id);
  }

  return sortMessages([...byId.values()]);
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

/**
 * Every user the interface can name, with their presence resolved. Keyed by id, never by name.
 *
 * Presence defaults to `OFFLINE`: the server only reports on people the caller shares a
 * conversation with, so a colleague who is merely in the directory is shown with their last-seen
 * time rather than a status the browser is not entitled to know.
 */
export function selectUsersById(state: ChatState): Map<string, UserSummary> {
  const users = new Map<string, UserSummary>();

  for (const user of Object.values(state.users)) {
    const presence = state.presence[user.id];
    users.set(user.id, {
      id: user.id,
      displayName: user.displayName,
      presence: presence?.online ? 'ONLINE' : 'OFFLINE',
      lastSeenAt: presence?.lastSeenAt ?? user.lastSeenAt,
    });
  }

  if (state.currentUser) {
    const existing = users.get(state.currentUser.id);
    users.set(state.currentUser.id, {
      id: state.currentUser.id,
      displayName: state.currentUser.displayName,
      // The user is looking at the page, so they are online by construction.
      presence: 'ONLINE',
      lastSeenAt: existing?.lastSeenAt ?? null,
    });
  }

  return users;
}

export function selectAllUsers(state: ChatState): UserSummary[] {
  return [...selectUsersById(state).values()];
}

/** The directory, excluding the current user, for the "New chat" picker. */
export function selectDirectoryUsers(state: ChatState): UserSummary[] {
  const currentUserId = state.currentUser?.id;
  return selectAllUsers(state)
    .filter((user) => user.id !== currentUserId)
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

export function selectSelectedConversation(state: ChatState): Conversation | null {
  if (!state.selectedConversationId) return null;
  return state.conversations.find((item) => item.id === state.selectedConversationId) ?? null;
}

export function selectMessages(state: ChatState, conversationId: string): ChatMessage[] {
  return state.messagesByConversation[conversationId] ?? [];
}

export function selectHistoryState(state: ChatState, conversationId: string): HistoryState {
  return state.history[conversationId] ?? EMPTY_HISTORY;
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

/**
 * Single-line preview for the conversation list.
 *
 * Prefers the newest delivered message on screen, falling back to the server's preview for a
 * conversation whose history has not been opened. A message still sending, or one that failed,
 * is not previewed: the sidebar should not claim something was said that was not.
 */
export function conversationPreview(state: ChatState, conversation: Conversation): string {
  const loaded = selectMessages(state, conversation.id);
  const last = lastDeliveredMessage(loaded) ?? conversation.lastMessage;
  if (!last) return 'No messages yet';

  if (last.kind === 'SYSTEM') return last.body ?? '';

  const usersById = selectUsersById(state);
  const isMine = last.senderId === state.currentUser?.id;
  const senderName = isMine
    ? 'You'
    : (usersById.get(last.senderId ?? '')?.displayName ?? 'Unknown user');

  const prefix = conversation.type === 'GROUP' || isMine ? `${senderName}: ` : '';

  // A file preview names the file. "Sent a file" tells somebody scanning the sidebar nothing
  // they could act on, and the name is already inside their visible window (D-03) or the
  // preview would not have been computed for them at all.
  if (last.kind === 'FILE') {
    const name = attachmentNameOf(last);
    return `${prefix}${name ? `📎 ${name}` : 'Sent a file'}`;
  }

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

/** The filename on whichever preview shape the caller has — a loaded message or the server's. */
function attachmentNameOf(
  last: ChatMessage | { attachmentFilename?: string | null },
): string | null {
  if ('attachment' in last && last.attachment) return last.attachment.filename;
  if ('attachmentFilename' in last) return last.attachmentFilename ?? null;
  return null;
}

/** Files this browser is currently uploading into one conversation. */
export function selectUploads(state: ChatState, conversationId: string): PendingUpload[] {
  return Object.values(state.uploads).filter(
    (upload) => upload.conversationId === conversationId,
  );
}

/** The Shared files list for a conversation, and whether it is being read. */
export function selectSharedFiles(
  state: ChatState,
  conversationId: string,
): { loading: boolean; files: SharedFile[] } {
  return state.attachments[conversationId] ?? { loading: false, files: [] };
}
