/**
 * Debounce, cancellation and stale-response protection for global search (Batch 1.6).
 *
 * These are the two parts of a search box that are easy to get wrong and invisible when wrong: a
 * missing debounce looks like nothing at all until somebody reads the query log, and a stale
 * response overwriting a newer one looks exactly like a slow server. Both are therefore kept out
 * of React — `lib/chat/search.ts` is pure and framework-free — so they can be driven properly
 * here rather than asserted structurally.
 *
 * The scheduler is injected rather than faked globally: nothing below waits for real time, and
 * "no request was scheduled" is a state that can be asserted directly instead of inferred from a
 * timer that never fired.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  countResults,
  createSearchController,
  IDLE_SEARCH_STATE,
  isEmptyResults,
  isSearchable,
  normalizeQuery,
  SEARCH_DEBOUNCE_MS,
  SEARCH_MIN_QUERY_LENGTH,
  type SearchState,
} from '@/lib/chat/search';
import type { SearchResultsWire } from '@/lib/chat/wire';

/* -------------------------------------------------------------------------------------------- */
/* Test doubles                                                                                   */
/* -------------------------------------------------------------------------------------------- */

/** A scheduler whose timers fire only when a test says so. */
function manualScheduler() {
  const tasks = new Map<number, () => void>();
  let nextId = 1;

  return {
    schedule(handler: () => void): unknown {
      const id = nextId++;
      tasks.set(id, handler);
      return id;
    },
    cancelScheduled(handle: unknown): void {
      tasks.delete(handle as number);
    },
    /** Runs every timer currently pending, as elapsing the debounce would. */
    flush(): void {
      const due = [...tasks.values()];
      tasks.clear();
      for (const task of due) task();
    },
    get pending(): number {
      return tasks.size;
    },
  };
}

function results(overrides: Partial<SearchResultsWire> = {}): SearchResultsWire {
  return { query: 'q', people: [], groups: [], messages: [], files: [], ...overrides };
}

function person(id: string, displayName: string) {
  return { id, displayName, lastSeenAt: '2026-09-22T09:00:00.000Z' };
}

/** A promise a test resolves by hand, so response ORDER can be chosen. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

/** Builds a controller and records every state it emits. */
function harness(run: (query: string, signal: AbortSignal) => Promise<SearchResultsWire>) {
  const clock = manualScheduler();
  const states: SearchState[] = [];

  const controller = createSearchController({
    run,
    onState: (state) => states.push(state),
    schedule: (handler) => clock.schedule(handler),
    cancelScheduled: (handle) => clock.cancelScheduled(handle),
  });

  return {
    controller,
    clock,
    states,
    get last(): SearchState | undefined {
      return states[states.length - 1];
    },
  };
}

/* -------------------------------------------------------------------------------------------- */
/* 1 — minimum query length                                                                       */
/* -------------------------------------------------------------------------------------------- */

