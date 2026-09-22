/**
 * GET /api/messages/:id/info — who has read a message you sent (Batch 1.3).
 *
 * THE FEATURE THIS IS, AND THE ONE IT IS NOT. It answers "who has seen what I said", for one
 * message, for the person who said it. It is not a way to watch colleagues: there is no endpoint
 * here for somebody else's message, no global last-seen, no device or session history, and no
 * cross-conversation query. The only identifier it accepts is a message id, and that id decides
 * which conversation is consulted — the caller never names one.
 *
 * AUTHORIZATION, all of it server-side and none of it trusting the request:
 *
 *   1. An authenticated session (`withIdentity`).
 *   2. `loadAccessibleMessage` — the message exists, the caller is an ACTIVE member of the
 *      conversation THE MESSAGE says it belongs to, and the message is inside the caller's own
 *      D-03 window. Deriving the conversation from the message is what makes cross-conversation
 *      IDOR impossible: there is no pairing of "a message over there" with "a conversation I am
 *      in" that this route would accept.
 *   3. The caller is the stored `senderId`.
 *
 * All three refusals answer the SAME 403 with the same body. Distinguishing "no such message"
 * from "not yours" would turn this into an oracle for which message ids exist, and the hidden
 * menu item is a courtesy rather than the control.
 *
 * WHAT COMES BACK carries display names and nothing else about a person — no device id, no
 * session, no address, no internal row id beyond the user id the interface already uses to name
 * people. And no read TIMES: the read marker records the timestamp of the furthest MESSAGE a
 * member has read, not the moment they read it, so a time here would be a plausible wrong answer
 * (lib/messages/read-status.ts).
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import type { MessageReadStatusWire } from '@/lib/chat/wire';
import { getDb } from '@/lib/db/prisma';
import { forbidden, invalidRequest, withIdentity } from '@/lib/http/route-helpers';
import { toUserWire } from '@/lib/http/serialize';
import { MessageActionError } from '@/lib/messages/actions';
import { readStatusForMessage } from '@/lib/messages/read-status';
import { listUsersByIds } from '@/lib/users/directory';

export const dynamic = 'force-dynamic';

const uuid = z.uuid({ version: 'v4' });

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return withIdentity(request, async (current) => {
    const { id } = await context.params;
    if (!uuid.safeParse(id).success) return invalidRequest('That message is not valid.');

    try {
      const status = await readStatusForMessage(getDb(), {
        userId: current.userId,
        messageId: id,
      });

      /*
       * Names are resolved here rather than inlined by the service.
       *
       * Somebody who has read the message and since LEFT the group is in this list, and the
       * caller's own conversation member list no longer contains them — so without this they
       * would render as an unnamed id. Resolving by id is also the project's one way of naming a
       * person anywhere (D-02: display names are not identifiers).
       */
      const userIds = [...status.readBy, ...status.notReadBy].map((entry) => entry.userId);
      const users = await listUsersByIds(getDb(), userIds);

      return NextResponse.json({
        messageId: id,
        readBy: status.readBy,
        notReadBy: status.notReadBy,
        users: users.map(toUserWire),
      } satisfies MessageReadStatusWire);
    } catch (error) {
      if (error instanceof MessageActionError) {
        // One answer for "no such message", "not a member", "before you joined" and "not yours".
        if (error.reason === 'NOT_ACCESSIBLE' || error.reason === 'NOT_THE_SENDER') {
          return forbidden();
        }
        // A tombstone: the caller can see it is deleted, so saying so discloses nothing.
        if (error.reason === 'NOT_ACTIONABLE') return invalidRequest(error.message);
      }
      throw error;
    }
  });
}
