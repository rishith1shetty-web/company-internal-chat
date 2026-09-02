/**
 * The notification centre — duplicates, the toast stack, and the surfaces it drives.
 *
 * Driven directly, with a fake chime, a fake `Notification` and a hand-cranked clock, so the
 * sequential behaviour that matters can be asserted step by step: a duplicate arriving second, a
 * fourth toast pushing the first out, a timer firing after a manual dismiss. None of it needs a
 * DOM or a React renderer, which is exactly why this logic lives outside the hook.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  MAX_TOASTS,
  TOAST_TTL_MS,
  createNotificationCenter,
  type NotificationCenter,
} from '@/lib/notifications/center';
import type { IncomingMessageEvent } from '@/lib/notifications/describe';
import type { DesktopPermission } from '@/lib/notifications/desktop';
import type { NotificationPreferences } from '@/lib/notifications/preferences';
import type { Chime } from '@/lib/notifications/sound';

/* --------------------------------------------------------------------------------- harness */

function fakeChime() {
  let plays = 0;
  const chime: Chime = {
    play: () => {
      plays += 1;
    },
    isBlocked: () => false,
  };
  return { chime, plays: () => plays };
}

/** A clock that only moves when a test says so. */
function fakeTimers() {
  const pending = new Map<number, { at: number; handler: () => void }>();
  let now = 0;
  let nextId = 1;

  return {
    setTimer: (handler: () => void, ms: number) => {
      const id = nextId++;
      pending.set(id, { at: now + ms, handler });
      return id;
    },
    clearTimer: (handle: unknown) => {
      pending.delete(handle as number);
    },
    /** Runs everything due within `ms`, in order. */
    advance(ms: number) {
      now += ms;
      const due = [...pending.entries()]
        .filter(([, timer]) => timer.at <= now)
        .sort((a, b) => a[1].at - b[1].at);
      for (const [id, timer] of due) {
        pending.delete(id);
        timer.handler();
      }
    },
    outstanding: () => pending.size,
  };
}

/** A stand-in for the browser's `Notification`, recording what it was asked to show. */
function fakeNotifications(permission: 'granted' | 'denied' | 'default' = 'granted') {
  const shown: { title: string; body: string; tag: string; silent: boolean }[] = [];
  const clicked: unknown[] = [];
  let focusCalls = 0;

  class FakeNotification {
    onclick: ((event: unknown) => unknown) | null = null;
    static permission = permission;
    static requestPermission = () => Promise.resolve(permission);

    constructor(title: string, options?: { body?: string; tag?: string; silent?: boolean }) {
      shown.push({
        title,
        body: options?.body ?? '',
        tag: options?.tag ?? '',
        silent: options?.silent ?? false,
      });
      // Keep the instance so a test can fire its click handler.
      clicked.push(this);
    }

    close() {
      /* nothing to release in a fake */
    }
  }

  return {
    scope: {
      Notification: FakeNotification as unknown as never,
      focus: () => {
        focusCalls += 1;
      },
    },
    shown,
    instances: clicked as { onclick: ((event: unknown) => unknown) | null }[],
    focusCalls: () => focusCalls,
  };
}

const ALL_ON: NotificationPreferences = { sound: true, inApp: true, desktop: true };

interface Harness {
  center: NotificationCenter;
  plays: () => number;
  timers: ReturnType<typeof fakeTimers>;
  opened: string[];
  desktop: ReturnType<typeof fakeNotifications>;
  setPreferences: (next: NotificationPreferences) => void;
}

