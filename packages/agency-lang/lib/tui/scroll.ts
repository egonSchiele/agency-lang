// Pure helpers for scrollable-list bookkeeping. Used by the logs
// viewer; reusable by any TUI app that needs a cursor + scroll
// position over a flat list of rows.

// Clamp `scrollTop` into `[0, max(0, total - viewportRows)]`. The
// upper bound stops the viewer from rendering an empty viewport
// when the user collapses content beneath them.
export function clampScroll(
  scrollTop: number,
  total: number,
  viewportRows: number,
): number {
  const max = Math.max(0, total - viewportRows);
  if (scrollTop < 0) return 0;
  if (scrollTop > max) return max;
  return scrollTop;
}

// Return a `scrollTop` such that `cursorIdx` is inside the viewport.
// If the cursor is above the viewport, snap it to the top; if below,
// snap it to the last visible row. Otherwise leave `scrollTop`
// untouched (no scroll-on-every-keystroke jitter).
export function followCursor(
  scrollTop: number,
  cursorIdx: number,
  viewportRows: number,
): number {
  if (cursorIdx < scrollTop) return cursorIdx;
  const lastVisible = scrollTop + viewportRows - 1;
  if (cursorIdx > lastVisible) return cursorIdx - viewportRows + 1;
  return scrollTop;
}
