/**
 * Where the desktop client connects.
 *
 * Two properties matter here and the rest is detail. The first is that no company address is
 * compiled into the application — the fallback is loopback, which is wrong everywhere except a
 * developer's own machine and therefore fails visibly rather than connecting somewhere
 * unintended. The second is that a configured-but-wrong address is an ERROR rather than a reason
 * to fall through to the next source: an administrator who mistyped the server name needs to be
 * told, not quietly connected to localhost where nothing will be found.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SERVER_URL,
  SERVER_CONFIG_FILENAME,
  ServerUrlError,
  parseServerUrl,
  readServerUrlFromConfig,
  PACKAGED_CONFIG_FILENAME,
  resolveServerUrl,
} from '@/desktop/config';

describe('the compiled-in default', () => {
  it('is loopback, so no company address is baked into the build', () => {
    // CLAUDE.md §7: the LAN address in use today is a development detail that will be replaced by
    // a hostname over HTTPS. A build with it inside is a build that has to be reissued when the
    // network changes.
    expect(DEFAULT_SERVER_URL).toBe('http://localhost:3000');
    expect(DEFAULT_SERVER_URL).not.toMatch(/192\.168\./);
  });

  it('applies when nothing at all is configured', () => {
    const resolved = resolveServerUrl();
    expect(resolved.url).toBe(DEFAULT_SERVER_URL);
    expect(resolved.source).toBe('default');
  });
});

describe('resolution order', () => {
  it('prefers the environment over the configuration file', () => {
    const resolved = resolveServerUrl({
      env: 'https://chat.example.local',
      file: 'http://192.0.2.10:3000',
    });

    expect(resolved.url).toBe('https://chat.example.local');
    expect(resolved.source).toBe('environment');
  });

  it('uses the configuration file when the environment is unset', () => {
    const resolved = resolveServerUrl({ file: 'http://192.0.2.10:3000' });

    expect(resolved.url).toBe('http://192.0.2.10:3000');
    expect(resolved.source).toBe('config-file');
  });

  it('skips a source that is present but empty', () => {
    // An environment variable set to '' or to spaces is how a shell profile leaves one behind. It
    // means "unset" rather than "connect nowhere".
    const resolved = resolveServerUrl({ env: '   ', file: 'https://chat.example.local' });

    expect(resolved.source).toBe('config-file');
  });

  it('names the file an administrator has to edit', () => {
    expect(SERVER_CONFIG_FILENAME).toBe('server.json');
  });
});

describe('the address baked in at build time', () => {
  /*
   * THE BUG THIS LEVEL EXISTS TO FIX. `DESKTOP_SERVER_URL` is read from the environment of
   * whichever process is running. During `electron-builder` that is the BUILD machine, and the
   * packaged application never sees that environment again — so setting the variable while
   * packaging produced an installer that still defaulted to localhost, silently. The build now
   * writes the value into the package, and this is the level that reads it back.
   */
  it('is used when nothing is configured on the machine', () => {
    const resolved = resolveServerUrl({ packaged: 'http://192.0.2.10:3000' });

    expect(resolved.url).toBe('http://192.0.2.10:3000');
    expect(resolved.source).toBe('packaged');
  });

  it('beats the loopback default, which is the whole point of baking it in', () => {
    expect(resolveServerUrl({ packaged: 'http://192.0.2.10:3000' }).source).not.toBe('default');
  });

  it('LOSES to server.json, so a site can move without waiting for a new installer', () => {
    /*
     * The ordering that matters in production. The baked address is a first-launch default; an
     * administrator who edits server.json on a machine must not have it ignored because somebody
     * built the installer with a different address months earlier.
     */
    const resolved = resolveServerUrl({
      file: 'https://chat.example.local',
      packaged: 'http://192.0.2.10:3000',
    });

    expect(resolved.url).toBe('https://chat.example.local');
    expect(resolved.source).toBe('config-file');
  });

  it('loses to the environment too', () => {
    const resolved = resolveServerUrl({
      env: 'https://chat.example.local',
      packaged: 'http://192.0.2.10:3000',
    });

    expect(resolved.source).toBe('environment');
  });

  it('falls through to loopback for a build made without one', () => {
    // An unconfigured build must fail visibly on an employee's machine, not connect somewhere
    // unintended.
    expect(resolveServerUrl({ packaged: undefined }).source).toBe('default');
    expect(resolveServerUrl({ packaged: '   ' }).source).toBe('default');
  });

  it('is still refused when it is malformed, rather than falling through', () => {
    // A typo in the build environment should fail the build; if one ever reaches a package, it
    // must surface as an error screen and not as a silent connection to localhost.
    expect(() => resolveServerUrl({ packaged: 'htp://192.0.2.10:3000' })).toThrow(ServerUrlError);
  });

  it('is the same filename the build script actually writes', () => {
    /*
     * `scripts/desktop-assets.mjs` writes this name out as a literal, because it is plain ESM run
     * by node and cannot import a TypeScript module. That duplication is only safe while something
     * notices when the two stop agreeing — otherwise the build would write a file the client never
     * reads, and every package would quietly fall back to localhost with nothing failing to say so.
     *
     * So the script is read and its literal compared, rather than this test merely restating the
     * constant back to itself.
     */
    const script = readFileSync(
      join(import.meta.dirname, '..', '..', 'scripts', 'desktop-assets.mjs'),
      'utf8',
    );

    const declared = /const PACKAGED_CONFIG = '([^']+)'/.exec(script);
    expect(declared?.[1]).toBe(PACKAGED_CONFIG_FILENAME);
  });
});

