/**
 * Phase 8 — IP and CIDR matching.
 *
 * Pure functions with no database and no server, so these run everywhere and are the place to be
 * exhaustive. Everything an access decision rests on is decided here; if this file is wrong, the
 * gate is wrong no matter how carefully it is wired.
 */

import { describe, expect, it } from 'vitest';

import {
  LOOPBACK_RULES,
  ipMatches,
  ipMatchesAny,
  parseCidr,
  parseCidrList,
  parseIp,
} from '@/lib/net/ip';

/** Parses, asserting success — the tests below are about matching, not about parse failure. */
function ip(value: string) {
  const parsed = parseIp(value);
  expect(parsed, `expected "${value}" to parse`).not.toBeNull();
  return parsed!;
}

function cidr(value: string) {
  const parsed = parseCidr(value);
  expect(parsed, `expected "${value}" to parse`).not.toBeNull();
  return parsed!;
}

describe('parsing IPv4', () => {
  it('accepts dotted quads', () => {
    expect(parseIp('192.168.1.5')?.bits).toBe(32);
    expect(parseIp('0.0.0.0')?.value).toBe(0n);
    expect(parseIp('255.255.255.255')?.value).toBe(4_294_967_295n);
  });

  it('refuses out-of-range octets and wrong shapes', () => {
    for (const bad of ['256.0.0.1', '1.2.3', '1.2.3.4.5', '1.2.3.-1', '1.2.3.a', '', '   ']) {
      expect(parseIp(bad), bad).toBeNull();
    }
  });

  /*
   * `010` is 8 to anything that reads it as octal and 10 to anything that does not. An allow-list
   * entry that means different things to the parser and to the person reviewing the file is worse
   * than one that is rejected outright.
   */
  it('refuses leading zeros rather than guessing octal or decimal', () => {
    expect(parseIp('010.0.0.1')).toBeNull();
    expect(parseIp('192.168.01.5')).toBeNull();
    expect(parseIp('0.0.0.0')).not.toBeNull();
  });
});

describe('parsing IPv6', () => {
  it('accepts full, compressed and loopback forms', () => {
    expect(parseIp('::1')?.bits).toBe(128);
    expect(parseIp('fe80::1')?.bits).toBe(128);
    expect(parseIp('2001:0db8:0000:0000:0000:0000:0000:0001')?.value).toBe(
      parseIp('2001:db8::1')?.value,
    );
  });

  it('refuses more than one :: and over-long addresses', () => {
    expect(parseIp('2001::db8::1')).toBeNull();
    expect(parseIp('1:2:3:4:5:6:7:8:9')).toBeNull();
    expect(parseIp('1:2:3:4:5:6:7')).toBeNull();
    // `::` must stand for at least one group; eight groups plus a `::` is over-long.
    expect(parseIp('1:2:3:4:5:6:7:8::')).toBeNull();
  });

  it('strips a zone index, which names an interface rather than an address', () => {
    expect(parseIp('fe80::1%eth0')?.value).toBe(parseIp('fe80::1')?.value);
  });

  it('accepts a bracketed literal, as it appears in a URL or Host header', () => {
    expect(parseIp('[::1]')?.value).toBe(parseIp('::1')?.value);
  });
});

/*
 * The case that silently breaks an allow-list in production.
 *
 * A server bound to `::` reports every IPv4 peer as `::ffff:192.168.1.5`. Without this mapping,
 * an operator who configured `192.168.1.0/24` would find that it matched nobody at all.
 */
describe('IPv4-mapped IPv6', () => {
  it('is treated as the IPv4 address it is', () => {
    const mapped = ip('::ffff:192.168.1.5');
    expect(mapped.bits).toBe(32);
    expect(ipMatches(mapped, cidr('192.168.1.0/24'))).toBe(true);
  });

  it('maps loopback too, so a dual-stack dev bind still matches 127.0.0.0/8', () => {
    expect(ipMatchesAny(ip('::ffff:127.0.0.1'), LOOPBACK_RULES)).toBe(true);
  });
});

