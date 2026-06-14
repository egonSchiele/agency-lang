# std::chart — terminal bar charts (design)

Date: 2026-06-13

## Overview

Add a new stdlib module, `std::chart`, for rendering **horizontal bar
charts** in the terminal. Charts are **first-class layout nodes**: a
`barChart(...)` call returns a `LayoutNode` that the layout render
pipeline knows how to size and paint, so charts nest inside `box` /
`row` / `column` / `table` and reuse all of layout's ANSI, width, and
`Block` machinery.

The module follows the same dual-construction pattern as `std::layout`:

- a **trailing block** form for ergonomic Agency authoring, and
- a **data-parameter** form (plain arrays) suitable for JSON / LLM
  tool calls.

The work has three phases:

- **Part A — Layout reorg.** Collapse layout's two parallel dispatch
  tables (`SIZERS`, `RENDERERS`) into one `HANDLERS` table that
  co-locates each node type's size + render logic. Pure refactor, **no
  behavior change**. This makes "add a node type" a one-entry change.
- **Part B — Extract `std::table`.** Move the table *constructor*
  surface out of `std::layout` into its own Agency module, leaving
  `std::layout` as the structural primitives. The table *renderer*
  stays a registered handler in the layout pipeline.
- **Part C — The bar chart.** Add `barchart` as one new handler plus a
  new Agency module (`std::chart`) that constructs the node — mirroring
  the now-clean `std::table` as its sibling.

### Module boundaries (end state)

The Agency module boundary and the TS render pipeline are **separate
concerns**:

- **Agency-side constructor modules** (public API): `std::layout`
  (box / row / column / text / raw / space / hline / vline + `render`),
  `std::table` (`table`), `std::chart` (`barChart`). Each just builds
  `{ type, attrs, children }` nodes.
- **TS render pipeline** (`lib/stdlib/layout/`): owns the `HANDLERS`
  registry and *all* node renderers — including `table.ts` and
  `barchart.ts` — because table and barchart are node types in the same
  render tree.

So `std::table` and `std::chart` are exactly parallel: thin Agency
modules whose renderers live as registered handlers in the layout
pipeline.

## Decisions (locked during brainstorming)