describe('a wrong address stops rather than falling through', () => {
  it('rejects an unparseable environment value instead of silently using the default', () => {
    /*
     * Falling back would leave an administrator staring at "cannot connect" on a machine whose
     * configuration they had just set, with nothing anywhere saying the value was never used.
     */
    expect(() => resolveServerUrl({ env: 'chat.example.local' })).toThrow(ServerUrlError);
  });

  it('does not quietly fall past a bad environment value to a good file value', () => {
    // The one that is set highest wins, right or wrong. Silently preferring the *working* source
    // would hide the mistake for as long as the file happened to be correct.
    expect(() =>
      resolveServerUrl({ env: 'not-a-url', file: 'https://chat.example.local' }),
    ).toThrow(ServerUrlError);
  });

  it('rejects a mistyped address in the configuration file', () => {
    expect(() => resolveServerUrl({ file: 'htp://192.0.2.10:3000' })).toThrow(ServerUrlError);
  });
});

describe('validating one address', () => {
  it('reduces it to an origin, discarding path, query and fragment', () => {
    // The window loads the application root. A stale path in a configuration file must not decide
    // which page an employee opens on.
    expect(parseServerUrl('https://chat.example.local/chat?a=1#x').url).toBe(
      'https://chat.example.local',
    );
  });

  it('keeps a non-default port and drops a default one', () => {
    expect(parseServerUrl('http://192.0.2.10:3000').url).toBe('http://192.0.2.10:3000');
    expect(parseServerUrl('https://chat.example.local:443').url).toBe('https://chat.example.local');
  });

  it('accepts both protocols', () => {
    expect(parseServerUrl('http://192.0.2.10:3000').url).toBe('http://192.0.2.10:3000');
    expect(parseServerUrl('https://chat.example.local').url).toBe('https://chat.example.local');
  });

  it('refuses any other protocol', () => {
    for (const value of [
      'file:///C:/chat/index.html',
      'javascript:alert(1)',
      'data:text/html,x',
      'ftp://192.0.2.10',
      'ws://192.0.2.10:3000',
    ]) {
      expect(() => parseServerUrl(value), value).toThrow(ServerUrlError);
    }
  });

  it('refuses credentials embedded in the address', () => {
    /*
     * Refused rather than stripped. This application does not authenticate that way at all, so a
     * URL of that shape is a misunderstanding worth stopping on — and it would otherwise be
     * written into a plain-text configuration file (§22).
     */
    expect(() => parseServerUrl('https://admin:secret@chat.example.local')).toThrow(
      /username or password/i,
    );
  });

  it('refuses nothing at all', () => {
    for (const value of ['', '   ', null, undefined, 42, {}]) {
      expect(() => parseServerUrl(value), String(value)).toThrow(ServerUrlError);
    }
  });

  it('explains itself in words an administrator can act on', () => {
    // This text is what appears on the configuration screen of a wrongly set-up installation, so
    // it has to name the fix rather than the failure.
    try {
      parseServerUrl('chat.example.local');
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as Error).message).toMatch(/http:\/\/server:3000/);
    }
  });
});

describe('flagging plain HTTP', () => {
  /*
   * Flagged, never blocked. Development runs over http on the LAN today and §18 is explicit that
   * production documentation recommends HTTPS — but a client that refused http would stop the
   * project rather than improve it. Nothing here disables a certificate check either way.
   */
  it('marks http to a LAN address as insecure', () => {
    expect(parseServerUrl('http://192.0.2.10:3000').insecure).toBe(true);
    expect(parseServerUrl('http://chat.example.local').insecure).toBe(true);
  });

  it('does not mark loopback, where there is no network to overhear', () => {
    expect(parseServerUrl('http://localhost:3000').insecure).toBe(false);
    expect(parseServerUrl('http://127.0.0.1:3000').insecure).toBe(false);
  });

  it('does not mark https', () => {
    expect(parseServerUrl('https://chat.example.local').insecure).toBe(false);
  });
});

describe('reading server.json', () => {
  it('takes the serverUrl field', () => {
    expect(readServerUrlFromConfig({ serverUrl: 'https://chat.example.local' })).toBe(
      'https://chat.example.local',
    );
  });

  it('ignores a file that is missing the field, or is not an object', () => {
    // An absent or half-written file is the normal state on a development machine, so it is not
    // an error — the environment variable and the default answer instead.
    for (const contents of [null, undefined, {}, [], 'text', 42, { serverUrl: 5 }]) {
      expect(readServerUrlFromConfig(contents), JSON.stringify(contents)).toBeUndefined();
    }
  });

  it('ignores every other field, including one that looks like a secret', () => {
    // Nothing but the address is read out of this file. A token left in it by mistake is not
    // picked up, not logged and not sent anywhere.
    const contents = { serverUrl: 'https://chat.example.local', adminToken: 'nope' };
    expect(readServerUrlFromConfig(contents)).toBe('https://chat.example.local');
  });
});
