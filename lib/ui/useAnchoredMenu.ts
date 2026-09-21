'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

import { clampToViewport, type Point } from '@/lib/ui/menuPosition';

/**
 * The shared behaviour of a pointer-anchored context menu.
 *
 * Extracted from `MessageContextMenu` when the composer gained one of its own (Batch 1.2). Two
 * menus with independently written dismissal logic is how one of them ends up outliving its
 * context, or trapping focus, or closing on a scroll while the other does not — so there is one
 * implementation and both use it.
 *
 * What it provides:
 *
 *   - **Placement.** Anchored at the pointer, then measured and pulled back inside the viewport in
 *     a layout effect. Measured rather than guessed, because the size depends on the contents; and
 *     in a LAYOUT effect rather than a normal one, because correcting after paint makes the menu
 *     visibly jump.
 *   - **Dismissal, deliberately generous.** Escape, a click anywhere else, a right-click anywhere
 *     else, scrolling and resizing all close it. The right-click case is also what keeps the two
 *     menus from ever being open at once: opening either one closes the other.
 *   - **Focus.** Moves to the first item on open and returns to where it was on close, so a
 *     keyboard user is not dropped at the top of the document.
 *   - **Arrow keys.** The WAI-ARIA menu pattern, minus submenus, which neither menu has.
 *
 * Items are found by their `data-menu-item` attribute rather than being passed in, so a menu can
 * mix buttons and other controls (the reaction row) without telling the hook about them.
 */
export function useAnchoredMenu(anchor: Point, onClose: () => void, itemCount: number) {
  const menuRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const [position, setPosition] = useState<Point>(anchor);

  /*
   * Destructured, so the effect below depends on two NUMBERS rather than on the object.
   *
   * Callers build the anchor inline (`anchor={{ x, y }}`), so a new object arrives on every
   * render. An effect that depended on it would re-run, call `setPosition` with a freshly built
   * object, re-render, receive another new anchor — a loop with no exit. Reading the coordinates
   * out here says that in a way the exhaustive-deps rule can check, instead of suppressing it.
   */
  const { x: anchorX, y: anchorY } = anchor;

  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element) return;

    const { width, height } = element.getBoundingClientRect();
    setPosition(
      clampToViewport(
        { x: anchorX, y: anchorY },
        { width, height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
    // `itemCount` is a dependency because the menu's height changes with it.
  }, [anchorX, anchorY, itemCount]);

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    menuRef.current?.querySelector<HTMLElement>('[data-menu-item]')?.focus();

    return () => {
      // Returning focus matters for keyboard and screen-reader users: without it focus falls back
      // to the document and the next Tab starts from the top of the page.
      previouslyFocused.current?.focus?.();
    };
  }, []);

  useEffect(() => {
    const closeOnOutside = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const closeOnKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        /*
         * Stopped here so Escape means "close the menu" and nothing more.
         *
         * It matters in the composer, where Escape otherwise cancels a reply or an edit: closing
         * the menu must not also throw away the mode the employee was in.
         */
        event.stopPropagation();
        onClose();
      }
    };

    // `capture` on pointerdown so the menu closes before the click lands on whatever is beneath.
    document.addEventListener('pointerdown', closeOnOutside, true);
    document.addEventListener('contextmenu', closeOnOutside, true);
    document.addEventListener('keydown', closeOnKey);
    window.addEventListener('resize', onClose);
    window.addEventListener('scroll', onClose, true);

    return () => {
      document.removeEventListener('pointerdown', closeOnOutside, true);
      document.removeEventListener('contextmenu', closeOnOutside, true);
      document.removeEventListener('keydown', closeOnKey);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [onClose]);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[data-menu-item]') ?? [])];
    if (items.length === 0) return;

    const index = items.indexOf(document.activeElement as HTMLElement);
    const focusAt = (next: number) => {
      event.preventDefault();
      items[(next + items.length) % items.length]?.focus();
    };

    if (event.key === 'ArrowDown') focusAt(index + 1);
    else if (event.key === 'ArrowUp') focusAt(index - 1);
    else if (event.key === 'Home') focusAt(0);
    else if (event.key === 'End') focusAt(items.length - 1);
  }, []);

  return { menuRef, position, onKeyDown };
}
