/**
 * POST   /api/messages/:id/pin — pin a message in its conversation.
 * DELETE /api/messages/:id/pin — unpin it.
 *
 * Pinning is CONVERSATION-LEVEL: one pin, visible to every member, not a private bookmark. Any
 * active member may pin and any active member may unpin — deliberately, over "only the pinner may
 * unpin", which would strand a pin the moment that person left the group.
 *
 * Neither verb writes a message or moves `lastMessageAt`, so pinning cannot reorder the sidebar
 * or create an unread badge.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import type { MessageMutationWire } from '@/lib/chat/wire';
import { getDb } from '@/lib/db/prisma';
import { forbidden, invalidRequest, withIdentity } from '@/lib/http/route-helpers';
import { toMessageWireFromRow } from '@/lib/http/serialize';
import { MessageActionError, setPinned } from '@/lib/messages/actions';
import { notifyMessageUpdated } from '@/lib/realtime/notify';

export const dynamic = 'force-dynamic';

const uuid = z.uuid({ version: 'v4' });

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return pinOrUnpin(request, context, true);
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return pinOrUnpin(request, context, false);
}

async function pinOrUnpin(
  request: Request,
  context: { params: Promise<{ id: string }> },
  pinned: boolean,
): Promise<NextResponse> {
  return withIdentity(request, async (current) => {
    const { id } = await context.params;
    if (!uuid.safeParse(id).success) return invalidRequest('That message is not valid.');

    try {
      const { message, membership } = await setPinned(getDb(), {
        userId: current.userId,
        messageId: id,
        pinned,
      });

      notifyMessageUpdated({ conversationId: message.conversationId, message });

      return NextResponse.json({
        message: toMessageWireFromRow(message, membership.joinedAt),
      } satisfies MessageMutationWire);
    } catch (error) {
      if (error instanceof MessageActionError) {
        // One answer for "no such message", "not a member" and "before you joined".
        if (error.reason === 'NOT_ACCESSIBLE') return forbidden();
        if (error.reason === 'NOT_ACTIONABLE') return invalidRequest(error.message);
      }
      throw error;
    }
  });
}