describe('a query below the minimum never reaches the server', () => {
  it('the minimum is two characters', () => {
    expect(SEARCH_MIN_QUERY_LENGTH).toBe(2);
  });

  it('schedules NOTHING for one character', () => {
    const run = vi.fn();
    const h = harness(run);

    h.controller.setQuery('r');

    expect(h.clock.pending).toBe(0);
    expect(run).not.toHaveBeenCalled();
    expect(h.last).toEqual(IDLE_SEARCH_STATE);
  });

  it('schedules nothing for an empty or whitespace query', () => {
    const run = vi.fn();
    const h = harness(run);

    for (const term of ['', '   ', '\t', '\n  ']) {
      h.controller.setQuery(term);
      expect(h.clock.pending, term).toBe(0);
    }

    expect(run).not.toHaveBeenCalled();
  });

  it('does not count surrounding whitespace towards the minimum', () => {
    const run = vi.fn();
    const h = harness(run);

    h.controller.setQuery(' r ');

    expect(run).not.toHaveBeenCalled();
    expect(h.last?.status).toBe('idle');
  });

  it('schedules a request at exactly the minimum', () => {
    const h = harness(() => Promise.resolve(results()));

    h.controller.setQuery('re');

    expect(h.clock.pending).toBe(1);
    expect(h.last?.status).toBe('loading');
  });

  it('CLEARING the box returns to idle and cancels what was pending', () => {
    const run = vi.fn();
    const h = harness(run);

    h.controller.setQuery('report');
    expect(h.clock.pending).toBe(1);

    h.controller.setQuery('');

    expect(h.clock.pending).toBe(0);
    expect(h.last).toEqual(IDLE_SEARCH_STATE);
    h.clock.flush();
    expect(run).not.toHaveBeenCalled();
  });

  it('agrees with `isSearchable`', () => {
    expect(isSearchable('r')).toBe(false);
    expect(isSearchable(' r ')).toBe(false);
    expect(isSearchable('re')).toBe(true);
    expect(isSearchable('report')).toBe(true);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 2 — debounce                                                                                   */
/* -------------------------------------------------------------------------------------------- */

describe('typing a word is one request, not one per letter', () => {
  it('is debounced at 300ms', () => {
    expect(SEARCH_DEBOUNCE_MS).toBe(300);
  });

  it('typing "report" produces ONE request, for the final term', async () => {
    // Parameters declared so the recorded call is typed and the term can be read back below.
    const run = vi.fn((query: string, signal: AbortSignal) =>
      Promise.resolve(results({ query: signal.aborted ? '' : query })),
    );
    const h = harness(run);

    // The keystrokes an employee actually makes, none of them pausing.
    for (const term of ['re', 'rep', 'repo', 'repor', 'report']) {
      h.controller.setQuery(term);
    }

    // Only the last timer survives: each keystroke cancelled the one before it.
    expect(h.clock.pending).toBe(1);

    h.clock.flush();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(run.mock.calls[0]?.[0]).toBe('report');
  });

  it('announces loading immediately, before the timer elapses', () => {
    const h = harness(() => Promise.resolve(results()));

    h.controller.setQuery('report');

    // The employee pressed a key; the interface acknowledges it now, not in 300ms.
    expect(h.last).toMatchObject({ status: 'loading', query: 'report' });
  });

  it('trims the query it sends, so a trailing space is not a second search', async () => {
    const run = vi.fn(() => Promise.resolve(results()));
    const h = harness(run);

    h.controller.setQuery('report  ');
    h.clock.flush();

    await vi.waitFor(() => expect(run).toHaveBeenCalledWith('report', expect.anything()));
  });

  it('normalizeQuery trims and nothing else', () => {
    expect(normalizeQuery('  report  ')).toBe('report');
    // Inner spacing is the employee's, and two words is a legitimate search.
    expect(normalizeQuery('monthly  report')).toBe('monthly  report');
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 3 — staleness and cancellation                                                                 */
/* -------------------------------------------------------------------------------------------- */

describe('a stale response never replaces a newer one', () => {
  it('discards an EARLIER response that arrives after a later one', async () => {
    const first = deferred<SearchResultsWire>();
    const second = deferred<SearchResultsWire>();
    const calls: string[] = [];

    const h = harness((query) => {
      calls.push(query);
      return query === 'rep' ? first.promise : second.promise;
    });

    h.controller.setQuery('rep');
    h.clock.flush(); // "rep" is now in flight

    h.controller.setQuery('report');
    h.clock.flush(); // "report" is now in flight too

    expect(calls).toEqual(['rep', 'report']);

    // The NEWER one answers first…
    second.resolve(results({ query: 'report', people: [person('u2', 'Reporting Bot')] }));
    await vi.waitFor(() => expect(h.last?.status).toBe('ready'));
    expect(h.last?.query).toBe('report');

    // …and then the older one arrives late. It must change nothing.
    first.resolve(results({ query: 'rep', people: [person('u1', 'Repair Team')] }));
    await Promise.resolve();
    await Promise.resolve();

    expect(h.last?.query).toBe('report');
    expect(h.last?.results?.people).toEqual([person('u2', 'Reporting Bot')]);
  });

  it('ABORTS the in-flight request when a new query supersedes it', async () => {
    const signals: AbortSignal[] = [];
    const h = harness((_query, signal) => {
      signals.push(signal);
      return new Promise<SearchResultsWire>(() => {
        /* never settles: this request is meant to be abandoned */
      });
    });

    h.controller.setQuery('rep');
    h.clock.flush();
    expect(signals[0]?.aborted).toBe(false);

    h.controller.setQuery('report');

    // Superseded the moment the next keystroke lands, not when its replacement completes.
    expect(signals[0]?.aborted).toBe(true);
  });

  it('an abort is never shown as an error', async () => {
    const h = harness((_query, signal) =>
      new Promise<SearchResultsWire>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(abortError()));
      }),
    );

    h.controller.setQuery('rep');
    h.clock.flush();
    h.controller.setQuery('report');

    await Promise.resolve();
    await Promise.resolve();

    // A cancellation is something the interface did, not something that went wrong.
    expect(h.states.some((state) => state.status === 'error')).toBe(false);
  });

  it('a stale FAILURE is discarded too', async () => {
    const first = deferred<SearchResultsWire>();
    const second = deferred<SearchResultsWire>();

    const h = harness((query) => (query === 'rep' ? first.promise : second.promise));

    h.controller.setQuery('rep');
    h.clock.flush();
    h.controller.setQuery('report');
    h.clock.flush();

    second.resolve(results({ query: 'report' }));
    await vi.waitFor(() => expect(h.last?.status).toBe('ready'));

    first.reject(new Error('the old request fell over'));
    await Promise.resolve();
    await Promise.resolve();

    // The newer results stay on screen; the dead request says nothing.
    expect(h.last?.status).toBe('ready');
  });

  it('`reset` abandons everything in flight and returns to idle', async () => {
    const signals: AbortSignal[] = [];
    const h = harness((_query, signal) => {
      signals.push(signal);
      return new Promise<SearchResultsWire>(() => {});
    });

    h.controller.setQuery('report');
    h.clock.flush();

    h.controller.reset();

    expect(signals[0]?.aborted).toBe(true);
    expect(h.last).toEqual(IDLE_SEARCH_STATE);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Outcome states                                                                                 */
/* -------------------------------------------------------------------------------------------- */

describe('what the sidebar is told', () => {
  it('reports results when the current request succeeds', async () => {
    const h = harness(() =>
      Promise.resolve(results({ query: 'report', people: [person('u1', 'Priya Sharma')] })),
    );

    h.controller.setQuery('report');
    h.clock.flush();

    await vi.waitFor(() => expect(h.last?.status).toBe('ready'));
    expect(h.last?.results?.people).toHaveLength(1);
    expect(h.last?.error).toBeNull();
  });

  it('reports a safe message when it fails, and keeps no stale results', async () => {
    const h = harness(() => Promise.reject(new Error('Cannot reach the chat server.')));

    h.controller.setQuery('report');
    h.clock.flush();

    await vi.waitFor(() => expect(h.last?.status).toBe('error'));
    expect(h.last?.error).toBe('Cannot reach the chat server.');
    expect(h.last?.results).toBeNull();
  });

  it('falls back to a generic message when the failure carries none', async () => {
    const h = harness(() => Promise.reject({ weird: true }));

    h.controller.setQuery('report');
    h.clock.flush();

    await vi.waitFor(() => expect(h.last?.status).toBe('error'));
    expect(h.last?.error).toBe('Search is unavailable right now.');
  });

  it('recovers: a failure followed by a good query reports results again', async () => {
    let fail = true;
    const h = harness(() =>
      fail ? Promise.reject(new Error('nope')) : Promise.resolve(results({ query: 'report' })),
    );

    h.controller.setQuery('rep');
    h.clock.flush();
    await vi.waitFor(() => expect(h.last?.status).toBe('error'));

    fail = false;
    h.controller.setQuery('report');
    h.clock.flush();
    await vi.waitFor(() => expect(h.last?.status).toBe('ready'));
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Small helpers the interface renders from                                                       */
/* -------------------------------------------------------------------------------------------- */

describe('result helpers', () => {
  it('counts across every category', () => {
    expect(
      countResults(
        results({
          people: [person('a', 'A')],
          groups: [{ conversationId: 'g', name: 'G', memberCount: 3 }],
          messages: [],
          files: [],
        }),
      ),
    ).toBe(2);
  });

  it('treats null and all-empty categories as empty', () => {
    expect(isEmptyResults(null)).toBe(true);
    expect(isEmptyResults(results())).toBe(true);
    expect(countResults(null)).toBe(0);
  });

  it('is not empty when any single category has something', () => {
    expect(isEmptyResults(results({ files: [] , people: [person('a', 'A')] }))).toBe(false);
  });
});
