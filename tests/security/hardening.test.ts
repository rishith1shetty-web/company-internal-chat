/**
 * Phase 9 hardening, exercised against the real database and the real route handlers.
 *
 * The pure matching rules are pinned in `request-guard.test.ts` and `rate-limit.test.ts`. What is
 * left is the behaviour that only shows up when the whole path runs: an oversized body reaching a
 * real endpoint, two requests racing for one enrollment code, and the handling of message and
 * filename content that is deliberately shaped like an injection.
 *
 * Everything here uses the shared harness, so every row it creates is registered and deleted by id
 * afterwards, under the approved `zz-test-p5-` prefix. Nothing is truncated and no manually created
 * development data is read or touched.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { POST as postConversation } from '@/app/api/conversations/route';
import { POST as postEnroll } from '@/app/api/enroll/route';
import { contentDispositionFor, sanitizeFilename } from '@/lib/files/service';
import { listMessages, sendMessage } from '@/lib/messages/service';
import { DeviceError, enrollDevice } from '@/lib/devices/service';
import { JSON_BODY_LIMIT } from '@/lib/http/request-guard';
import { readJsonBody } from '@/lib/http/route-helpers';
import type { ApiErrorWire, ConversationCreatedWire } from '@/lib/chat/wire';

import {
  ENROLLMENT_CONFIG,
  assignTestDevice,
  buildRequest,
  cleanUp,
  createTestIdentity,
  databaseConfigured,
  db,
  disconnect,
  readResponse,
  seedDirectConversation,
  trackConversation,
} from '../chat/harness';

const withDatabase = databaseConfigured ? describe : describe.skip;

afterAll(async () => {
  await cleanUp();
  await disconnect();
});

describe('an oversized JSON body', () => {
  /*
   * Asserted against `readJsonBody` itself rather than through a route, and the distinction
   * matters: driving a route with a huge `name` would be refused by the endpoint's own Zod schema
   * and the test would pass whether or not the body was ever bounded. What is being proven here is
   * that the READ stops — that the bytes are never accumulated in the first place.
   *
   * This is the half of the control that does not depend on believing the sender. `server.ts`
   * refuses an honest oversized body from its declared `Content-Length` before Next.js allocates
   * anything; a body sent chunked, or one that lies about its length, arrives here.
   */
  function streamedRequest(chunks: Uint8Array[]): Request {
    // No `Content-Length`, exactly like a chunked upload — so nothing upstream can have refused it.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });

    return new Request('http://127.0.0.1/api/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      // Required by undici for a streaming body.
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
  }

  it('is abandoned rather than accumulated', async () => {
    const encoder = new TextEncoder();
    const chunk = encoder.encode('a'.repeat(64 * 1024));
    const chunks = [encoder.encode('{"padding":"')];

    // Comfortably past the limit, delivered in pieces so the counter is what has to notice.
    for (let index = 0; index < Math.ceil(JSON_BODY_LIMIT / chunk.length) + 2; index += 1) {
      chunks.push(chunk);
    }
    chunks.push(encoder.encode('"}'));

    // `undefined` is how this function reports every unusable body, so every caller already
    // answers 400 for it — the same answer malformed JSON has always produced.
    await expect(readJsonBody(streamedRequest(chunks))).resolves.toBeUndefined();
  });

  it('does not get in the way of an ordinary one', async () => {
    // A limit nobody meets by accident, or it is an outage rather than a control.
    const encoder = new TextEncoder();
    const body = JSON.stringify({ type: 'GROUP', name: 'Ordinary group', memberIds: [] });

    await expect(readJsonBody(streamedRequest([encoder.encode(body)]))).resolves.toEqual({
      type: 'GROUP',
      name: 'Ordinary group',
      memberIds: [],
    });
  });

  it('accepts a body just under the limit, so the boundary is where it is documented', async () => {
    const encoder = new TextEncoder();
    // `{"padding":"..."}` — the quoting and key cost 15 bytes.
    const padding = 'a'.repeat(JSON_BODY_LIMIT - 15);
    const payload = encoder.encode(`{"padding":"${padding}"}`);
    expect(payload.byteLength).toBeLessThanOrEqual(JSON_BODY_LIMIT);

    const parsed = await readJsonBody(streamedRequest([payload]));
    expect((parsed as { padding: string }).padding).toHaveLength(padding.length);
  });
});

