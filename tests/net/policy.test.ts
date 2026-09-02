/**
 * Phase 8 — client address resolution and the proxy trust rule.
 *
 * This is the file that decides whether the allow-list is an allow-list or a suggestion. Every
 * test here is about one question: can something a client typed change the answer?
 */

import { describe, expect, it } from 'vitest';

import { parseCidr, type CidrRule } from '@/lib/net/ip';
import { decideAccess, resolveClientAddress, trustsProxyHeaders, type NetworkPolicy } from '@/lib/net/policy';

function rules(...entries: string[]): CidrRule[] {
  return entries.map((entry) => {
    const rule = parseCidr(entry);
    expect(rule, entry).not.toBeNull();
    return rule!;
  });
}

const COMPANY = '192.168.1.0/24';

/** The V1 shape: employees reach the Node process directly, no proxy anywhere. */
const directPolicy: NetworkPolicy = {
  allowed: rules(COMPANY),
  trustedProxies: [],
};

/** The optional shape: one proxy on the server itself, explicitly vouched for. */
const proxiedPolicy: NetworkPolicy = {
  allowed: rules(COMPANY),
  trustedProxies: rules('127.0.0.1/32'),
};

describe('the default posture', () => {
  it('does not consult forwarding headers when no proxy is configured', () => {
    expect(trustsProxyHeaders(directPolicy)).toBe(false);
    expect(trustsProxyHeaders(proxiedPolicy)).toBe(true);
  });

  it('uses the socket address', () => {
    const resolved = resolveClientAddress(directPolicy, '192.168.1.50', {});
    expect(resolved?.address.text).toBe('192.168.1.50');
    expect(resolved?.source).toBe('socket');
  });
});

/*
 * THE ATTACK THIS PHASE EXISTS TO STOP.
 *
 * An outside client sends `X-Forwarded-For: 192.168.1.50` and asks to be treated as if it were
 * inside the company. With no trusted proxy configured — the default and the V1 deployment — the
 * header is not read at all, so there is nothing to spoof.
 */
describe('spoofed forwarding headers, with proxy trust disabled', () => {
  const spoofs = {
    'x-forwarded-for': '192.168.1.50',
    'x-real-ip': '192.168.1.50',
    forwarded: 'for=192.168.1.50',
  };

  it('ignores them entirely and uses the real peer', () => {
    const resolved = resolveClientAddress(directPolicy, '203.0.113.9', spoofs);
    expect(resolved?.address.text).toBe('203.0.113.9');
    expect(resolved?.source).toBe('socket');
  });

  it('so an outside client claiming a company address is still denied', () => {
    const decision = decideAccess(directPolicy, '203.0.113.9', spoofs);
    expect(decision.allowed).toBe(false);
    expect(decision.address).toBe('203.0.113.9');
  });

  it('and a company client is allowed on its socket address alone', () => {
    expect(decideAccess(directPolicy, '192.168.1.50', {}).allowed).toBe(true);
  });
});

