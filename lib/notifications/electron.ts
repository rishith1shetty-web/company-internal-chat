'use client';

/**
 * Native Windows notifications, when the page is running inside the desktop client.
 *
 * THE SHAPE OF THIS FILE IS ITS WHOLE ARGUMENT. `showDesktopNotification` already takes an
 * injectable `DesktopScope` (lib/notifications/desktop.ts) — a `Notification` constructor and a
 * `focus` function. So the desktop client does not need a second notification path, a branch in
 * the policy, or a flag threaded through the centre: it needs an object of that shape backed by
 * the preload bridge instead of by the browser. Everything above it — `planNotification`, the
 * duplicate guard, the toast stack, the wording, and their 103 tests — is untouched and cannot
 * tell the difference.
 *
 * WHY IT IS NEEDED AT ALL. The desktop client can hide its window to the system tray, and a
 * notification click has to bring that window back. A renderer cannot show a hidden
 * BrowserWindow — `window.focus()` does nothing for one — so only the main process can complete
 * the click, which is the whole point of clicking. On top of that the desktop client denies every
 * browser permission by default, notifications included, so the page's own API would be refused
 * here anyway.
 *
 * A CORRECTION WORTH RECORDING, because the obvious guess is wrong: inside Electron
 * `window.Notification` IS defined even on a plain-http LAN origin, where `isSecureContext` is
 * false — Electron does not apply Chromium's secure-context gating to it. That gating is real for
 * Chrome and Edge, and it is why *browser* users on plain http get the toast fallback instead of
 * a desktop popup (docs/17-notifications.md), but it is not the reason this file exists.
 *
 * WHAT IS DIFFERENT ABOUT THE DESKTOP SCOPE, stated so the differences are deliberate:
 *
 *   - `permission` is always `granted`. There is no operating-system prompt to ask for; the
 *     employee's control is the switch in Settings, which is where it belonged anyway.
 *   - The icon is the packaged application's own, chosen by the main process. The web path's
 *     `/brand/rising-path-mark.png` is not used here because a Windows toast icon is a file on
 *     disk, not a URL — it is the same mark either way.
 *   - `focus` is absent on purpose: the main process shows and focuses the window itself, for the
 *     reason above.
 */

import type {
  DesktopScope,
  NotificationConstructorLike,
  NotificationLike,
  NotificationOptionsLike,
} from './desktop';

/** The half of the preload bridge this module uses. See desktop/preload.ts for the whole of it. */
export interface DesktopBridge {
  readonly isDesktop: true;
  notify(payload: {
    id: string;
    title: string;
    body: string;
    tag: string;
    silent: boolean;
  }): void;
  closeNotification(id: string): void;
  onNotificationClick(handler: (id: string) => void): () => void;
}

/**
 * Returns the bridge when this page is running inside the desktop client, otherwise null.
 *
 * Every method is checked rather than trusting `isDesktop`, so a partial or future bridge causes
 * a clean fall back to the browser path instead of a call to something that is not there.
 */
export function readDesktopBridge(scope: unknown = typeof window === 'undefined' ? undefined : window): DesktopBridge | null {
  if (typeof scope !== 'object' || scope === null) return null;

  const candidate = (scope as Record<string, unknown>).risingPathDesktop;
  if (typeof candidate !== 'object' || candidate === null) return null;

  const bridge = candidate as Partial<DesktopBridge>;

  return bridge.isDesktop === true &&
    typeof bridge.notify === 'function' &&
    typeof bridge.closeNotification === 'function' &&
    typeof bridge.onNotificationClick === 'function'
    ? (bridge as DesktopBridge)
    : null;
}

/** Unique per popup, so a click can be routed back to the object that was constructed. */
function newNotificationId(): string {
  try {
    const cryptoApi = globalThis.crypto;
    if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
  } catch {
    // Falls through to the counter below.
  }
  return `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Builds a `DesktopScope` backed by the desktop client.
 *
 * The returned `Notification` is constructor-shaped rather than a function that shows a popup,
 * because that is the contract `showDesktopNotification` is written against: it constructs one,
 * assigns `onclick`, and may later call `close()`. Matching that shape is what lets the desktop
 * client reuse every line of the browser implementation.
 */
export function createDesktopScope(bridge: DesktopBridge): DesktopScope {
  /*
   * Popups currently on screen, by id.
   *
   * A Windows toast outlives the call that created it — it sits in the corner, and then in the
   * Action Center — so the object whose `onclick` must fire has to be findable when the click
   * eventually arrives. Entries are removed on click and on close, so this does not grow.
   */
  const live = new Map<string, DesktopNotificationHandle>();

  /*
   * One subscription for the lifetime of the page, not one per notification.
   *
   * Subscribing inside the constructor would add a listener per message and remove none of them.
   */
  bridge.onNotificationClick((id) => {
    const handle = live.get(id);
    if (!handle) return;

    live.delete(id);
    handle.fireClick();
  });

  class DesktopNotificationHandle implements NotificationLike {
    onclick: ((this: unknown, event: unknown) => unknown) | null = null;

    private readonly id = newNotificationId();

    constructor(title: string, options?: NotificationOptionsLike) {
      live.set(this.id, this);

      bridge.notify({
        id: this.id,
        title,
        body: options?.body ?? '',
        // The conversation id, used by the main process to replace this conversation's previous
        // popup rather than stacking a new one beside it.
        tag: options?.tag ?? '',
        silent: options?.silent === true,
      });
    }

    close(): void {
      live.delete(this.id);
      bridge.closeNotification(this.id);
    }

    /** Called from the bridge subscription above. Kept off the public `NotificationLike` shape. */
    fireClick(): void {
      try {
        this.onclick?.call(this, { type: 'click' });
      } catch {
        // A handler that throws must not take down the IPC listener for every later click.
      }
    }
  }

  const constructor = DesktopNotificationHandle as unknown as NotificationConstructorLike;
  // Always granted: the popup is drawn by the application's own process, so there is no operating
  // system permission in the way. Settings remains the employee's on/off switch.
  constructor.permission = 'granted';
  constructor.requestPermission = () => Promise.resolve('granted');

  return {
    Notification: constructor,
    // No `focus`: the main process reveals the window on click, and it is the only side that can
    // when the window is hidden in the tray.
  };
}

/** The scope for this environment: the desktop client's, or undefined to use the browser's. */
export function desktopClientScope(): DesktopScope | undefined {
  const bridge = readDesktopBridge();
  return bridge ? createDesktopScope(bridge) : undefined;
}
