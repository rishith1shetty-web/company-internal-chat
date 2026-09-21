/**
 * POST /api/messages/:id/delete — hide a message, or replace it with a tombstone.
 *
 * Two very different operations behind one endpoint, separated by `scope`:
 *
 *   `ME`        Hides the message from the caller and nobody else. The shared row is untouched;
 *               everyone else goes on seeing it. Available for any message the caller can see,
 *               including other people's.
 *
 *   `EVERYONE`  Replaces the message with a tombstone for the whole conversation. **Only the
 *               original sender.** This is enforced in `deleteMessageForEveryone` from the stored
 *               `senderId`, not from anything in this request — a crafted call naming somebody
 *               else's message is refused by the service, so the interface hiding the option is a
 *               convenience and never the control.
 *
 * A POST rather than HTTP DELETE because it carries a body that changes what it means, and
 * because `ME` does not delete anything at all.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import type { MessageMutationWire } from '@/lib/chat/wire';
import { getDb } from '@/lib/db/prisma';
import {
  forbidden,
  invalidRequest,
  readJsonBody,
  routeLogger,
  storageConfig,
  withIdentity,
} from '@/lib/http/route-helpers';
import { toMessageWireFromRow } from '@/lib/http/serialize';
import {
  MessageActionError,
  deleteMessageForEveryone,
  hideMessageForUser,
  removeOrphanedBytes,
} from '@/lib/messages/actions';
import { notifyMessageHidden, notifyMessageUpdated } from '@/lib/realtime/notify';

export const dynamic = 'force-dynamic';

const uuid = z.uuid({ version: 'v4' });

const bodySchema = z.object({
  scope: z.enum(['ME', 'EVERYONE']),
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
      if (parsed.data.scope === 'ME') {
        const { conversationId } = await hideMessageForUser(getDb(), {
          userId: current.userId,
          messageId: id,
        });

        // Only this person's own sockets. For everybody else nothing happened.
        notifyMessageHidden({ userId: current.userId, conversationId, messageId: id });

        // 204: there is no message to return, because from the caller's point of view it is gone.
        return new NextResponse(null, { status: 204 });
      }

      const result = await deleteMessageForEveryone(getDb(), {
        userId: current.userId,
        messageId: id,
      });

      notifyMessageUpdated({
        conversationId: result.message.conversationId,
        message: result.message,
      });

      /*
       * The bytes go AFTER the commit, never inside the transaction.
       *
       * Deleting the file first and then failing to commit would leave a READY attachment row
       * pointing at bytes that no longer exist — a broken download for every member, caused by a
       * delete that did not happen. This way the worst case is a file left on disk, which is
       * inert: nothing can reach it, because its row is `DELETED` and every download is
       * authorized through the message.
       *
       * Forwarded copies are independent files with their own storage keys, so this cannot reach
       * them (see `forwardMessage`).
       */
      if (result.orphanedStorageKey) {
        const removed = await removeOrphanedBytes(storageConfig, result.orphanedStorageKey);
        if (!removed) {
          // Logged, not raised: the delete succeeded and the user must be told so.
          routeLogger.warn('Deleted attachment bytes could not be removed', { messageId: id });
        }
      }

      return NextResponse.json({
        message: toMessageWireFromRow(result.message, result.membership.joinedAt),
      } satisfies MessageMutationWire);
    } catch (error) {
      if (error instanceof MessageActionError) {
        if (error.reason === 'NOT_ACCESSIBLE') return forbidden();
        /*
         * Also 403, and with the SAME body as `NOT_ACCESSIBLE`.
         *
         * Answering "you are not the sender" would confirm that the message exists and that
         * somebody else wrote it. The caller can already see the message, so that is a small
         * disclosure — but there is no reason to make the two distinguishable at all.
         */
        if (error.reason === 'NOT_THE_SENDER') return forbidden();
      }
      throw error;
    }
  });
}
