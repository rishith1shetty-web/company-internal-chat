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
 * PHASE 5: `POST` accepts `type: "DIRECT"` only. Group creation is Phase 6 and is refused here
 * rather than half-implemented.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import type { ConversationCreatedWire, ConversationListWire } from '@/lib/chat/wire';
import {
  ConversationError,
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

/**
 * The only thing a browser may supply: which colleague to talk to.
 *
 * There is no `conversationId`, no member list, no `createdById` and no `role` — the caller is
 * always one of the two members and always a `MEMBER`, decided server-side. `type` is present so
 * the Phase 6 group case has somewhere to go, and is rejected until then.
 */
const createConversationSchema = z.object({
  type: z.literal('DIRECT'),
  userId: z.uuid({ version: 'v4' }),
});

export async function POST(request: Request): Promise<NextResponse> {
  return withIdentity(request, async (current) => {
    const parsed = createConversationSchema.safeParse(await readJsonBody(request));

    if (!parsed.success) {
      const wrongType = parsed.error.issues.some((issue) => issue.path[0] === 'type');
      return invalidRequest(
        wrongType
          ? 'Group conversations are not available yet.'
          : 'Choose a colleague to start a conversation with.',
      );
    }

    const db = getDb();

    let resolved: { conversationId: string; created: boolean };
    try {
      resolved = await resolveDirectConversation(db, current.userId, parsed.data.userId);
    } catch (error) {
      if (error instanceof ConversationError) {
        switch (error.reason) {
          case 'SELF_CONVERSATION':
          case 'USER_NOT_FOUND':
            return apiError(400, 'INVALID_REQUEST', error.message);
          case 'NOT_A_MEMBER':
            return apiError(403, 'FORBIDDEN', error.message);
          default:
            break;
        }
      }
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
