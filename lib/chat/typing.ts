/**
 * Typing indicators, browser side (Batch 1.8). Pure: no React, no socket, no imports.
 *
 * TWO JOBS.
 *
 *   1. `createTypingSignal` turns keystrokes into a handful of socket events. The first keystroke
 *      of a burst sends "start"; further keystrokes send nothing, except a heartbeat every few
 *      seconds so the server's expiry never catches somebody still typing. A pause of a couple of
 *      seconds, an emptied field, a send or leaving the conversation sends "stop". Never one event
 *      per key.
 *
 *   2. `formatTypingText` says who is typing, compactly: one name, two names, or two names and a
 *      count — never an unbounded list.
 */

/** A pause this long ends a typing burst. */
export const TYPING_IDLE_MS = 2_500;

/**
 * While a burst continues, "start" is repeated this often so the server keeps it alive.
 *
 * Must stay well under the server's `TYPING_TTL_MS` (lib/realtime/typing.ts), or a slow, steady
 * typist would flicker off between heartbeats.
 */
export const TYPING_HEARTBEAT_MS = 3_000;

export interface TypingSignal {
  /** The composer's text changed because the user typed, pasted or picked a mention. */
  input(text: string): void;
  /** Typing is over: sent, cancelled, conversation left. Safe to call when already stopped. */
  stop(): void;
}

/**
 * One signal per composer. The composer is remounted per conversation, so a signal only ever
 * speaks for one conversation, and unmounting it (`stop`) is what clears the old conversation when
 * the user switches.
 */
export function createTypingSignal(send: (typing: boolean) => void): TypingSignal {
  let active = false;
  let lastStartAt = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  function clearIdle(): void {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function stop(): void {
    clearIdle();
    if (!active) return;
    active = false;
    send(false);
  }

  return {
    input(text) {
      // Emptying the field is stopping, not typing.
      if (text.trim().length === 0) {
        stop();
        return;
      }

      const now = Date.now();
      if (!active) {
        active = true;
        lastStartAt = now;
        send(true);
      } else if (now - lastStartAt >= TYPING_HEARTBEAT_MS) {
        lastStartAt = now;
        send(true);
      }

      clearIdle();
      idleTimer = setTimeout(stop, TYPING_IDLE_MS);
    },
    stop,
  };
}

/**
 * The indicator's words, or null when nobody is typing.
 *
 *   ["Rahul"]                          → "Rahul is typing…"
 *   ["Rahul", "Priya"]                 → "Rahul and Priya are typing…"
 *   ["Rahul", "Priya", "Amit"]         → "Rahul, Priya and 1 other are typing…"
 *   ["Rahul", "Priya", "Amit", "Neha"] → "Rahul, Priya and 2 others are typing…"
 */
export function formatTypingText(names: readonly string[]): string | null {
  const [first, second] = names;
  if (first === undefined) return null;
  if (second === undefined) return `${first} is typing…`;
  if (names.length === 2) return `${first} and ${second} are typing…`;

  const others = names.length - 2;
  return `${first}, ${second} and ${others} ${others === 1 ? 'other' : 'others'} are typing…`;
}
