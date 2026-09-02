/**
 * The network gate (Phase 8) — the single place a request is refused for coming from the wrong
 * network.
 *
 * There are exactly two enforcement points in this application, and both call into this module:
 *
 *   server.ts          every HTTP request Next.js would serve — pages, API routes, uploads,
 *                      downloads, /admin, /setup, everything.
 *   realtime/gateway   every Socket.IO handshake, via engine.io's `allowRequest`.
 *
 * BOTH ARE REQUIRED, and the reason is not defence in depth. `engine.io` caches and removes the
 * HTTP server's `request` listeners when it attaches, then calls them only for requests it does
 * not want itself (engine.io/build/server.js, `attach()`). Socket.IO's polling transport
 * therefore never reaches the listener in `server.ts`. A gate written only there would leave the
 * entire real-time surface open, and would look completely correct while doing so.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Logger } from '../logging/logger';
import { decideAccess, type AccessDecision, type NetworkPolicy } from './policy';

/**
 * How often a repeat denial from the same address is logged.
 *
 * A port scanner or a misconfigured monitor can produce thousands of refused requests a minute,
 * and one log line each would turn a denial into a disk-space problem (CLAUDE.md §14: avoid
 * excessive logging). The first denial from an address is always logged; further ones are
 * summarised on the next line after this interval.
 *
 * This throttles LOG LINES, not requests. Every request is still evaluated and refused; nothing
 * here rate-limits traffic, which is Phase 9's subject and deliberately not started.
 */
const DENIAL_LOG_INTERVAL_MS = 60_000;

/** Bounded so a spray of unique source addresses cannot grow this map without limit. */
const DENIAL_LOG_MAX_TRACKED = 512;

interface DenialRecord {
  lastLoggedAt: number;
  suppressed: number;
}

export interface NetworkGate {
  /** Decides, logs, and reports. Does not write a response — the caller chooses the shape. */
  check(remoteAddress: string | undefined | null, headers: IncomingMessage['headers'], path: string): AccessDecision;
  /** Refuses an ordinary HTTP request with a safe 403. */
  denyHttp(req: IncomingMessage, res: ServerResponse): void;
}

export interface GateOptions {
  policy: NetworkPolicy;
  logger: Logger;
  /** Overridable for tests, which must not wait a minute to observe throttling. */
  logIntervalMs?: number;
  now?: () => number;
}

export function createNetworkGate(options: GateOptions): NetworkGate {
  const { policy, logger } = options;
  const interval = options.logIntervalMs ?? DENIAL_LOG_INTERVAL_MS;
  const now = options.now ?? (() => Date.now());

  const denials = new Map<string, DenialRecord>();

  function noteDenial(decision: AccessDecision, path: string): void {
    const key = decision.address ?? '<unresolved>';
    const timestamp = now();
    const existing = denials.get(key);

    if (existing && timestamp - existing.lastLoggedAt < interval) {
      existing.suppressed += 1;
      return;
    }

    if (denials.size >= DENIAL_LOG_MAX_TRACKED && !existing) denials.clear();

    logger.warn('Request refused: outside the permitted network', {
      // The client's own address, which it already knows, and the path it asked for. The
      // configured ranges are NOT logged here — a log line is not the place to publish the
      // allow-list (CLAUDE.md §14).
      address: key,
      source: decision.source,
      path,
      ...(existing && existing.suppressed > 0 ? { suppressedSince: existing.suppressed } : {}),
    });

    denials.set(key, { lastLoggedAt: timestamp, suppressed: 0 });
  }

  return {
    check(remoteAddress, headers, path) {
      const decision = decideAccess(policy, remoteAddress, headers);
      if (!decision.allowed) noteDenial(decision, path);
      return decision;
    },

    denyHttp(req, res) {
      writeDenial(req, res);
    },
  };
}

/**
 * The refusal.
 *
 * 403 and nothing else. It does not say which ranges are permitted, what the server is, or
 * whether the path exists — the answer is identical for `/`, `/admin`, a real attachment id and
 * a made-up one, so an outside client learns only that it is not allowed to be here
 * (CLAUDE.md §13).
 *
 * It is never a redirect. Sending a denied client to /setup or a sign-in page would advertise
 * those routes and invite a second attempt at them.
 */
function writeDenial(req: IncomingMessage, res: ServerResponse): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }

  const wantsHtml = expectsHtml(req);

  res.statusCode = 403;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Nothing on this page is a link and nothing loads: a denied client cannot fetch the
  // stylesheet, the logo or anything else through this same gate, so the page is self-contained.
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");

  if (wantsHtml) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(DENIED_PAGE);
    return;
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(
    JSON.stringify({
      error: { code: 'NETWORK_FORBIDDEN', message: 'This application is not available from your network.' },
    }),
  );
}

function expectsHtml(req: IncomingMessage): boolean {
  const url = req.url ?? '';
  // API and socket paths always answer JSON, whatever the Accept header says, so a fetch() gets
  // a parseable body rather than a page.
  if (url.startsWith('/api/') || url.startsWith('/socket.io')) return false;

  const accept = req.headers.accept;
  const value = Array.isArray(accept) ? accept.join(',') : (accept ?? '');
  return value.includes('text/html');
}

/**
 * The denied page.
 *
 * Branded only as far as a colour and a typeface: the company logo is served from the same
 * origin behind the same gate, so an <img> here would be refused and render as a broken image —
 * worse than no logo. Inline, self-contained, no requests, and no detail about the server.
 */
const DENIED_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Access denied</title>
<style>
  :root { color-scheme: light }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #f6f2ec; color: #23180e; padding: 24px;
    font: 16px/1.5 ui-sans-serif, system-ui, "Segoe UI", Roboto, Arial, sans-serif;
  }
  main {
    max-width: 26rem; background: #fff; border: 1px solid #e8dfd2; border-radius: 18px;
    padding: 32px; box-shadow: 0 2px 8px -2px rgba(64,43,20,.08);
  }
  .rule { height: 4px; border-radius: 2px; margin-bottom: 24px;
          background: linear-gradient(90deg,#a8682b,#f0a018 60%,#f8c810) }
  h1 { margin: 0 0 8px; font-size: 1.125rem; letter-spacing: -.01em }
  p { margin: 0; color: #5c4b3a; font-size: .9375rem }
</style>
</head>
<body>
<main>
  <div class="rule"></div>
  <h1>Access denied</h1>
  <p>This application is only available from the company network. If you are on a company
     computer and seeing this, contact IT.</p>
</main>
</body>
</html>
`;
