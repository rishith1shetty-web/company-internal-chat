/**
 * Which context menu the composer shows, and the spellcheck configuration behind it (Batch 1.5).
 *
 * The rule is pure, so it can be tested properly rather than structurally: hand it a scope that
 * looks like Mac Chrome, or Mac Safari, or the Electron desktop client, and assert what the
 * composer would do. That is most of this batch's risk, because the failure that matters is not
 * "spellcheck is off" but "the custom menu swallowed the native one" — which is exactly what was
 * happening before this batch, in every browser.
 *
 * What CANNOT be tested here is the platform's own behaviour: whether Chrome actually draws a red
 * underline, and what words it suggests, are properties of Chrome and of the OS dictionary. Those
 * are covered by the manual smoke test in the report, and are not simulated here — a test that
 * faked them would assert only that the fake works.
 */

import { describe, expect, it } from 'vitest';

import {
  COMPOSER_SPELLCHECK,
  isDesktopClient,
  shouldUseCustomComposerMenu,
  type ContextMenuScope,
} from '@/lib/chat/composer-menu';

/* Real user agent strings, trimmed but otherwise as these clients actually send them. */

const MAC_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/141.0.0.0 Safari/537.36';

const MAC_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) ' +
  'Version/18.6 Safari/605.1.15';

const WINDOWS_EDGE =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0';

/** What the desktop client sends. Electron appends its own token to a Chrome-shaped string. */
const ELECTRON =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'RisingPathRecruitersChat/0.1.0 Chrome/140.0.0.0 Electron/38.8.6 Safari/537.36';

function scope(userAgent?: string, bridge?: unknown): ContextMenuScope {
  return {
    ...(bridge === undefined ? {} : { risingPathDesktop: bridge }),
    ...(userAgent === undefined ? {} : { navigator: { userAgent } }),
  };
}

/** The bridge as desktop/preload.ts exposes it, reduced to what this module reads. */
const REAL_BRIDGE = { isDesktop: true, notify() {}, closeNotification() {}, reload() {} };

/* -------------------------------------------------------------------------------------------- */
/* Browsers: the native menu must be left alone                                                   */
/* -------------------------------------------------------------------------------------------- */

