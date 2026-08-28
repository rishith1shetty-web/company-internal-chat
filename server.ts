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
import { createLogger, describeError, type Logger } from './lib/logging/logger';

/** Time to wait for in-flight requests to finish before forcing exit. */
const SHUTDOWN_GRACE_MS = 10_000;

async function main(): Promise<void> {
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
  // PHASE 4 ATTACH POINT — real-time gateway.
  //
  // The Socket.IO server attaches to `server` here, so it shares this port and origin:
  //
  //     const io = new Server(server, { path: '/socket.io' });
  //     registerRealtimeGateway(io);   // lib/realtime/
  //
  // Per docs/01-architecture.md §6 and CLAUDE.md §10, that gateway must authenticate every
  // handshake from the session cookie and verify conversation membership server-side before
  // joining any room. Nothing is attached in Phase 1.
  // ---------------------------------------------------------------------------------------

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
  });

  installShutdownHandlers(server, app, logger);
}

function installShutdownHandlers(
  server: ReturnType<typeof createServer>,
  app: ReturnType<typeof next>,
  logger: Logger,
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

    server.close((error?: Error) => {
      if (error) {
        logger.error('Error closing HTTP server', describeError(error));
      }
      void app
        .close()
        .catch((closeError: unknown) => {
          logger.error('Error closing Next.js application', describeError(closeError));
        })
        .finally(() => {
          clearTimeout(forceExit);
          process.exit(error ? 1 : 0);
        });
    });
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
