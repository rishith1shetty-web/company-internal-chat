/**
 * IP address and CIDR parsing (Phase 8).
 *
 * Pure functions, no configuration and no I/O, so the matching rules can be tested exhaustively
 * on their own. Everything here fails by returning `null` rather than throwing or guessing: an
 * address that cannot be parsed is not "probably fine", it is an address this module refuses to
 * make a claim about, and the caller denies it.
 *
 * WHY NOT A LIBRARY. `ipaddr.js` and `cidr-matcher` do this well, but the whole job is two
 * parsers and a bitmask compare, and a dependency at the centre of an access-control decision is
 * a dependency whose next version silently changes who can reach the application (CLAUDE.md §3).
 * The behaviour is pinned by tests instead.
 *
 * IPv4 and IPv6 are both supported. They are held in one shape — a big-endian integer plus a
 * width — so a single mask comparison serves both.
 */

/** A parsed address: 32-bit for IPv4, 128-bit for IPv6. */
export interface IpAddress {
  readonly bits: 32 | 128;
  readonly value: bigint;
  /** Canonical text, used only for logging. */
  readonly text: string;
}

/** A parsed allow-list entry. A bare address parses to a full-width prefix (/32 or /128). */
export interface CidrRule {
  readonly bits: 32 | 128;
  readonly network: bigint;
  readonly prefix: number;
  /** The rule as written, for diagnostics. Never shown to a client. */
  readonly text: string;
}

const IPV4_GROUPS = 4;
const IPV6_GROUPS = 8;

/**
 * Strips the wrappers Node and operators actually produce, so the parsers below only ever see a
 * bare address:
 *
 *   `[::1]`              a bracketed literal, as it appears in a URL or a Host header
 *   `fe80::1%eth0`       a link-local zone index, which identifies an interface, not an address
 *   `::ffff:192.168.1.5` an IPv4-mapped IPv6 address
 *
 * The last one matters more than it looks. A dual-stack listener reports every IPv4 peer in that
 * form, so a server bound to `::` would see `::ffff:192.168.1.5` where the operator configured
 * `192.168.1.0/24`. Mapping it back to IPv4 here — once, for every caller — is what stops the
 * allow-list silently failing to match the entire company on a dual-stack bind.
 */
function canonicalize(raw: string): string {
  let value = raw.trim();
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);

  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);

  value = value.toLowerCase();

  // `::ffff:1.2.3.4` and the all-hex `::ffff:c0a8:0105` spelling of the same thing.
  if (value.startsWith('::ffff:')) {
    const rest = value.slice('::ffff:'.length);
    if (parseIpv4(rest) !== null) return rest;
  }

  return value;
}

/**
 * Parses dotted-quad IPv4.
 *
 * Leading zeros are REFUSED rather than accepted. `010` is 8 in some resolvers and 10 in others,
 * so an allow-list entry written that way means different things to the parser and to whoever
 * reviews the configuration file — and an access rule that reads differently to a person than it
 * behaves is worse than one that is rejected at startup.
 */
function parseIpv4(value: string): bigint | null {
  const parts = value.split('.');
  if (parts.length !== IPV4_GROUPS) return null;

  let result = 0n;
  for (const part of parts) {
    if (part.length === 0 || part.length > 3) return null;
    if (!/^\d+$/.test(part)) return null;
    if (part.length > 1 && part.startsWith('0')) return null;

    const octet = Number(part);
    if (octet > 255) return null;
    result = (result << 8n) | BigInt(octet);
  }

  return result;
}

/**
 * Parses IPv6, including `::` compression and a trailing embedded IPv4 (`::ffff:1.2.3.4`).
 *
 * Written out rather than delegated to a regular expression: the compression rule ("exactly one
 * `::`, expanding to at least one zero group") is a counting rule, and a regex that enforces it
 * is unreadable enough that nobody would spot an error in it.
 */
function parseIpv6(value: string): bigint | null {
  if (!value.includes(':')) return null;

  // At most one `::`.
  const doubleColonCount = value.split('::').length - 1;
  if (doubleColonCount > 1) return null;

  let head: string;
  let tail: string;
  if (doubleColonCount === 1) {
    const [left = '', right = ''] = value.split('::');
    head = left;
    tail = right;
  } else {
    head = value;
    tail = '';
  }

  const headGroups = head.length > 0 ? head.split(':') : [];
  const tailGroups = tail.length > 0 ? tail.split(':') : [];

  // A trailing dotted-quad occupies the last two 16-bit groups.
  const groups: string[] = [];
  const expand = (source: string[], into: string[]): boolean => {
    for (let index = 0; index < source.length; index += 1) {
      const part = source[index];
      if (part === undefined) return false;

      if (part.includes('.')) {
        // Only ever valid as the final component.
        if (index !== source.length - 1) return false;
        const embedded = parseIpv4(part);
        if (embedded === null) return false;
        into.push(
          ((embedded >> 16n) & 0xffffn).toString(16),
          (embedded & 0xffffn).toString(16),
        );
        continue;
      }

      if (part.length === 0 || part.length > 4) return false;
      if (!/^[0-9a-f]+$/.test(part)) return false;
      into.push(part);
    }
    return true;
  };

  const headParsed: string[] = [];
  const tailParsed: string[] = [];
  if (!expand(headGroups, headParsed)) return null;
  if (!expand(tailGroups, tailParsed)) return null;

  if (doubleColonCount === 0) {
    if (headParsed.length !== IPV6_GROUPS) return null;
    groups.push(...headParsed);
  } else {
    const missing = IPV6_GROUPS - headParsed.length - tailParsed.length;
    // `::` must stand for at least one group, otherwise the address is simply over-long.
    if (missing < 1) return null;
    groups.push(...headParsed, ...Array(missing).fill('0'), ...tailParsed);
  }

  let result = 0n;
  for (const group of groups) {
    result = (result << 16n) | BigInt(`0x${group}`);
  }
  return result;
}