function harness(
  options: {
    preferences?: NotificationPreferences;
    permission?: DesktopPermission;
    focused?: boolean;
    desktopPermission?: 'granted' | 'denied' | 'default';
  } = {},
): Harness {
  const { chime, plays } = fakeChime();
  const timers = fakeTimers();
  const desktop = fakeNotifications(options.desktopPermission ?? 'granted');
  const opened: string[] = [];

  let preferences = options.preferences ?? ALL_ON;
  const openConversation = (id: string) => opened.push(id);

  const center = createNotificationCenter({
    chime,
    context: {
      preferences,
      permission: options.permission ?? 'granted',
      openConversation,
    },
    isAppFocused: () => options.focused ?? true,
    desktopScope: desktop.scope,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  return {
    center,
    plays,
    timers,
    opened,
    desktop,
    setPreferences(next) {
      preferences = next;
      center.setContext({
        preferences,
        permission: options.permission ?? 'granted',
        openConversation,
      });
    },
  };
}

let counter = 0;
function event(overrides: Partial<IncomingMessageEvent> = {}): IncomingMessageEvent {
  counter += 1;
  return {
    messageId: `message-${counter}`,
    conversationId: 'conversation-a',
    title: 'Rishith',
    body: 'Can you review the report?',
    senderId: 'user-them',
    senderName: 'Rishith',
    isGroup: false,
    filename: null,
    createdAt: '2026-09-02T10:15:00.000Z',
    isOwnMessage: false,
    isSystemMessage: false,
    isOpenConversation: false,
    ...overrides,
  };
}

/* ----------------------------------------------------------------------------- the tests */

describe('an incoming message', () => {
  it('chimes and shows a toast', () => {
    const { center, plays } = harness();

    center.handle(event({ messageId: 'm1' }));

    expect(plays()).toBe(1);
    expect(center.toasts()).toHaveLength(1);
    expect(center.toasts()[0]?.title).toBe('Rishith');
  });

  it('carries the group name, sender and file through to the toast', () => {
    const { center } = harness();

    center.handle(
      event({
        messageId: 'm2',
        title: 'Engineering Team',
        body: 'Rishith sent report.pdf',
        isGroup: true,
        filename: 'report.pdf',
      }),
    );

    const toast = center.toasts()[0];
    expect(toast?.title).toBe('Engineering Team');
    expect(toast?.body).toBe('Rishith sent report.pdf');
    expect(toast?.isGroup).toBe(true);
    expect(toast?.filename).toBe('report.pdf');
  });

  it('does nothing at all for your own message', () => {
    const { center, plays, desktop } = harness();

    center.handle(event({ messageId: 'm3', isOwnMessage: true }));

    expect(plays()).toBe(0);
    expect(center.toasts()).toHaveLength(0);
    expect(desktop.shown).toHaveLength(0);
  });

  it('does nothing at all for a SYSTEM message', () => {
    const { center, plays } = harness();

    center.handle(event({ messageId: 'm4', isSystemMessage: true }));

    expect(plays()).toBe(0);
    expect(center.toasts()).toHaveLength(0);
  });
});

describe('duplicate suppression', () => {
  it('announces the same message once, however many times it is delivered', () => {
    const { center, plays } = harness();
    const arrival = event({ messageId: 'same-id' });

    center.handle(arrival);
    center.handle(arrival);
    center.handle({ ...arrival });

    expect(plays()).toBe(1);
    expect(center.toasts()).toHaveLength(1);
  });

  it('reports the repeat as having done nothing', () => {
    const { center } = harness();
    const arrival = event({ messageId: 'same-id-2' });

    expect(center.handle(arrival).sound).toBe(true);
    expect(center.handle(arrival)).toEqual({ sound: false, toast: false, desktop: false });
  });

  /*
   * A history page or a reconnect backfill never reaches the centre at all — those are REST reads
   * that dispatch into the reducer. But if the same ids were ever replayed through here, the
   * guard would still hold, so the property is asserted rather than assumed.
   */
  it('stays quiet when a batch of already-seen messages is replayed', () => {
    const { center, plays } = harness();
    const batch = [
      event({ messageId: 'h1' }),
      event({ messageId: 'h2' }),
      event({ messageId: 'h3' }),
    ];

    for (const item of batch) center.handle(item);
    expect(plays()).toBe(3);

    // The reconnect: the same three, again.
    for (const item of batch) center.handle(item);
    expect(plays()).toBe(3);
  });

  it('does not let a silent message consume its id', () => {
    // Your own message must not "use up" its id: if the rules later said to announce that id,
    // the record must not already claim it was announced.
    const { center, plays } = harness();

    center.handle(event({ messageId: 'shared-id', isOwnMessage: true }));
    center.handle(event({ messageId: 'shared-id', isOwnMessage: false }));

    expect(plays()).toBe(1);
  });
});

describe('the toast stack', () => {
  it('keeps the newest last', () => {
    const { center } = harness();

    center.handle(event({ messageId: 'a', title: 'First' }));
    center.handle(event({ messageId: 'b', title: 'Second' }));

    expect(center.toasts().map((toast) => toast.title)).toEqual(['First', 'Second']);
  });

  it('never grows past the cap, dropping the oldest', () => {
    const { center } = harness();

    for (let index = 0; index < MAX_TOASTS + 3; index += 1) {
      center.handle(event({ messageId: `burst-${index}`, title: `Message ${index}` }));
    }

    const titles = center.toasts().map((toast) => toast.title);
    expect(titles).toHaveLength(MAX_TOASTS);
    expect(titles).toEqual(['Message 3', 'Message 4', 'Message 5']);
  });

  it('dismisses itself after the display time', () => {
    const { center, timers } = harness();

    center.handle(event({ messageId: 'ttl' }));
    expect(center.toasts()).toHaveLength(1);

    timers.advance(TOAST_TTL_MS - 1);
    expect(center.toasts()).toHaveLength(1);

    timers.advance(1);
    expect(center.toasts()).toHaveLength(0);
  });

  it('can be dismissed by hand, and then its timer does nothing', () => {
    const { center, timers } = harness();

    center.handle(event({ messageId: 'manual' }));
    center.dismiss('manual');

    expect(center.toasts()).toHaveLength(0);
    expect(timers.outstanding()).toBe(0);

    // The timer must not fire into an empty stack, or dismiss a later toast that reused the slot.
    timers.advance(TOAST_TTL_MS * 2);
    expect(center.toasts()).toHaveLength(0);
  });

  it('leaves the stack reference untouched when a dismissal dismisses nothing', () => {
    const { center } = harness();

    center.handle(event({ messageId: 'kept' }));
    const before = center.toasts();

    center.dismiss('never-existed');

    // An identical reference is what stops React re-rendering for a no-op.
    expect(center.toasts()).toBe(before);
  });

  it('tells subscribers when the stack changes, and stops when they leave', () => {
    const { center, timers } = harness();
    const listener = vi.fn();

    const unsubscribe = center.subscribe(listener);
    center.handle(event({ messageId: 'notify-1' }));
    expect(listener).toHaveBeenCalledTimes(1);

    timers.advance(TOAST_TTL_MS);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    center.handle(event({ messageId: 'notify-2' }));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('drops every pending timer when disposed', () => {
    const { center, timers } = harness();

    center.handle(event({ messageId: 'd1' }));
    center.handle(event({ messageId: 'd2' }));
    expect(timers.outstanding()).toBe(2);

    center.dispose();
    expect(timers.outstanding()).toBe(0);
  });
});

describe('desktop notifications', () => {
  it('shows one when the tab is in the background', () => {
    const { center, desktop, plays } = harness({ focused: false });

    center.handle(event({ messageId: 'bg-1', title: 'Rishith', body: 'Sent report.pdf' }));

    expect(desktop.shown).toEqual([
      { title: 'Rishith', body: 'Sent report.pdf', tag: 'conversation-a', silent: true },
    ]);
    // The chime is ours, so the OS notification is silent — one sound, not two.
    expect(plays()).toBe(1);
    // And no toast piles up behind a popup nobody can see.
    expect(center.toasts()).toHaveLength(0);
  });

  it('tags by conversation, so a busy group replaces its own popup', () => {
    const { center, desktop } = harness({ focused: false });

    center.handle(event({ messageId: 'g1', conversationId: 'group-x' }));
    center.handle(event({ messageId: 'g2', conversationId: 'group-x' }));

    expect(desktop.shown.map((item) => item.tag)).toEqual(['group-x', 'group-x']);
  });

  it('opens the conversation when the popup is clicked, and focuses the window', () => {
    const { center, desktop, opened } = harness({ focused: false });

    center.handle(event({ messageId: 'click-1', conversationId: 'conversation-z' }));
    desktop.instances[0]?.onclick?.({});

    expect(opened).toEqual(['conversation-z']);
    expect(desktop.focusCalls()).toBe(1);
  });

  it('shows nothing and falls back to a toast when permission was denied', () => {
    const { center, desktop } = harness({
      focused: false,
      permission: 'denied',
      desktopPermission: 'denied',
    });

    center.handle(event({ messageId: 'denied-1' }));

    expect(desktop.shown).toHaveLength(0);
    expect(center.toasts()).toHaveLength(1);
  });

  it('falls back to a toast when the browser has no Notification API', () => {
    const { chime } = fakeChime();
    const timers = fakeTimers();

    const center = createNotificationCenter({
      chime,
      context: { preferences: ALL_ON, permission: 'unsupported', openConversation: () => {} },
      isAppFocused: () => false,
      desktopScope: {},
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    center.handle(event({ messageId: 'unsupported-1' }));

    expect(center.toasts()).toHaveLength(1);
  });

  it('shows nothing while the employee is looking at the application', () => {
    const { center, desktop } = harness({ focused: true });

    center.handle(event({ messageId: 'focused-1' }));

    expect(desktop.shown).toHaveLength(0);
    expect(center.toasts()).toHaveLength(1);
  });
});

describe('live preference changes', () => {
  /*
   * The centre outlives every render, so a switch flipped in Settings has to reach it. Capturing
   * preferences at construction is the bug this guards.
   */
  it('takes effect on the very next message', () => {
    const context = harness();

    context.center.handle(event({ messageId: 'before' }));
    expect(context.plays()).toBe(1);
    expect(context.center.toasts()).toHaveLength(1);

    context.setPreferences({ sound: false, inApp: false, desktop: false });
    context.center.handle(event({ messageId: 'after' }));

    expect(context.plays()).toBe(1);
    expect(context.center.toasts()).toHaveLength(1);
  });

  it('suppresses only the sound when sounds alone are switched off', () => {
    const context = harness();

    context.setPreferences({ sound: false, inApp: true, desktop: true });
    context.center.handle(event({ messageId: 'muted' }));

    expect(context.plays()).toBe(0);
    expect(context.center.toasts()).toHaveLength(1);
  });

  it('suppresses only the toast when in-app notifications alone are switched off', () => {
    const context = harness();

    context.setPreferences({ sound: true, inApp: false, desktop: true });
    context.center.handle(event({ messageId: 'no-toast' }));

    expect(context.plays()).toBe(1);
    expect(context.center.toasts()).toHaveLength(0);
  });
});