| # | Decision |
|---|----------|
| 1 | **Horizontal** bars only for v1. |
| 2 | Chart is a **first-class layout node** (Approach 2), modeled on `table`. |
| 3 | Phase order: **handler-per-type reorg → extract `std::table` → add chart.** |
| 4 | **One chart type, done well**: horizontal bar with grouped + stacked modes, colors, symbols, legend. |
| 5 | **Keys + positional values** data model (table-like): a `keys` array names/colors each series; each bar has a positional `values` array aligned to keys by index. |
| 6 | **Negatives supported** via a zero baseline (bidirectional bars) for single-series and grouped. **Stacked bars must be uniform-sign**; mixed-sign stacks rejected with a clear error. |
| 7 | **Extract `std::table`** as its own Agency module, **hard move** (no back-compat re-export from `std::layout`). |
| 8 | **Coloring uses `lib/utils/termcolors.ts`** (not layout's `ansi.ts`) for the chart renderer. |

## Reference / attribution

npm research surfaced **chartscii** (MIT, TypeScript) as the closest
existing implementation — it already does stacked bars and per-segment
colors. We **lift its value→cell scaling + largest-remainder rounding**
(so stacked segments sum exactly to the bar area) — roughly 15 lines we
adapt, with a credit comment carrying the MIT notice in `barchart.ts`.
We do **not** add an npm dependency.

**babar was evaluated and rejected.** Despite being ~100 lines, it is
(a) written in **CoffeeScript**, not droppable into a TS codebase, and
(b) the wrong model — it plots `[x, y]` points on a **vertical
coordinate plane**, and its README explicitly limits it to "one data
set per graph, only numerical labels, only linear axes." No keys, no
stacking, no categorical labels, no legend, no horizontal bars. It
would save none of our actual rendering work.

**Color** comes from `lib/utils/termcolors.ts`, a chalk-style chainable
API (`color.blue(s)`, `color.green.bold(s)`, `color.hex("#cc7a4a")(s)`,
`color.dim(s)`). It emits standard SGR sequences, so layout's
`visualWidth` / `stripAnsi` measure and strip them correctly and
colored strings compose cleanly through the `Block` algebra. All other
width / `Block` primitives already exist in `lib/stdlib/layout/`.

---

## Part A — Layout reorg: handler-per-type

### Motivation

Today a node type's behavior is split across two tables keyed by
`node.type`:

- `SIZERS` (in `render.ts`) — phase 1, resolves widths top-down.
- `RENDERERS` (in `render.ts`, importing the `compose*` functions) —
  phase 2, paints each node to a `Block`.

The per-type *size* functions all live in `render.ts`; the per-type
*render* functions live in the per-concern files (`axis.ts`, `box.ts`,
`table.ts`, `nodes.ts`). A reader who wants to know "how does a box
behave" must look in two places. Merging them makes each per-concern
file the single source of truth for its node type, and makes adding the
chart node a one-entry change.

### Target shape

In `render.ts`:

```ts
export type NodeHandler = {
  size:   (node: LayoutNode, ctx: SizingContext) => LayoutNode;
  render: (node: LayoutNode) => Block;
};

export const HANDLERS: Record<NodeType, NodeHandler> = {
  box, row, column, table,
  text, raw, space, hline, vline,
  // Part C adds: barchart,
};

export function resolveNode(node: LayoutNode, ctx: SizingContext): LayoutNode {
  return HANDLERS[node.type].size(node, ctx);
}

export function renderNode(node: LayoutNode): Block {
  const h = HANDLERS[node.type];
  if (!h) throw new Error(`std::layout: unknown node type "${node.type}"`);
  return h.render(node);
}
```

Each per-concern file exports a single `NodeHandler` (or a small object
of them, for files that own multiple types):

- `box.ts` → `export const box: NodeHandler = { size: sizeBox, render: composeBox }`
- `axis.ts` → `export const row` and `export const column`
- `table.ts` → `export const table` (wraps the existing `sizeTable` /
  `composeTable` / `_resolveTableWidths`)
- `nodes.ts` → the leaf handlers (`text`, `raw`, `space`, `hline`,
  `vline`), pairing `sizeText` / `passthrough` with the existing
  `LEAF_RENDERERS`.

### File moves

| Function | From | To |
|---|---|---|
| `sizeBox` | `render.ts` | `box.ts` |
| `sizeRow`, `sizeColumn` | `render.ts` | `axis.ts` |
| `sizeTable` | `render.ts` | `table.ts` |
| `sizeText`, leaf `passthrough` sizers | `render.ts` | `nodes.ts` |

### New file: `sizing.ts`

The cross-type sizing helpers move out of `render.ts` into a small
shared module so the per-concern handler files can import them without
pulling in the whole dispatcher:

- `SizingContext` (type)
- `resolveOwnWidth`
- `resolveContainer`
- `innerWidthAfterChrome`
- `nonNegativeInteger`
- `setAttr`

`resolveContainer` recurses via `resolveNode`, which stays in
`render.ts`. The per-concern files therefore import `sizing.ts` for the
helpers and `render.ts` for the `resolveNode` / `renderNode` recursion
points. This is the **same benign import cycle** the codebase already
documents in `render.ts` for `renderNode`: every use is inside a
function body, so module loading completes before any call happens.

`render.ts` slims to the orchestrator: `HANDLERS`, `resolveNode`,
`renderNode`, `resolveSizes`, `_viewport`, `growToWidth`, the color
logic (`_autoUseColor`), and `_render`.

### Test surface

`layout.ts` currently pins `RENDERERS` and assorted internals onto
`_internal` for tests. To minimize churn:

- Add `HANDLERS` to `_internal`.
- Keep `RENDERERS` and `SIZERS` as **derived views** for back-compat:
  `Object.fromEntries(Object.entries(HANDLERS).map(([k, h]) => [k, h.render]))`
  and the `.size` equivalent.

`layout.test.ts` should pass unchanged.

### Acceptance criteria (Part A)

- **No behavior change.** Every existing golden / unit test in
  `layout.test.ts` passes with no edits to expected output.
- `make` builds clean; structural linter passes.
- Each per-concern file owns both halves of its node type's behavior.

---

## Part B — Extract `std::table`

### Motivation

`table` is a heavy tenant of `std::layout`: ~150–200 lines of
table-specific Agency surface plus the 625-line `table.ts` renderer.
Moving the constructor surface into its own module leaves `std::layout`
as just the structural primitives and gives `std::chart` a clean
sibling to mirror.

### What moves (Agency side)

A new module `stdlib/table.agency` (`std::table`) receives, lifted
verbatim from `layout.agency`:

- **Types:** `Cell`, `CellRow`, `ColumnSpec`, `TableBuilder`.
- **Builder helpers:** `_setTableColumns`, `_setTableCaption`,
  `_setTableHeader`, `_addTableRow`, `_addTableFooter`,
  `_makeTableBuilder`.
- **Constructor:** `table()`.

`table.agency` imports the types it depends on from `std::layout`
(`LayoutNode`, `Width`, `Alignment`, `BorderStyle`) and **re-exports
`render`** so a table-only user needs a single import.

### What stays

- **The renderer stays put.** `lib/stdlib/layout/table.ts` and the
  `table` entry in `HANDLERS` are unchanged — table is still a node
  type in the layout render tree. Only the Agency-side public module
  boundary moves.

### Hard move (decision 7)

`table` and its types are **removed** from `layout.agency`; there is no
re-export. `import { table } from "std::layout"` stops working;
`import { table } from "std::table"` is the new path. The module is
~11 days old, so in-repo updates cover the blast radius:

- Grep the repo for `table` / `Cell` / `ColumnSpec` imports from
  `std::layout` (tests, fixtures, examples, guide snippets) and repoint
  them to `std::table`.
- Update `layout.agency`'s `@module` doc (which currently documents
  `table`) to point readers at `std::table`.
