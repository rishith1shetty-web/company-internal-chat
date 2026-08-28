'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * Subscribes to a CSS media query.
 *
 * `useSyncExternalStore` rather than state-plus-effect: the match is external browser state, so
 * React reads it directly instead of copying it into state after mount. That keeps the server
 * and first client render in agreement (the server snapshot is always `false`) without a
 * cascading re-render.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    // Server render: assume the narrow layout, so nothing that only suits a wide screen is
    // rendered before the browser has said the screen is wide.
    () => false,
  );
}
