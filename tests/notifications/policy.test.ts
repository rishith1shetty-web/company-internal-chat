/**
 * The notification decision, exhaustively.
 *
 * This is the file that protects the requirement everything else rests on: **a backgrounded tab
 * still notifies**. Visibility chooses the surface, never whether there is one — so the tests
 * below assert what happens when the employee is in Excel just as carefully as when they are
 * looking at the conversation.
 */

import { describe, expect, it } from 'vitest';

import { isSilent, planNotification, type NotificationContext } from '@/lib/notifications/policy';
import { DEFAULT_PREFERENCES, type NotificationPreferences } from '@/lib/notifications/preferences';

const ALL_ON: NotificationPreferences = { sound: true, inApp: true, desktop: true };

/** A message from somebody else, in another conversation, while the app is in front of you. */
function context(overrides: Partial<NotificationContext> = {}): NotificationContext {
  return {
    isOwnMessage: false,
    isSystemMessage: false,
    isOpenConversation: false,
    isAppFocused: true,
    canShowDesktop: false,
    preferences: ALL_ON,
    ...overrides,
  };
}

describe('messages that never notify', () => {
  it('says nothing for your own message', () => {
    // The server excludes the sending socket, but the same employee's OTHER tab is in the room
    // and does receive it — so this rule is doing real work.
    const plan = planNotification(context({ isOwnMessage: true }));

    expect(plan).toEqual({ sound: false, toast: false, desktop: false });
    expect(isSilent(plan)).toBe(true);
  });

  it('says nothing for your own message even from a background tab', () => {
    expect(
      planNotification(context({ isOwnMessage: true, isAppFocused: false, canShowDesktop: true })),
    ).toEqual({ sound: false, toast: false, desktop: false });
  });

  it('says nothing for a SYSTEM message', () => {
    // "Sam was added to the group" is shown in the transcript. A chime for it trains people to
    // ignore the chime.
    expect(planNotification(context({ isSystemMessage: true }))).toEqual({
      sound: false,
      toast: false,
      desktop: false,
    });
  });

  it('says nothing for a SYSTEM message in the background either', () => {
    expect(
      planNotification(
        context({ isSystemMessage: true, isAppFocused: false, canShowDesktop: true }),
      ),
    ).toEqual({ sound: false, toast: false, desktop: false });
  });
});

describe('while the employee is looking at the application', () => {
  it('chimes but does not cover the conversation they are reading', () => {
    const plan = planNotification(context({ isOpenConversation: true }));

    expect(plan.sound).toBe(true);
    // The message is already arriving on screen; a toast would cover it with a copy of itself.
    expect(plan.toast).toBe(false);
    expect(plan.desktop).toBe(false);
  });

  it('chimes and shows a toast for a different conversation', () => {
    expect(planNotification(context())).toEqual({ sound: true, toast: true, desktop: false });
  });

  /*
   * The rule that keeps the two surfaces from doubling up. A desktop popup while somebody is
   * looking straight at the application is the most annoying thing this feature could do.
   */
  it('never shows a desktop popup while the application is in front of them', () => {
    for (const isOpenConversation of [true, false]) {
      expect(
        planNotification(context({ isOpenConversation, canShowDesktop: true })).desktop,
        `open conversation: ${isOpenConversation}`,
      ).toBe(false);
    }
  });
});

describe('while the tab is in the background', () => {
  /*
   * THE REQUIREMENT. The employee is in Excel, or on another tab, and the chat page is merely
   * open. Everything below must still happen.
   */
  it('chimes and shows a desktop popup', () => {
    expect(planNotification(context({ isAppFocused: false, canShowDesktop: true }))).toEqual({
      sound: true,
      toast: false,
      desktop: true,
    });
  });

  it('still notifies when the message is for the conversation left open behind', () => {
    // Being "on" a conversation means nothing while looking at something else.
    expect(
      planNotification(
        context({ isAppFocused: false, isOpenConversation: true, canShowDesktop: true }),
      ),
    ).toEqual({ sound: true, toast: false, desktop: true });
  });

  it('falls back to a toast when desktop notifications are not available', () => {
    // Queued rather than dropped, so somebody who never granted permission still finds out what
    // happened when they come back to the tab.
    expect(planNotification(context({ isAppFocused: false, canShowDesktop: false }))).toEqual({
      sound: true,
      toast: true,
      desktop: false,
    });
  });

  it('is never silent merely because the tab is hidden', () => {
    for (const canShowDesktop of [true, false]) {
      expect(
        isSilent(planNotification(context({ isAppFocused: false, canShowDesktop }))),
        `desktop available: ${canShowDesktop}`,
      ).toBe(false);
    }
  });
});

describe('preferences', () => {
  it('suppresses the sound when sounds are off, without suppressing anything else', () => {
    const plan = planNotification(context({ preferences: { ...ALL_ON, sound: false } }));

    expect(plan.sound).toBe(false);
    expect(plan.toast).toBe(true);
  });

  it('suppresses the toast when in-app notifications are off', () => {
    const plan = planNotification(context({ preferences: { ...ALL_ON, inApp: false } }));

    expect(plan.toast).toBe(false);
    expect(plan.sound).toBe(true);
  });

  it('suppresses the background toast fallback when in-app notifications are off', () => {
    expect(
      planNotification(
        context({ isAppFocused: false, preferences: { ...ALL_ON, inApp: false } }),
      ),
    ).toEqual({ sound: true, toast: false, desktop: false });
  });

  /*
   * `canShowDesktop` is the caller's conjunction of preference AND browser permission, so a
   * false here stands for both "switched off" and "not permitted" — and both must land on the
   * toast fallback rather than on silence.
   */
  it('falls back to the toast when the desktop preference is off in the background', () => {
    expect(
      planNotification(context({ isAppFocused: false, canShowDesktop: false })),
    ).toEqual({ sound: true, toast: true, desktop: false });
  });

  it('can be turned off entirely', () => {
    const off: NotificationPreferences = { sound: false, inApp: false, desktop: false };

    expect(isSilent(planNotification(context({ preferences: off })))).toBe(true);
    expect(
      isSilent(planNotification(context({ preferences: off, isAppFocused: false }))),
    ).toBe(true);
  });

  it('uses the shipped defaults sensibly: sound and toast, no desktop', () => {
    expect(DEFAULT_PREFERENCES).toEqual({ sound: true, inApp: true, desktop: false });

    expect(planNotification(context({ preferences: DEFAULT_PREFERENCES }))).toEqual({
      sound: true,
      toast: true,
      desktop: false,
    });
  });
});