- Regenerate `stdlib/table.js` and the generated stdlib docs via `make`.

### Acceptance criteria (Part B)

- `std::layout` no longer exports `table` / table types; `std::table`
  does.
- All in-repo references compile and pass.
- Rendered table output is byte-identical (renderer untouched).

---

## Part C — The bar chart node

### New Agency module: `std::chart` (`stdlib/chart.agency`)

Pure data construction. Depends on `std::layout` only for the
`LayoutNode` / `Width` types and a **re-exported `render`**. All
rendering lives TS-side in the `barchart` handler.

#### Types

```ts
/** A series. One per stacked/grouped segment; colors/symbols auto-assign if omitted. */
export type BarKey = {
  name: string
  color?: string    # termcolors name (e.g. "blue", "brightCyan") or hex "#cc7a4a"
  symbol?: string   # fill char; disambiguates keys when color is disabled
}

/** One category. `values` aligns to `keys` by index (length must match). */
export type Bar = {
  label: string
  values: number[]
}

export type BarMode = "stacked" | "grouped"

/** Methods inside a barChart trailing `as c { ... }` block. */
export type ChartBuilder = {
  key: any
  bar: any
}
```

#### Constructor

```ts
export safe def barChart(
  title: string = "",
  mode: BarMode = "grouped",
  keys: BarKey[] = null,
  data: Bar[] = null,
  showValues: boolean = true,
  legend: boolean = true,
  max: number = 0,                 // 0 = auto from data
  barChar: string = "█",           // default fill cell (single-series / first key)
  width: Width = null,             // number | "full" | "X%"
  block: (ChartBuilder) -> void = null,
): LayoutNode
```

Returns a **leaf node** (data-in-attrs, like `table`):

```ts
{ type: "barchart", attrs: { title, mode, keys, data, showValues,
  legend, max, barChar, /* width if set */ }, children: [] }
```

Construction styles (both produce the identical node):

```ts
// data-param form (LLM-friendly)
barChart(
  title: "Revenue by quarter",
  mode: "stacked",
  keys: [
    { name: "web", color: "blue" },
    { name: "app", color: "green" },
    { name: "api", color: "brightYellow" },
  ],
  data: [
    { label: "Q1", values: [120, 80, 30] },
    { label: "Q2", values: [98, 90, 45] },
  ],
)

// block form
barChart(title: "Revenue by quarter", mode: "stacked") as c {
  c.key("web", color: "blue")
  c.key("app", color: "green")
  c.key("api", color: "brightYellow")
  c.bar("Q1", 120, 80, 30)
  c.bar("Q2", 98, 90, 45)
}

// single-series: one key (or none)
barChart(data: [
  { label: "North", values: [82] },
  { label: "South", values: [58] },
])
```

