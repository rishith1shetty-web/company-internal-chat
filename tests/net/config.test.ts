/**
 * Phase 8 — how the network policy is configured, and what happens when it is not.
 *
 * `loadConfig` is called with an explicit environment object rather than mutating `process.env`,
 * so these tests cannot disturb the rest of the run.
 */

import { describe, expect, it } from 'vitest';

import { ConfigError, assertNetworkPolicyConfigured, loadConfig } from '@/lib/config/env';

/** A minimal environment. Nothing else in the config surface matters to these tests. */
function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: 'development', ...overrides } as NodeJS.ProcessEnv;
}

function problemsOf(environment: NodeJS.ProcessEnv): string[] {
  try {
    loadConfig(environment);
    return [];
  } catch (error) {
    return error instanceof ConfigError ? [...error.problems] : [String(error)];
  }
}

describe('ALLOWED_NETWORKS', () => {
  it('is parsed into rules when set', () => {
    const config = loadConfig(env({ ALLOWED_NETWORKS: '192.168.1.0/24,10.0.0.0/8' }));
    expect(config.networkPolicy.allowed).toHaveLength(2);
    expect(config.networkPolicyConfigured).toBe(true);
  });

  /*
   * The direction of this default is the point.
   *
   * Development falls back to loopback only — the TIGHTEST policy available, not a relaxation.
   * That is what makes NODE_ENV safe to get wrong: mislabelling a production server as
   * development can only lock people out, never let outsiders in. There is no branch anywhere
   * that widens access because the environment is not production.
   */
  it('defaults to loopback only outside production, which is the tightest policy, not the loosest', () => {
    const config = loadConfig(env({ ALLOWED_NETWORKS: undefined }));
    expect(config.networkPolicyConfigured).toBe(false);
    expect(config.networkPolicy.allowed.map((rule) => rule.text)).toEqual(['127.0.0.0/8', '::1/128']);
  });

  it('refuses a malformed range rather than quietly dropping it', () => {
    const problems = problemsOf(env({ ALLOWED_NETWORKS: '192.168.1.0/24,nonsense' }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('nonsense');
  });

  it('names every malformed range, not just the first', () => {
    const problems = problemsOf(env({ ALLOWED_NETWORKS: 'nonsense,10.0.0.0/99' }));
    expect(problems).toHaveLength(2);
  });

  it('refuses a range whose host bits are set, in configuration as in parsing', () => {
    const problems = problemsOf(env({ ALLOWED_NETWORKS: '192.168.1.5/24' }));
    expect(problems[0]).toContain('192.168.1.5/24');
  });

  it('refuses a setting that is present but lists nothing', () => {
    const problems = problemsOf(env({ ALLOWED_NETWORKS: ',,' }));
    expect(problems[0]).toContain('lists no ranges');
  });
});

/*
 * Fail closed, checked at the moment a process is about to serve traffic.
 *
 * Deliberately NOT part of `loadConfig`: route modules read the configuration at import, and
 * `next build` evaluates them with NODE_ENV=production, so enforcing it there made the build
 * require the company's address ranges in order to compile. A build machine has no business
 * knowing them.
 */
describe('the production requirement', () => {
  it('refuses to start a production server that has no policy configured', () => {
    const config = loadConfig(env({ NODE_ENV: 'production', ALLOWED_NETWORKS: undefined }));
    expect(config.networkPolicyConfigured).toBe(false);

    expect(() => assertNetworkPolicyConfigured(config)).toThrow(ConfigError);
    try {
      assertNetworkPolicyConfigured(config);
    } catch (error) {
      expect((error as ConfigError).problems[0]).toContain('ALLOWED_NETWORKS must be set in production');
    }
  });

  it('starts a production server once ranges are configured', () => {
    const config = loadConfig(env({ NODE_ENV: 'production', ALLOWED_NETWORKS: '192.168.1.0/24' }));
    expect(config.networkPolicy.allowed).toHaveLength(1);
    expect(() => assertNetworkPolicyConfigured(config)).not.toThrow();
  });

  /* Loading the configuration must stay safe everywhere — that is what unbroke the build. */
  it('does not throw merely from loading a production configuration', () => {
    expect(() => loadConfig(env({ NODE_ENV: 'production', ALLOWED_NETWORKS: undefined }))).not.toThrow();
  });

  it('leaves development and test environments alone', () => {
    for (const nodeEnv of ['development', 'test']) {
      const config = loadConfig(env({ NODE_ENV: nodeEnv, ALLOWED_NETWORKS: undefined }));
      expect(() => assertNetworkPolicyConfigured(config), nodeEnv).not.toThrow();
    }
  });
});

describe('TRUSTED_PROXY_IPS', () => {
  it('is empty by default, so forwarding headers are ignored', () => {
    expect(loadConfig(env()).networkPolicy.trustedProxies).toEqual([]);
  });

  it('is parsed when set', () => {
    const config = loadConfig(env({ TRUSTED_PROXY_IPS: '127.0.0.1,10.0.0.0/8' }));
    expect(config.networkPolicy.trustedProxies).toHaveLength(2);
  });

  it('refuses a malformed entry', () => {
    const problems = problemsOf(env({ TRUSTED_PROXY_IPS: 'not-an-ip' }));
    expect(problems[0]).toContain('TRUSTED_PROXY_IPS');
  });

  /* Enabling proxy trust must be a deliberate act, never a side effect of another setting. */
  it('stays off when only ALLOWED_NETWORKS is configured', () => {
    const config = loadConfig(env({ ALLOWED_NETWORKS: '192.168.1.0/24' }));
    expect(config.networkPolicy.trustedProxies).toEqual([]);
  });
});
