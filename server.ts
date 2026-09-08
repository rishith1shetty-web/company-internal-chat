/**
 * Custom HTTP server for the Company Internal Chat application.
 *
 * This file is the project's intentional architectural decision D-09 (see
 * docs/01-architecture.md §3): one Node process, one port, serving both the Next.js
 * application and — from Phase 4 — the Socket.IO gateway.
 *
 * The reason it exists: Next.js route handlers are request/response scoped and cannot host a
 * long-lived WebSocket server, and `next start` offers no hook to attach one. Creating the
 * `http.Server` here means Socket.IO can later attach to the very same server instance, so
 * the browser talks to a single origin and the session cookie applies to both transports
 * without any CORS handling.
 *
 * PHASE 1 SCOPE: process lifecycle only — configuration, Next.js request handling, logging,
 * error handling and graceful shutdown. There is no Socket.IO, no chat, no session handling
 * and no database access here yet. The attach point for Phase 4 is marked below.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import next from 'next';

import { assertNetworkPolicyConfigured, loadConfig, ConfigError } from './lib/config/env';
import { disconnectDb, getDb } from './lib/db/prisma';
import { createLogger, describeError, type Logger } from './lib/logging/logger';
import { createNetworkGate } from './lib/net/gate';
import { createRateLimiter, type RateLimitRule } from './lib/http/rate-limit';
import {
  bodyLimitFor,
  guardedEndpointFor,
  isSameOriginWrite,
  isUnsafeMethod,
  normalisePath,
  type GuardedEndpoint,
} from './lib/http/request-guard';
import { SOCKET_PATH } from './lib/realtime/events';
import { createRealtimeGateway, type RealtimeGateway } from './lib/realtime/gateway';

/** Time to wait for in-flight requests to finish before forcing exit. */
const SHUTDOWN_GRACE_MS = 10_000;

/**
 * How hard the two secret-guessing endpoints may be guessed at (Phase 9).
 *
 * Both were explicitly deferred to this phase by the code they protect — see the notes in
 * `lib/auth/admin.ts` and `app/api/enroll/route.ts`.
 *
 * The numbers are set by what a PERSON does, not by what sounds strict. An administrator typing a
 * long random token will occasionally mistype it; ten attempts in a quarter of an hour is far more
 * room than that needs, and still leaves an attacker under a thousand guesses a day against a
 * 24-character minimum secret. Setting it to three would lock out a real administrator on a bad
 * morning — an outage caused by a security control, which is the failure mode that makes people
 * switch security controls off.
 *
 * Enrollment is more generous because the code is read off one screen and typed on another, with
 * dashes that may or may not be included, so a mistyped attempt or two is ordinary. The code
 * carries ~98 bits, so the limit is not what makes guessing hopeless — it is what stops the
 * endpoint being hammered, and what puts the attempt in the log.
 */
const RATE_LIMITS: Record<GuardedEndpoint, RateLimitRule> = {
  'admin-sign-in': { limit: 10, windowMs: 15 * 60_000, blockMs: 15 * 60_000 },
  'device-enrollment': { limit: 20, windowMs: 15 * 60_000, blockMs: 15 * 60_000 },
};

/** How often a repeat throttling event from one address is logged. Same budget logic as the gate. */
const THROTTLE_LOG_INTERVAL_MS = 60_000;

