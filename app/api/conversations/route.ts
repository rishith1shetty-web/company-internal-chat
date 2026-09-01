/**
 * /api/conversations — the caller's conversations, and starting a new direct one.
 *
 * GET  lists every conversation the caller is an active member of, newest activity first, with
 *      the sidebar's preview and unread count already computed.
 * POST resolves the direct conversation with one other user, creating it only if it does not
 *      already exist.
 *
 * Authorization is not a step in these handlers — it is the query. `listConversationsForUser`
 * reads from the caller's own membership rows, so there is no moment at which a conversation the
 * caller is not in has been loaded and is waiting to be filtered out.
 *
 * `POST` accepts `type: "DIRECT"` and, from Phase 6, `type: "GROUP"`. Neither shape lets the
 * caller say who *they* are: the creator is taken from the session, is always a member, and is
 * always the owner of a group they create.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import type { ConversationCreatedWire, ConversationListWire } from '@/lib/chat/wire';
import {
  ConversationError,
  MAX_GROUP_MEMBERS,
  MAX_GROUP_NAME_LENGTH,
  createGroupConversation,
  listConversationsForUser,
  resolveDirectConversation,
} from '@/lib/conversations/service';
import { getDb } from '@/lib/db/prisma';
import {
  apiError,
  invalidRequest,
  readJsonBody,
  routeLogger,
  withIdentity,
} from '@/lib/http/route-helpers';
import { memberIdsOf, toConversationWire, toUserWire } from '@/lib/http/serialize';
import { notifyConversationChanged } from '@/lib/realtime/notify';
import { listUsersByIds } from '@/lib/users/directory';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  return withIdentity(request, async (current) => {
    const db = getDb();
    const conversations = await listConversationsForUser(db, current.userId);

    // Everyone who appears in the list, resolved by id so the sidebar can name them without a
    // second round trip — and without the browser ever having to map a name back to a person.
    const users = await listUsersByIds(db, memberIdsOf(conversations));

    return NextResponse.json({
      conversations: conversations.map(toConversationWire),
      users: users.map(toUserWire),
    } satisfies ConversationListWire);
  });
}

const uuid = z.uuid({ version: 'v4' });

/**
 * What a browser may supply.
 *
 * For a direct conversation: which colleague to talk to. For a group: a name and the other people
 * to add, by id. In neither case is there a `conversationId`, a `createdById`, a `role` or a
 * `joinedAt` — the caller is always a member of what they create, is always the `OWNER` of a group
 * they create, and every one of those facts is decided from the session rather than the payload
 * (CLAUDE.md §9).
 *
 * Members are named by id and never by display name: two colleagues may share a name (D-02), so a
 * name could not identify which was meant even if the API accepted one.
 */
const createConversationSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('DIRECT'),
    userId: uuid,
  }),
  z.object({
    type: z.literal('GROUP'),
    name: z.string().min(1).max(MAX_GROUP_NAME_LENGTH),
    /** The service re-validates and collapses duplicates; this bounds the request. */
    memberIds: z.array(uuid).min(1).max(MAX_GROUP_MEMBERS),
  }),
]);

/** Maps a conversation failure onto a status and a message the caller can act on. */
function conversationFailure(error: ConversationError): NextResponse {
  switch (error.reason) {
    case 'SELF_CONVERSATION':
    case 'USER_NOT_FOUND':
    case 'INVALID_GROUP_NAME':
    case 'NO_MEMBERS':
    case 'TOO_MANY_MEMBERS':
      return apiError(400, 'INVALID_REQUEST', error.message);
    case 'NOT_A_MEMBER':
      return apiError(403, 'FORBIDDEN', error.message);
    default:
      return apiError(400, 'INVALID_REQUEST', error.message);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  return withIdentity(request, async (current) => {
    const parsed = createConversationSchema.safeParse(await readJsonBody(request));

    if (!parsed.success) {
      const badName = parsed.error.issues.some((issue) => issue.path[0] === 'name');
      return invalidRequest(
        badName
          ? `Give the group a name of at most ${MAX_GROUP_NAME_LENGTH} characters.`
          : 'Choose who to start a conversation with.',
      );
    }

    const db = getDb();

    let resolved: { conversationId: string; created: boolean };
    try {
      if (parsed.data.type === 'GROUP') {
        const group = await createGroupConversation(db, {
          // From the session. The browser cannot nominate a creator, a member list that omits
          // itself, or an owner.
          creatorId: current.userId,
          name: parsed.data.name,
          memberIds: parsed.data.memberIds,
        });

        /*
         * The members are told after the transaction committed, never before: the notification
         * makes their browsers re-read, and a browser that read before the commit would be told
         * about a group that does not exist yet.
         */
        notifyConversationChanged({
          conversationId: group.conversationId,
          memberIds: group.memberIds,
        });

        resolved = { conversationId: group.conversationId, created: true };
      } else {
        resolved = await resolveDirectConversation(db, current.userId, parsed.data.userId);
      }
    } catch (error) {
      if (error instanceof ConversationError) return conversationFailure(error);
      throw error;
    }

    // Re-read through the same membership-filtered listing the sidebar uses, so the response
    // cannot describe a conversation differently from the way the list will.
    const conversations = await listConversationsForUser(db, current.userId);
    const conversation = conversations.find((item) => item.id === resolved.conversationId);

    if (!conversation) {
      // Would mean the conversation was created without the caller as a member, which the
      // service cannot do. Treated as a server fault rather than papered over.
      routeLogger.error('Resolved conversation is not visible to its own member', {
        userId: current.userId,
      });
      return apiError(500, 'INTERNAL_ERROR', 'Could not open that conversation.');
    }

    const users = await listUsersByIds(db, memberIdsOf([conversation]));

    return NextResponse.json(
      {
        conversation: toConversationWire(conversation),
        users: users.map(toUserWire),
        created: resolved.created,
      } satisfies ConversationCreatedWire,
      { status: resolved.created ? 201 : 200 },
    );
  });
}