#### Builder helpers (Agency side)

Following the `table` pattern: `_addKey(state, name, color, symbol)`
and `_addBar(state, label, ...values)` take a mutable `state` record,
push onto `state.keys` / `state.data`, and are `.partial(state: state)`
bound by `_makeChartBuilder`. `c.bar` is variadic over values
(`...values: number[]`). When both `keys`/`data` params and a `block`
are supplied, params seed the state and the block appends (mirrors
`table`).

### New TS handler: `lib/stdlib/layout/barchart.ts`

Wired into `HANDLERS` as `{ size: sizeBarChart, render: renderBarChart }`,
and `barchart` is added to the `NodeType` union in `nodes.ts`. This is
the one-entry payoff of Part A.

#### `sizeBarChart(node, ctx)`

- `const own = resolveOwnWidth(node, ctx)`.
- If `own === undefined` (unsized, no sized ancestor): fall back to a
  default total width = label column + value column + a default bar
  area of `40` cells.
- Stamp `attrs.resolvedWidth`. **Leaf** — no child recursion.
- This is what makes `width: 80`, `"full"`, `"50%"`, and nested
  `"100%"` all resolve correctly through the normal sizing pass.

#### `renderBarChart(node)`

Pure function `LayoutNode → Block`. Steps:

1. **Decode + validate** attrs (see Errors below). Auto-assign colors
   and symbols to any key missing them (round-robin from a default
   palette of termcolors names + a distinct-symbols list). Single-series
   with no keys → one implicit key whose fill is `barChar`.
2. **Measure columns:** label column = max `visualWidth(label)`; value
   column = max width of the formatted value string (when
   `showValues`). bar area = `resolvedWidth − labelCol − valueCol −
   gaps`.
3. **Compute scale + baseline.** Data range is
   `[min(0, dataMin), max(0, dataMax)]` where `dataMin/Max` come from
   the per-bar quantity (single value for grouped; row sum for
   stacked). If `dataMin ≥ 0`, baseline column = 0 (left edge — the
   simple positive-only path). Otherwise baseline column =
   `round((0 − rangeMin) / (rangeMax − rangeMin) · barArea)`, splitting
   the bar area into left (negative) and right (positive) halves.
4. **Draw bars:**
   - **grouped / single-series:** one sub-line per key. A bar of
     magnitude `|value|` occupies `round(|value| / rangeSpan · barArea)`
     cells, drawn from the baseline column toward the right (positive)
     or left (negative), filled with the key's symbol, colored with the
     key's color. The category label sits on the first sub-line only.
   - **stacked:** one line per bar; key segments concatenated from the
     baseline outward in the bar's (uniform) sign direction, each
     `round(value / rangeSpan · barArea)` cells. Leftover rounding is
     distributed so segments sum exactly to the bar's total length
     (largest-remainder method, adapted from chartscii).
   - Remainder of the bar area is padded with a dim track char
     (`color.dim`).
5. **Value labels** (when `showValues`): right-aligned in the value
   column; for negative bars the number reads on the bar's left side.
6. **Legend** (when `legend` and ≥1 named key): a row of `▇ name`
   swatches, one per key, using each key's color + symbol.
7. **Assemble** title + legend + bars into a `Block` via
   `above` / `beside` / `pad` — the same primitives `table` uses.

#### Coloring (termcolors)

- Import `color` from `lib/utils/termcolors.ts`
  (`../../utils/termcolors.js` from `barchart.ts`).
- A `resolveColor(name): (s: string) => string` helper maps a key's
  `color` string to a termcolors function: `#hex` → `color.hex(name)`,
  a known style name → `color[name]`, otherwise an identity (no color).
- **Use `color`, not `ttyColor`.** `ttyColor` self-noops when stdout
  isn't a TTY, which would double-gate against layout's own
  `_render(color)` / `stripAnsi` path and break both the explicit
  `render(color: false)` override and golden-test determinism. Layout
  stays the single authority on color on/off.
- The chart builds its `Block` lines as plain strings with embedded
  termcolors SGR. `visualWidth` strips the SGR for measurement; when
  color is disabled, `_render`'s `stripAnsi` removes the codes and the
  per-key **symbols** still disambiguate the keys. (Layout's existing
  `ansi.ts` styling for `text` / `box` is left untouched — decision 8
  scopes termcolors to the chart.)

