'use client';

/**
 * React's share of the notification feature: the state that causes a render, and nothing else.
 *
 * The decision is `planNotification` (policy.ts) and the stateful machinery — duplicate
 * suppression, the toast stack, its timers, the chime and the desktop popup — is
 * `createNotificationCenter` (center.ts). Both are plain and both are tested directly, without a
 * DOM or a React renderer. What is left here is wiring: preferences, the browser permission, and
 * a subscription that turns the centre's stack into a render.
 *
 * FOCUS IS READ WHEN A MESSAGE ARRIVES, not held in state. A message is handled inside a socket
 * callback; React state read from that closure can be a render behind, which would mean deciding
 * "they are looking at this" about a tab left several seconds ago. `visibilityState` and
 * `hasFocus()` read at the point of decision cannot be stale.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { createNotificationCenter, type NotificationCenter, type ToastItem } from './center';
import {
  desktopPermission,
  requestDesktopPermission,
  type DesktopPermission,
  type DesktopScope,
} from './desktop';
import type { IncomingMessageEvent } from './describe';
import {
  loadPreferences,
  savePreferences,
  type NotificationPreferences,
  type PreferenceStore,
} from './preferences';
import { createChime, type Chime, type ChimeOptions } from './sound';

export type { ToastItem } from './center';

export interface UseNotificationsOptions {
  /** Called when a toast or a desktop notification is clicked. */
  openConversation: (conversationId: string) => void;
  /** Test seams. The application supplies none of these. */
  chime?: Chime | ChimeOptions;
  store?: PreferenceStore | null;
  desktopScope?: DesktopScope;
  isAppFocused?: () => boolean;
}

export interface NotificationsApi {
  toasts: readonly ToastItem[];
  dismissToast: (key: string) => void;
  /** Feed a message in. Safe to call with anything: it decides whether to do nothing. */
  notify: (event: IncomingMessageEvent) => void;
  preferences: NotificationPreferences;
  setPreference: (key: keyof NotificationPreferences, value: boolean) => void;
  /** What the browser currently allows. */
  permission: DesktopPermission;
  /** Asks the browser. Call only from a click. Turns the preference on when granted. */
  enableDesktop: () => Promise<DesktopPermission>;
  /** True once the browser has refused to play the chime for want of an interaction. */
  soundBlocked: boolean;
  /** Plays the chime on demand, so Settings can offer a preview. */
  testSound: () => void;
}

/** Visible AND focused. A tab behind a spreadsheet is not being looked at. */
function documentIsFocused(): boolean {
  if (typeof document === 'undefined') return false;

  try {
    if (document.visibilityState !== 'visible') return false;
    // `hasFocus` is missing in some embedded contexts; visibility alone is the fallback.
    return typeof document.hasFocus === 'function' ? document.hasFocus() : true;
  } catch {
    return false;
  }
}

/** Stable empty snapshot for the server render: a new array each call would loop React. */
const NO_TOASTS: readonly ToastItem[] = [];

export function useNotifications(options: UseNotificationsOptions): NotificationsApi {
  const { openConversation, store, desktopScope, isAppFocused = documentIsFocused } = options;

  /*
   * Read once, during the first render, rather than assigned from an effect afterwards.
   *
   * Safe for hydration despite `localStorage` and `Notification` being absent on the server,
   * because nothing derived from either is in the initial markup: the toast stack starts empty and
   * the settings dialog renders null while closed. Setting these from an effect instead would
   * cost an extra render on every mount to arrive at the same place.
   */
  const [preferences, setPreferences] = useState<NotificationPreferences>(() =>
    loadPreferences(store === undefined ? undefined : store),
  );
  const [permission, setPermission] = useState<DesktopPermission>(() =>
    desktopPermission(desktopScope),
  );
  const [soundBlocked, setSoundBlocked] = useState(false);

  /*
   * Built once, on the first render, and kept for the life of the component.
   *
   * `useState` with a lazy initialiser rather than a ref: the value never changes, so it is state
   * in the "created once" sense, and it keeps the construction out of the render body — a ref
   * assigned during render is both a lint error here and a hazard under concurrent rendering.
   */
  const [chime] = useState<Chime>(() => {
    const supplied = options.chime;
    return supplied && typeof (supplied as Chime).play === 'function'
      ? (supplied as Chime)
      : createChime((supplied as ChimeOptions | undefined) ?? {});
  });

  const [center] = useState<NotificationCenter>(() =>
    createNotificationCenter({
      chime,
      context: { preferences, permission, openConversation },
      isAppFocused,
      ...(desktopScope ? { desktopScope } : {}),
    }),
  );

  /*
   * Keep the centre's view of the world current.
   *
   * The centre is built once and outlives every render, so a preference flipped in Settings — or
   * a new conversation-open handler — has to be pushed in rather than waiting to be captured.
   * An effect, so nothing is written during render.
   */
  useEffect(() => {
    center.setContext({ preferences, permission, openConversation });
  }, [center, preferences, permission, openConversation]);

  // Every pending timer is cleared on unmount: one firing into a removed component is both a
  // React warning and a leaked handle per message.
  useEffect(() => () => center.dispose(), [center]);

  /*
   * The toast stack, read as an external store.
   *
   * The centre owns it and replaces the array only when it changes, so this is a stable snapshot
   * rather than a new array on every read — which is what would otherwise send React into a loop.
   */
  const toasts = useSyncExternalStore(
    useCallback((listener: () => void) => center.subscribe(listener), [center]),
    useCallback(() => center.toasts(), [center]),
    () => NO_TOASTS,
  );

  const notify = useCallback(
    (event: IncomingMessageEvent) => {
      const plan = center.handle(event);
      if (plan.sound) {
        // Surfaced in Settings so "no sound" has an explanation rather than looking broken.
        setSoundBlocked(chime.isBlocked());
      }
    },
    [center, chime],
  );

  const dismissToast = useCallback((key: string) => center.dismiss(key), [center]);

  const persist = useCallback(
    (next: NotificationPreferences) => {
      savePreferences(next, store === undefined ? undefined : store);
      return next;
    },
    [store],
  );

  const setPreference = useCallback(
    (key: keyof NotificationPreferences, value: boolean) => {
      setPreferences((currentPreferences) => persist({ ...currentPreferences, [key]: value }));
    },
    [persist],
  );

  const enableDesktop = useCallback(async (): Promise<DesktopPermission> => {
    const result = await requestDesktopPermission(desktopScope);
    setPermission(result);

    // The preference follows the answer: granted turns it on; anything else leaves it off rather
    // than storing an intent the browser will not honour.
    setPreferences((currentPreferences) =>
      persist({ ...currentPreferences, desktop: result === 'granted' }),
    );

    return result;
  }, [desktopScope, persist]);

  const testSound = useCallback(() => {
    chime.play();
    setSoundBlocked(chime.isBlocked());
  }, [chime]);

  return useMemo(
    () => ({
      toasts,
      dismissToast,
      notify,
      preferences,
      setPreference,
      permission,
      enableDesktop,
      soundBlocked,
      testSound,
    }),
    [
      toasts,
      dismissToast,
      notify,
      preferences,
      setPreference,
      permission,
      enableDesktop,
      soundBlocked,
      testSound,
    ],
  );
}