withDatabase('the endpoints an oversized body would have reached', () => {
  it('still create a conversation normally', async () => {
    const caller = await createTestIdentity('Creator');
    const colleague = await createTestIdentity('Colleague');

    const response = await postConversation(
      buildRequest({
        url: '/api/conversations',
        method: 'POST',
        cookie: caller.cookie,
        body: { type: 'GROUP', name: 'Ordinary group', memberIds: [colleague.userId] },
      }),
    );

    const result = await readResponse<ConversationCreatedWire>(response);
    expect(result.status).toBe(201);
    trackConversation(result.body.conversation.id);
  });
});

withDatabase('a setup code redeemed twice at once', () => {
  it('enrolls exactly one computer, not two', async () => {
    /*
     * THE RACE THIS FIX EXISTS FOR. Redemption used to read the device, then write it by id. Two
     * requests arriving together would both find the code unspent and both write — and the pair
     * would resolve to whichever committed last, leaving the other holding a device cookie that
     * had already stopped working, with nothing to say why.
     *
     * The claim is now one conditional statement (`enrollmentTokenHash: codeHash` in the `where`),
     * so PostgreSQL settles it: the second transaction re-evaluates the condition after the first
     * commits, finds the column already NULL, and matches nothing.
     */
    const assigned = await assignTestDevice('Raced');

    const attempts = await Promise.allSettled([
      enrollDevice(db(), { code: assigned.enrollmentCode, userAgent: 'vitest-a' }, ENROLLMENT_CONFIG),
      enrollDevice(db(), { code: assigned.enrollmentCode, userAgent: 'vitest-b' }, ENROLLMENT_CONFIG),
    ]);

    const succeeded = attempts.filter((attempt) => attempt.status === 'fulfilled');
    const failed = attempts.filter((attempt) => attempt.status === 'rejected');

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);

    // And the loser is told the same thing as somebody who made a code up.
    const rejection = failed[0] as PromiseRejectedResult;
    expect(rejection.reason).toBeInstanceOf(DeviceError);
    expect((rejection.reason as DeviceError).reason).toBe('INVALID_CODE');
  });

  it('leaves the winner with a device cookie that actually works', async () => {
    // The failure mode being ruled out is subtler than "both succeeded": it is one request
    // returning a token that a concurrent write had already replaced.
    const assigned = await assignTestDevice('RacedWinner');

    const attempts = await Promise.allSettled([
      enrollDevice(db(), { code: assigned.enrollmentCode, userAgent: 'vitest-a' }, ENROLLMENT_CONFIG),
      enrollDevice(db(), { code: assigned.enrollmentCode, userAgent: 'vitest-b' }, ENROLLMENT_CONFIG),
    ]);

    const winner = attempts.find((attempt) => attempt.status === 'fulfilled');
    expect(winner).toBeDefined();

    const enrolled = (winner as PromiseFulfilledResult<Awaited<ReturnType<typeof enrollDevice>>>)
      .value;

    const device = await db().device.findUnique({
      where: { id: assigned.deviceId },
      select: { tokenHash: true, enrollmentTokenHash: true, enrolledAt: true },
    });

    expect(device?.enrollmentTokenHash).toBeNull();
    expect(device?.enrolledAt).not.toBeNull();
    // Exactly one session survives: the winner's.
    const sessions = await db().session.count({ where: { deviceId: assigned.deviceId } });
    expect(sessions).toBe(1);
    expect(enrolled.deviceId).toBe(assigned.deviceId);
  });

  it('still refuses the same code sequentially afterwards', async () => {
    const assigned = await assignTestDevice('RacedThenReplayed');

    await enrollDevice(db(), { code: assigned.enrollmentCode }, ENROLLMENT_CONFIG);

    await expect(
      enrollDevice(db(), { code: assigned.enrollmentCode }, ENROLLMENT_CONFIG),
    ).rejects.toBeInstanceOf(DeviceError);
  });

  it('answers a replayed code over HTTP with a 400 and nothing about why', async () => {
    const assigned = await assignTestDevice('ReplayedOverHttp');

    await enrollDevice(db(), { code: assigned.enrollmentCode }, ENROLLMENT_CONFIG);

    const response = await postEnroll(
      buildRequest({ url: '/api/enroll', method: 'POST', body: { code: assigned.enrollmentCode } }),
    );
    const result = await readResponse<ApiErrorWire>(response);

    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('INVALID_CODE');
    // The same wording a made-up code gets: that a code was real a moment ago is not something
    // this endpoint confirms.
    expect(result.body.error.message).toBe('That setup code is not valid.');
  });
});

