/**
 * GET /api/conversations/:id/messages — conversation history.
 *
 * This is the endpoint that makes PostgreSQL, and not the socket, the source of truth. A client
 * that reconnects does not replay missed socket events: it asks here with `after=<last known
 * message id>` and backfills from the database, which reduces "missed while offline" and
 * "delivered twice" to the same already-solved problem (docs/01-architecture.md §6).
 *
 * The conversation id in the path is a request, not a permission. `listMessages` re-derives the
 * caller's membership from the database on every call and bounds the result by their `joinedAt`
 * (D-03); nothing here trusts the browser for either.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import type { MessagePageWire } from '@/lib/chat/wire';
import { getDb } from '@/lib/db/prisma';
import { forbidden, invalidRequest, withIdentity } from '@/lib/http/route-helpers';
import { toMessageWireFromRow } from '@/lib/http/serialize';
import { HISTORY_MAX_LIMIT, ListMessagesError, listMessages } from '@/lib/messages/service';

export const dynamic = 'force-dynamic';

const uuid = z.uuid({ version: 'v4' });

const querySchema = z.object({
  /** Page backwards from this message: older history. */
  before: uuid.optional(),
  /** Backfill forwards from this message: the reconnect path. */
  after: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(HISTORY_MAX_LIMIT).optional(),
});

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return withIdentity(request, async (current) => {
    const { id } = await context.params;

    // A malformed id is a bad request, not a forbidden one: there is nothing to authorize yet.
    if (!uuid.safeParse(id).success) return invalidRequest('That conversation is not valid.');

    const url = new URL(request.url);
    const parsed = querySchema.safeParse({
      before: url.searchParams.get('before') ?? undefined,
      after: url.searchParams.get('after') ?? undefined,
      limit: url.searchParams.get('limit') ?? undefined,
    });

    if (!parsed.success) return invalidRequest('That request for history was not understood.');
    if (parsed.data.before && parsed.data.after) {
      return invalidRequest('Ask for older or newer messages, not both.');
    }

    try {
      const page = await listMessages(getDb(), {
        userId: current.userId,
        conversationId: id,
        before: parsed.data.before,
        after: parsed.data.after,
        limit: parsed.data.limit,
      });

      return NextResponse.json({
        messages: page.messages.map(toMessageWireFromRow),
        hasMore: page.hasMore,
      } satisfies MessagePageWire);
    } catch (error) {
      if (error instanceof ListMessagesError) {
        // "Not a member" and "no such conversation" answer identically on purpose.
        if (error.reason === 'NOT_A_MEMBER') return forbidden();
        return invalidRequest(error.message);
      }
      throw error;
    }
  });
}
