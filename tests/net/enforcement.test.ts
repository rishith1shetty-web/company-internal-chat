/**
 * Phase 8 — enforcement, through a real HTTP server and a real Socket.IO gateway.
 *
 * HOW A "DENIED IP" IS SIMULATED. Every connection a test can make comes from loopback, so the
 * policy is flipped instead of the address: a server configured to allow only `10.99.0.0/24` is
 * a server on which this machine is an outside client. That exercises the real gate, on a real
 * socket, with a real remote address — nothing about the request is faked, and no header is
 * involved in the decision. The mirror-image server, which allows loopback, proves the same code
 * lets legitimate traffic through.
 *
 * SAFETY: identities are created through the real device-assignment path and deleted by id
 * afterwards, exactly as the other realtime tests do.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createNetworkGate, type NetworkGate } from '@/lib/net/gate';
import { parseCidr, type CidrRule } from '@/lib/net/ip';
import type { NetworkPolicy } from '@/lib/net/policy';
import {
  cleanUp,
  connectClient,
  createDirectConversation,
  createTestIdentity,
  databaseConfigured,
  disconnectDb,
  emitWithAck,
  expectNoEvent,
  silentLogger,
  startTestServer,
  uuid,
  type RunningServer,
  type TestClient,
  type TestIdentity,
} from '../realtime/harness';

function rules(...entries: string[]): CidrRule[] {
  return entries.map((entry) => {
    const rule = parseCidr(entry);
    if (!rule) throw new Error(`unparsable test rule: ${entry}`);
    return rule;
  });
}

/** This machine is inside. */
const ALLOWS_LOOPBACK: NetworkPolicy = {
  allowed: rules('127.0.0.0/8', '::1/128'),
  trustedProxies: [],
};

/** This machine is outside: a range that exists but contains nothing on this host. */
const EXCLUDES_LOOPBACK: NetworkPolicy = {
  allowed: rules('10.99.0.0/24'),
  trustedProxies: [],
};

function gateFor(policy: NetworkPolicy): NetworkGate {
  return createNetworkGate({ policy, logger: silentLogger() });
}

/**
 * Stands in for Next.js: echoes the path so a test can prove a request actually arrived.
 *
 * If the gate ever fails open, these responses are what a test sees instead of a 403 — which is
 * the point of echoing rather than returning a bare 200.
 */
function appHandler(): (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void {
  return (req, res) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ reached: true, path: req.url }));
  };
}

interface Fetched {
  status: number;
  body: string;
  contentType: string;
}

async function get(url: string, headers: Record<string, string> = {}): Promise<Fetched> {
  const response = await fetch(url, { headers, redirect: 'manual' });
  return {
    status: response.status,
    body: await response.text(),
    contentType: response.headers.get('content-type') ?? '',
  };
}

/*
 * Paths chosen to cover the surfaces the phase brief names individually: the application root,
 * the admin console, the setup page, the REST API, the health endpoint, and both ends of file
 * transfer. All of them are served by the same handler behind the same gate, which is exactly
 * the property being asserted — there is no per-route list to keep in step.
 */
const GUARDED_PATHS = [
  '/',
  '/admin',
  '/setup',
  '/api/session',
  '/api/users',
  '/api/conversations',
  '/api/health',
  '/api/admin/devices',
  '/api/enroll',
  '/api/conversations/abc/attachments',
  '/api/attachments/abc/download',
];