/** Parses an address of either family, or returns null. Never throws. */
export function parseIp(raw: string | undefined | null): IpAddress | null {
  if (typeof raw !== 'string') return null;

  const value = canonicalize(raw);
  if (value.length === 0) return null;

  const asIpv4 = parseIpv4(value);
  if (asIpv4 !== null) return { bits: 32, value: asIpv4, text: value };

  const asIpv6 = parseIpv6(value);
  if (asIpv6 !== null) return { bits: 128, value: asIpv6, text: value };

  return null;
}

/**
 * Parses one allow-list entry: `192.168.1.0/24`, `10.0.0.5`, `::1`, `fd00::/8`.
 *
 * A bare address becomes a full-width prefix, so "one address" and "a range" are the same kind of
 * rule downstream and there is no second matching path to get wrong.
 *
 * HOST BITS MUST BE ZERO. `192.168.1.5/24` is refused rather than quietly widened to
 * `192.168.1.0/24`: the two readings differ by 255 hosts, and an operator who wrote the first
 * meaning the second should be told at startup, not discover it from who got in.
 */
export function parseCidr(raw: string | undefined | null): CidrRule | null {
  if (typeof raw !== 'string') return null;

  const text = raw.trim();
  if (text.length === 0) return null;

  const slash = text.indexOf('/');
  if (slash === -1) {
    const address = parseIp(text);
    if (!address) return null;
    return { bits: address.bits, network: address.value, prefix: address.bits, text };
  }

  const addressPart = text.slice(0, slash);
  const prefixPart = text.slice(slash + 1);

  const address = parseIp(addressPart);
  if (!address) return null;

  if (!/^\d{1,3}$/.test(prefixPart)) return null;
  const prefix = Number(prefixPart);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > address.bits) return null;

  const network = maskOf(address.value, address.bits, prefix);
  if (network !== address.value) return null;

  return { bits: address.bits, network, prefix, text };
}

function maskOf(value: bigint, bits: 32 | 128, prefix: number): bigint {
  if (prefix === 0) return 0n;
  const hostBits = BigInt(bits - prefix);
  return (value >> hostBits) << hostBits;
}

/**
 * Is this address inside this rule?
 *
 * Families never match across: an IPv6 address does not fall inside an IPv4 range, and the
 * IPv4-mapped case that looks like it should was already turned back into IPv4 by `parseIp`.
 */
export function ipMatches(address: IpAddress, rule: CidrRule): boolean {
  if (address.bits !== rule.bits) return false;
  return maskOf(address.value, address.bits, rule.prefix) === rule.network;
}

/** Is this address inside any of these rules? An empty rule set matches nothing. */
export function ipMatchesAny(address: IpAddress, rules: readonly CidrRule[]): boolean {
  return rules.some((rule) => ipMatches(address, rule));
}

/**
 * Parses a comma-separated list, reporting every bad entry rather than the first.
 *
 * Both halves are returned. The caller decides what a malformed entry means, and in this
 * application it means the process does not start — an allow-list that silently dropped the one
 * range it could not parse would be a smaller allow-list than the operator wrote, which is the
 * failure that locks out a company on a Monday morning.
 */
export function parseCidrList(raw: string): { rules: CidrRule[]; invalid: string[] } {
  const rules: CidrRule[] = [];
  const invalid: string[] = [];

  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;

    const rule = parseCidr(trimmed);
    if (rule) rules.push(rule);
    else invalid.push(trimmed);
  }

  return { rules, invalid };
}

/** Loopback, both families. The default policy in development, and never assumed in production. */
export const LOOPBACK_RULES: readonly CidrRule[] = Object.freeze(
  ['127.0.0.0/8', '::1/128'].map((entry) => {
    const rule = parseCidr(entry);
    /* istanbul ignore next -- these two literals are constant and parse by construction. */
    if (!rule) throw new Error(`Unparsable built-in rule: ${entry}`);
    return rule;
  }),
);
