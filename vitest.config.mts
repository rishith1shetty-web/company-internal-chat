/**
 * Vitest configuration.
 *
 * Node environment: the Phase 3 tests exercise the database layer, not the browser. Component
 * tests, if they are ever wanted, would need their own environment and are not set up here —
 * the project adds test infrastructure when a phase needs it, not in advance.
 *
 * `.mts` rather than `.ts`: package.json declares no "type", so a `.ts` config is loaded as
 * CommonJS while this file uses ESM syntax. The explicit extension avoids that mismatch.
 */

import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Loads `.env` into process.env; without it the database suite would skip even when the
    // database is configured.
    setupFiles: ['tests/setup-env.ts'],
    // Database tests share one PostgreSQL schema, so they run in a single process rather than
    // racing each other across workers.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
});
