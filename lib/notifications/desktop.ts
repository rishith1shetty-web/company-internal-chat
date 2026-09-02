/**
 * Browser/desktop notifications — the surface for a chat tab sitting behind Excel.
 *
 * PERMISSION IS ASKED FOR ONCE, FROM A BUTTON. `Notification.requestPermission()` is never called
 * on load, on connect, or on the first message. Browsers now require a user gesture for it in any
 * case, but the real reason is that an unexplained permission prompt on first visit is dismissed
 * reflexively — and "denied" is permanent from the page's point of view. So the prompt happens
 * only when somebody presses "Turn on desktop notifications" in Settings, having just read what
 * it does. After a denial the application never asks again; it says so in Settings and points at
 * the browser's own site settings, which is the only place a denial can be undone.
 *
 * WHAT REACHES THE OPERATING SYSTEM. A title, a one-line body, and the company mark as the icon.
 * No id, no path, no storage key (lib/notifications/describe.ts). The content is the same message
 * the socket already delivered to this authorized session, so the notification cannot reveal
 * anything the tab behind it does not already hold.
 */

/** What the browser will currently allow. `unsupported` is a real answer, not an error. */
export type DesktopPermission = 'unsupported' | 'default' | 'granted' | 'denied';

/** The static side of the `Notification` API, narrowed to what this module uses. */
export interface NotificationConstructorLike {
  new (title: string, options?: NotificationOptionsLike): NotificationLike;
  permission: string;
  requestPermission(): Promise<string> | void;
}

export interface NotificationOptionsLike {
  body?: string;
  tag?: string;
  icon?: string;
  silent?: boolean;
}

export interface NotificationLike {
  onclick: ((this: unknown, event: unknown) => unknown) | null;
  close(): void;
}

/** The globals this module touches. Injectable so every branch below is testable. */
export interface DesktopScope {
  Notification?: NotificationConstructorLike | undefined;
  focus?: () => void;
}

function scopeOf(scope?: DesktopScope): DesktopScope {
  return scope ?? (globalThis as unknown as DesktopScope);
}

/** The company mark, from this origin. The exact existing brand asset — never a generated one. */
export const NOTIFICATION_ICON = '/brand/rising-path-mark.png';

export function desktopPermission(scope?: DesktopScope): DesktopPermission {
  const api = scopeOf(scope).Notification;
  if (!api) return 'unsupported';

  const value = api.permission;
  return value === 'granted' || value === 'denied' ? value : 'default';
}

/**
 * Asks the browser for permission. Call this ONLY from a user gesture in Settings.
 *
 * Returns the resulting state rather than a boolean, so the caller can tell "the employee closed
 * the prompt without choosing" (still `default`) from "the employee said no" (`denied`) — which
 * are different things to show in Settings.
 */
export async function requestDesktopPermission(scope?: DesktopScope): Promise<DesktopPermission> {
  const api = scopeOf(scope).Notification;
  if (!api) return 'unsupported';

  // Already decided, either way: asking again is a no-op in every browser, and re-prompting a
  // user who declined is the behaviour that gets a site permanently blocked.
  if (api.permission === 'granted') return 'granted';
  if (api.permission === 'denied') return 'denied';

  try {
    const result = await api.requestPermission();
    if (result === 'granted' || result === 'denied') return result;
    // Safari's older callback form resolves undefined; fall back to reading the property.
    return desktopPermission(scope);
  } catch {
    return desktopPermission(scope);
  }
}

export interface DesktopRequest {
  title: string;
  body: string;
  /**
   * Groups popups for one conversation.
   *
   * A second message in the same conversation REPLACES the first popup rather than adding to a
   * pile of them. The trade is that the replacement does not re-alert on its own — which is why
   * the chime is played separately and is not left to the operating system.
   */
  tag: string;
  /** True when this application is playing its own chime, so the OS does not play a second one. */
  silent: boolean;
  onClick: () => void;
}

/**
 * Shows a desktop notification, or returns null when it cannot.
 *
 * Never throws. A browser that supports the constructor but refuses it in this context (some
 * mobile browsers require a service worker) fails as a null rather than as an exception in the
 * middle of handling a message.
 */
export function showDesktopNotification(
  request: DesktopRequest,
  scope?: DesktopScope,
): NotificationLike | null {
  const target = scopeOf(scope);
  const api = target.Notification;

  if (!api || api.permission !== 'granted') return null;

  try {
    const notification = new api(request.title, {
      body: request.body,
      tag: request.tag,
      icon: NOTIFICATION_ICON,
      silent: request.silent,
    });

    notification.onclick = () => {
      /*
       * Bring the tab forward, then open the conversation. `window.focus()` from a notification
       * click is one of the few places browsers still honour it; where they do not, the click at
       * least selects the conversation, so returning to the tab by hand lands in the right place.
       */
      try {
        target.focus?.();
      } catch {
        // A browser that refuses to focus is not a reason to skip the navigation below.
      }
      notification.close();
      request.onClick();
    };

    return notification;
  } catch {
    return null;
  }
}