describe('in a browser, the platform keeps its own menu', () => {
  it('MAC CHROME is not the desktop client', () => {
    expect(isDesktopClient(scope(MAC_CHROME))).toBe(false);
  });

  it('MAC SAFARI is not the desktop client', () => {
    expect(isDesktopClient(scope(MAC_SAFARI))).toBe(false);
  });

  it('Windows Edge and Chrome are not the desktop client either', () => {
    expect(isDesktopClient(scope(WINDOWS_EDGE))).toBe(false);
  });

  it('so the composer does NOT show its own menu in any of them', () => {
    for (const agent of [MAC_CHROME, MAC_SAFARI, WINDOWS_EDGE]) {
      expect(shouldUseCustomComposerMenu(scope(agent)), agent).toBe(false);
    }
  });

  it('is not fooled by "Safari" or "Chrome" appearing in the desktop agent', () => {
    /*
     * The Electron string contains BOTH tokens — it is a Chrome user agent with a suffix. A check
     * written as "contains Chrome → browser" would get this exactly backwards.
     */
    expect(ELECTRON).toContain('Safari/');
    expect(ELECTRON).toContain('Chrome/');
    expect(isDesktopClient(scope(ELECTRON))).toBe(true);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* The desktop client: our menu is the only menu                                                  */
/* -------------------------------------------------------------------------------------------- */

describe('in the desktop client, the composer still shows its own menu', () => {
  it('recognises it by the user agent alone', () => {
    // No bridge at all — the documented preload failure. The menu must survive it.
    expect(isDesktopClient(scope(ELECTRON))).toBe(true);
    expect(shouldUseCustomComposerMenu(scope(ELECTRON))).toBe(true);
  });

  it('recognises it by the preload bridge alone', () => {
    // No user agent — a scope that has a bridge but no navigator.
    expect(isDesktopClient(scope(undefined, REAL_BRIDGE))).toBe(true);
    expect(shouldUseCustomComposerMenu(scope(undefined, REAL_BRIDGE))).toBe(true);
  });

  it('recognises it when BOTH signals are present, which is the normal case', () => {
    expect(isDesktopClient(scope(ELECTRON, REAL_BRIDGE))).toBe(true);
  });

  it('accepts a bridge carrying only the flag, without the notification methods', () => {
    /*
     * Deliberately weaker than `readDesktopBridge`, which requires every notification method.
     * The question here is "is this the desktop shell", not "can it raise a notification", and a
     * bridge that lost a method should not also cost the composer its only context menu.
     */
    expect(isDesktopClient(scope(undefined, { isDesktop: true }))).toBe(true);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Nothing else counts as the desktop client                                                      */
/* -------------------------------------------------------------------------------------------- */

describe('everything malformed falls back to the browser', () => {
  it('an absent scope — server rendering — is not the desktop client', () => {
    expect(isDesktopClient(undefined)).toBe(false);
    expect(shouldUseCustomComposerMenu(undefined)).toBe(false);
  });

  it('an empty scope is not the desktop client', () => {
    expect(isDesktopClient({})).toBe(false);
  });

  it('a bridge that is not an object is refused', () => {
    for (const bridge of [null, 'yes', 42, true, [], () => {}]) {
      expect(isDesktopClient(scope(MAC_CHROME, bridge)), String(bridge)).toBe(false);
    }
  });

  it('a bridge whose isDesktop is not exactly true is refused', () => {
    for (const flag of ['true', 1, {}, null, undefined]) {
      expect(isDesktopClient(scope(MAC_CHROME, { isDesktop: flag })), String(flag)).toBe(false);
    }
  });

  it('a non-string user agent is ignored rather than thrown on', () => {
    for (const agent of [null, 42, {}, undefined]) {
      const weird = { navigator: { userAgent: agent } } as unknown as ContextMenuScope;
      expect(() => isDesktopClient(weird)).not.toThrow();
      expect(isDesktopClient(weird), String(agent)).toBe(false);
    }
  });

  it('a scope with no navigator at all is ignored rather than thrown on', () => {
    expect(() => isDesktopClient({ risingPathDesktop: REAL_BRIDGE })).not.toThrow();
  });

  it('does not match a user agent that merely mentions Electron in passing', () => {
    /*
     * The token is `Electron/<version>`, with the slash. Matching the bare word would catch a
     * browser whose agent happened to carry it — and, more to the point, says what the real
     * signal is.
     */
    expect(isDesktopClient(scope('Mozilla/5.0 ElectronicArts/3 Chrome/141'))).toBe(false);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Spellcheck configuration                                                                       */
/* -------------------------------------------------------------------------------------------- */

describe('spellcheck configuration', () => {
  it('is ON for the composer', () => {
    expect(COMPOSER_SPELLCHECK).toBe(true);
  });

  it('is a plain constant, so it cannot vary by platform', () => {
    /*
     * Chrome, Safari and Electron all get the same markup. The differences between them are the
     * platforms' own, and the application does not try to anticipate them.
     */
    expect(typeof COMPOSER_SPELLCHECK).toBe('boolean');
  });
});

/* -------------------------------------------------------------------------------------------- */
/* The module cannot do anything but decide                                                       */
/* -------------------------------------------------------------------------------------------- */

describe('deciding which menu to show is a local act', () => {
  it('neither function is async, so neither can await a server', async () => {
    expect(isDesktopClient(scope(MAC_CHROME))).not.toBeInstanceOf(Promise);
    expect(shouldUseCustomComposerMenu(scope(MAC_CHROME))).not.toBeInstanceOf(Promise);
  });

  it('reads the scope it is given and never a global', () => {
    /*
     * Both branches are driven entirely by the argument: if either reached for the real `window`
     * instead, these two calls could not disagree in a Node environment that has no window.
     */
    expect(isDesktopClient(scope(ELECTRON))).toBe(true);
    expect(isDesktopClient(scope(MAC_CHROME))).toBe(false);
  });
});
