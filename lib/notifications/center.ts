/**
 * The notification centre: everything that happens when a message arrives, with no React in it.
 *
 * WHY THIS IS NOT A HOOK. The interesting behaviour here is stateful and sequential — a duplicate
 * arriving second, a fourth toast pushing the first out, a timer firing after a manual dismiss —
 * and none of it is about rendering. Kept inside a hook it would need a DOM, a React renderer and
 * a testing library to exercise at all, which is three dependencies bought to test logic that
 * never needed them. As a plain object it is driven directly: call `handle`, read `toasts()`,
 * advance the injected clock.
 *
 * The React hook (useNotifications.ts) owns exactly what React must own — the state that causes a
 * render — and delegates the rest here.
 *
 * Everything external is injected: the chime, the browser's `Notification`, the timer functions,
 * and the changing values pushed in with `setContext`. There is no global read in this file.
 */

import { showDesktopNotification, type DesktopPermission, type DesktopScope } from './desktop';
import type { IncomingMessageEvent } from './describe';
import { isSilent, planNotification, type NotificationPlan } from './policy';
import type { NotificationPreferences } from './preferences';
import type { Chime } from './sound';

/** How long a toast stays before it removes itself. */
export const TOAST_TTL_MS = 5_000;

/**
 * How many toasts may be on screen at once.
 *
 * Three. Enough to see a short burst, few enough that a busy group cannot fill the corner — a
 * fourth arrival pushes the oldest out rather than growing the stack downwards into the composer.
 */
export const MAX_TOASTS = 3;

/** How many message ids are remembered for duplicate suppression. Bounded on purpose. */
export const SEEN_LIMIT = 300;

export interface ToastItem {
  /** The message id: unique, and the same value the duplicate guard uses. */
  key: string;
  conversationId: string;
  title: string;
  body: string;
  senderId: string | null;
  senderName: string | null;
  isGroup: boolean;
  filename: string | null;
  createdAt: string;
}

/**
 * The values that change underneath a long-lived centre.
 *
 * Pushed in with `setContext` rather than read through callbacks the caller owns. The difference
 * matters: the centre outlives every render, and a preference flipped in Settings has to take
 * effect on the very next message rather than whenever something happens to rebuild the centre.
 */
export interface NotificationContextValues {
  preferences: NotificationPreferences;
  permission: DesktopPermission;
  openConversation: (conversationId: string) => void;
}

export interface NotificationCenterOptions {
  chime: Chime;
  /** The starting context. Replaced wholesale by `setContext`. */
  context: NotificationContextValues;
  /** Visible AND focused. Chooses the surface; never whether there is one. */
  isAppFocused: () => boolean;
  desktopScope?: DesktopScope;
  toastTtlMs?: number;
  maxToasts?: number;
  /** Injectable timers, so a test does not have to wait five real seconds. */
  setTimer?: (handler: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface NotificationCenter {
  /** Feed an arrived message in. Returns what it decided, which the tests assert on. */
  handle(event: IncomingMessageEvent): NotificationPlan;
  /** Replaces the live values. Cheap, and safe to call on every render. */
  setContext(values: NotificationContextValues): void;
  /** The current stack, oldest first. Referentially stable until it changes. */
  toasts(): readonly ToastItem[];
  dismiss(key: string): void;
  /** Subscribe to stack changes. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Clears every pending timer. Called when the interface unmounts. */
  dispose(): void;
}

export function createNotificationCenter(options: NotificationCenterOptions): NotificationCenter {
  const {
    chime,
    isAppFocused,
    desktopScope,
    toastTtlMs = TOAST_TTL_MS,
    maxToasts = MAX_TOASTS,
    setTimer = (handler, ms) => setTimeout(handler, ms),
    clearTimer = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  } = options;

  /*
   * A frozen array, replaced rather than mutated.
   *
   * `toasts()` is read by React as a snapshot, and a snapshot that returns a new array each call
   * makes React re-render forever. Replacing the reference only when the contents actually change
   * is what makes that safe.
   */
  let context = options.context;
  let current: readonly ToastItem[] = [];
  const listeners = new Set<() => void>();
  const timers = new Map<string, unknown>();

  /** Message ids already announced, oldest first, so the record cannot grow without limit. */
  const seenIds = new Set<string>();
  const seenOrder: string[] = [];

  const publish = (next: readonly ToastItem[]): void => {
    current = next;
    for (const listener of listeners) listener();
  };

  const clearTimerFor = (key: string): void => {
    const handle = timers.get(key);
    if (handle !== undefined) {
      clearTimer(handle);
      timers.delete(key);
    }
  };

  const dismiss = (key: string): void => {
    if (!current.some((toast) => toast.key === key)) {
      // Already gone. Still clear any timer, then publish nothing: an unchanged reference means
      // React does not re-render for a dismissal that dismissed nothing.
      clearTimerFor(key);
      return;
    }
    clearTimerFor(key);
    publish(current.filter((toast) => toast.key !== key));
  };

  const push = (item: ToastItem): void => {
    const next = [...current.filter((toast) => toast.key !== item.key), item];

    // Oldest out first, and its timer with it.
    while (next.length > maxToasts) {
      const dropped = next.shift();
      if (!dropped) break;
      clearTimerFor(dropped.key);
    }

    publish(next);
    timers.set(
      item.key,
      setTimer(() => dismiss(item.key), toastTtlMs),
    );
  };

  /** Records an id and reports whether it had been seen before. */
  const alreadyNotified = (messageId: string): boolean => {
    if (seenIds.has(messageId)) return true;

    seenIds.add(messageId);
    seenOrder.push(messageId);
    while (seenOrder.length > SEEN_LIMIT) {
      const oldest = seenOrder.shift();
      if (oldest !== undefined) seenIds.delete(oldest);
    }

    return false;
  };

  return {
    handle(event) {
      const { preferences } = context;

      const plan = planNotification({
        isOwnMessage: event.isOwnMessage,
        isSystemMessage: event.isSystemMessage,
        isOpenConversation: event.isOpenConversation,
        isAppFocused: isAppFocused(),
        canShowDesktop: preferences.desktop && context.permission === 'granted',
        preferences,
      });

      if (isSilent(plan)) return plan;

      /*
       * The duplicate check happens HERE, after the decision and not before it.
       *
       * A message that was never going to notify — your own, or a system line — must not consume
       * a slot in the record. If it did, the id would be marked as announced without anything
       * having been announced.
       */
      if (alreadyNotified(event.messageId)) {
        return { sound: false, toast: false, desktop: false };
      }

      if (plan.sound) chime.play();

      if (plan.toast) {
        push({
          key: event.messageId,
          conversationId: event.conversationId,
          title: event.title,
          body: event.body,
          senderId: event.senderId,
          senderName: event.senderName,
          isGroup: event.isGroup,
          filename: event.filename,
          createdAt: event.createdAt,
        });
      }

      if (plan.desktop) {
        showDesktopNotification(
          {
            title: event.title,
            body: event.body,
            // One popup per conversation: a busy group replaces its own rather than stacking.
            tag: event.conversationId,
            // The chime is ours; letting the OS add its own is a double sound on every message.
            silent: plan.sound,
            // Read at click time, not at show time: a popup can outlive several renders.
            onClick: () => context.openConversation(event.conversationId),
          },
          desktopScope,
        );
      }

      return plan;
    },

    setContext(values) {
      context = values;
    },

    toasts() {
      return current;
    },

    dismiss,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    dispose() {
      for (const handle of timers.values()) clearTimer(handle);
      timers.clear();
      listeners.clear();
    },
  };
}
