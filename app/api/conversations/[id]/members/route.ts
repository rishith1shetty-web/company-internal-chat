/**
 * POST /api/conversations/:id/members — add employees to a group.
 *
 * Three things the caller supplies: the conversation id in the path, and a list of user ids in
 * the body. Two things they do NOT supply, and could not: who they are, and when the people they
 * are adding joined. Both come from the server (CLAUDE.md §9, §10).
 *
 * The authorization is `addGroupMembers` itself — it starts by reading the caller's own active
 * membership of the conversation, so a conversation id from a browser is a request rather than a
 * permission, and an id belonging to somebody else's group answers exactly as an id that does not
 * exist at all.
 *
 * D-03: everybody added here gets `joinedAt = now`, which is what makes the group's earlier
 * history invisible to them — in message queries, previews, unread counts and, from Phase 7, file
 * downloads. Nothing is deleted to achieve that.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  ConversationError,
  MAX_GROUP_MEMBERS,
  addGroupMembers,
} from '@/lib/conversations/service';
import { getDb } from '@/lib/db/prisma';
import { apiError, forbidden, invalidRequest, readJsonBody, withIdentity } from '@/lib/http/route-helpers';
import { describeConversationFor } from '@/lib/http/serialize';
import { notifyConversationChanged } from '@/lib/realtime/notify';

export const dynamic = 'force-dynamic';

const uuid = z.uuid({ version: 'v4' });

const bodySchema = z.object({
  /** Who to add, by id. Duplicates are collapsed by the service, not rejected. */
  userIds: z.array(uuid).min(1).max(MAX_GROUP_MEMBERS),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return withIdentity(request, async (current) => {
    const { id } = await context.params;
    if (!uuid.safeParse(id).success) return invalidRequest('That conversation is not valid.');

    const parsed = bodySchema.safeParse(await readJsonBody(request));
    if (!parsed.success) return invalidRequest('Choose at least one colleague to add.');

    const db = getDb();

    try {
      const change = await addGroupMembers(db, {
        // From the session, never the body.
        actorId: current.userId,
        conversationId: id,
        userIds: parsed.data.userIds,
      });

      // After the commit: the notification is what makes the added members' browsers re-read.
      notifyConversationChanged({
        conversationId: change.conversationId,
        memberIds: change.memberIds,
      });

      return NextResponse.json(
        await describeConversationFor(db, current.userId, change.conversationId),
      );
    } catch (error) {
      if (error instanceof ConversationError) {
        switch (error.reason) {
          // Membership and existence are one answer, as everywhere else in this application.
          case 'NOT_A_MEMBER':
            return forbidden();
          case 'NOT_A_GROUP':
          case 'NO_MEMBERS':
          case 'TOO_MANY_MEMBERS':
          case 'USER_NOT_FOUND':
            return apiError(400, 'INVALID_REQUEST', error.message);
          default:
            return apiError(400, 'INVALID_REQUEST', error.message);
        }
      }
      throw error;
    }
  });
}
