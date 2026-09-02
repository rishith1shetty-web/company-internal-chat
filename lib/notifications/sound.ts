/**
 * The notification chime.
 *
 * ONE audio element, created once and rewound on each use. Creating an `Audio` per message would
 * leak an element per message for the life of the tab and would let a burst of messages play a
 * dozen overlapping copies of the same sound — which is the difference between a notification and
 * an alarm.
 *
 * THE ASSET IS LOCAL AND ORIGINAL. `public/sounds/notification.wav` is generated from arithmetic
 * (two sine tones, C6 then F6, with an exponential decay) and is served from this application's
 * own origin. Nothing is fetched from a CDN, and no audio from Microsoft Teams or any other
 * product is used or imitated beyond the general idea of "a short rising two-note chime", which
 * is not anybody's property.
 *
 * AUTOPLAY. Browsers refuse `play()` until the page has been interacted with at least once, and
 * the refusal arrives as a rejected promise rather than an exception. That is caught and recorded
 * rather than surfaced: a chime that cannot play yet is not an error worth telling an employee
 * about, and the very next message after their first click will be audible. Note that this
 * restriction is about INTERACTION, not visibility — once the page has been clicked, the chime
 * keeps working while the tab is in the background, which is the case this feature is for.
 */

/** How long the chime must be left alone before it will play again. */
export const MIN_CHIME_INTERVAL_MS = 400;

/** The published asset. A path on this origin, never a URL to anywhere else. */
export const CHIME_SRC = '/sounds/notification.wav';

/** The slice of `HTMLAudioElement` this module uses, so a test can supply a stand-in. */
export interface AudioLike {
  volume: number;
  currentTime: number;
  play(): Promise<void> | void;
  load?(): void;
}

export interface ChimeOptions {
  /** Builds the element. Injectable so tests need no DOM and no real audio decoder. */
  create?: (src: string) => AudioLike;
  src?: string;
  /** Modest by default: this plays next to somebody on a phone call. */
  volume?: number;
  /**
   * Rate limit. Ten messages arriving together should sound like a notification, not a machine
   * gun — so the chime plays at most this often. Set to 0 in tests that count calls.
   */
  minIntervalMs?: number;
  now?: () => number;
}

export interface Chime {
  /** Plays, unless the rate limit says otherwise. Never throws and never rejects. */
  play(): void;
  /**
   * True once the browser has refused to play for want of a user interaction.
   *
   * Read by the settings panel so it can say why the test button did nothing, rather than
   * leaving somebody to conclude the sound is broken.
   */
  isBlocked(): boolean;
}

function defaultCreate(src: string): AudioLike {
  const audio = new Audio(src);
  // Fetch it now rather than on the first message, so the first notification of the day is not
  // silent while the file is still being downloaded.
  audio.preload = 'auto';
  return audio;
}

export function createChime(options: ChimeOptions = {}): Chime {
  const {
    create = defaultCreate,
    src = CHIME_SRC,
    volume = 0.45,
    minIntervalMs = MIN_CHIME_INTERVAL_MS,
    now = () => Date.now(),
  } = options;

  let element: AudioLike | null = null;
  let blocked = false;
  let lastPlayedAt = Number.NEGATIVE_INFINITY;

  /** Built lazily and kept, so nothing is constructed on a server render. */
  const audio = (): AudioLike | null => {
    if (element) return element;
    try {
      element = create(src);
      element.volume = volume;
      element.load?.();
      return element;
    } catch {
      // No audio support at all. The toast and the desktop notification still work.
      return null;
    }
  };

  return {
    play() {
      const at = now();
      if (at - lastPlayedAt < minIntervalMs) return;

      const target = audio();
      if (!target) return;

      lastPlayedAt = at;

      try {
        // Rewind: without this, a second message during the first chime plays nothing at all,
        // because the element is already at its end.
        target.currentTime = 0;
        const result = target.play();
        // `play()` returns a promise in every current browser, but the older void-returning form
        // is still specified — hence the guard rather than an unconditional `.catch`.
        if (result && typeof result.then === 'function') {
          void result.then(
            () => {
              blocked = false;
            },
            () => {
              // NotAllowedError: no user interaction yet. Not an error worth showing.
              blocked = true;
            },
          );
        }
      } catch {
        blocked = true;
      }
    },

    isBlocked() {
      return blocked;
    },
  };
}
