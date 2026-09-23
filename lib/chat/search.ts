/**
 * The client half of global search: when to ask, what to ignore, and what to show (Batch 1.6).
 *
 * PURE AND FRAMEWORK-FREE ON PURPOSE. Debouncing and race protection are the two parts of a
 * search box that are genuinely easy to get wrong, and both are invisible when wrong — a stale
 * response overwriting a newer one looks exactly like a slow server, and a missing debounce looks
 * like nothing at all until somebody reads the query log. Keeping them out of a React hook means
 * they can be tested with fake timers in this project's Node test environment, which has no DOM
 * and deliberately no React testing infrastructure.
 *
 * THE THREE THINGS THIS GUARDS:
 *
 *   1. **Minimum length.** One character matches most of the corpus and answers nothing. Below
 *      the minimum no request is made at all — the controller returns to idle, and the sidebar
 *      goes on showing its own instant filtering of the conversation list.
 *
 *   2. **Debounce.** Typing "report" is six keystrokes and must be one request, not six. The
 *      timer restarts on every change, so the request is made when typing pauses.
 *
 *   3. **Staleness, twice over.** The in-flight request is ABORTED when superseded, so the
 *      browser stops waiting for an answer nobody wants; and every dispatch carries a sequence
 *      number that is checked when it resolves, so a response that was already in flight — and
 *      therefore cannot be aborted usefully — is discarded instead of being rendered over newer
 *      results. Aborting alone is not enough: an abort is a request to stop, not a guarantee that
 *      a response already on the wire will not arrive.
 *
 * It makes no request of its own. It is handed a `run` function and a scheduler, which is what
 * makes every branch below reachable from a test.
 */

import type { SearchResultsWire } from '@/lib/chat/wire';

/** Shortest query that causes a request. Must match the server's own minimum. */
export const SEARCH_MIN_QUERY_LENGTH = 2;

/**
 * How long typing must pause before a request goes out.
 *
 * 300ms is the usual resting point: long enough that an ordinary typist produces one request per
 * word rather than one per letter, short enough that it does not read as lag.
 */
export const SEARCH_DEBOUNCE_MS = 300;

export type SearchStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface SearchState {
  status: SearchStatus;
  /** The query these results answer. Empty while idle. */
  query: string;
  results: SearchResultsWire | null;
  /** Safe to show; set only when `status` is 'error'. */
  error: string | null;
}

export const IDLE_SEARCH_STATE: SearchState = {
  status: 'idle',
  query: '',
  results: null,
  error: null,
};

/** True when a query is long enough to be worth asking about. */
export function isSearchable(raw: string): boolean {
  return raw.trim().length >= SEARCH_MIN_QUERY_LENGTH;
}

/** The query as it will be sent: trimmed, so trailing spaces do not make a different request. */
export function normalizeQuery(raw: string): string {
  return raw.trim();
}

/** True when the results hold nothing at all — the "no matches" state. */
export function isEmptyResults(results: SearchResultsWire | null): boolean {
  if (!results) return true;

  return (
    results.people.length === 0 &&
    results.groups.length === 0 &&
    results.messages.length === 0 &&
    results.files.length === 0
  );
}

/** Total number of results across every category. Used for the accessible live announcement. */
export function countResults(results: SearchResultsWire | null): number {
  if (!results) return 0;

  return (
    results.people.length +
    results.groups.length +
    results.messages.length +
    results.files.length
  );
}

/** Runs one search. Rejects with an `AbortError` when `signal` is aborted. */
export type SearchRunner = (query: string, signal: AbortSignal) => Promise<SearchResultsWire>;

export interface SearchControllerOptions {
  run: SearchRunner;
  /** Called on every state change. The React wrapper turns this into `setState`. */
  onState: (state: SearchState) => void;
  debounceMs?: number;
  minLength?: number;
  /** Injectable timers, so tests need neither real time nor a browser. */
  schedule?: (handler: () => void, ms: number) => unknown;
  cancelScheduled?: (handle: unknown) => void;
  /** Turns a thrown value into a message safe to show. */
  describeError?: (error: unknown) => string;
}

export interface SearchController {
  /** The search box changed. Starts, restarts or cancels the debounce as appropriate. */
  setQuery(raw: string): void;
  /** Abandons everything in flight and returns to idle. For unmount, and for Escape. */
  reset(): void;
}

function defaultDescribeError(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : 'Search is unavailable right now.';
}

/** Whether a thrown value is a cancellation. Checked by name — see `lib/chat/api.ts`. */
function isAbort(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

/**
 * Creates the controller.
 *
 * Every transition below is deliberate:
 *
 *   too short            → cancel everything, emit idle. No request.
 *   long enough          → emit loading immediately (so the box reacts to the keystroke, not to
 *                          the timer), then request when the debounce elapses.
 *   response, current    → emit ready.
 *   response, superseded → discard silently. Not an error, and not shown.
 *   failure, current     → emit error. The sidebar and the conversation keep working.
 *   failure, superseded  → discard.
 */
export function createSearchController(options: SearchControllerOptions): SearchController {
  const {
    run,
    onState,
    debounceMs = SEARCH_DEBOUNCE_MS,
    minLength = SEARCH_MIN_QUERY_LENGTH,
    schedule = (handler, ms) => setTimeout(handler, ms),
    cancelScheduled = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    describeError = defaultDescribeError,
  } = options;

  /**
   * Identifies the most recent dispatch. A response is rendered only if this still equals the
   * sequence it was issued under, which is the check that makes an out-of-order arrival harmless.
   */
  let sequence = 0;
  let timer: unknown = null;
  let inFlight: AbortController | null = null;

  function cancelPending(): void {
    if (timer !== null) {
      cancelScheduled(timer);
      timer = null;
    }
    if (inFlight) {
      inFlight.abort();
      inFlight = null;
    }
  }

  function setQuery(raw: string): void {
    const query = normalizeQuery(raw);

    // Superseding whatever came before, whether or not the new query will be searched.
    sequence += 1;
    const issued = sequence;
    cancelPending();

    if (query.length < minLength) {
      onState({ ...IDLE_SEARCH_STATE });
      return;
    }

    /*
     * Loading is announced now rather than when the timer fires. The employee pressed a key; the
     * interface should acknowledge it immediately, even though the request is 300ms away.
     */
    onState({ status: 'loading', query, results: null, error: null });

    timer = schedule(() => {
      timer = null;
      void dispatch(query, issued);
    }, debounceMs);
  }

  async function dispatch(query: string, issued: number): Promise<void> {
    const controller = new AbortController();
    inFlight = controller;

    try {
      const results = await run(query, controller.signal);

      // The guard that makes a late response harmless. Checked BEFORE anything is emitted.
      if (issued !== sequence) return;

      onState({ status: 'ready', query, results, error: null });
    } catch (error) {
      // A cancellation is something we did, not something that went wrong. Never shown.
      if (isAbort(error) || issued !== sequence) return;

      onState({ status: 'error', query, results: null, error: describeError(error) });
    } finally {
      if (inFlight === controller) inFlight = null;
    }
  }

  function reset(): void {
    sequence += 1;
    cancelPending();
    onState({ ...IDLE_SEARCH_STATE });
  }

  return { setQuery, reset };
}
