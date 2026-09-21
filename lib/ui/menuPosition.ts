/**
 * Keeping a pointer-anchored menu inside the window.
 *
 * Pure arithmetic, separated from the component so it can be read and tested without a DOM — the
 * test environment is Node (vitest.config.mts), and "does the menu stay on screen" is exactly the
 * sort of rule that is easy to get subtly wrong and impossible to notice until somebody
 * right-clicks near an edge.
 */

/** How far from the window edge a menu refuses to sit. */
export const EDGE_MARGIN = 8;

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/**
 * Moves an anchor point so a menu of the given size fits in the viewport.
 *
 * The menu's top-left corner is placed at the pointer and then pulled back if it would overhang
 * the right or bottom edge — which is why the size has to be MEASURED rather than assumed: the
 * row count changes with what the message allows.
 *
 * A menu taller or wider than the viewport pins to the top-left margin rather than being pushed
 * off the opposite edge. The lower bound is applied last, so it wins over the upper bound, and the
 * part of the menu that is reachable is the part that starts.
 */
export function clampToViewport(
  anchor: Point,
  size: Size,
  viewport: Size,
  margin: number = EDGE_MARGIN,
): Point {
  const maxX = viewport.width - size.width - margin;
  const maxY = viewport.height - size.height - margin;

  return {
    x: Math.max(margin, Math.min(anchor.x, maxX)),
    y: Math.max(margin, Math.min(anchor.y, maxY)),
  };
}
