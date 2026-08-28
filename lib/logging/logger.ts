/**
 * Minimal structured logger (CLAUDE.md §14, docs/01-architecture.md §9).
 *
 * Deliberately dependency-free for Phase 1: the server needs level-filtered, structured
 * output, and that is a few lines of code. `pino` is the intended replacement once there is
 * real request/socket logging to do (Phase 4 onwards) — the call signature here matches
 * pino's, so swapping it is a one-file change.
 *
 * Never log message bodies, file contents, cookie or token values, or credentials.
 */

import type { LogLevel } from '../config/env';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(message: string, details?: Record<string, unknown>): void;
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  level: LogLevel;
  /** Human-readable output for local development; JSON lines otherwise. */
  pretty: boolean;
}

/**
 * Reduces an unknown thrown value to something safe to log. Stack traces stay in the server
 * log and must never be returned to a browser (CLAUDE.md §13).
 */
export function describeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: 'UnknownError', message: String(error) };
}

export function createLogger(options: LoggerOptions): Logger {
  const threshold = LEVEL_ORDER[options.level];

  const write = (level: LogLevel, message: string, details?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[level] < threshold) return;

    const time = new Date().toISOString();
    const stream = LEVEL_ORDER[level] >= LEVEL_ORDER.warn ? process.stderr : process.stdout;

    if (options.pretty) {
      const suffix = details && Object.keys(details).length > 0 ? ` ${JSON.stringify(details)}` : '';
      stream.write(`${time} ${level.toUpperCase().padEnd(5)} ${message}${suffix}\n`);
      return;
    }

    stream.write(`${JSON.stringify({ time, level, message, ...details })}\n`);
  };

  return {
    debug: (message, details) => write('debug', message, details),
    info: (message, details) => write('info', message, details),
    warn: (message, details) => write('warn', message, details),
    error: (message, details) => write('error', message, details),
  };
}
