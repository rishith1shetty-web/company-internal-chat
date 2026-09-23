/**
 * `GET /api/search` — identity, validation, and what searching leaves behind (Batch 1.6).
 *
 * The service's authorization rules are proven in `search-service.test.ts`. What is left for the
 * route is the front door: that an unidentified caller gets nothing, that a malformed query is
 * refused rather than run, that the serialised body carries no internals — and that a search
 * CHANGES NOTHING. That last one is the quiet requirement of this batch: search is read-only, and
 * the way that breaks is not a wrong result but a side effect nobody looked for.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GET as searchRoute } from '@/app/api/search/route';
import type { SearchResultsWire } from '@/lib/chat/wire';

import {
  buildRequest,
  cleanUp,
  cookieHeader,
  createTestIdentity,
  databaseConfigured,
  db,
  disconnect,
  readResponse,
  seedDirectConversation,
  seedMessageAt,
  type TestIdentity,
} from './harness';

const suite = databaseConfigured ? describe : describe.skip;

const TAG = 'zzroute';

let alice: TestIdentity;
let bob: TestIdentity;
let conversationId: string;

async function callSearch(query: string, cookie?: string) {
  const response = await searchRoute(
    buildRequest({
      url: `http://localhost/api/search?q=${encodeURIComponent(query)}`,
      ...(cookie === undefined ? {} : { cookie }),
    }),
  );

  return readResponse<SearchResultsWire>(response);
}

suite('GET /api/search', () => {
  beforeAll(async () => {
    alice = await createTestIdentity(`${TAG}-Alice`);
    bob = await createTestIdentity(`${TAG}-Bob`);

    conversationId = await seedDirectConversation(alice.userId, bob.userId);
    // "Now", so it is inside the default joinedAt window these identities were created with.
    await seedMessageAt(conversationId, bob.userId, `${TAG} the quarterly report`, new Date());
  });

  afterAll(async () => {
    await cleanUp();
    await disconnect();
  });

  /* ------------------------------------------------------------------------------------------ */
  /* Identity                                                                                     */
  /* ------------------------------------------------------------------------------------------ */

  it('refuses a caller with no identity', async () => {
    const result = await callSearch(`${TAG} report`);
    expect(result.status).toBe(401);
  });

  it('refuses a caller whose cookies do not resolve', async () => {
    const result = await callSearch(`${TAG} report`, cookieHeader('not-a-real-token'));
    expect(result.status).toBe(401);
  });

  it('answers an identified caller', async () => {
    const result = await callSearch(
      `${TAG} the quarterly`,
      cookieHeader(alice.sessionToken, alice.deviceToken),
    );

    expect(result.status).toBe(200);
    expect(result.body?.messages).toHaveLength(1);
  });

  it('takes the searcher from the cookie, never from the request', async () => {
    /*
     * There is no `userId` parameter to send, which is the point — but a caller could still try,
     * and it must make no difference whose results come back.
     */
    const response = await searchRoute(
      buildRequest({
        url: `http://localhost/api/search?q=${encodeURIComponent(`${TAG} the quarterly`)}&userId=${bob.userId}`,
        cookie: cookieHeader(alice.sessionToken, alice.deviceToken),
      }),
    );

    const result = await readResponse<SearchResultsWire>(response);
    expect(result.status).toBe(200);
    // Alice's own visible window answered it; the extra parameter was simply ignored.
    expect(result.body?.messages[0]?.conversationId).toBe(conversationId);
  });

  /* ------------------------------------------------------------------------------------------ */
  /* Validation                                                                                   */
  /* ------------------------------------------------------------------------------------------ */

  describe('query validation', () => {
    const cookie = () => cookieHeader(alice.sessionToken, alice.deviceToken);

    it('returns empty results for a query below the minimum, not an error', async () => {
      for (const term of ['', ' ', 'r']) {
        const result = await callSearch(term, cookie());

        expect(result.status, term).toBe(200);
        expect(result.body, term).toEqual({
          query: '',
          people: [],
          groups: [],
          messages: [],
          files: [],
        });
      }
    });

    it('refuses an excessively long query', async () => {
      const result = await callSearch('x'.repeat(65), cookie());
      expect(result.status).toBe(400);
    });

    it('accepts a query at exactly the maximum', async () => {
      const result = await callSearch('x'.repeat(64), cookie());
      expect(result.status).toBe(200);
    });

    it('echoes the query it actually ran, trimmed', async () => {
      const result = await callSearch(`  ${TAG} the quarterly  `, cookie());
      expect(result.body?.query).toBe(`${TAG} the quarterly`);
    });

    it('always returns all four categories, even when empty', async () => {
      const result = await callSearch('zznothingmatchesthis', cookie());

      expect(result.body).toMatchObject({
        people: [],
        groups: [],
        messages: [],
        files: [],
      });
    });
  });

  /* ------------------------------------------------------------------------------------------ */
  /* 17 — nothing internal crosses the wire                                                       */
  /* ------------------------------------------------------------------------------------------ */

  it('leaks no storage path, session, device or token data', async () => {
    const result = await callSearch(
      TAG,
      cookieHeader(alice.sessionToken, alice.deviceToken),
    );

    const serialised = JSON.stringify(result.body);
    for (const forbidden of [
      'storageKey',
      '.bin',
      'tokenHash',
      'deviceId',
      'sessionToken',
      'enrollment',
      'C:\\',
      'DATABASE_URL',
    ]) {
      expect(serialised, forbidden).not.toContain(forbidden);
    }
  });

  /* ------------------------------------------------------------------------------------------ */
  /* 20, 21, 22 — searching changes nothing                                                       */
  /* ------------------------------------------------------------------------------------------ */

  describe('search is read-only', () => {
    it('does not move a read marker or change an unread count', async () => {
      const before = await db().conversationMember.findUniqueOrThrow({
        where: { conversationId_userId: { conversationId, userId: alice.userId } },
        select: { lastReadAt: true, lastReadMessageId: true },
      });

      await callSearch(`${TAG} the quarterly`, cookieHeader(alice.sessionToken, alice.deviceToken));

      const after = await db().conversationMember.findUniqueOrThrow({
        where: { conversationId_userId: { conversationId, userId: alice.userId } },
        select: { lastReadAt: true, lastReadMessageId: true },
      });

      // Finding a message is not reading it. The badge must still be there afterwards.
      expect(after).toEqual(before);
    });

    it('creates no rows', async () => {
      const counts = async () => ({
        messages: await db().message.count({ where: { conversationId } }),
        conversations: await db().conversation.count({
          where: { members: { some: { userId: alice.userId } } },
        }),
        hides: await db().messageHide.count({ where: { userId: alice.userId } }),
      });

      const before = await counts();
      await callSearch(TAG, cookieHeader(alice.sessionToken, alice.deviceToken));
      await callSearch(`${TAG} the quarterly`, cookieHeader(alice.sessionToken, alice.deviceToken));

      expect(await counts()).toEqual(before);
    });

    it('does not touch the message rows it matched', async () => {
      const before = await db().message.findFirstOrThrow({
        where: { conversationId },
        select: { id: true, body: true, editedAt: true, pinnedAt: true, deletedAt: true },
      });

      await callSearch(`${TAG} the quarterly`, cookieHeader(alice.sessionToken, alice.deviceToken));

      const after = await db().message.findUniqueOrThrow({
        where: { id: before.id },
        select: { id: true, body: true, editedAt: true, pinnedAt: true, deletedAt: true },
      });

      expect(after).toEqual(before);
    });
  });
});
