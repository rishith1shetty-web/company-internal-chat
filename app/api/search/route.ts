/**
 * GET /api/search?q=… — global search across people, groups, messages and filenames (Batch 1.6).
 *
 * Read-only. This route creates nothing, changes nothing, marks nothing read and emits no socket
 * event: searching is not an activity anyone else can observe, and it must never move an unread
 * count or raise a notification.
 *
 * Identity comes from the same `withIdentity` wrapper every other route uses — the session and
 * device cookies, resolved server-side. There is no `userId` parameter, here or anywhere: a
 * caller cannot search as somebody else because there is nothing to send that would say so.
 *
 * WHAT IS AND IS NOT AN ERROR. A query that is too short is not a failure — it is the normal
 * state of a search box halfway through a word — so it returns empty results with no database
 * access at all. A query longer than a search term could sensibly be is refused, because at that
 * point it is a paste or a probe.
 *
 * The query text is NOT LOGGED. What an employee types into search is as sensitive as the
 * messages it searches, and the existing route logger already records the method, the path and
 * the outcome, which is what diagnosing this route actually needs.
 */

import { NextResponse } from 'next/server';

import type { SearchResultsWire } from '@/lib/chat/wire';
import { getDb } from '@/lib/db/prisma';
import { invalidRequest, withIdentity } from '@/lib/http/route-helpers';
import {
  emptySearchResults,
  normalizeSearchQuery,
  searchEverything,
  SEARCH_MAX_QUERY_LENGTH,
  type SearchResults,
} from '@/lib/search/service';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  return withIdentity(request, async (current) => {
    const raw = new URL(request.url).searchParams.get('q') ?? '';

    // Checked before trimming: the cost of a very long string is in having accepted it at all.
    if (raw.length > SEARCH_MAX_QUERY_LENGTH) {
      return invalidRequest('That search term is too long.');
    }

    const query = normalizeSearchQuery(raw);

    /*
     * Too short, empty, or whitespace. Answered without touching the database — which is what
     * makes a debounce failure on some future client a wasted round trip rather than a scan.
     */
    if (query === null) {
      return NextResponse.json(toWire('', emptySearchResults()) satisfies SearchResultsWire);
    }

    const results = await searchEverything(getDb(), current.userId, query);

    return NextResponse.json(toWire(query, results) satisfies SearchResultsWire);
  });
}

/** Dates to ISO-8601 UTC, and nothing added that the service did not already authorize. */
function toWire(query: string, results: SearchResults): SearchResultsWire {
  return {
    query,
    people: results.people.map((person) => ({
      id: person.id,
      displayName: person.displayName,
      lastSeenAt: person.lastSeenAt.toISOString(),
    })),
    groups: results.groups.map((group) => ({
      conversationId: group.conversationId,
      name: group.name,
      memberCount: group.memberCount,
    })),
    messages: results.messages.map((message) => ({
      id: message.id,
      conversationId: message.conversationId,
      conversationType: message.conversationType,
      conversationName: message.conversationName,
      senderId: message.senderId,
      senderName: message.senderName,
      body: message.body,
      createdAt: message.createdAt.toISOString(),
    })),
    files: results.files.map((file) => ({
      attachmentId: file.attachmentId,
      messageId: file.messageId,
      conversationId: file.conversationId,
      conversationType: file.conversationType,
      conversationName: file.conversationName,
      filename: file.filename,
      senderId: file.senderId,
      senderName: file.senderName,
      createdAt: file.createdAt.toISOString(),
    })),
  };
}
