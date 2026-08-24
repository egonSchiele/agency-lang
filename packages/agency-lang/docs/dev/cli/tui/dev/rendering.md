# Rendering Pipeline

## Overview

The rendering pipeline converts an element tree into visual output in three stages:

```
Element tree → layout() → PositionedElement tree → render() → Frame tree → flatten() → Cell[][] → toANSI/toHTML/toPlainText
```

This runs on every keypress in the debugger and the logs viewer, so the pipeline is performance-sensitive.

## Stage 1: Layout (`lib/tui/layout.ts`)

See [layout.md](./layout.md) for details. Produces a `PositionedElement` tree with absolute positions and sizes.

## Stage 2: Render (`lib/tui/render/renderer.ts`)

`render(positioned: PositionedElement): Frame` converts positioned elements into a `Frame` tree with content cells.

For each element:
1. Compute inner area (subtract border + padding)
2. If the element has a border or background, create a full `Cell[][]` grid and draw the border/background
3. Render inner content based on element type:
   - **text/box with content**: parse styled text via `parseStyledText()`, render spans into cells. Apply `scrollOffset` for scrollable containers.
   - **list**: render items as rows, highlight `selectedIndex` with a blue background. One item can span several rows, so auto-scroll targets visual rows rather than item indices. A `selectedIndex` past the end of the list is the follow-tail sentinel: scroll to the newest rows but draw no selection chrome.
   - **textInput**: render the value with a cursor character (`█`) at the end of the last line. Each `\n` starts a new row, long lines clip at the inner width, and a buffer taller than the box renders its trailing window so the cursor stays visible.
4. Blit inner content into the frame grid using `blitCells()`
5. Recurse into children

### Scroll Propagation

Scrolling is an interesting case. The `scrollable` and `scrollOffset` styles sit on a *parent* box, but the actual text content is in a *child* text element. The renderer passes `parentScrollOffset` down to children so text elements can apply it.

## Stage 3: Flatten (`lib/tui/render/flatten.ts`)

`flatten(frame, width, height): Cell[][]` composites a Frame tree into a flat 2D cell grid. It creates a blank grid, then recursively blits each frame's content cells at its absolute position. Children are blitted after parents, so they paint on top.

The flatten function uses the root frame's `x`/`y` as the origin offset. This is critical for sub-frames. When you call `frame.findByKey("child").toPlainText()`, the child frame's `x`/`y` are absolute screen coordinates and so non-zero, but the output grid should be sized to the child's dimensions. The origin offset ensures the child's content starts at grid position (0, 0).

## Stage 4: Output Adapters

All three adapters call `flatten()` first, then format the resulting grid:

- **`toANSI`** (`lib/tui/render/ansi.ts`): Collects runs of same-styled cells, emits ANSI escape codes for color/bold, resets at run boundaries.
- **`toHTML`** (`lib/tui/render/html.ts`): Collects runs of same-styled cells, wraps in `<span style="...">`. A color is emitted only when it is a known name in `cssColors` or a literal `#rgb` / `#rrggbb` hex string. Anything else is dropped, which is what prevents CSS injection. Uses the shared `escapeHtml()` from `utils.ts`.
- **`toPlainText`** (`lib/tui/render/plaintext.ts`): Just joins characters, trims trailing spaces per row.

## Key Types

- **`Frame`** (`lib/tui/frame.ts`): A class with `key`, `x`, `y`, `width`, `height`, `style` (FrameStyle), `content` (Cell[][]), and `children` (Frame[]). Has `findByKey()`, `toPlainText()`, `toHTML()`, and `image()` methods.
- **`Cell`** (`lib/tui/elements.ts`): `{ char, fg?, bg?, bold? }`, a single character with styling.
- **`FrameStyle`**: `Pick<Style, "border" | "borderColor" | "bg" | "label" | "labelColor">`, the subset of Style that applies to frame decoration.

## Helper Functions

These all live in `lib/tui/render/renderer.ts` and are module-private:

- `blitCells(dest, src, startX, startY, maxW, maxH)` — copies a source Cell[][] into a destination at an offset
- `makeGrid(width, height, bg?)` — creates a blank Cell[][] filled with spaces
- `renderBorder(grid, width, height, borderColor?, label?, labelColor?)` — draws box-drawing characters into a grid

`flatten()` does not use `blitCells`. It has its own recursive `blitFrame` helper that clips against the output grid.