describe('HTTP enforcement', () => {
  let open: RunningServer;
  let closed: RunningServer;

  beforeAll(async () => {
    if (!databaseConfigured) return;
    open = await startTestServer({ gate: gateFor(ALLOWS_LOOPBACK), onRequest: appHandler() });
    closed = await startTestServer({ gate: gateFor(EXCLUDES_LOOPBACK), onRequest: appHandler() });
  });

  afterAll(async () => {
    await open?.close();
    await closed?.close();
  });

  it.runIf(databaseConfigured)('lets an allowed address reach the application', async () => {
    for (const path of GUARDED_PATHS) {
      const response = await get(`${open.url}${path}`);
      expect(response.status, path).toBe(200);
      expect(JSON.parse(response.body).reached, path).toBe(true);
    }
  });

  it.runIf(databaseConfigured)('refuses a denied address on every path', async () => {
    for (const path of GUARDED_PATHS) {
      const response = await get(`${closed.url}${path}`);
      expect(response.status, path).toBe(403);
      // The application handler was never called: the gate answered first.
      expect(response.body, path).not.toContain('"reached"');
    }
  });

  it.runIf(databaseConfigured)('refuses the admin and setup pages like everything else', async () => {
    // Named separately because the brief calls them out separately, and because "the admin token
    // protects /admin" is exactly the reasoning this phase is meant to replace.
    expect((await get(`${closed.url}/admin`)).status).toBe(403);
    expect((await get(`${closed.url}/setup`)).status).toBe(403);
    expect((await get(`${closed.url}/api/admin/devices`)).status).toBe(403);
  });

  it.runIf(databaseConfigured)('refuses attachment upload and download', async () => {
    const upload = await fetch(`${closed.url}/api/conversations/abc/attachments`, {
      method: 'POST',
      body: 'bytes',
    });
    expect(upload.status).toBe(403);
    expect((await get(`${closed.url}/api/attachments/abc/download`)).status).toBe(403);
  });

  /*
   * A copied cookie is not a way in. The gate runs before identity is resolved, so an attachment
   * URL carried outside the company network fails whatever it is carrying.
   */
  it.runIf(databaseConfigured)('refuses a denied address even with a session cookie', async () => {
    const identity = await createTestIdentity('Outside');
    const response = await get(`${closed.url}/api/attachments/abc/download`, {
      cookie: identity.cookie,
    });
    expect(response.status).toBe(403);
  });

  describe('the refusal itself', () => {
    it.runIf(databaseConfigured)('answers JSON for API paths and HTML for pages', async () => {
      const api = await get(`${closed.url}/api/session`);
      expect(api.contentType).toContain('application/json');
      expect(JSON.parse(api.body).error.code).toBe('NETWORK_FORBIDDEN');

      const page = await get(`${closed.url}/`, { accept: 'text/html' });
      expect(page.contentType).toContain('text/html');
      expect(page.body).toContain('Access denied');
    });

    /* A denied client must not be sent somewhere else to try again. */
    it.runIf(databaseConfigured)('is a refusal, never a redirect into setup or sign-in', async () => {
      const response = await fetch(`${closed.url}/`, { redirect: 'manual' });
      expect(response.status).toBe(403);
      expect(response.headers.get('location')).toBeNull();
    });

    /*
     * The response is the same regardless of what was asked for, so an outside client cannot use
     * it to map the application (CLAUDE.md §13).
     */
    it.runIf(databaseConfigured)('leaks no configuration, ranges or internals', async () => {
      const page = await get(`${closed.url}/admin`, { accept: 'text/html' });
      for (const secret of ['10.99.', '127.0.0', 'ALLOWED_NETWORKS', 'postgres', 'company_chat', 'node_modules']) {
        expect(page.body, secret).not.toContain(secret);
      }
    });

    it.runIf(databaseConfigured)('is identical for a real path and a made-up one', async () => {
      const real = await get(`${closed.url}/admin`, { accept: 'text/html' });
      const fake = await get(`${closed.url}/no-such-route-at-all`, { accept: 'text/html' });
      expect(fake.status).toBe(real.status);
      expect(fake.body).toBe(real.body);
    });
  });

  /*
   * With no trusted proxy configured, the header is not read — so this is the end-to-end version
   * of the spoofing test, over a real socket rather than a fabricated header bag.
   */
  it.runIf(databaseConfigured)('ignores a spoofed X-Forwarded-For over a real connection', async () => {
    for (const spoof of ['10.99.0.5', '10.99.0.5, 10.99.0.6', '127.0.0.1']) {
      const response = await get(`${closed.url}/`, { 'x-forwarded-for': spoof });
      expect(response.status, spoof).toBe(403);
    }
    expect((await get(`${closed.url}/`, { 'x-real-ip': '10.99.0.5' })).status).toBe(403);
  });

  /*
   * The mirror image: turning proxy trust ON must not make the loopback peer's own header
   * believable in a way that lets it claim an address outside the allow-list, and must let it
   * claim one inside.
   */
  it.runIf(databaseConfigured)('honours the header only when the peer is a configured proxy', async () => {
    const trusting = await startTestServer({
      gate: gateFor({ allowed: rules('10.99.0.0/24'), trustedProxies: rules('127.0.0.1/32') }),
      onRequest: appHandler(),
    });

    try {
      // The loopback peer IS the trusted proxy here, so its claim is read — and it names an
      // address inside the allow-list, so the request is permitted.
      expect((await get(`${trusting.url}/`, { 'x-forwarded-for': '10.99.0.5' })).status).toBe(200);
      // A claim outside the allow-list is still refused.
      expect((await get(`${trusting.url}/`, { 'x-forwarded-for': '203.0.113.9' })).status).toBe(403);
      // And with no claim at all, the peer's own loopback address is not in the allow-list.
      expect((await get(`${trusting.url}/`)).status).toBe(403);
    } finally {
      await trusting.close();
    }
  });
});

