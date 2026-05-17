import type { Element } from "./elements.js";
import { column } from "./builders.js";
import { clampScroll, followCursor } from "./scroll.js";

export type ScrollListOpts<T> = {
  items: ReadonlyArray<T>;
  // Index of the cursor row, or -1 for "no cursor / nothing to follow".
  cursorIdx: number;
  scrollTop: number;
  viewportRows: number;
  // Render one item; `isCursor` is true for the currently selected row.
  renderItem: (item: T, isCursor: boolean) => Element;
};

export type ScrollListResult = {
  element: Element;
  // The clamped (and cursor-followed) scrollTop. Callers should
  // persist this back into their state so the next render starts
  // from the same place.
  scrollTop: number;
};

/**
 * Render a list of items into a scrollable, cursor-aware column.
 *
 * `scrollList` owns the boilerplate that every list-style TUI screen
 * has rewritten by hand: clamp `scrollTop` to a valid range, follow
 * the cursor if it has moved out of the viewport, slice the visible
 * window, and wrap the rendered items in a `flex-start` column so
 * they don't stretch.
 *
 * It is intentionally a pure builder, not a stateful component:
 * callers pass the cursor and scroll position in, get the new
 * scroll position back, and store both in whatever state shape they
 * want. Cursor styling, item rendering, and key handling all live
 * with the caller.
 */
export function scrollList<T>(opts: ScrollListOpts<T>): ScrollListResult {
  const clamped = clampScroll(opts.scrollTop, opts.items.length, opts.viewportRows);
  const scrollTop = opts.cursorIdx >= 0
    ? followCursor(clamped, opts.cursorIdx, opts.viewportRows)
    : clamped;
  const visible = opts.items.slice(scrollTop, scrollTop + opts.viewportRows);
  const children = visible.map((item, i) =>
    opts.renderItem(item, scrollTop + i === opts.cursorIdx),
  );
  return {
    element: column({ justifyContent: "flex-start" }, ...children),
    scrollTop,
  };
}
