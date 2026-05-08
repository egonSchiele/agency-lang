# Rendering Pipeline

## Overview

The rendering pipeline converts an element tree into visual output in three stages:

```
Element tree → layout() → PositionedElement tree → render() → Frame tree → flatten() → Cell[][] → toANSI/toHTML/toPlainText
```

This runs on every keypress in the debugger, so the pipeline is performance-sensitive.

## Stage 1: Layout (`lib/layout.ts`)

See `docs/dev/layout.md` for details. Produces a `PositionedElement` tree with absolute positions and sizes.

## Stage 2: Render (`lib/render/renderer.ts`)

`render(positioned: PositionedElement): Frame` converts positioned elements into a `Frame` tree with content cells.

For each element:
1. Compute inner area (subtract border + padding)
2. If the element has a border or background, create a full `Cell[][]` grid and draw the border/background
3. Render inner content based on element type:
   - **text/box with content**: parse styled text via `parseStyledText()`, render spans into cells. Apply `scrollOffset` for scrollable containers.
   - **list**: render items as rows, highlight `selectedIndex` with blue background. Auto-scroll to keep selection visible.
   - **textInput**: render value text with a cursor character (`█`)
4. Blit inner content into the frame grid using `blitCells()`
5. Recurse into children

### Scroll Propagation

Scrolling is an interesting case: the `scrollable` and `scrollOffset` styles are on a *parent* box, but the actual text content is in a *child* text element. The renderer passes `parentScrollOffset` down to children so text elements can apply it.

## Stage 3: Flatten (`lib/render/flatten.ts`)

`flatten(frame, width, height): Cell[][]` composites a Frame tree into a flat 2D cell grid. It creates a blank grid, then recursively blits each frame's content cells at its absolute position. Children are blitted after parents, so they paint on top.

The flatten function uses the root frame's `x`/`y` as the origin offset. This is critical for sub-frames: when you call `frame.findByKey("child").toPlainText()`, the child frame's `x`/`y` are non-zero (absolute coordinates from the full screen), but the output grid should be sized to the child's dimensions. The origin offset ensures the child's content starts at grid position (0, 0).

## Stage 4: Output Adapters

All three adapters call `flatten()` first, then format the resulting grid:

- **`toANSI`** (`lib/render/ansi.ts`): Collects runs of same-styled cells, emits ANSI escape codes for color/bold, resets at run boundaries.
- **`toHTML`** (`lib/render/html.ts`): Collects runs of same-styled cells, wraps in `<span style="...">`. Only emits known color names (from `cssColors`) to prevent CSS injection. Uses shared `escapeHtml()` from `utils.ts`.
- **`toPlainText`** (`lib/render/plaintext.ts`): Just joins characters, trims trailing spaces per row.

## Key Types

- **`Frame`** (`lib/frame.ts`): A class with `key`, `x`, `y`, `width`, `height`, `style` (FrameStyle), `content` (Cell[][]), and `children` (Frame[]). Has `findByKey()`, `toPlainText()`, `toHTML()`, and `image()` methods.
- **`Cell`** (`lib/elements.ts`): `{ char, fg?, bg?, bold? }` — a single character with styling.
- **`FrameStyle`**: `Pick<Style, "border" | "borderColor" | "bg" | "label" | "labelColor">` — the subset of Style that applies to frame decoration.

## Helper Functions

- `blitCells(dest, src, startX, startY, maxW, maxH)` — copies a source Cell[][] into a destination at an offset
- `makeGrid(width, height, bg?)` — creates a blank Cell[][] filled with spaces
- `renderBorder(grid, width, height, borderColor, label, labelColor)` — draws box-drawing characters into a grid
