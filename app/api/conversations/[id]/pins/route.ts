/**
 * GET /api/conversations/:id/pins — the pinned messages of a conversation.
 *
 * Bounded by the caller's own `joinedAt` exactly as message history is, and excluding anything
 * they hid for themselves. A pinned message from before somebody joined is not theirs to read,
 * and pinning must not become a way around D-03 — which it would be if this endpoint answered
 * "everything pinned in this conversation".
 *
 * Tombstones are excluded: a message deleted for everyone loses its pin when it is deleted, and
 * this filters them again so a pin written by an older code path can never surface as misleading
 * pinned content.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import type { PinnedMessagesWire } from '@/lib/chat/wire';
import { getDb } from '@/lib/db/prisma';
import { forbidden, invalidRequest, withIdentity } from '@/lib/http/route-helpers';
import { toMessageWireFromRow } from '@/lib/http/serialize';
import { MessageActionError, listPinnedMessages } from '@/lib/messages/actions';

export const dynamic = 'force-dynamic';

const uuid = z.uuid({ version: 'v4' });

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return withIdentity(request, async (current) => {
    const { id } = await context.params;
    if (!uuid.safeParse(id).success) return invalidRequest('That conversation is not valid.');

    try {
      const { membership, messages } = await listPinnedMessages(getDb(), {
        userId: current.userId,
        conversationId: id,
      });

      return NextResponse.json({
        messages: messages.map((message) => toMessageWireFromRow(message, membership.joinedAt)),
      } satisfies PinnedMessagesWire);
    } catch (error) {
      if (error instanceof MessageActionError && error.reason === 'NOT_ACCESSIBLE') {
        return forbidden();
      }
      throw error;
    }
  });
}
