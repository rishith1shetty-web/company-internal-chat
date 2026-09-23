'use client';

import { useEffect, useState } from 'react';

import { searchEverything } from '@/lib/chat/api';
import {
  createSearchController,
  IDLE_SEARCH_STATE,
  type SearchController,
  type SearchState,
} from '@/lib/chat/search';

/**
 * React's view of the search controller (Batch 1.6).
 *
 * DELIBERATELY THIN. Everything worth testing — the minimum length, the debounce, the abort, the
 * stale-response guard — lives in `lib/chat/search.ts`, where it can be exercised with fake
 * timers in a Node environment. What is left here is the part that only React can do: hold the
 * state, and tear the controller down when the workspace closes.
 *
 * The controller is created ONCE. Rebuilding it on a re-render would drop the in-flight request
 * and the sequence number with it, which is precisely how a "fixed" race condition comes back.
 */
export function useGlobalSearch(term: string): SearchState {
  const [state, setState] = useState<SearchState>(IDLE_SEARCH_STATE);

  /*
   * Built once, by a lazy `useState` initializer rather than a `useMemo`.
   *
   * `useMemo` is a performance hint that React is allowed to discard; this is not a cache, it is
   * an OBJECT WITH IDENTITY — it owns the debounce timer, the abort controller and the sequence
   * number that makes a late response harmless. Rebuilding it would drop all three, which is
   * exactly how a fixed race condition comes back. `useState` is the hook that promises to keep
   * a value, so it is the one used.
   *
   * `setState` needs no ref: React guarantees the setter is stable for the life of the component.
   */
  const [controller] = useState<SearchController>(() =>
    createSearchController({
      run: (query, signal) => searchEverything(query, signal),
      onState: setState,
    }),
  );

  useEffect(() => {
    controller.setQuery(term);
  }, [controller, term]);

  useEffect(() => {
    // Leaving the workspace with a request in flight would resolve into an unmounted tree.
    return () => controller.reset();
  }, [controller]);

  return state;
}
