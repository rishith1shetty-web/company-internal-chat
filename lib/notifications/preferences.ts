/**
 * Notification preferences.
 *
 * WHERE THESE LIVE, AND WHY NOT POSTGRESQL. Identity is scoped to a browser profile, so a
 * preference stored on the server would be shared by every browser on a computer while the thing
 * it controls — whether *this* browser makes a sound — is per-browser by nature. It is also not
 * company data: nobody needs it backed up, audited or readable by an administrator, and putting
 * it in the database would mean a migration, an endpoint and an authorization check for a value
 * that changes nothing outside the tab it was set in (CLAUDE.md §8).
 *
 * So: `localStorage`, read defensively. Every access is wrapped, because `localStorage` is not
 * merely empty in a private window or with site data blocked — reading it THROWS, and an
 * exception here would take down the chat interface over a mute switch.
 *
 * DEFAULTS. Sound and in-app toasts start on, because an internal chat application that says
 * nothing when a message arrives is not doing its job. Desktop notifications start OFF in a
 * browser and stay off until somebody presses the button in Settings: the browser permission
 * prompt is an interruption, and one that appears unbidden on first load is the kind users
 * dismiss forever. The Windows desktop client overrides that one default — see the `defaults`
 * parameter of `loadPreferences` for why the reason behind it does not apply there.
 */

/** What the employee can turn on and off. Booleans only — nothing here identifies anybody. */
export interface NotificationPreferences {
  /** Play the chime when a message arrives. */
  sound: boolean;
  /** Show the in-app toast. */
  inApp: boolean;
  /**
   * Use the browser's desktop notifications while the tab is in the background.
   *
   * Being true is a statement of intent, not of capability: the browser permission is separate
   * and is asked for once, explicitly, from Settings. Both must hold for a desktop notification
   * to appear.
   */
  desktop: boolean;
}

export const DEFAULT_PREFERENCES: NotificationPreferences = {
  sound: true,
  inApp: true,
  desktop: false,
};

/** Namespaced so it is recognisable in a browser's storage inspector, like the cookies are. */
export const PREFERENCES_KEY = 'cic.notifications';

/**
 * The storage this module uses. Injectable so the tests can exercise the failure paths — a
 * throwing store, a store holding junk — which are the paths that actually matter here.
 */
export interface PreferenceStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStore(): PreferenceStore | null {
  try {
    // Touching `localStorage` at all can throw, so even reaching for it is guarded.
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Reads the stored preferences, falling back to the defaults for anything missing or malformed.
 *
 * Field by field rather than trusting the parsed object: what comes back is a string a user could
 * have edited by hand, and `{"sound": "yes"}` must not produce a preference that is neither true
 * nor false.
 */
export function loadPreferences(
  store: PreferenceStore | null = defaultStore(),
  /*
   * What to use for anything not stored yet.
   *
   * The desktop client passes `{ desktop: true }`. The reason `desktop` defaults to false in a
   * browser is the permission prompt — an interruption worth earning before asking for. Inside
   * the desktop client there is no prompt at all: the popup is drawn by the application's own
   * process (lib/notifications/electron.ts), so the reason for the conservative default does not
   * apply, and an employee who installed a chat application expects it to tell them about
   * messages while it sits in the tray. A stored choice still wins over this, so an employee who
   * turns it off stays turned off.
   */
  defaults: NotificationPreferences = DEFAULT_PREFERENCES,
): NotificationPreferences {
  if (!store) return { ...defaults };

  let raw: string | null;
  try {
    raw = store.getItem(PREFERENCES_KEY);
  } catch {
    return { ...defaults };
  }

  if (raw === null) return { ...defaults };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...defaults };
  }

  if (typeof parsed !== 'object' || parsed === null) return { ...defaults };

  const source = parsed as Record<string, unknown>;
  const read = (key: keyof NotificationPreferences): boolean =>
    typeof source[key] === 'boolean' ? (source[key] as boolean) : defaults[key];

  return { sound: read('sound'), inApp: read('inApp'), desktop: read('desktop') };
}

/** Writes the preferences. A storage failure is silent: it is a mute switch, not an operation. */
export function savePreferences(
  preferences: NotificationPreferences,
  store: PreferenceStore | null = defaultStore(),
): void {
  if (!store) return;

  try {
    store.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // Quota exceeded, or site data blocked. The preference still applies for this page's
    // lifetime; it simply will not be remembered, which is better than an error dialog.
  }
}