describe('forwarding headers, with a trusted proxy configured', () => {
  it('honours the header when the immediate peer is the trusted proxy', () => {
    const resolved = resolveClientAddress(proxiedPolicy, '127.0.0.1', {
      'x-forwarded-for': '192.168.1.50',
    });
    expect(resolved?.address.text).toBe('192.168.1.50');
    expect(resolved?.source).toBe('forwarded');
    expect(decideAccess(proxiedPolicy, '127.0.0.1', { 'x-forwarded-for': '192.168.1.50' }).allowed).toBe(true);
  });

  /*
   * Trust is per-peer, not global. Switching header support on for the proxy on localhost must
   * not make every other host's headers believable — otherwise configuring a proxy would open
   * the spoof back up for anybody who can reach the port directly.
   */
  it('ignores the header when the peer is NOT a trusted proxy', () => {
    const resolved = resolveClientAddress(proxiedPolicy, '203.0.113.9', {
      'x-forwarded-for': '192.168.1.50',
    });
    expect(resolved?.address.text).toBe('203.0.113.9');
    expect(resolved?.source).toBe('socket');
    expect(decideAccess(proxiedPolicy, '203.0.113.9', { 'x-forwarded-for': '192.168.1.50' }).allowed).toBe(false);
  });

  it('refuses a client the header says is outside, even via a trusted proxy', () => {
    expect(decideAccess(proxiedPolicy, '127.0.0.1', { 'x-forwarded-for': '203.0.113.9' }).allowed).toBe(false);
  });

  /*
   * The classic bug, tested from the attacker's side.
   *
   * With an appending proxy the header becomes "<what the client sent>, <what the proxy saw>".
   * Reading it left to right hands the decision to the client. Reading right to left, peeling off
   * addresses we ourselves trust, gives the address the nearest proxy actually observed.
   */
  it('reads right to left, so a client-supplied prefix cannot win', () => {
    const resolved = resolveClientAddress(proxiedPolicy, '127.0.0.1', {
      'x-forwarded-for': '192.168.1.50, 203.0.113.9',
    });
    expect(resolved?.address.text).toBe('203.0.113.9');
    expect(decideAccess(proxiedPolicy, '127.0.0.1', {
      'x-forwarded-for': '192.168.1.50, 203.0.113.9',
    }).allowed).toBe(false);
  });

  it('peels off chained trusted proxies to find the first address that is not one of ours', () => {
    const chained: NetworkPolicy = {
      allowed: rules(COMPANY),
      trustedProxies: rules('127.0.0.1/32', '10.10.0.0/16'),
    };
    const resolved = resolveClientAddress(chained, '127.0.0.1', {
      'x-forwarded-for': '192.168.1.50, 10.10.0.7',
    });
    expect(resolved?.address.text).toBe('192.168.1.50');
    expect(resolved?.source).toBe('forwarded');
  });

  it('collapses a repeated header in the order it arrived', () => {
    const resolved = resolveClientAddress(proxiedPolicy, '127.0.0.1', {
      'x-forwarded-for': ['192.168.1.50', '203.0.113.9'],
    });
    expect(resolved?.address.text).toBe('203.0.113.9');
  });

  /*
   * Junk stops the walk rather than being skipped. Skipping it would let a client insert an
   * unparsable hop to push the scan further left, into a value it wrote itself.
   */
  it('falls back to the peer when a hop is unparsable, rather than scanning past it', () => {
    const resolved = resolveClientAddress(proxiedPolicy, '127.0.0.1', {
      'x-forwarded-for': '192.168.1.50, garbage',
    });
    expect(resolved?.address.text).toBe('127.0.0.1');
    expect(resolved?.source).toBe('socket');
  });

  it('falls back to the peer when the header is present but empty', () => {
    const resolved = resolveClientAddress(proxiedPolicy, '127.0.0.1', { 'x-forwarded-for': '  ' });
    expect(resolved?.address.text).toBe('127.0.0.1');
    expect(resolved?.source).toBe('socket');
  });

  it('uses the proxy itself when every hop is a trusted proxy', () => {
    const resolved = resolveClientAddress(proxiedPolicy, '127.0.0.1', {
      'x-forwarded-for': '127.0.0.1',
    });
    expect(resolved?.address.text).toBe('127.0.0.1');
    expect(resolved?.source).toBe('socket');
  });

  /*
   * RFC 7239 `Forwarded` is deliberately not parsed. Supporting a third spelling of the same
   * claim is a third chance to disagree about which one wins; an unparsed header is ignored.
   */
  it('does not read the RFC 7239 Forwarded header', () => {
    const resolved = resolveClientAddress(proxiedPolicy, '127.0.0.1', {
      forwarded: 'for=192.168.1.50',
    });
    expect(resolved?.address.text).toBe('127.0.0.1');
  });
});

describe('addresses that cannot be established', () => {
  it('denies rather than passes when there is no peer address', () => {
    for (const missing of [undefined, null, '', 'not-an-ip']) {
      const decision = decideAccess(directPolicy, missing, {});
      expect(decision.allowed, String(missing)).toBe(false);
      expect(decision.address).toBeNull();
    }
  });
});

describe('an empty allow-list', () => {
  it('denies everyone, including loopback', () => {
    const closed: NetworkPolicy = { allowed: [], trustedProxies: [] };
    expect(decideAccess(closed, '127.0.0.1', {}).allowed).toBe(false);
    expect(decideAccess(closed, '192.168.1.50', {}).allowed).toBe(false);
  });
});
