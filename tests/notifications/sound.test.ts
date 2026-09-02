/**
 * The chime.
 *
 * Three things worth protecting: it reuses one element rather than leaking one per message, it
 * rewinds so a second message during the first chime is still audible, and a browser refusing to
 * play for want of a user interaction is recorded rather than thrown. The last one is the reason
 * this is testable at all — an unhandled rejection there would surface as an error in the console
 * of every employee who had not yet clicked the page.
 */

import { describe, expect, it, vi } from 'vitest';

import { CHIME_SRC, MIN_CHIME_INTERVAL_MS, createChime, type AudioLike } from '@/lib/notifications/sound';

/** A stand-in for `HTMLAudioElement`, recording what was done to it. */
function fakeAudio(behaviour: 'resolve' | 'reject' | 'throw' | 'void' = 'resolve') {
  const plays: number[] = [];
  let created = 0;
  let loaded = 0;

  const element: AudioLike = {
    volume: 1,
    currentTime: 99,
    play() {
      plays.push(element.currentTime);
      if (behaviour === 'reject') return Promise.reject(new Error('NotAllowedError'));
      if (behaviour === 'throw') throw new Error('NotAllowedError');
      if (behaviour === 'void') return undefined as unknown as void;
      return Promise.resolve();
    },
    load() {
      loaded += 1;
    },
  };

  return {
    element,
    create: (src: string) => {
      created += 1;
      element.currentTime = 99;
      void src;
      return element;
    },
    plays,
    createdCount: () => created,
    loadedCount: () => loaded,
  };
}

describe('the asset', () => {
  it('is a path on this origin, not a URL to anywhere else', () => {
    expect(CHIME_SRC).toBe('/sounds/notification.wav');
    expect(CHIME_SRC.startsWith('/')).toBe(true);
    expect(CHIME_SRC).not.toMatch(/^https?:/);
  });
});

describe('playing', () => {
  it('plays on the first message', () => {
    const audio = fakeAudio();
    const chime = createChime({ create: audio.create, minIntervalMs: 0 });

    chime.play();

    expect(audio.plays).toHaveLength(1);
  });

  it('builds one element and reuses it', () => {
    const audio = fakeAudio();
    const chime = createChime({ create: audio.create, minIntervalMs: 0 });

    chime.play();
    chime.play();
    chime.play();

    expect(audio.createdCount()).toBe(1);
    expect(audio.plays).toHaveLength(3);
  });

  it('rewinds before playing, so a second message is not silent', () => {
    const audio = fakeAudio();
    const chime = createChime({ create: audio.create, minIntervalMs: 0 });

    chime.play();

    // Without the rewind the element sits at its end and the next play is inaudible.
    expect(audio.plays[0]).toBe(0);
  });

  it('preloads, so the first notification of the day is not silent while it downloads', () => {
    const audio = fakeAudio();
    const chime = createChime({ create: audio.create });

    chime.play();

    expect(audio.loadedCount()).toBe(1);
  });

  it('sets a modest volume rather than full scale', () => {
    const audio = fakeAudio();
    const chime = createChime({ create: audio.create });

    chime.play();

    expect(audio.element.volume).toBeGreaterThan(0);
    expect(audio.element.volume).toBeLessThan(1);
  });
});

describe('the rate limit', () => {
  /*
   * Ten messages arriving together should sound like a notification, not a machine gun. The
   * limit is on the SOUND, never on the notification: the toast and the desktop popup are
   * unaffected.
   */
  it('will not play again within the minimum interval', () => {
    const audio = fakeAudio();
    let now = 1_000;
    const chime = createChime({ create: audio.create, now: () => now });

    chime.play();
    now += MIN_CHIME_INTERVAL_MS - 1;
    chime.play();

    expect(audio.plays).toHaveLength(1);
  });

  it('plays again once the interval has passed', () => {
    const audio = fakeAudio();
    let now = 1_000;
    const chime = createChime({ create: audio.create, now: () => now });

    chime.play();
    now += MIN_CHIME_INTERVAL_MS;
    chime.play();

    expect(audio.plays).toHaveLength(2);
  });
});

describe('autoplay restrictions', () => {
  /*
   * The browser refuses until the page has been interacted with, and refuses by REJECTING rather
   * than throwing. An unhandled rejection here would appear in the console of every employee who
   * had not yet clicked.
   */
  it('records a rejected play instead of leaving it unhandled', async () => {
    const audio = fakeAudio('reject');
    const chime = createChime({ create: audio.create, minIntervalMs: 0 });

    expect(() => chime.play()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(chime.isBlocked()).toBe(true);
  });

  it('records a synchronous refusal too', () => {
    const audio = fakeAudio('throw');
    const chime = createChime({ create: audio.create, minIntervalMs: 0 });

    expect(() => chime.play()).not.toThrow();
    expect(chime.isBlocked()).toBe(true);
  });

  it('clears the blocked flag once a play succeeds', async () => {
    let behaviour: 'reject' | 'resolve' = 'reject';
    const element: AudioLike = {
      volume: 1,
      currentTime: 0,
      play: () =>
        behaviour === 'reject' ? Promise.reject(new Error('NotAllowedError')) : Promise.resolve(),
    };
    const chime = createChime({ create: () => element, minIntervalMs: 0 });

    chime.play();
    await Promise.resolve();
    await Promise.resolve();
    expect(chime.isBlocked()).toBe(true);

    // The employee has now clicked something, so the browser relents.
    behaviour = 'resolve';
    chime.play();
    await Promise.resolve();
    await Promise.resolve();
    expect(chime.isBlocked()).toBe(false);
  });

  it('is not blocked before anything has been attempted', () => {
    const audio = fakeAudio();
    expect(createChime({ create: audio.create }).isBlocked()).toBe(false);
  });

  it('copes with the older void-returning play()', () => {
    const audio = fakeAudio('void');
    const chime = createChime({ create: audio.create, minIntervalMs: 0 });

    expect(() => chime.play()).not.toThrow();
    expect(chime.isBlocked()).toBe(false);
  });
});

describe('an environment with no audio at all', () => {
  it('does nothing rather than throwing', () => {
    const create = vi.fn(() => {
      throw new Error('Audio is not defined');
    });
    const chime = createChime({ create, minIntervalMs: 0 });

    expect(() => chime.play()).not.toThrow();
    // Tried once; the toast and desktop notification carry on regardless.
    expect(create).toHaveBeenCalled();
  });
});
