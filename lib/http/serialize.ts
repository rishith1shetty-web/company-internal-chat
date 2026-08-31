/**
 * Database rows → wire shapes.
 *
 * One place where `Date` becomes an ISO-8601 UTC string and where it is decided what a browser
 * is allowed to see. Serialising ad hoc inside each route is how a column nobody meant to expose
 * — a token hash, a `leftAt`, an internal flag — ends up in a JSON response.
 */

import type { ConversationSummary } from '@/lib/conversations/service';
import type { DirectoryEntry } from '@/lib/users/directory';
import type { ConversationWire, UserWire } from '@/lib/chat/wire';
import type { StoredMessage } from '@/lib/messages/service';
import type { MessageWire } from '@/lib/chat/wire';

export function toUserWire(user: DirectoryEntry): UserWire {
  return {
    id: user.id,
    displayName: user.displayName,
    lastSeenAt: user.lastSeenAt.toISOString(),
  };
}

export function toConversationWire(conversation: ConversationSummary): ConversationWire {
  return {
    id: conversation.id,
    type: conversation.type,
    name: conversation.name,
    createdAt: conversation.createdAt.toISOString(),
    lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
    members: conversation.members.map((member) => ({
      userId: member.userId,
      role: member.role,
      joinedAt: member.joinedAt.toISOString(),
    })),
    lastMessage: conversation.lastMessage
      ? {
          id: conversation.lastMessage.id,
          senderId: conversation.lastMessage.senderId,
          type: conversation.lastMessage.type,
          body: conversation.lastMessage.body,
          createdAt: conversation.lastMessage.createdAt.toISOString(),
        }
      : null,
    unreadCount: conversation.unreadCount,
  };
}

export function toMessageWireFromRow(message: StoredMessage): MessageWire {
  return {
    id: message.id,
    conversationId: message.conversationId,
    senderId: message.senderId,
    clientMessageId: message.clientMessageId,
    type: message.type,
    body: message.body,
    createdAt: message.createdAt.toISOString(),
  };
}

/** Every distinct member id across a set of conversations, so their names can be resolved once. */
export function memberIdsOf(conversations: readonly ConversationSummary[]): string[] {
  const ids = new Set<string>();
  for (const conversation of conversations) {
    for (const member of conversation.members) ids.add(member.userId);
  }
  return [...ids];
}
