/**
 * PUT    /api/messages/:id/reactions — set (or change) the caller's reaction.
 * DELETE /api/messages/:id/reactions — remove the caller's reaction.
 *
 * PUT rather than POST, deliberately: one person has at most one reaction to one message, so
 * this replaces a value at a known address. Sending it twice leaves exactly the same state, which
 * is what a client retrying after a dropped response needs.
 *
 * There is no user id in either request. The reaction belongs to whoever the cookie resolves to,
 * and there is no field through which a client could name anybody else — so "remove somebody
 * else's reaction" is not a request this endpoint can express, let alone authorize.
 *
 * Neither verb writes a message, touches `lastMessageAt` or moves a read marker: reacting must
 * never produce an unread badge (see `lib/messages/actions.ts`).
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import type { MessageMutationWire } from '@/lib/chat/wire';
import { getDb } from '@/lib/db/prisma';
import {
  forbidden,
  invalidRequest,
  readJsonBody,
  withIdentity,
} from '@/lib/http/route-helpers';
import { toMessageWireFromRow } from '@/lib/http/serialize';
import { MessageActionError, clearReaction, setReaction } from '@/lib/messages/actions';
import { notifyMessageUpdated } from '@/lib/realtime/notify';

export const dynamic = 'force-dynamic';

const uuid = z.uuid({ version: 'v4' });

const bodySchema = z.object({
  /**
   * Checked against the server's allow-list in the service, not here. This bound only stops an
   * absurdly long string reaching the database layer.
   */
  emoji: z.string().min(1).max(32),
});

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return withIdentity(request, async (current) => {
    const { id } = await context.params;
    if (!uuid.safeParse(id).success) return invalidRequest('That message is not valid.');

    const parsed = bodySchema.safeParse(await readJsonBody(request));
    if (!parsed.success) return invalidRequest('That reaction was not understood.');

    try {
      const { message, membership } = await setReaction(getDb(), {
        userId: current.userId,
        messageId: id,
        emoji: parsed.data.emoji,
      });

      notifyMessageUpdated({ conversationId: message.conversationId, message });

      // Serialized for the caller with the caller's own window — the gateway re-serializes the
      // same row per recipient, because a quoted reply preview is reader-specific.
      return NextResponse.json({
        message: toMessageWireFromRow(message, membership.joinedAt),
      } satisfies MessageMutationWire);
    } catch (error) {
      return handleActionError(error);
    }
  });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return withIdentity(request, async (current) => {
    const { id } = await context.params;
    if (!uuid.safeParse(id).success) return invalidRequest('That message is not valid.');

    try {
      const { message, membership } = await clearReaction(getDb(), {
        userId: current.userId,
        messageId: id,
      });

      notifyMessageUpdated({ conversationId: message.conversationId, message });

      return NextResponse.json({
        message: toMessageWireFromRow(message, membership.joinedAt),
      } satisfies MessageMutationWire);
    } catch (error) {
      return handleActionError(error);
    }
  });
}

/**
 * Maps a service failure onto a response.
 *
 * `NOT_ACCESSIBLE` becomes 403 with the generic body every other endpoint uses — it must not be
 * possible to tell "no such message" from "not yours" from "before you joined", because that
 * distinction is an oracle for which message ids exist.
 */
function handleActionError(error: unknown): NextResponse {
  if (error instanceof MessageActionError) {
    if (error.reason === 'NOT_ACCESSIBLE') return forbidden();
    if (error.reason === 'INVALID_EMOJI') return invalidRequest('That reaction is not available.');
    if (error.reason === 'NOT_ACTIONABLE') return invalidRequest(error.message);
  }
  throw error;
}
