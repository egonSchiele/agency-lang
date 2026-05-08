# Layout Engine

## Overview

`lib/layout.ts` implements a flexbox-lite layout engine. It is a pure function: `layout(element, width, height) -> PositionedElement`. Given an element tree and available terminal dimensions, it produces a tree of positioned elements with absolute `{ resolvedX, resolvedY, resolvedWidth, resolvedHeight }` on every node.

## Architecture

Three functions divide the work:

- **`layoutRoot`** — Handles the root element, which has no parent. Both axes are resolved by the element itself against the available space.
- **`layoutChild`** — Handles child elements. The parent has already determined the main-axis size. The child resolves only its cross-axis size.
- **`layoutChildren`** — The core flexbox algorithm. Shared by both `layoutRoot` and `layoutChild`. Takes an element's children and positions them using a 3-pass approach.

### The Parent-Owns-Main / Child-Owns-Cross Design

This is the key architectural decision. In a flex container:

- The **main axis** (horizontal for `row`, vertical for `column`) is the direction children are laid out. The *parent* must own this axis because it distributes space among siblings — only it knows about remaining space and flex ratios.
- The **cross axis** (perpendicular) can be resolved by the *child* itself, subject to the parent's `alignItems`.

`layoutChild` receives `mainAxisSize` (already computed, used as-is) and `crossAxisAvailable` (the child resolves its own cross dimension against this). This eliminates the double-resolution bug where a percentage would be resolved twice against shrinking contexts.

## The Three-Pass Algorithm

### Pass 1: Measure fixed children, defer flex children

For each visible child, determine its main-axis size:
- **Fixed/percentage children**: Resolve `width`/`height` against the parent's inner dimension. Add to `usedMain`.
- **Flex children** (or children with no explicit size): Record their flex value, defer sizing to pass 2. Children with no explicit size and no flex are treated as `flex: 1`.

Also caches each child's resolved margins to avoid recomputing in pass 3.

### Pass 2: Distribute remaining space

`remainingMain = max(0, mainSize - usedMain)`. Distribute proportionally among flex children based on their flex values.

### Pass 3: Position children

Compute each child's `(x, y)` position along the main axis. This is where `justifyContent` and `alignItems` take effect:

- **`justifyContent`** controls main-axis distribution:
  - `flex-start` (default): children start at the beginning
  - `flex-end`: children are pushed to the end
  - `center`: children are centered
  - `space-between`: remaining space distributed as gaps between children

- **`alignItems`** controls cross-axis positioning (passed to `layoutChild`):
  - `stretch` (default): child fills the cross axis
  - `flex-start`: child at the start of the cross axis
  - `flex-end`: child at the end
  - `center`: child centered on the cross axis

## Inner Area Computation

Before laying out children, the parent's inner area is computed by subtracting border (1 per side if present) and padding. Both `innerWidth` and `innerHeight` are clamped to 0 to handle cases where border+padding exceeds the element's total size.

## Key Types

- `PositionedElement` — extends `Element` with `resolvedX`, `resolvedY`, `resolvedWidth`, `resolvedHeight`
- `Edges` — `{ top, bottom, left, right }` used for padding and margin

## Dependencies

- `resolveEdges` from `utils.ts` — normalizes padding/margin from `number | object | undefined` to `Edges`
- `resolveDimension` — resolves `number | "50%" | undefined` against available space
- `clampDimension` — applies min/max constraints