async function main(): Promise<void> {
  // Load `.env` before reading configuration.
  //
  // Next.js loads env files for the application itself, but it does so during `app.prepare()` —
  // after this process has already read PORT, APP_URL and DATABASE_URL. Loading here means the
  // custom server honours `.env` too, which it previously did not. Node's built-in loader is
  // used rather than adding `dotenv` (CLAUDE.md §3); a missing file is normal and not an error.
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env on this machine: every setting has a safe default, and the database is optional.
  }

  const config = loadConfig();

  /*
   * Fail closed before anything else happens (Phase 8).
   *
   * Checked here rather than inside `loadConfig` because `next build` evaluates route modules —
   * and therefore the configuration — with NODE_ENV=production, and a build machine has no
   * business knowing the company's address ranges. This is the moment that actually matters: a
   * process about to accept traffic.
   */
  assertNetworkPolicyConfigured(config);

  const logger = createLogger({
    level: config.logLevel,
    pretty: !config.isProduction,
  });

  const app = next({
    dev: config.isDevelopment,
    hostname: config.bindHost,
    port: config.port,
  });
  const handleRequest = app.getRequestHandler();

  await app.prepare();

  /*
   * The network gate (Phase 8).
   *
   * Built once, from configuration, and consulted by both enforcement points: this request
   * listener and the Socket.IO handshake below. See lib/net/gate.ts for why both are needed —
   * engine.io intercepts the socket transport before this listener ever sees it.
   */
  const gate = createNetworkGate({ policy: config.networkPolicy, logger });

  /*
   * The rate limiter (Phase 9).
   *
   * One per process, built here alongside the gate, and consulted only for the two endpoints
   * `guardedEndpointFor` names. In-memory by design: this deployment is a single Node process on
   * the company server (D-09), so a shared store would be infrastructure bought to synchronise one
   * writer with itself. What it is and is not is set out in lib/http/rate-limit.ts.
   */
  const limiter = createRateLimiter();

  /** Throttling events are logged on the same budget as denials, and for the same reason. */
  const throttleLoggedAt = new Map<string, number>();

  function noteThrottle(endpoint: GuardedEndpoint, address: string | null): void {
    const key = `${endpoint}:${address ?? '<unresolved>'}`;
    const last = throttleLoggedAt.get(key) ?? 0;
    const timestamp = Date.now();
    if (timestamp - last < THROTTLE_LOG_INTERVAL_MS) return;

    // Bounded, so a spray of source addresses cannot grow this map without limit.
    if (throttleLoggedAt.size >= 512) throttleLoggedAt.clear();
    throttleLoggedAt.set(key, timestamp);

    // The endpoint and the caller's own address. Never the value they submitted: a near-miss
    // token or setup code in a log file is still a secret (CLAUDE.md §14).
    logger.warn('Too many attempts; refusing further requests for now', {
      endpoint,
      address: address ?? '<unresolved>',
    });
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    /*
     * FIRST, BEFORE NEXT.JS SEES THE REQUEST.
     *
     * One check, here, covers every page, every API route, /admin, /setup, attachment uploads
     * and attachment downloads — because all of them are served by the handler below and none of
     * them can be reached without passing this line. That is the whole reason the check lives at
     * the server rather than being repeated in route handlers, where a new route would have to
     * remember to include it (CLAUDE.md §9).
     *
     * It is also the only layer that CAN do this: a Next.js route handler receives a `Request`,
     * which has headers but no socket, so it cannot see the peer address at all. Anything
     * enforced in there would necessarily be trusting a header.
     */
    const decision = gate.check(req.socket.remoteAddress, req.headers, req.url ?? '/');
    if (!decision.allowed) {
      gate.denyHttp(req, res);
      return;
    }

    /*
     * SECOND, STILL BEFORE NEXT.JS (Phase 9).
     *
     * Three refusals that belong here for the same reason the gate does: a route handler receives
     * a `Request`, which has headers but no socket and no way to stop a body arriving. All three
     * are cheap, and all three answer before any of a request body is read.
     */
    const path = normalisePath(req.url);

    /*
     * Cross-site writes.
     *
     * The identity cookies are already `SameSite=Lax`, which stops a cross-site form post from
     * carrying them. This is the second lock rather than the first: a browser attaches `Origin` to
     * exactly the requests this refuses, and comparing it with `Host` needs no configuration an
     * operator could get wrong.
     */
    if (isUnsafeMethod(req.method) && !isSameOriginWrite(req.headers.origin, req.headers.host)) {
      logger.warn('Request refused: cross-origin write', { path, method: req.method });
      refuse(res, 403, 'CROSS_ORIGIN_FORBIDDEN', 'That request did not come from this application.');
      return;
    }

    /*
     * Oversized bodies.
     *
     * The declared length only — a sender who lies about it, or sends none at all, is caught while
     * the body is read (`readJsonBody` in lib/http/route-helpers.ts). This is the cheap half: an
     * honest 2 GB POST is refused before Next.js allocates anything for it.
     *
     * The file upload route is deliberately not bounded here. Its body IS a file, and it is
     * counted as it arrives by lib/files/storage.ts — the only measurement that does not depend on
     * believing the sender.
     */
    const limit = bodyLimitFor(req.method, path);
    if (limit !== null) {
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > limit) {
        logger.warn('Request refused: body too large', { path, declared, limit });
        refuse(res, 413, 'PAYLOAD_TOO_LARGE', 'That request was too large.');
        return;
      }
    }

    /*
     * Guessing at a secret.
     *
     * Keyed on the address the network gate already resolved, so the limiter and the allow-list
     * can never disagree about who a caller is.
     */
    const guarded = guardedEndpointFor(req.method, path);
    if (guarded) {
      const verdict = limiter.consume(
        `${guarded}:${decision.address ?? '<unresolved>'}`,
        RATE_LIMITS[guarded],
      );

      if (!verdict.allowed) {
        noteThrottle(guarded, decision.address);
        res.setHeader('Retry-After', String(verdict.retryAfterSeconds));
        refuse(res, 429, 'TOO_MANY_ATTEMPTS', 'Too many attempts. Please wait and try again.');
        return;
      }
    }

    // Next's handler returns a promise; an unhandled rejection here would take down the
    // process, so every request failure is caught, logged, and answered generically.
    void handleRequest(req, res).catch((error: unknown) => {
      logger.error('Unhandled error while serving request', {
        method: req.method,
        url: req.url,
        ...describeError(error),
      });

      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        // Generic body: no stack trace, no paths, no internals (CLAUDE.md §13).
        res.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Internal error' } }));
      } else {
        res.destroy();
      }
    });
  });

  // ---------------------------------------------------------------------------------------
  // Real-time gateway (Phase 4).
  //
  // Attached to the same `http.Server` as Next.js, which is the whole point of D-09: one
  // process, one port, one origin, and the session cookie applies to both transports without
  // CORS. The gateway authenticates every handshake from that cookie and verifies conversation
  // membership against the database before joining any room (docs/01-architecture.md §6).
  //
  // It is created only when a database is configured. Without one there is no identity to
  // resolve and no message to persist, so a socket server would have nothing to do — and the
  // Phase 2 interface must keep working on a machine with no `.env`.
  // ---------------------------------------------------------------------------------------
  let gateway: RealtimeGateway | undefined;

  if (config.databaseTarget) {
    gateway = createRealtimeGateway(server, {
      db: getDb(),
      logger,
      identity: {
        sessionTtlHours: config.sessionTtlHours,
        deviceTtlDays: config.deviceTtlDays,
      },
      // The same gate object, so the socket and the HTTP surface can never drift apart on who
      // is allowed in, and a denial from either is throttled by one shared log budget.
      gate,
    });
    logger.info('Realtime gateway attached', { path: SOCKET_PATH });
  } else {
    logger.warn('Realtime gateway not attached: no database configured');
  }

  server.on('error', (error: unknown) => {
    logger.error('HTTP server error', describeError(error));
    process.exitCode = 1;
  });

  await new Promise<void>((resolve) => {
    server.listen(config.port, config.bindHost, resolve);
  });

  logger.info('Server listening', {
    url: `http://${config.bindHost}:${config.port}`,
    appUrl: config.appUrl,
    nodeEnv: config.nodeEnv,
    mode: config.isDevelopment ? 'development' : 'production',
    // Redacted: role, host, port and database name only, never the password (CLAUDE.md §14).
    // No connection is opened here — the client connects lazily on first use.
    database: config.databaseTarget ?? 'not configured',
    /*
     * How many ranges are permitted and whether forwarding headers are believed — but never the
     * ranges themselves. An operator needs to know the policy is the one they configured, and
     * the count plus the source tells them that; printing the allow-list into a log file that
     * gets pasted into a ticket does not (CLAUDE.md §14).
     */
    network: config.networkPolicyConfigured
      ? `${config.networkPolicy.allowed.length} allowed range(s) from ALLOWED_NETWORKS`
      : 'loopback only (ALLOWED_NETWORKS not set)',
    trustedProxies: config.networkPolicy.trustedProxies.length,
  });

  /*
   * A bind address that is not loopback, with a policy nobody configured, is the one combination
   * that is almost certainly a mistake: the server is reachable from the LAN and will refuse
   * every employee on it. Said plainly at startup, because the symptom otherwise appears as
   * "the app is broken" rather than "the app is not configured".
   */
  if (!config.networkPolicyConfigured && !isLoopbackHost(config.bindHost)) {
    logger.warn(
      'Bound to a non-loopback interface with no ALLOWED_NETWORKS: every request from the ' +
        'network will be refused. Set ALLOWED_NETWORKS to the company ranges.',
      { bindHost: config.bindHost },
    );
  }

  installShutdownHandlers(server, app, logger, gateway);
}

