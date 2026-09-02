/**
 * Network access policy (Phase 8): who is allowed to reach this application, and how the
 * application decides where a request came from.
 *
 * Two separate questions, deliberately in one file, because getting the second one wrong makes
 * the first one meaningless:
 *
 *   1. Is this address inside ALLOWED_NETWORKS?          — `isAllowed`
 *   2. Which address is "this address"?                  — `resolveClientAddress`
 *
 * An allow-list checked against an address the client chose is not an allow-list. That is the
 * whole risk in this phase, and it is why the header path below is off unless an operator has
 * explicitly named the proxies whose word is worth taking.
 */

import {
  ipMatchesAny,
  parseIp,
  type CidrRule,
  type IpAddress,
} from './ip';

export interface NetworkPolicy {
  /** Ranges permitted to reach the application. Never empty — an empty policy denies everyone. */
  readonly allowed: readonly CidrRule[];
  /**
   * Peers whose forwarding headers are believed. Empty means forwarding headers are ignored
   * completely, which is the default and the correct setting for a server on the LAN.
   */
  readonly trustedProxies: readonly CidrRule[];
}

/** Where a resolved client address came from. Recorded so a denial log is diagnosable. */
export type AddressSource = 'socket' | 'forwarded';

export interface ResolvedAddress {
  readonly address: IpAddress;
  readonly source: AddressSource;
}

/**
 * The forwarding headers this application understands.
 *
 * `Forwarded` (RFC 7239) is deliberately NOT parsed. Supporting three spellings of the same
 * claim means three chances to disagree about which one wins, and nothing in this deployment
 * emits it. An unparsed header is ignored, never trusted.
 */
const FORWARDED_FOR_HEADER = 'x-forwarded-for';

export function isAllowed(policy: NetworkPolicy, address: IpAddress): boolean {
  return ipMatchesAny(address, policy.allowed);
}

/** Whether forwarding headers are consulted at all. False unless proxies were configured. */
export function trustsProxyHeaders(policy: NetworkPolicy): boolean {
  return policy.trustedProxies.length > 0;
}

function headerValue(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | undefined {
  const raw = headers[name];
  if (raw === undefined) return undefined;
  // Node collapses repeated headers into an array; join them in the order received, which is the
  // same order a single appended header would have had.
  return Array.isArray(raw) ? raw.join(',') : raw;
}

/**
 * Works out the client address for a request.
 *
 * THE RULE, stated before the code because the code is short and the rule is the point:
 *
 *   - The socket's peer address is the only thing the network itself guarantees. It is the
 *     default answer and, with no trusted proxy configured, the ONLY answer.
 *   - `X-Forwarded-For` is a string the sender typed. It is consulted only when the immediate
 *     peer is itself a configured trusted proxy — that is, only when something the operator
 *     vouched for is the thing that wrote it.
 *   - Even then, entries are read from the RIGHT. The rightmost entry was appended by the
 *     nearest proxy and is the only one it observed directly; everything further left was
 *     supplied by whatever came before, ending in a value the original client controls. So
 *     trusted proxies are peeled off the right-hand end, and the first address that is not a
 *     trusted proxy is the client.
 *
 * Reading from the LEFT instead is the classic version of this bug: a client that sends
 * `X-Forwarded-For: 192.168.1.10` picks its own company address, and the allow-list is bypassed
 * by one header. The right-to-left walk is the reason that cannot happen here.
 *
 * Returns null when no usable address could be determined at all — a caller must treat that as
 * a denial, never as a pass.
 */
export function resolveClientAddress(
  policy: NetworkPolicy,
  remoteAddress: string | undefined | null,
  headers: Readonly<Record<string, string | string[] | undefined>> = {},
): ResolvedAddress | null {
  const peer = parseIp(remoteAddress);
  if (!peer) return null;

  // No trusted proxy configured: headers are not read, so nothing a client sends can influence
  // the decision. This is the default and the V1 deployment shape.
  if (!trustsProxyHeaders(policy)) {
    return { address: peer, source: 'socket' };
  }

  // The peer is not one of ours, so its claims about other addresses are worth nothing — even
  // though header trust is switched on generally.
  if (!ipMatchesAny(peer, policy.trustedProxies)) {
    return { address: peer, source: 'socket' };
  }

  const forwarded = headerValue(headers, FORWARDED_FOR_HEADER);
  if (forwarded === undefined) {
    // A trusted proxy that forwarded nothing. Its own address is the best available answer.
    return { address: peer, source: 'socket' };
  }

  const hops = forwarded
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  // Walk right to left, discarding proxies we put there ourselves.
  for (let index = hops.length - 1; index >= 0; index -= 1) {
    const candidate = parseIp(hops[index]);
    // An unparsable hop stops the walk. Skipping it would let a client insert junk to push the
    // scan further left, into a value it wrote.
    if (!candidate) return { address: peer, source: 'socket' };

    if (!ipMatchesAny(candidate, policy.trustedProxies)) {
      return { address: candidate, source: 'forwarded' };
    }
  }

  // Every hop was a trusted proxy: the request originated inside our own proxy chain.
  return { address: peer, source: 'socket' };
}

/** Convenience for the enforcement points: resolve, then decide. */
export interface AccessDecision {
  readonly allowed: boolean;
  /** Canonical text of the address the decision was made about, or null when unresolvable. */
  readonly address: string | null;
  readonly source: AddressSource | null;
}

export function decideAccess(
  policy: NetworkPolicy,
  remoteAddress: string | undefined | null,
  headers: Readonly<Record<string, string | string[] | undefined>> = {},
): AccessDecision {
  const resolved = resolveClientAddress(policy, remoteAddress, headers);

  // Unresolvable address: denied. A request whose origin cannot be established is exactly the
  // request an allow-list exists to refuse.
  if (!resolved) return { allowed: false, address: null, source: null };

  return {
    allowed: isAllowed(policy, resolved.address),
    address: resolved.address.text,
    source: resolved.source,
  };
}
