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

import { loadConfig, ConfigError } from './lib/config/env';
import { disconnectDb, getDb } from './lib/db/prisma';
import { createLogger, describeError, type Logger } from './lib/logging/logger';
import { SOCKET_PATH } from './lib/realtime/events';
import { createRealtimeGateway, type RealtimeGateway } from './lib/realtime/gateway';

/** Time to wait for in-flight requests to finish before forcing exit. */
const SHUTDOWN_GRACE_MS = 10_000;

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

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
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
  });

  installShutdownHandlers(server, app, logger, gateway);
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
