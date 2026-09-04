/**
 * The desktop notification scope: the page's side of the native Windows notification.
 *
 * THE CLAIM THIS FILE EXISTS TO CHECK is that the desktop client changes the *surface* and
 * nothing else. `showDesktopNotification` is the same function in a browser and in the desktop
 * client (lib/notifications/desktop.ts); all that differs is the `DesktopScope` handed to it. So
 * these tests drive the real `showDesktopNotification` against the real desktop scope, with only
 * the preload bridge faked — which is the boundary the desktop client actually introduces.
 *
 * Runs in Node with no DOM, like the rest of the notification suite.
 */

import { describe, expect, it, vi } from 'vitest';

import { showDesktopNotification } from '@/lib/notifications/desktop';
import { createDesktopScope, readDesktopBridge, type DesktopBridge } from '@/lib/notifications/electron';

interface Sent {
  id: string;
  title: string;
  body: string;
  tag: string;
  silent: boolean;
}

/** A stand-in for the preload bridge (desktop/preload.ts). */
function fakeBridge() {
  const sent: Sent[] = [];
  const closed: string[] = [];
  let click: ((id: string) => void) | null = null;
  let subscriptions = 0;

  const bridge: DesktopBridge = {
    isDesktop: true,
    notify: (payload) => {
      sent.push(payload);
    },
    closeNotification: (id) => {
      closed.push(id);
    },
    onNotificationClick: (handler) => {
      subscriptions += 1;
      click = handler;
      return () => {
        click = null;
      };
    },
  };

  return {
    bridge,
    sent,
    closed,
    subscriptions: () => subscriptions,
    /** Simulates the employee clicking the Windows toast. */
    clickLast: () => click?.(sent[sent.length - 1]?.id ?? ''),
    clickId: (id: string) => click?.(id),
  };
}

/** A representative notification, in the shape the notification centre produces. */
function request(onClick: () => void = () => {}) {
  return {
    title: 'Engineering Team',
    body: 'Rishith sent report.pdf',
    tag: 'conversation-1',
    silent: true,
    onClick,
  };
}

describe('detecting the desktop client', () => {
  it('finds a complete bridge', () => {
    const { bridge } = fakeBridge();
    expect(readDesktopBridge({ risingPathDesktop: bridge })).toBe(bridge);
  });

  it('reports none in an ordinary browser', () => {
    expect(readDesktopBridge({})).toBeNull();
    expect(readDesktopBridge(undefined)).toBeNull();
    expect(readDesktopBridge(null)).toBeNull();
  });

  it('refuses a partial or counterfeit bridge rather than calling into it', () => {
    /*
     * Every method is checked rather than trusting the `isDesktop` flag. A page served to a
     * browser could define `window.risingPathDesktop` itself; falling back to the browser path is
     * the correct answer, and calling a method that is not there is not.
     */
    const { bridge } = fakeBridge();

    expect(readDesktopBridge({ risingPathDesktop: { isDesktop: true } })).toBeNull();
    expect(readDesktopBridge({ risingPathDesktop: { ...bridge, notify: 'no' } })).toBeNull();
    expect(readDesktopBridge({ risingPathDesktop: { ...bridge, isDesktop: false } })).toBeNull();
    expect(readDesktopBridge({ risingPathDesktop: 'yes' })).toBeNull();
  });
});

describe('permission', () => {
  it('is granted, because the application draws the popup itself', () => {
    // There is no operating-system prompt to ask for: the main process shows the toast. The
    // employee's control is the switch in Settings, which is where it belonged anyway.
    const scope = createDesktopScope(fakeBridge().bridge);

    expect(scope.Notification?.permission).toBe('granted');
  });

  it('answers a permission request without prompting anybody', async () => {
    const scope = createDesktopScope(fakeBridge().bridge);

    await expect(scope.Notification?.requestPermission()).resolves.toBe('granted');
  });
});

