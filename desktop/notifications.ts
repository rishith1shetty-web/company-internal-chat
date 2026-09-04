/**
 * Native Windows notifications for the desktop client.
 *
 * WHY THE MAIN PROCESS SHOWS THESE, rather than the page doing what it does in a browser. Three
 * reasons, in order of how much they matter:
 *
 *   1. THE TRAY. Clicking a notification has to bring the window back, and the window may be
 *      hidden rather than merely unfocused. A renderer cannot show a hidden BrowserWindow —
 *      `window.focus()` does nothing for one — so the restore can only happen on this side. That
 *      alone settles it.
 *   2. The session denies every browser permission, notifications included (main.ts,
 *      `hardenSession`), so the renderer's own API is refused in this client by design. Measured
 *      rather than assumed: inside Electron `window.Notification` exists even on a non-secure
 *      origin, unlike Chrome and Edge, but its permission reads `denied` here.
 *   3. A toast from this process carries the application's icon and AppUserModelID, so Windows
 *      attributes it to Rising Path Recruiters Chat rather than to a browser.
 *
 * The renderer therefore asks, over IPC. Whether this employee may be shown this text was settled
 * long before it got here: the message arrived on a socket the server authenticated and placed in
 * a room whose membership it verified. Displaying it discloses nothing new.
 *
 * WHAT CROSSES THE BRIDGE is four fields, all strings the renderer already held. Every one is
 * re-validated here anyway — a renderer is the least trustworthy part of an Electron application,
 * and "we sent it ourselves" is not a property the main process is able to check.
 */

/** What the renderer may ask for. Deliberately tiny. */
export interface DesktopNotificationRequest {
  title: string;
  body: string;
  /** Groups popups for one conversation, so a busy group replaces its own rather than stacking. */
  tag: string;
  /** True when the page is playing its own chime and Windows should not add a second sound. */
  silent: boolean;
}

/** Length caps. Windows truncates long toasts itself; this keeps what crosses the bridge sane. */
export const MAX_TITLE_LENGTH = 120;
export const MAX_BODY_LENGTH = 300;
export const MAX_TAG_LENGTH = 64;

/** Control characters, which are a layout artefact at best in a shell-rendered toast. */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/g;

/**
 * Reduces an arbitrary IPC payload to a notification, or null when it is not one.
 *
 * Control characters are replaced rather than escaped: a notification body is rendered by the
 * Windows shell, not by a markup parser, so there is nothing to escape them into. Whitespace is
 * collapsed for the same reason — a toast is one line.
 */
export function sanitizeNotificationRequest(payload: unknown): DesktopNotificationRequest | null {
  if (typeof payload !== 'object' || payload === null) return null;

  const source = payload as Record<string, unknown>;

  const clean = (value: unknown, limit: number): string => {
    if (typeof value !== 'string') return '';
    return value.replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
  };

  const title = clean(source.title, MAX_TITLE_LENGTH);
  // A notification with no title is not one anybody can act on.
  if (title.length === 0) return null;

  return {
    title,
    body: clean(source.body, MAX_BODY_LENGTH),
    tag: clean(source.tag, MAX_TAG_LENGTH),
    silent: source.silent === true,
  };
}
