/**
 * What a newly arrived message should do — sound, toast, desktop popup, or nothing.
 *
 * A pure function with no DOM, no audio and no React, because this is the part that is easy to
 * get subtly wrong and hard to notice: a rule that notifies for your own message, or that goes
 * quiet exactly when the employee has switched to Excel, is a bug nobody reports as a bug.
 *
 * THE RULE THE WHOLE FEATURE TURNS ON: whether the tab is visible decides WHICH surface is used,
 * never WHETHER there is a notification. A backgrounded tab is the case this feature exists for —
 * the employee is in another application and the chat tab is merely open — so `document.hidden`
 * selects the desktop popup over the toast and does nothing else.
 *
 *                                          sound   toast   desktop
 *   own message, or SYSTEM                   ·       ·        ·
 *   focused, this conversation open          ✓       ·        ·
 *   focused, a different conversation        ✓       ✓        ·
 *   background, desktop available            ✓       ·        ✓
 *   background, desktop unavailable          ✓       ✓        ·
 *
 * Two of those rows are judgement calls, so they are stated here rather than buried:
 *
 *   READING THE CONVERSATION ALREADY. The message is already on screen, arriving in the list the
 *   employee is looking at. A toast would cover it with a copy of itself and a desktop popup
 *   would be worse. The chime alone is the least annoying thing that still says "that arrived",
 *   and it is what Teams does.
 *
 *   BACKGROUND WITH NO DESKTOP PERMISSION. The toast is queued rather than dropped, so somebody
 *   who never enabled desktop notifications still finds out what happened when they come back to
 *   the tab. Dropping it would make the unread badge the only trace.
 */

import type { NotificationPreferences } from './preferences';

/** Everything the decision depends on. No React types, no DOM types — deliberately. */
export interface NotificationContext {
  /** This browser's owner. A message from them is never a notification. */
  isOwnMessage: boolean;
  /** `SYSTEM` messages: "X added Y to the group". Real, but not worth a sound. */
  isSystemMessage: boolean;
  /** Is the employee looking at the conversation this message arrived in? */
  isOpenConversation: boolean;
  /**
   * Is the application actually in front of the employee?
   *
   * Visible AND focused. A tab that is visible behind a spreadsheet is not being looked at, and
   * treating it as though it were is how a notification gets silently swallowed.
   */
  isAppFocused: boolean;
  /** Whether a desktop notification could be shown right now: supported, permitted, enabled. */
  canShowDesktop: boolean;
  preferences: NotificationPreferences;
}

/** Which surfaces to use. All false is a legitimate answer and means "stay quiet". */
export interface NotificationPlan {
  sound: boolean;
  toast: boolean;
  desktop: boolean;
}

const SILENT: NotificationPlan = { sound: false, toast: false, desktop: false };

export function planNotification(context: NotificationContext): NotificationPlan {
  /*
   * Never for your own message. The server broadcasts with `socket.to(room)`, which excludes the
   * socket that sent it — but the same employee's OTHER tab is in that room and does receive it,
   * so this check is doing real work rather than restating the server's behaviour.
   */
  if (context.isOwnMessage) return SILENT;

  // Membership changes are shown in the transcript, where they belong. A chime for "Sam was
  // added to the group" trains people to ignore the chime.
  if (context.isSystemMessage) return SILENT;

  const { preferences } = context;

  // The chime is the one surface that applies in every remaining case, including while the
  // employee is reading the conversation the message arrived in.
  const sound = preferences.sound;

  if (context.isAppFocused) {
    return {
      sound,
      // Already on screen: a toast would cover the message with a copy of itself.
      toast: preferences.inApp && !context.isOpenConversation,
      // Never while the employee is looking at the application. That is what the toast is for.
      desktop: false,
    };
  }

  // Backgrounded — the case this feature exists for. The desktop popup is the surface when it is
  // available; the toast is what is left when it is not, and it waits for the employee's return.
  if (context.canShowDesktop) {
    return { sound, toast: false, desktop: true };
  }

  return { sound, toast: preferences.inApp, desktop: false };
}

/** True when the plan asks for nothing at all, so a caller can skip the work entirely. */
export function isSilent(plan: NotificationPlan): boolean {
  return !plan.sound && !plan.toast && !plan.desktop;
}