/**
 * A refusal from the guards above.
 *
 * One shape, always JSON, never a redirect, and never anything about why beyond a stable code —
 * the same discipline `lib/net/gate.ts` applies to a network denial (CLAUDE.md §13).
 */
function refuse(res: ServerResponse, status: number, code: string, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }

  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify({ error: { code, message } }));
}

/** Loopback in either family, plus the hostname form. Used only for the startup warning above. */
function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return value === 'localhost' || value === '::1' || value.startsWith('127.');
}

function installShutdownHandlers(
  server: ReturnType<typeof createServer>,
  app: ReturnType<typeof next>,
  logger: Logger,
  gateway: RealtimeGateway | undefined,
): void {
  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info('Shutting down', { signal });

    const forceExit = setTimeout(() => {
      logger.warn('Shutdown grace period elapsed; forcing exit');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    forceExit.unref();

    // Close the sockets FIRST. An open WebSocket is a live connection, and `server.close()`
    // waits for those to end — without this the process would sit until the grace timer fired
    // on every shutdown.
    const closeSockets = gateway
      ? gateway.close().catch((error: unknown) => {
          logger.error('Error closing the realtime gateway', describeError(error));
        })
      : Promise.resolve();

    void closeSockets.then(() => closeHttpServer());

    function closeHttpServer(): void {
      server.close((error?: Error) => {
        if (error) {
          logger.error('Error closing HTTP server', describeError(error));
        }

        void app
          .close()
          .catch((closeError: unknown) => {
            logger.error('Error closing Next.js application', describeError(closeError));
          })
          // Release the database connection pool, if one was ever opened.
          .then(() => disconnectDb())
          .catch((dbError: unknown) => {
            logger.error('Error closing database connections', describeError(dbError));
          })
          .finally(() => {
            clearTimeout(forceExit);
            process.exit(error ? 1 : 0);
          });
      });
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Nothing should reach these. If something does, it is logged rather than silently
  // swallowed (CLAUDE.md §13: never leave errors unhandled).
  process.on('unhandledRejection', (reason: unknown) => {
    logger.error('Unhandled promise rejection', describeError(reason));
  });

  process.on('uncaughtException', (error: unknown) => {
    logger.error('Uncaught exception', describeError(error));
    shutdown('uncaughtException');
  });
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    // Configuration problems are the operator's to fix; print them plainly rather than as a
    // stack trace, since this is what a failed deployment will show first.
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(`Failed to start server: ${JSON.stringify(describeError(error))}\n`);
  }
  process.exit(1);
});
