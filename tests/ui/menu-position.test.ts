/**
 * Keeping a context menu on screen.
 *
 * Both right-click menus — the one on a message and the one in the composer (Batch 1.2) — place
 * themselves at the pointer and are then pulled back inside the viewport. That arithmetic lives in
 * `clampToViewport` precisely so it can be checked here, in a Node environment with no DOM: a menu
 * that opens half off the edge is easy to ship and hard to notice until somebody right-clicks the
 * bottom message in a full window.
 */

import { describe, expect, it } from 'vitest';

import { EDGE_MARGIN, clampToViewport } from '@/lib/ui/menuPosition';

/** A typical window, and a typical menu. */
const VIEWPORT = { width: 1280, height: 800 };
const MENU = { width: 200, height: 260 };

describe('clampToViewport', () => {
  it('leaves a menu with room to spare exactly where the pointer was', () => {
    expect(clampToViewport({ x: 400, y: 300 }, MENU, VIEWPORT)).toEqual({ x: 400, y: 300 });
  });

  it('pulls a menu back from the right edge', () => {
    // 1200 + 200 would end at 1400, well past the window.
    const position = clampToViewport({ x: 1200, y: 300 }, MENU, VIEWPORT);

    expect(position.x).toBe(VIEWPORT.width - MENU.width - EDGE_MARGIN);
    expect(position.x + MENU.width).toBeLessThanOrEqual(VIEWPORT.width - EDGE_MARGIN);
  });

  it('pulls a menu up from the bottom edge — right-clicking the newest message', () => {
    const position = clampToViewport({ x: 400, y: 780 }, MENU, VIEWPORT);

    expect(position.y).toBe(VIEWPORT.height - MENU.height - EDGE_MARGIN);
    expect(position.y + MENU.height).toBeLessThanOrEqual(VIEWPORT.height - EDGE_MARGIN);
  });

  it('handles both edges at once, in the bottom-right corner', () => {
    const position = clampToViewport({ x: 1279, y: 799 }, MENU, VIEWPORT);

    expect(position.x + MENU.width).toBeLessThanOrEqual(VIEWPORT.width - EDGE_MARGIN);
    expect(position.y + MENU.height).toBeLessThanOrEqual(VIEWPORT.height - EDGE_MARGIN);
  });

  it('never places a menu above or left of the margin', () => {
    expect(clampToViewport({ x: 0, y: 0 }, MENU, VIEWPORT)).toEqual({
      x: EDGE_MARGIN,
      y: EDGE_MARGIN,
    });
    // A negative pointer position should not be possible, but the arithmetic must not trust that.
    expect(clampToViewport({ x: -50, y: -50 }, MENU, VIEWPORT)).toEqual({
      x: EDGE_MARGIN,
      y: EDGE_MARGIN,
    });
  });

  it('pins a menu larger than the window to the top-left rather than pushing it off', () => {
    const huge = { width: 2000, height: 2000 };
    const position = clampToViewport({ x: 600, y: 400 }, huge, VIEWPORT);

    // The lower bound is applied last and wins, so the part that IS reachable is the part that
    // starts. Pushing it the other way would hide the first row instead of the last.
    expect(position).toEqual({ x: EDGE_MARGIN, y: EDGE_MARGIN });
  });

  it('adapts as the menu grows, which is why the size is measured and not assumed', () => {
    const short = clampToViewport({ x: 400, y: 700 }, { width: 200, height: 80 }, VIEWPORT);
    const tall = clampToViewport({ x: 400, y: 700 }, { width: 200, height: 400 }, VIEWPORT);

    // A short menu still fits below the pointer; a tall one has to move up.
    expect(short.y).toBe(700);
    expect(tall.y).toBeLessThan(700);
  });

  it('respects a caller-supplied margin', () => {
    const position = clampToViewport({ x: 0, y: 0 }, MENU, VIEWPORT, 24);
    expect(position).toEqual({ x: 24, y: 24 });
  });
});