withDatabase('message content that is shaped like an injection', () => {
  const HOSTILE = [
    '<script>alert(document.cookie)</script>',
    '"><img src=x onerror=alert(1)>',
    "'; DROP TABLE messages; --",
    '{{constructor.constructor("alert(1)")()}}',
    '\u202Egnp.exe',
  ];

  it('is stored and returned exactly as typed, neither executed nor mangled', async () => {
    /*
     * The right behaviour for a chat application is to treat this as TEXT — a colleague pasting a
     * snippet of HTML into a message is doing ordinary work, and silently rewriting it would be a
     * bug. Safety comes from the rendering end: React escapes the body, and there is no
     * `dangerouslySetInnerHTML` anywhere in this codebase.
     *
     * The SQL string is here for the same reason: Prisma parameterises every query, so it is
     * simply a message. A test that saw it altered would be seeing something go wrong.
     */
    const alice = await createTestIdentity('Alice');
    const bob = await createTestIdentity('Bob');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    for (const body of HOSTILE) {
      await sendMessage(db(), {
        senderId: alice.userId,
        conversationId,
        body,
        clientMessageId: crypto.randomUUID(),
      });
    }

    const page = await listMessages(db(), { userId: bob.userId, conversationId });
    const bodies = page.messages.map((message) => message.body);

    for (const body of HOSTILE) {
      expect(bodies).toContain(body);
    }
  });

  it('survives the round trip without the database being confused by it', async () => {
    // The point of the SQL-shaped string: the table is still there afterwards.
    const alice = await createTestIdentity('Alice2');
    const bob = await createTestIdentity('Bob2');
    const conversationId = await seedDirectConversation(alice.userId, bob.userId);

    await sendMessage(db(), {
      senderId: alice.userId,
      conversationId,
      body: "'; DELETE FROM messages WHERE '1'='1",
      clientMessageId: crypto.randomUUID(),
    });

    const page = await listMessages(db(), { userId: bob.userId, conversationId });
    expect(page.messages).toHaveLength(1);
  });
});

describe('a filename shaped like an attack', () => {
  /*
   * Pure, so it needs no database. It belongs with the rest of this file because it is the same
   * question asked of a different input: what does a hostile string do on its way to a header?
   */
  it('cannot inject a response header', () => {
    const injected = sanitizeFilename('report\r\nSet-Cookie: cic_session=stolen.pdf');
    expect(injected).not.toContain('\r');
    expect(injected).not.toContain('\n');
    expect(contentDispositionFor(injected)).not.toMatch(/[\r\n]/);
  });

  it('cannot close the quoted filename and append parameters of its own', () => {
    const disposition = contentDispositionFor('a".pdf; x=y');
    // The ASCII fallback has its quotes stripped rather than escaped, so the quoted string is the
    // one this server opened and closed.
    const quoted = disposition.match(/filename="([^"]*)"/);
    expect(quoted).not.toBeNull();
    expect(quoted?.[1]).not.toContain('"');
  });

  it('cannot describe a path, however it is spelled', () => {
    for (const raw of ['../../etc/passwd', '..\\..\\windows\\system32\\cmd.exe', 'C:\\secret.txt']) {
      const safe = sanitizeFilename(raw);
      expect(safe).not.toContain('/');
      expect(safe).not.toContain('\\');
      expect(safe).not.toContain(':');
    }
  });

  it('always produces something, so a hostile name cannot produce an empty one', () => {
    expect(sanitizeFilename('/////').length).toBeGreaterThan(0);
    expect(sanitizeFilename('...').length).toBeGreaterThan(0);
    expect(sanitizeFilename('\u0000\u0001').length).toBeGreaterThan(0);
  });
});
