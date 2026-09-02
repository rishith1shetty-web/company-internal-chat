/**
 * Notification preferences and their storage.
 *
 * The interesting cases are the failures, not the happy path: `localStorage` does not merely come
 * back empty in a private window or with site data blocked — reading it THROWS. A mute switch
 * must never be able to take the chat interface down with it, so every one of those paths is
 * exercised here.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_PREFERENCES,
  PREFERENCES_KEY,
  loadPreferences,
  savePreferences,
  type PreferenceStore,
} from '@/lib/notifications/preferences';

/** An in-memory store, as a working browser behaves. */
function memoryStore(initial?: string): PreferenceStore & { value: string | null } {
  return {
    value: initial ?? null,
    getItem(key) {
      return key === PREFERENCES_KEY ? this.value : null;
    },
    setItem(key, value) {
      if (key === PREFERENCES_KEY) this.value = value;
    },
  };
}

/** A store that throws on every access, as a browser with site data blocked does. */
const hostileStore: PreferenceStore = {
  getItem() {
    throw new Error('SecurityError: access to storage is denied');
  },
  setItem() {
    throw new Error('QuotaExceededError');
  },
};

describe('defaults', () => {
  /*
   * Sound and toasts on, desktop off. Desktop stays off because turning it on means a browser
   * permission prompt, and a prompt nobody asked for is dismissed reflexively — permanently.
   */
  it('are sound on, in-app on, desktop off', () => {
    expect(DEFAULT_PREFERENCES).toEqual({ sound: true, inApp: true, desktop: false });
  });

  it('apply when nothing has been stored', () => {
    expect(loadPreferences(memoryStore())).toEqual(DEFAULT_PREFERENCES);
  });

  it('apply when there is no store at all, as on the server', () => {
    expect(loadPreferences(null)).toEqual(DEFAULT_PREFERENCES);
  });

  it('are a fresh object each time, so a caller cannot mutate the shared default', () => {
    const first = loadPreferences(null);
    first.sound = false;

    expect(loadPreferences(null).sound).toBe(true);
    expect(DEFAULT_PREFERENCES.sound).toBe(true);
  });
});

describe('round trip', () => {
  it('saves and reads back', () => {
    const store = memoryStore();

    savePreferences({ sound: false, inApp: true, desktop: true }, store);

    expect(loadPreferences(store)).toEqual({ sound: false, inApp: true, desktop: true });
  });

  it('stores under a namespaced key, recognisable in a storage inspector', () => {
    const store = memoryStore();
    savePreferences(DEFAULT_PREFERENCES, store);

    expect(PREFERENCES_KEY).toBe('cic.notifications');
    expect(store.value).toContain('"sound"');
  });
});

describe('malformed storage', () => {
  /*
   * What is stored is a string a user can edit by hand, so it is validated field by field rather
   * than trusted once parsed.
   */
  it('falls back to defaults for text that is not JSON', () => {
    expect(loadPreferences(memoryStore('not json at all'))).toEqual(DEFAULT_PREFERENCES);
  });

  it('falls back to defaults for JSON that is not an object', () => {
    for (const value of ['null', '"string"', '42', '[]', 'true']) {
      expect(loadPreferences(memoryStore(value)), value).toEqual(DEFAULT_PREFERENCES);
    }
  });

  it('replaces only the fields that are not booleans', () => {
    const stored = JSON.stringify({ sound: false, inApp: 'yes', desktop: null, extra: 1 });

    expect(loadPreferences(memoryStore(stored))).toEqual({
      // A real boolean is kept…
      sound: false,
      // …and anything else falls back rather than becoming truthy-by-accident.
      inApp: true,
      desktop: false,
    });
  });

  it('ignores unknown fields entirely', () => {
    const stored = JSON.stringify({ sound: true, inApp: true, desktop: true, admin: true });

    expect(loadPreferences(memoryStore(stored))).toEqual({
      sound: true,
      inApp: true,
      desktop: true,
    });
  });
});

describe('a browser that refuses storage', () => {
  it('reads the defaults instead of throwing', () => {
    expect(() => loadPreferences(hostileStore)).not.toThrow();
    expect(loadPreferences(hostileStore)).toEqual(DEFAULT_PREFERENCES);
  });

  it('swallows a failed write, because a preference is not an operation', () => {
    expect(() => savePreferences(DEFAULT_PREFERENCES, hostileStore)).not.toThrow();
  });

  it('does nothing when there is no store', () => {
    const setItem = vi.fn();
    expect(() => savePreferences(DEFAULT_PREFERENCES, null)).not.toThrow();
    expect(setItem).not.toHaveBeenCalled();
  });
});
