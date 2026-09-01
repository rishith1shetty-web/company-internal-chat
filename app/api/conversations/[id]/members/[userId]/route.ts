/**
 * DELETE /api/conversations/:id/members/:userId — leave a group, or remove somebody from one.
 *
 * One endpoint for both, because they are the same operation with different authorization
 * (Q-05b, option (a)): anybody may remove themselves, and only an `OWNER` may remove somebody
 * else. Whether this is a leave or a removal is decided by comparing the path's user id with the
 * *session's* user id — never by a flag in the request, which would let a caller nominate which
 * rule they would prefer to be judged by.
 *
 * The membership row is not deleted. `leftAt` is set, so the record of who was present when
 * survives, the person's messages stay in the conversation and stay attributed to them, and every
 * authorization check keeps working because they all test `leftAt IS NULL` rather than the row's
 * existence.
 *
 * The response describes the conversation as the caller can now see it — which for somebody who
 * has just left is `null`, and that is the whole point: the answer is produced by the same
 * membership-filtered query as the sidebar, so it cannot accidentally describe a group the caller
 * is no longer in.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { ConversationError, removeGroupMember } from '@/lib/conversations/service';
import { getDb } from '@/lib/db/prisma';
import { apiError, forbidden, invalidRequest, withIdentity } from '@/lib/http/route-helpers';
import { describeConversationFor } from '@/lib/http/serialize';
import { notifyConversationChanged } from '@/lib/realtime/notify';

export const dynamic = 'force-dynamic';

const uuid = z.uuid({ version: 'v4' });

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string; userId: string }> },
): Promise<NextResponse> {
  return withIdentity(request, async (current) => {
    const { id, userId } = await context.params;

    if (!uuid.safeParse(id).success || !uuid.safeParse(userId).success) {
      return invalidRequest('That request was not understood.');
    }

    const db = getDb();

    try {
      const change = await removeGroupMember(db, {
        // From the session. This is what decides "leaving" from "removing".
        actorId: current.userId,
        conversationId: id,
        targetUserId: userId,
      });

      /*
       * After the commit, and carrying both audiences: the people still in the group re-read and
       * see the member list change, and the person who has gone re-reads and finds the group is
       * no longer theirs. Their sockets leave the room in the same call, so the next message
       * cannot reach them.
       */
      notifyConversationChanged({
        conversationId: change.conversationId,
        memberIds: change.memberIds,
        removedIds: change.removedIds,
      });

      return NextResponse.json(
        await describeConversationFor(db, current.userId, change.conversationId),
      );
    } catch (error) {
      if (error instanceof ConversationError) {
        switch (error.reason) {
          // "Not a member" and "no such conversation" are one answer, deliberately.
          case 'NOT_A_MEMBER':
            return forbidden();
          case 'NOT_AN_OWNER':
            return apiError(403, 'FORBIDDEN', error.message);
          case 'MEMBER_NOT_FOUND':
          case 'NOT_A_GROUP':
            return apiError(400, 'INVALID_REQUEST', error.message);
          default:
            return apiError(400, 'INVALID_REQUEST', error.message);
        }
      }
      throw error;
    }
  });
}