describe('Socket.IO enforcement', () => {
  let open: RunningServer;
  let closed: RunningServer;
  let alice: TestIdentity;
  let bob: TestIdentity;
  let conversationId: string;

  beforeAll(async () => {
    if (!databaseConfigured) return;
    open = await startTestServer({ gate: gateFor(ALLOWS_LOOPBACK) });
    closed = await startTestServer({ gate: gateFor(EXCLUDES_LOOPBACK) });

    alice = await createTestIdentity('NetAlice');
    bob = await createTestIdentity('NetBob');
    conversationId = await createDirectConversation(alice.userId, bob.userId);
  });

  afterAll(async () => {
    await open?.close();
    await closed?.close();
    await cleanUp();
    await disconnectDb();
  });

  it.runIf(databaseConfigured)('lets an allowed address connect', async () => {
    const socket = await connectClient(open.url, alice.cookie);
    expect(socket.connected).toBe(true);
    socket.close();
  });

  /*
   * The handshake is refused before engine.io creates a session, so there is no socket to
   * authenticate — the identity middleware and the database are never reached.
   */
  it.runIf(databaseConfigured)('refuses a denied address, with a valid cookie', async () => {
    await expect(connectClient(closed.url, alice.cookie, { timeoutMs: 3_000 })).rejects.toThrow();
  });

  it.runIf(databaseConfigured)('refuses a denied address that spoofs a forwarding header', async () => {
    await expect(
      connectClient(closed.url, alice.cookie, { timeoutMs: 3_000 }),
    ).rejects.toThrow();
  });

  /*
   * The requirement is not merely that the socket fails, but that nothing leaks through it: no
   * room, no presence, no message.
   *
   * Bob is a real member of the conversation with a valid cookie — the only thing wrong with him
   * is where he is connecting from. So this proves the network gate alone stops a client that
   * every other check in the system would happily admit, while the conversation carries on
   * normally for the member who is allowed in it.
   *
   * The explicit timeout covers a deliberate wait: the refused connection is given 1.5s to fail
   * and the presence window another 400ms, neither of which fits the 5s default alongside the
   * message round trip.
   */
  it.runIf(databaseConfigured)(
    'gives a refused client no socket, no presence and no messages',
    async () => {
      const member = await connectClient(open.url, alice.cookie);

      try {
        const joined = await emitWithAck(member, 'conversation:join', { conversationId });
        expect(joined.ok).toBe(true);

        let outsider: TestClient | null = null;
        await expect(
          connectClient(closed.url, bob.cookie, { timeoutMs: 1_500 }).then((socket) => {
            outsider = socket;
            return socket;
          }),
        ).rejects.toThrow();
        expect(outsider).toBeNull();

        // Bob never became present to anybody, because he never got a socket.
        await expectNoEvent(member, 'presence:update', {
          windowMs: 400,
          filter: (payload) => (payload as { userId?: string }).userId === bob.userId,
        });

        /*
         * And the conversation still works for the member who is allowed in it. The assertion is
         * on the acknowledgement rather than a `message:new` event because the gateway broadcasts
         * with `socket.to(room)`, which excludes the sender — alice's own copy comes back in the
         * ack, and waiting for an event she is deliberately not sent would hang.
         */
        const ack = await emitWithAck<{ id: string }>(member, 'message:send', {
          conversationId,
          body: 'zz-net visible only inside',
          clientMessageId: uuid(),
        });
        expect(ack.ok).toBe(true);
      } finally {
        member.close();
      }
    },
    20_000,
  );
});

describe('the gate itself', () => {
  it('throttles repeated denial logs without throttling the denials', () => {
    const lines: unknown[] = [];
    let clock = 0;

    const gate = createNetworkGate({
      policy: EXCLUDES_LOOPBACK,
      logger: {
        debug: () => {},
        info: () => {},
        warn: (message, context) => lines.push({ message, context }),
        error: () => {},
      },
      logIntervalMs: 1_000,
      now: () => clock,
    });

    // Twenty refusals from one address inside the window.
    for (let index = 0; index < 20; index += 1) {
      expect(gate.check('203.0.113.9', {}, '/').allowed).toBe(false);
    }
    expect(lines).toHaveLength(1);

    // A different address is its own first-time denial, always logged.
    expect(gate.check('203.0.113.10', {}, '/').allowed).toBe(false);
    expect(lines).toHaveLength(2);

    // Past the interval, the address is logged again, with a count of what was suppressed.
    clock += 2_000;
    expect(gate.check('203.0.113.9', {}, '/').allowed).toBe(false);
    expect(lines).toHaveLength(3);
    expect(JSON.stringify(lines[2])).toContain('suppressedSince');
  });

  it('never logs the configured ranges', () => {
    const lines: string[] = [];
    const gate = createNetworkGate({
      policy: EXCLUDES_LOOPBACK,
      logger: {
        debug: () => {},
        info: () => {},
        warn: (message, context) => lines.push(`${message} ${JSON.stringify(context ?? {})}`),
        error: () => {},
      },
    });

    gate.check('203.0.113.9', {}, '/admin');
    expect(lines.join(' ')).not.toContain('10.99.0.0');
  });
});
