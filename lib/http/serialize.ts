/**
 * Database rows → wire shapes.
 *
 * One place where `Date` becomes an ISO-8601 UTC string and where it is decided what a browser
 * is allowed to see. Serialising ad hoc inside each route is how a column nobody meant to expose
 * — a token hash, a `leftAt`, an internal flag — ends up in a JSON response.
 */

import type { PrismaClient } from '@/prisma/generated/client';
import { listConversationsForUser, type ConversationSummary } from '@/lib/conversations/service';
import type { DirectoryEntry } from '@/lib/users/directory';
import type { ConversationMembersWire, ConversationWire, UserWire } from '@/lib/chat/wire';
import { listUsersByIds } from '@/lib/users/directory';
import type { StoredMessage } from '@/lib/messages/service';
import type { MessageWire } from '@/lib/chat/wire';
import { toMessageWire } from '@/lib/realtime/events';

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
      // Null in groups; the service decides that, not this mapping (Batch 1.3).
      lastReadAt: member.lastReadAt?.toISOString() ?? null,
    })),
    lastMessage: conversation.lastMessage
      ? {
          id: conversation.lastMessage.id,
          senderId: conversation.lastMessage.senderId,
          type: conversation.lastMessage.type,
          body: conversation.lastMessage.body,
          createdAt: conversation.lastMessage.createdAt.toISOString(),
          attachmentFilename: conversation.lastMessage.attachmentFilename,
        }
      : null,
    unreadCount: conversation.unreadCount,
  };
}

/**
 * `viewerJoinedAt` is required rather than optional on purpose.
 *
 * It gates the quoted reply preview against the reader's D-03 window. An optional parameter with
 * a permissive default would make "forgot to pass it" look exactly like "there is nothing to
 * hide", and the failure would be silent disclosure rather than a type error.
 */
export function toMessageWireFromRow(message: StoredMessage, viewerJoinedAt: Date): MessageWire {
  return toMessageWire(message, viewerJoinedAt);
}

/** Every distinct member id across a set of conversations, so their names can be resolved once. */
export function memberIdsOf(conversations: readonly ConversationSummary[]): string[] {
  const ids = new Set<string>();
  for (const conversation of conversations) {
    for (const member of conversation.members) ids.add(member.userId);
  }
  return [...ids];
}

/**
 * One conversation, described exactly as the caller is entitled to see it.
 *
 * Read back through `listConversationsForUser` rather than assembled from whatever the operation
 * just did: that is the same membership-filtered query the sidebar uses, so a response can never
 * describe a conversation differently from the way the list will — and it comes back `null`,
 * rather than leaking, when the caller is no longer a member. Which is precisely what leaving a
 * group looks like from the leaver's side.
 */
export async function describeConversationFor(
  db: PrismaClient,
  userId: string,
  conversationId: string,
): Promise<ConversationMembersWire> {
  const conversations = await listConversationsForUser(db, userId);
  const conversation = conversations.find((item) => item.id === conversationId);

  if (!conversation) return { conversation: null, users: [] };

  const users = await listUsersByIds(db, memberIdsOf([conversation]));
  return { conversation: toConversationWire(conversation), users: users.map(toUserWire) };
}