describe('showing one', () => {
  it('sends the title, body, tag and silence across the bridge', () => {
    const fake = fakeBridge();
    const scope = createDesktopScope(fake.bridge);

    showDesktopNotification(request(), scope);

    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toMatchObject({
      title: 'Engineering Team',
      body: 'Rishith sent report.pdf',
      tag: 'conversation-1',
      silent: true,
    });
  });

  it('gives every notification a distinct id', () => {
    // The id is how a click finds the object whose `onclick` must fire; two sharing one would
    // open the wrong conversation.
    const fake = fakeBridge();
    const scope = createDesktopScope(fake.bridge);

    showDesktopNotification(request(), scope);
    showDesktopNotification(request(), scope);

    expect(fake.sent[0]?.id).not.toBe(fake.sent[1]?.id);
    expect(fake.sent[0]?.id).toBeTruthy();
  });

  it('sends no icon, path or id in the visible text', () => {
    // What reaches the operating system is a title and a line of body. The id is routing, and it
    // is not rendered anywhere (lib/notifications/describe.ts).
    const fake = fakeBridge();
    const scope = createDesktopScope(fake.bridge);

    showDesktopNotification(request(), scope);

    const sent = fake.sent[0];
    expect(`${sent?.title} ${sent?.body}`).not.toContain(sent?.id ?? 'x');
    expect(Object.keys(sent ?? {}).sort()).toEqual(['body', 'id', 'silent', 'tag', 'title']);
  });

  it('subscribes to clicks once for the page, not once per notification', () => {
    /*
     * Subscribing inside the constructor would add an IPC listener per message and remove none of
     * them — a leak that grows with the working day.
     */
    const fake = fakeBridge();
    const scope = createDesktopScope(fake.bridge);

    for (let i = 0; i < 5; i += 1) showDesktopNotification(request(), scope);

    expect(fake.subscriptions()).toBe(1);
  });
});

describe('clicking one', () => {
  it('opens the conversation it came from', () => {
    const fake = fakeBridge();
    const scope = createDesktopScope(fake.bridge);
    const onClick = vi.fn();

    showDesktopNotification(request(onClick), scope);
    fake.clickLast();

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('routes to the right one when several are on screen', () => {
    const fake = fakeBridge();
    const scope = createDesktopScope(fake.bridge);
    const first = vi.fn();
    const second = vi.fn();

    showDesktopNotification({ ...request(), tag: 'c1', onClick: first }, scope);
    showDesktopNotification({ ...request(), tag: 'c2', onClick: second }, scope);

    fake.clickId(fake.sent[0]?.id ?? '');

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('does nothing on a second click of the same popup', () => {
    // Windows keeps a toast in the Action Center after it is clicked. Firing twice would select
    // the conversation twice, and — worse — would keep the entry alive for a third.
    const fake = fakeBridge();
    const scope = createDesktopScope(fake.bridge);
    const onClick = vi.fn();

    showDesktopNotification(request(onClick), scope);
    fake.clickLast();
    fake.clickLast();

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('ignores a click for an id it does not know', () => {
    const fake = fakeBridge();
    createDesktopScope(fake.bridge);

    expect(() => fake.clickId('never-issued')).not.toThrow();
  });

  it('survives a handler that throws, so later clicks still work', () => {
    /*
     * The click arrives on a single long-lived IPC subscription shared by every notification. An
     * exception escaping one handler would take that subscription down for the rest of the day.
     */
    const fake = fakeBridge();
    const scope = createDesktopScope(fake.bridge);
    const good = vi.fn();

    showDesktopNotification(
      {
        ...request(),
        onClick: () => {
          throw new Error('the conversation is gone');
        },
      },
      scope,
    );
    const badId = fake.sent[0]?.id ?? '';

    showDesktopNotification({ ...request(), onClick: good }, scope);
    const goodId = fake.sent[1]?.id ?? '';

    expect(() => fake.clickId(badId)).not.toThrow();
    fake.clickId(goodId);

    expect(good).toHaveBeenCalledTimes(1);
  });
});

describe('closing one', () => {
  it('tells the main process to dismiss it', () => {
    const fake = fakeBridge();
    const scope = createDesktopScope(fake.bridge);

    const notification = showDesktopNotification(request(), scope);
    notification?.close();

    expect(fake.closed).toEqual([fake.sent[0]?.id]);
  });

  it('stops a later click from firing', () => {
    const fake = fakeBridge();
    const scope = createDesktopScope(fake.bridge);
    const onClick = vi.fn();

    const notification = showDesktopNotification(request(onClick), scope);
    notification?.close();
    fake.clickLast();

    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('the browser path is untouched', () => {
  it('still reports unsupported when there is no Notification API and no bridge', () => {
    // The desktop integration adds a scope; it does not alter what happens without one. This is
    // the case of a plain-http browser tab, where Chrome and Edge — unlike Electron — really do
    // leave `window.Notification` undefined because the origin is not a secure context.
    expect(showDesktopNotification(request(), {})).toBeNull();
  });
});