describe('CIDR rules', () => {
  it('parses a range and a bare address alike', () => {
    expect(cidr('192.168.1.0/24').prefix).toBe(24);
    // A bare address is a full-width prefix, so there is only one matching path downstream.
    expect(cidr('10.0.0.5').prefix).toBe(32);
    expect(cidr('::1').prefix).toBe(128);
  });

  /*
   * `192.168.1.5/24` could mean the host or the range; the two differ by 255 machines. Refusing
   * it makes the operator write which one they meant.
   */
  it('refuses a range whose host bits are set rather than widening it', () => {
    expect(parseCidr('192.168.1.5/24')).toBeNull();
    expect(parseCidr('192.168.1.0/24')).not.toBeNull();
  });

  it('refuses malformed and out-of-range prefixes', () => {
    for (const bad of ['192.168.1.0/33', '192.168.1.0/-1', '192.168.1.0/', '192.168.1.0/aa', '/24', '::1/129']) {
      expect(parseCidr(bad), bad).toBeNull();
    }
  });

  it('accepts /0 as the explicit "everything" rule', () => {
    // Not recommended, but it is a legitimate thing to write and must not silently mean something
    // else. An operator who writes it has said what they meant.
    expect(ipMatches(ip('8.8.8.8'), cidr('0.0.0.0/0'))).toBe(true);
  });
});

describe('matching', () => {
  it('matches inside a range and refuses outside it', () => {
    const range = cidr('192.168.1.0/24');
    expect(ipMatches(ip('192.168.1.1'), range)).toBe(true);
    expect(ipMatches(ip('192.168.1.255'), range)).toBe(true);
    expect(ipMatches(ip('192.168.2.1'), range)).toBe(false);
    expect(ipMatches(ip('192.167.1.1'), range)).toBe(false);
  });

  it('respects range boundaries exactly', () => {
    const range = cidr('10.1.2.0/23');
    expect(ipMatches(ip('10.1.1.255'), range)).toBe(false);
    expect(ipMatches(ip('10.1.2.0'), range)).toBe(true);
    expect(ipMatches(ip('10.1.3.255'), range)).toBe(true);
    expect(ipMatches(ip('10.1.4.0'), range)).toBe(false);
  });

  it('matches an exact address rule and nothing adjacent', () => {
    const exact = cidr('10.0.0.5');
    expect(ipMatches(ip('10.0.0.5'), exact)).toBe(true);
    expect(ipMatches(ip('10.0.0.6'), exact)).toBe(false);
  });

  it('never matches across address families', () => {
    expect(ipMatches(ip('::1'), cidr('0.0.0.0/0'))).toBe(false);
    expect(ipMatches(ip('127.0.0.1'), cidr('::/0'))).toBe(false);
  });

  it('matches IPv6 ranges', () => {
    expect(ipMatches(ip('fd00::1234'), cidr('fd00::/8'))).toBe(true);
    expect(ipMatches(ip('fe00::1'), cidr('fd00::/8'))).toBe(false);
  });

  it('matches nothing when the rule set is empty', () => {
    expect(ipMatchesAny(ip('192.168.1.1'), [])).toBe(false);
  });

  it('treats loopback as loopback in both families', () => {
    expect(ipMatchesAny(ip('127.0.0.1'), LOOPBACK_RULES)).toBe(true);
    expect(ipMatchesAny(ip('127.1.2.3'), LOOPBACK_RULES)).toBe(true);
    expect(ipMatchesAny(ip('::1'), LOOPBACK_RULES)).toBe(true);
    expect(ipMatchesAny(ip('192.168.1.1'), LOOPBACK_RULES)).toBe(false);
  });
});

describe('parsing a configured list', () => {
  it('reads several entries and ignores whitespace and empty slots', () => {
    const { rules, invalid } = parseCidrList(' 192.168.1.0/24 , 10.0.0.0/8 ,, ::1 ');
    expect(rules).toHaveLength(3);
    expect(invalid).toEqual([]);
  });

  /*
   * Reported rather than dropped. A silently narrower allow-list than the operator wrote is the
   * failure that presents as an outage on a Monday morning instead of as a configuration error
   * at startup.
   */
  it('reports every malformed entry instead of skipping it', () => {
    const { rules, invalid } = parseCidrList('192.168.1.0/24, not-an-ip, 10.0.0.0/33');
    expect(rules).toHaveLength(1);
    expect(invalid).toEqual(['not-an-ip', '10.0.0.0/33']);
  });

  it('returns nothing at all for an empty setting', () => {
    expect(parseCidrList('   ').rules).toEqual([]);
    expect(parseCidrList(',,,').rules).toEqual([]);
  });
});
