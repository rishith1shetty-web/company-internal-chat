/**
 * POST /api/messages/:id/forward — copy a message into one or more conversations.
 *
 * Every destination is authorized independently, from the database, and access to the SOURCE
 * grants nothing in any of them. A refusal does not fail the others: forwarding to three groups
 * when you have just been removed from one should deliver two and say which failed, so the
 * response carries both lists.
 *
 * A forwarded file becomes a REAL, INDEPENDENT attachment in the destination — new row, new
 * storage key, new bytes — so recipients download it through exactly the same authorized route as
 * any other file, and deleting the original cannot break it. The reasoning, including why the
 * bytes are not shared, is in `lib/messages/actions.ts`.
 *
 * `clientMessageId` is required per destination for the same reason a send needs one: it is the
 * idempotency key, so a retry after a dropped response collides with the stored row instead of
 * forwarding the file a second time.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import type { ForwardResultWire } from '@/lib/chat/wire';
import { getDb } from '@/lib/db/prisma';
import {
  forbidden,
  invalidRequest,
  readJsonBody,
  storageConfig,
  withIdentity,
} from '@/lib/http/route-helpers';
import { toMessageWireFromRow } from '@/lib/http/serialize';
import { MessageActionError, forwardMessage } from '@/lib/messages/actions';
import { notifyMessagePosted } from '@/lib/realtime/notify';

export const dynamic = 'force-dynamic';

const uuid = z.uuid({ version: 'v4' });

/**
 * A ceiling on destinations per request.
 *
 * Forwarding a file copies its bytes once per destination, so an unbounded list is a way to turn
 * one request into gigabytes of disk writes. Ten is well beyond what the interface offers and far
 * below anything that would matter.
 */
const MAX_DESTINATIONS = 10;

const bodySchema = z.object({
  destinations: z
    .array(z.object({ conversationId: uuid, clientMessageId: uuid }))
    .min(1)
    .max(MAX_DESTINATIONS),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return withIdentity(request, async (current) => {
    const { id } = await context.params;
    if (!uuid.safeParse(id).success) return invalidRequest('That message is not valid.');

    const parsed = bodySchema.safeParse(await readJsonBody(request));
    if (!parsed.success) return invalidRequest('That request was not understood.');

    try {
      const result = await forwardMessage(getDb(), storageConfig, {
        userId: current.userId,
        messageId: id,
        destinations: parsed.data.destinations,
      });

      /*
       * A forwarded message IS a new message, so it is delivered exactly like one — the same
       * `message:new` event, and therefore the same notification, sound and unread behaviour.
       * That is the intended difference from a reaction or a pin, which are updates and stay
       * silent.
       */
      for (const delivered of result.delivered) {
        notifyMessagePosted({
          conversationId: delivered.conversationId,
          senderId: current.userId,
          // Serialized against the forwarder's own membership of the destination. A forward is
          // always a brand-new message with no quoted preview, so nothing here is reader-specific
          // and the room broadcast in `messagePosted` remains correct.
          message: toMessageWireFromRow(delivered.message, delivered.viewerJoinedAt),
        });
      }

      return NextResponse.json(
        {
          messages: result.delivered.map((delivered) =>
            toMessageWireFromRow(delivered.message, delivered.viewerJoinedAt),
          ),
          failures: result.failures,
        } satisfies ForwardResultWire,
        { status: result.delivered.length > 0 ? 201 : 207 },
      );
    } catch (error) {
      if (error instanceof MessageActionError) {
        if (error.reason === 'NOT_ACCESSIBLE') return forbidden();
        if (error.reason === 'NOT_ACTIONABLE') return invalidRequest(error.message);
        if (error.reason === 'NO_DESTINATIONS') {
          return invalidRequest('Choose at least one conversation.');
        }
      }
      throw error;
    }
  });
}
