/**
 * Browser/desktop notifications: the permission states and what is shown.
 *
 * The rule this file exists to hold is that permission is asked for ONCE, deliberately, and never
 * again after a refusal. A page that re-prompts is a page users block permanently, and a blocked
 * origin cannot be un-blocked from the page — only from the browser's own settings.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  NOTIFICATION_ICON,
  desktopPermission,
  requestDesktopPermission,
  showDesktopNotification,
  type DesktopScope,
} from '@/lib/notifications/desktop';

interface Recorded {
  title: string;
  body?: string;
  tag?: string;
  icon?: string;
  silent?: boolean;
}

/** A browser with a `Notification` API in a given permission state. */
function browser(
  permission: string,
  options: { requestResolvesTo?: string; requestThrows?: boolean; constructorThrows?: boolean } = {},
) {
  const shown: Recorded[] = [];
  const instances: { onclick: ((event: unknown) => unknown) | null; closed: boolean }[] = [];
  const requestPermission = vi.fn(() => {
    if (options.requestThrows) throw new Error('not allowed here');
    return Promise.resolve(options.requestResolvesTo ?? permission);
  });
  let focused = 0;

  class FakeNotification {
    onclick: ((event: unknown) => unknown) | null = null;
    closed = false;
    static permission = permission;
    static requestPermission = requestPermission;

    constructor(title: string, init?: Omit<Recorded, 'title'>) {
      if (options.constructorThrows) throw new Error('Illegal constructor');
      shown.push({ title, ...init });
      instances.push(this);
    }

    close() {
      this.closed = true;
    }
  }

  const scope: DesktopScope = {
    Notification: FakeNotification as unknown as DesktopScope['Notification'],
    focus: () => {
      focused += 1;
    },
  };

  return { scope, shown, instances, requestPermission, focusCalls: () => focused };
}

describe('reading the permission', () => {
  it('reports each browser state', () => {
    expect(desktopPermission(browser('granted').scope)).toBe('granted');
    expect(desktopPermission(browser('denied').scope)).toBe('denied');
    expect(desktopPermission(browser('default').scope)).toBe('default');
  });

  it('reports a browser with no Notification API as unsupported', () => {
    expect(desktopPermission({})).toBe('unsupported');
  });

  it('treats an unrecognised value as "not yet asked"', () => {
    expect(desktopPermission(browser('something-else').scope)).toBe('default');
  });
});

describe('asking for permission', () => {
  it('asks when nothing has been decided', async () => {
    const fake = browser('default', { requestResolvesTo: 'granted' });

    await expect(requestDesktopPermission(fake.scope)).resolves.toBe('granted');
    expect(fake.requestPermission).toHaveBeenCalledTimes(1);
  });

  it('returns the refusal when the employee says no', async () => {
    const fake = browser('default', { requestResolvesTo: 'denied' });

    await expect(requestDesktopPermission(fake.scope)).resolves.toBe('denied');
  });

  /*
   * The dismissal case, which is NOT a refusal: the prompt was closed without a choice, so the
   * state is still "default" and Settings can offer the button again.
   */
  it('reports a dismissed prompt as still undecided', async () => {
    const fake = browser('default', { requestResolvesTo: 'default' });

    await expect(requestDesktopPermission(fake.scope)).resolves.toBe('default');
  });

  it('never re-asks after a refusal', async () => {
    const fake = browser('denied');

    await expect(requestDesktopPermission(fake.scope)).resolves.toBe('denied');
    expect(fake.requestPermission).not.toHaveBeenCalled();
  });

  it('does not ask again once granted', async () => {
    const fake = browser('granted');

    await expect(requestDesktopPermission(fake.scope)).resolves.toBe('granted');
    expect(fake.requestPermission).not.toHaveBeenCalled();
  });

  it('answers unsupported without touching anything', async () => {
    await expect(requestDesktopPermission({})).resolves.toBe('unsupported');
  });

  it('survives a browser that throws from requestPermission', async () => {
    const fake = browser('default', { requestThrows: true });

    await expect(requestDesktopPermission(fake.scope)).resolves.toBe('default');
  });
});

/** A representative request. Built fresh per use so a test can override one field safely. */
function fileRequest(onClick: () => void = () => {}) {
  return {
    title: 'Engineering Team',
    body: 'Rishith sent report.pdf',
    tag: 'conversation-1',
    silent: true,
    onClick,
  };
}

describe('showing a notification', () => {
  const request = fileRequest();

  it('shows the title, body, tag and the company mark', () => {
    const fake = browser('granted');

    showDesktopNotification(request, fake.scope);

    expect(fake.shown).toEqual([
      {
        title: 'Engineering Team',
        body: 'Rishith sent report.pdf',
        tag: 'conversation-1',
        icon: NOTIFICATION_ICON,
        silent: true,
      },
    ]);
  });

  it('uses the existing brand mark from this origin', () => {
    // The exact asset already in the project — never a generated or substituted logo.
    expect(NOTIFICATION_ICON).toBe('/brand/rising-path-mark.png');
  });

  it('shows nothing when permission was not granted', () => {
    for (const state of ['default', 'denied']) {
      const fake = browser(state);
      expect(showDesktopNotification(request, fake.scope), state).toBeNull();
      expect(fake.shown, state).toHaveLength(0);
    }
  });

  it('shows nothing, and does not throw, with no Notification API', () => {
    expect(showDesktopNotification(request, {})).toBeNull();
  });

  it('returns null rather than throwing when the constructor is refused', () => {
    // Some mobile browsers expose `Notification` but require a service worker to construct one.
    const fake = browser('granted', { constructorThrows: true });

    expect(showDesktopNotification(request, fake.scope)).toBeNull();
  });
});

describe('clicking a notification', () => {
  it('focuses the window, closes the popup and runs the callback', () => {
    const fake = browser('granted');
    const onClick = vi.fn();

    showDesktopNotification(fileRequest(onClick), fake.scope);
    fake.instances[0]?.onclick?.({});

    expect(fake.focusCalls()).toBe(1);
    expect(fake.instances[0]?.closed).toBe(true);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('still runs the callback when the browser refuses to focus', () => {
    const fake = browser('granted');
    const onClick = vi.fn();
    const scope: DesktopScope = {
      ...fake.scope,
      focus: () => {
        throw new Error('focus is not allowed');
      },
    };

    showDesktopNotification(fileRequest(onClick), scope);
    fake.instances[0]?.onclick?.({});

    // Refusing to focus must not cost the navigation: returning to the tab by hand should still
    // land on the right conversation.
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
