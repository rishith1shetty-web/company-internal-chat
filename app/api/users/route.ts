/**
 * GET /api/users — the colleague directory used to start a one-to-one conversation.
 *
 * Requires a valid identity: the list of who works here is company information, not a public
 * page. It returns ids and display names, and no presence — presence is derived from live
 * sockets and is scoped to people the caller shares a conversation with (Phase 4), so it travels
 * over the socket rather than being published to anyone who asks (lib/users/directory.ts).
 *
 * `q` filters; it never identifies. Two colleagues may both be called "Sarah Chen" (D-02), and
 * both are returned as separate rows with separate ids for the interface to tell apart.
 */

import { NextResponse } from 'next/server';

import type { DirectoryWire } from '@/lib/chat/wire';
import { getDb } from '@/lib/db/prisma';
import { invalidRequest, withIdentity } from '@/lib/http/route-helpers';
import { toUserWire } from '@/lib/http/serialize';
import { DIRECTORY_MAX_SEARCH_LENGTH, listDirectory } from '@/lib/users/directory';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  return withIdentity(request, async (current) => {
    const url = new URL(request.url);
    const search = url.searchParams.get('q') ?? undefined;

    // A "search term" longer than a display name can be is not a search term.
    if (search !== undefined && search.length > DIRECTORY_MAX_SEARCH_LENGTH) {
      return invalidRequest('That search term is too long.');
    }

    const users = await listDirectory(getDb(), current.userId, { search });

    return NextResponse.json({ users: users.map(toUserWire) } satisfies DirectoryWire);
  });
}
