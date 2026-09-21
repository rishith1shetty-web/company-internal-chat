/**
 * PATCH /api/messages/:id — edit the text of a message you sent (Batch 1.1).
 *
 * WHY PATCH ON THE MESSAGE ITSELF, rather than another `/:id/<verb>` sub-route like the rest of
 * Batch 1. Reacting, pinning, forwarding and deleting are all things done *to* a message and each
 * owns a sub-resource; editing changes the message's own representation, which is exactly what
 * PATCH means. It also keeps the request honest: there is one editable field, so the body carries
 * one field, and everything else about the message stays where it is.
 *
 * THE BODY IS STRICT. Unknown keys are REFUSED rather than quietly dropped — a request carrying
 * `senderId`, `createdAt`, `conversationId`, `replyToId`, `isForwarded`, `pinnedAt` or an
 * attachment id is a client that is confused or hostile, and answering 400 says so instead of
 * accepting it and appearing to have honoured it. Nothing is mass-assignable regardless: the
 * service takes three named arguments and writes exactly two columns, so even a field that got
 * past this schema would have nowhere to go.
 *
 * NO NEW REAL-TIME EVENT. An edit is a message that changed, which is what `message:updated`
 * already means — it carries the whole message, is emitted per member against each reader's D-03
 * window, and is deliberately not a notification: no sound, no toast, no unread, no reordering.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import type { MessageMutationWire } from '@/lib/chat/wire';
import { getDb } from '@/lib/db/prisma';
import { forbidden, invalidRequest, readJsonBody, withIdentity } from '@/lib/http/route-helpers';
import { toMessageWireFromRow } from '@/lib/http/serialize';
import { MessageActionError, editMessage } from '@/lib/messages/actions';
import { MAX_MESSAGE_LENGTH } from '@/lib/messages/service';
import { notifyMessageUpdated } from '@/lib/realtime/notify';

export const dynamic = 'force-dynamic';

const uuid = z.uuid({ version: 'v4' });

/**
 * The only thing an edit may carry.
 *
 * No lower bound: clearing a file message's caption is a legitimate edit, and whether emptiness is
 * acceptable depends on what the message is — which only the service can tell. The upper bound is
 * checked here so an oversized payload is rejected before the database layer, and again in the
 * service, which remains the authority.
 */
const bodySchema = z.strictObject({
  body: z.string().max(MAX_MESSAGE_LENGTH),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return withIdentity(request, async (current) => {
    const { id } = await context.params;
    if (!uuid.safeParse(id).success) return invalidRequest('That message is not valid.');

    const parsed = bodySchema.safeParse(await readJsonBody(request));
    if (!parsed.success) return invalidRequest('That request was not understood.');

    try {
      const { message, membership } = await editMessage(getDb(), {
        // From the resolved session, never from the payload.
        userId: current.userId,
        messageId: id,
        body: parsed.data.body,
      });

      notifyMessageUpdated({ conversationId: message.conversationId, message });

      return NextResponse.json({
        message: toMessageWireFromRow(message, membership.joinedAt),
      } satisfies MessageMutationWire);
    } catch (error) {
      if (error instanceof MessageActionError) {
        /*
         * "No such message", "not a member", "before you joined" and "not yours" all answer the
         * same 403 with the same body.
         *
         * The first three must be indistinguishable or this becomes an oracle for which message
         * ids exist. "Not yours" is folded in with them deliberately: a member can already see the
         * message, so the disclosure is small, but there is no reason to make the cases
         * distinguishable at all.
         */
        if (error.reason === 'NOT_ACCESSIBLE' || error.reason === 'NOT_THE_SENDER') {
          return forbidden();
        }
        // These concern the content of a message the caller can already see, so the reason is
        // safe to state and is the only way they can tell what to change.
        if (
          error.reason === 'NOT_ACTIONABLE' ||
          error.reason === 'EMPTY_BODY' ||
          error.reason === 'BODY_TOO_LONG'
        ) {
          return invalidRequest(error.message);
        }
      }
      throw error;
    }
  });
}