### Errors & edge cases (render-time, named like table mismatches)

- **values/keys length mismatch:** each bar's `values.length` must equal
  `keys.length` (or exactly `1` when no keys). Throw naming the
  offending bar label.
- **mixed-sign stacked bar:** a stacked bar whose `values` contain both
  positive and negative entries is rejected with a clear error (uniform
  sign required in v1).
- **empty data:** render title + legend only (no bars).
- **zero range / all-zero data:** guard against divide-by-zero; render
  empty bars at the baseline.
- **non-finite values:** rejected with a clear error.

### Wiring checklist (Part C)

- `nodes.ts`: add `"barchart"` to the `NodeType` union.
- `barchart.ts`: new file (`sizeBarChart`, `renderBarChart`,
  `resolveColor`, palette, pure helpers; MIT credit comment).
- `render.ts`: add `barchart` to `HANDLERS`.
- `layout.ts`: export `barchart` internals on `_internal` for tests.
- `stdlib/chart.agency`: new module (types, `barChart`, builder
  helpers, re-export `render`).
- Regenerate `stdlib/chart.js` via `make`.

---

## Testing plan

- **TS unit tests** (via `_internal`): value→cell scaling, baseline
  column computation, segment lengths + leftover-rounding sum,
  color/symbol round-robin assignment, legend construction. Pure
  functions, no I/O.
- **Golden render tests:** `barChart(...) → render(color: false) →
  expected string`, covering: single-series; grouped multi-key;
  stacked; negatives (single + grouped) with baseline; `legend` on/off;
  `showValues` on/off; explicit `width` number + `"full"`; and each
  error case (length mismatch, mixed-sign stack).
- **Agency execution test** (`tests/agency/`, no LLM required per the
  testing guide): one `.agency` file that builds a chart both ways
  (block + data-param) and asserts the rendered output string.
- **Part A regression:** `layout.test.ts` passes unchanged.
- **Part B regression:** table render output byte-identical; all
  repointed imports compile and pass.

## Documentation

- Module-level (`@module`) and per-function docstrings in
  `chart.agency` and `table.agency` — required because stdlib reference
  docs are generated from source, and docstrings double as LLM tool
  descriptions. Use `@param` form so PFA-bound params are stripped
  cleanly.
- Update `layout.agency`'s `@module` doc to drop table and point at
  `std::table`.
- Run `make` after stdlib changes.
- Guide page (`docs/site/guide/`) is a **stretch goal**, not required
  for v1.

## Out of scope (future)

- Vertical bars.
- Mixed-sign stacked bars.
- A rendered numeric axis with tick marks (v1 shows per-bar value
  labels + a zero baseline marker only).
- A back-compat re-export of `table` from `std::layout` (hard move).
- Other chart types (line, sparkline, scatter).

## File-change summary

**Part A (refactor, no behavior change):**
- `lib/stdlib/layout/render.ts` — introduce `HANDLERS`; slim to orchestrator.
- `lib/stdlib/layout/sizing.ts` — **new**; shared sizing helpers.
- `lib/stdlib/layout/box.ts`, `axis.ts`, `table.ts`, `nodes.ts` —
  export per-type `NodeHandler`s; absorb their sizers.
- `lib/stdlib/layout.ts` — `_internal` exposes `HANDLERS`; derived
  `RENDERERS`/`SIZERS` for back-compat.

**Part B (extract std::table, hard move):**
- `stdlib/table.agency` — **new** module (table types + builders +
  `table()` + re-export `render`); generated `stdlib/table.js`.
- `stdlib/layout.agency` — remove table types/builders/`table()`;
  update `@module` doc.
- Repo-wide: repoint `import { table } from "std::layout"` →
  `"std::table"` in tests, fixtures, examples, docs.
- `lib/stdlib/layout/table.ts` — **unchanged** (renderer stays a handler).

**Part C (feature):**
- `lib/stdlib/layout/barchart.ts` — **new** handler (uses termcolors).
- `lib/stdlib/layout/nodes.ts` — `NodeType` gains `"barchart"`.
- `lib/stdlib/layout/render.ts` — `HANDLERS` gains `barchart`.
- `stdlib/chart.agency` — **new** module (+ generated `stdlib/chart.js`).
- Tests as above.
