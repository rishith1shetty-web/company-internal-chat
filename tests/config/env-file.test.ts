/**
 * Which environment file a process loads, and whether it considers itself production.
 *
 * These two questions decide whether the production server reads its own configuration or
 * silently inherits the development `.env` sitting beside it, and whether a destructive utility
 * will run against real company data. Both answers are pure functions of the environment, so
 * every branch is tested here without a filesystem, a database or a server.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ConfigError } from '../../lib/config/env';
import {
  DEFAULT_ENV_FILE,
  ENV_FILE_VARIABLE,
  detectProduction,
  loadEnvironmentFile,
  resolveEnvFilePath,
} from '../../lib/config/env-file';

describe('resolveEnvFilePath', () => {
  it('defaults to .env in the working directory, exactly as before', () => {
    expect(resolveEnvFilePath({})).toEqual({ path: resolve(DEFAULT_ENV_FILE), explicit: false });
  });

  it('uses ENV_FILE when one is set, and reports that the choice was explicit', () => {
    const selection = resolveEnvFilePath({ [ENV_FILE_VARIABLE]: 'C:/company-chat/production.env' });
    expect(selection.explicit).toBe(true);
    expect(selection.path).toBe(resolve('C:/company-chat/production.env'));
  });

  it('resolves a relative ENV_FILE to an absolute path', () => {
    expect(resolveEnvFilePath({ [ENV_FILE_VARIABLE]: 'config/prod.env' }).path).toBe(
      resolve('config/prod.env'),
    );
  });

  it.each(['', '   '])('treats a blank ENV_FILE (%j) as unset rather than as a path', (blank) => {
    expect(resolveEnvFilePath({ [ENV_FILE_VARIABLE]: blank })).toEqual({
      path: resolve(DEFAULT_ENV_FILE),
      explicit: false,
    });
  });
});

describe('loadEnvironmentFile', () => {
  it('reads an explicitly selected file and reports the path it used', () => {
    const directory = mkdtempSync(join(tmpdir(), 'zz-test-envfile-'));
    const file = join(directory, 'production.env');
    const marker = `ZZ_TEST_MARKER_${Date.now()}`;
    writeFileSync(file, `${marker}=loaded-from-the-explicit-file\n`, 'utf8');

    try {
      const selection = loadEnvironmentFile({ [ENV_FILE_VARIABLE]: file });

      expect(selection).toEqual({ path: resolve(file), explicit: true, loaded: true });
      expect(process.env[marker]).toBe('loaded-from-the-explicit-file');
    } finally {
      delete process.env[marker];
    }
  });

  it('REFUSES to start when ENV_FILE names a file that does not exist', () => {
    /*
     * The single most important case in this file.
     *
     * Falling back to `.env` here would mean a production service whose configuration file was
     * renamed, moved or never deployed would boot anyway — with loopback-only access, no
     * database and no admin token — and look broken rather than misconfigured.
     */
    const missing = join(tmpdir(), `zz-test-absent-${Date.now()}.env`);

    expect(() => loadEnvironmentFile({ [ENV_FILE_VARIABLE]: missing })).toThrow(ConfigError);
    expect(() => loadEnvironmentFile({ [ENV_FILE_VARIABLE]: missing })).toThrow(/does not exist/);
  });

  it('names the offending path in the failure, so the operator can see the typo', () => {
    const missing = join(tmpdir(), `zz-test-absent-${Date.now()}.env`);
    expect(() => loadEnvironmentFile({ [ENV_FILE_VARIABLE]: missing })).toThrow(
      new RegExp(missing.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&')),
    );
  });

  it('tolerates a missing .env when nothing selected it, because that is normal', () => {
    // The default path is only a default. A machine with no `.env` runs on safe defaults, and
    // the database is optional — so this must never throw.
    expect(() => loadEnvironmentFile({})).not.toThrow();
  });
});

describe('detectProduction', () => {
  it('says no for an empty environment', () => {
    expect(detectProduction({})).toEqual({ production: false, reasons: [] });
  });

  it('says no for development', () => {
    expect(detectProduction({ NODE_ENV: 'development' }).production).toBe(false);
  });

  it('says no for the test environment this suite runs in', () => {
    expect(detectProduction({ NODE_ENV: 'test' }).production).toBe(false);
  });

  it('detects NODE_ENV=production', () => {
    const verdict = detectProduction({ NODE_ENV: 'production' });
    expect(verdict.production).toBe(true);
    expect(verdict.reasons).toEqual([expect.stringContaining('NODE_ENV')]);
  });

  it('detects a selected ENV_FILE even when NODE_ENV says nothing', () => {
    /*
     * The case that actually protects the company: an administrator standing at the production
     * server runs a script by hand, in a shell where NODE_ENV was never exported. The service
     * sets ENV_FILE, the operator's shell may not — so the file selection is checked too, and
     * either signal alone is enough.
     */
    const verdict = detectProduction({ [ENV_FILE_VARIABLE]: 'C:/company-chat/production.env' });
    expect(verdict.production).toBe(true);
    expect(verdict.reasons).toEqual([expect.stringContaining(ENV_FILE_VARIABLE)]);
  });

  it('reports both signals when both fire', () => {
    const verdict = detectProduction({
      NODE_ENV: 'production',
      [ENV_FILE_VARIABLE]: 'C:/company-chat/production.env',
    });
    expect(verdict.production).toBe(true);
    expect(verdict.reasons).toHaveLength(2);
  });

  it('trims whitespace rather than being fooled by it', () => {
    expect(detectProduction({ NODE_ENV: '  production  ' }).production).toBe(true);
  });

  it('ignores a blank ENV_FILE', () => {
    expect(detectProduction({ [ENV_FILE_VARIABLE]: '   ' }).production).toBe(false);
  });
});
