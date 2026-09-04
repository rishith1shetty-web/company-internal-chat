/**
 * First run: how the desktop client decides whether to open chat or enrollment.
 *
 * THE BUG THIS EXISTS TO PREVENT COMING BACK. `/setup` is deliberately unreachable from the
 * employee interface — nothing links to it, so that a setup mechanism does not become something
 * employees ask each other for (docs/12-admin-device-identity.md). In a browser that is right: an
 * administrator types the URL. In a window with no address bar it meant enrollment could not be
 * reached AT ALL, so a freshly registered computer showed "this computer is not set up yet" and
 * offered no way to set it up.
 *
 * The fix turns on one signal, and the tests below are mostly about the signal being the RIGHT
 * one: whether this profile has ever held a device cookie, rather than whether it currently
 * resolves to an employee. Those two differ exactly in the case that matters — a retired or
 * reassigned computer — and sending that employee to a code form they cannot fill would be a
 * worse screen than the one they have now.
 */

import { describe, expect, it } from 'vitest';

import { DEVICE_COOKIE_NAME, startPathFor } from '@/desktop/config';
import { decideNavigation } from '@/desktop/navigation';
import { DEVICE_COOKIE, SESSION_COOKIE } from '@/lib/auth/session';

describe('the cookie name the desktop client looks for', () => {
  /*
   * The desktop client compiles with its own rootDir and cannot import from `lib/`, so the name is
   * written out in desktop/config.ts. That duplication is only safe if something notices when the
   * two stop agreeing — otherwise renaming the cookie would send every enrolled computer in the
   * company back to a setup screen, and nothing would have failed to say so.
   */
  it('is the same name lib/auth/session.ts actually sets', () => {
    expect(DEVICE_COOKIE_NAME).toBe(DEVICE_COOKIE);
  });

  it('is the DEVICE cookie, not the session cookie', () => {
    /*
     * A session cookie lasts 24 idle hours; the device cookie lasts 90 days and is what enrollment
     * writes. Watching the session cookie would send a computer back to setup after a long weekend
     * — enrolled, working, and asked to enroll again.
     */
    expect(DEVICE_COOKIE_NAME).not.toBe(SESSION_COOKIE);
  });
});

describe('where a launch opens', () => {
  it('opens enrollment when this computer has never been set up', () => {
    // The administrator is standing at the machine with a one-time code, and this is the only
    // route to the form in a window with no address bar.
    expect(startPathFor(false)).toBe('/setup');
  });

  it('opens chat when the computer has been enrolled', () => {
    expect(startPathFor(true)).toBe('/');
  });

  it('opens chat — not enrollment — for a computer whose enrollment stopped working', () => {
    /*
     * The distinction the whole fix rests on. A retired or reassigned computer still HOLDS a
     * device cookie; it just no longer resolves to anybody. That employee gets the existing "ask
     * your IT administrator" screen, which is the honest one, rather than a setup-code form they
     * have no code for.
     *
     * The signal is the cookie's presence, so this is the same call as an enrolled machine — which
     * is precisely the point.
     */
    expect(startPathFor(true)).toBe('/');
  });

  it('only ever answers with one of the two application paths', () => {
    for (const enrolled of [true, false]) {
      expect(['/', '/setup']).toContain(startPathFor(enrolled));
    }
  });
});

describe('the paths it chooses are ones the window is allowed to load', () => {
  const SERVER = 'http://192.0.2.10:3000';

  /*
   * A start path the navigation rules would refuse is a client that opens on a blocked page. The
   * two rules are written in different files, so they are checked against each other here rather
   * than assumed to agree.
   */
  it('allows the enrollment page it opens on first run', () => {
    const path = startPathFor(false);
    expect(decideNavigation(`${SERVER}${path}`, SERVER).action).toBe('allow');
  });

  it('allows the chat page it opens on every run after that', () => {
    const path = startPathFor(true);
    expect(decideNavigation(`${SERVER}${path}`, SERVER).action).toBe('allow');
  });

  it('still refuses administration, whatever the enrollment state', () => {
    // The route to setup must not have loosened anything else on the way in.
    expect(decideNavigation(`${SERVER}/admin`, SERVER).reason).toBe('admin');
    expect(decideNavigation(`${SERVER}/api/admin/devices`, SERVER).reason).toBe('admin');
  });
});
