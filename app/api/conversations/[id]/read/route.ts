/**
 * POST /api/conversations/:id/read — move the caller's read marker.
 *
 * The unread badge is computed, not stored (docs/02-database.md, "Not modelled"): it is the
 * number of messages in the caller's visible window that are newer than
 * `ConversationMember.lastReadAt` and were not sent by them. This endpoint is the only thing
 * that moves that marker.
 *
 * The message id is supplied by the browser and is therefore checked: it must belong to *this*
 * conversation and lie inside the caller's `joinedAt` window, and the marker only ever moves
 * forward, so a stale request from a second tab cannot bring a cleared badge back.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import type { ReadReceiptWire } from '@/lib/chat/wire';
import {
  ConversationError,
  markConversationRead,
  readAnnouncementFor,
} from '@/lib/conversations/service';
import { getDb } from '@/lib/db/prisma';
import { forbidden, invalidRequest, readJsonBody, withIdentity } from '@/lib/http/route-helpers';
import { notifyConversationRead } from '@/lib/realtime/notify';

export const dynamic = 'force-dynamic';

const uuid = z.uuid({ version: 'v4' });

const bodySchema = z.object({
  /** The newest message the caller has actually seen. Verified against the conversation. */
  messageId: uuid,
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return withIdentity(request, async (current) => {
    const { id } = await context.params;
    if (!uuid.safeParse(id).success) return invalidRequest('That conversation is not valid.');

    const parsed = bodySchema.safeParse(await readJsonBody(request));
    if (!parsed.success) return invalidRequest('That request was not understood.');

    try {
      const result = await markConversationRead(
        getDb(),
        current.userId,
        id,
        parsed.data.messageId,
      );

      /*
       * Tell the others, but only when the marker actually MOVED (Batch 1.3).
       *
       * One event per move, never one per message: a conversation opened with two hundred unread
       * messages advances a single watermark. Re-opening one already read to the end changes
       * nothing and announces nothing.
       *
       * The watermark itself travels only in a DIRECT conversation. In a group it is withheld, so
       * per-member read state stays behind the sender-only `GET /api/messages/:id/info` — the
       * event is then a bare nudge for an open Message info panel.
       */
      if (result.moved) {
        const audience = await readAnnouncementFor(getDb(), result.conversationId);
        notifyConversationRead({
          conversationId: result.conversationId,
          userId: current.userId,
          lastReadAt: audience.type === 'DIRECT' ? result.lastReadAt : null,
          audienceIds: audience.audienceIds,
        });
      }

      return NextResponse.json({
        conversationId: result.conversationId,
        lastReadMessageId: result.lastReadMessageId,
        lastReadAt: result.lastReadAt.toISOString(),
        unreadCount: result.unreadCount,
      } satisfies ReadReceiptWire);
    } catch (error) {
      if (error instanceof ConversationError) {
        // Both answers are deliberately indistinguishable from the outside: neither confirms
        // that a conversation or a message id exists.
        if (error.reason === 'NOT_A_MEMBER') return forbidden();
        if (error.reason === 'MESSAGE_NOT_FOUND') return forbidden();
      }
      throw error;
    }
  });
}
