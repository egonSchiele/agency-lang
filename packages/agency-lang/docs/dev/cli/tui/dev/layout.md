# Layout Engine

## Overview

`lib/tui/layout.ts` implements a flexbox-lite layout engine. It is a pure function: `layout(element, availableWidth, availableHeight) -> PositionedElement`. Given an element tree and available terminal dimensions, it produces a tree of positioned elements with absolute `{ resolvedX, resolvedY, resolvedWidth, resolvedHeight }` on every node.

## Architecture

Three functions divide the work:

- **`layoutRoot`** — Handles the root element, which has no parent. Both axes are resolved by the element itself against the available space.
- **`layoutChild`** — Handles child elements. The parent has already determined the main-axis size. The child resolves only its cross-axis size.
- **`layoutChildren`** — The core flexbox algorithm. Shared by both `layoutRoot` and `layoutChild`. Takes an element's children and positions them using a 3-pass approach.

`layoutChildren` first drops every child whose style sets `visible: false`. If nothing is left, it returns `undefined` and the parent gets no `children` array at all.

### The Parent-Owns-Main / Child-Owns-Cross Design

This is the key architectural decision. In a flex container:

- The **main axis** (horizontal for `row`, vertical for `column`) is the direction children are laid out. The *parent* must own this axis because it distributes space among siblings — only it knows about remaining space and flex ratios.
- The **cross axis** (perpendicular) can be resolved by the *child* itself, subject to the parent's `alignItems`.

`layoutChild` receives `mainAxisSize` (already computed, used as-is) and `crossAxisAvailable` (the child resolves its own cross dimension against this). This eliminates the double-resolution bug where a percentage would be resolved twice against shrinking contexts.

## The Three-Pass Algorithm

### Pass 1: Measure fixed children, defer flex children

For each visible child, determine its main-axis size:
- **Fixed/percentage children**: Resolve `width`/`height` against the parent's inner dimension. Add to `usedMain`.
- **Flex children**, and children with no explicit size: Record their flex value and defer sizing to pass 2. A child with no explicit size and no flex is treated as `flex: 1`.

A child that sets both `flex` and an explicit main-axis size is treated as a flex child. The explicit size is ignored on the main axis.

Margins always count against `usedMain`, whether the child is fixed or flex. Pass 1 also caches each child's resolved margins so pass 3 does not recompute them.

### Pass 2: Distribute remaining space

`remainingMain = max(0, mainSize - usedMain)`. Distribute it proportionally among the flex children based on their flex values, rounding each share down.

### Pass 3: Position children

Compute each child's `(x, y)` position along the main axis. This is where `justifyContent` and `alignItems` take effect:

- **`justifyContent`** controls main-axis distribution:
  - `flex-start` (default): children start at the beginning
  - `flex-end`: children are pushed to the end
  - `center`: children are centered
  - `space-between`: remaining space distributed as gaps between children, but only when there is more than one child

- **`alignItems`** controls cross-axis positioning, and `layoutChildren` passes it down to `layoutChild`. It moves the child, it does not size it. A child's cross size comes from its own `width` or `height` when set, and otherwise fills the available cross space.
  - `stretch` (default): no offset, so an unsized child fills the cross axis
  - `flex-start`: no offset, child sits at the start of the cross axis
  - `flex-end`: child pushed to the end
  - `center`: child centered on the cross axis

## Inner Area Computation

`innerArea` in `utils.ts` computes the parent's inner area before its children are laid out. It subtracts padding, plus one cell per side when the element has a border. It clamps the resulting width and height to 0, so a border and padding larger than the element itself cannot produce a negative size.

## Key Types

- `PositionedElement` (`elements.ts`) — extends `Element` with `resolvedX`, `resolvedY`, `resolvedWidth`, `resolvedHeight`, and `PositionedElement[]` children
- `Edges` (`utils.ts`) — `{ top, bottom, left, right }`, used for padding and margin

## Dependencies

From `utils.ts`:

- `resolveEdges` — normalizes padding and margin from `number | object | undefined` to `Edges`
- `innerArea` — subtracts border and padding from an element's box

Private to `layout.ts`:

- `resolveDimension` — resolves a number or a percentage string like `"50%"` against the available space, flooring the result. It throws on any other string.
- `clampDimension` — applies `min`/`max` constraints
