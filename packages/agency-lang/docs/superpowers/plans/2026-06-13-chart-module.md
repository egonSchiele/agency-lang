# std::chart — Bar Chart Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (the user prefers inline execution in the main session — do **not** use subagent-driven development). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `std::chart` stdlib module that renders horizontal bar charts (grouped + stacked, keyed series with auto color/symbol, legend, negative values via a zero baseline) as a first-class layout node.

**Architecture:** Three phases. (A) Refactor `std::layout`'s render pipeline so each node type's size+render live together in one `HANDLERS` table — pure refactor, no behavior change. (B) Extract the table constructor surface into its own `std::table` Agency module (hard move; the renderer stays a registered handler). (C) Add the bar chart as one new handler (`barchart.ts`) plus a `std::chart` Agency module that mirrors `std::table`.

**Tech Stack:** TypeScript (render pipeline, vitest), Agency (.agency stdlib modules), `lib/utils/termcolors.ts` for color, the existing `Block` algebra in `lib/stdlib/layout/`.

**Spec:** `docs/superpowers/specs/2026-06-13-chart-module-design.md`

**Conventions for every task:**
- TS tests: `pnpm exec vitest run <file>` (fast, no build needed).
- Agency tests: `pnpm run agency test <file>` — run **single files only**, never the full suite (it is slow/expensive). Save output to a file when debugging: `pnpm run agency test <file> | tee /tmp/out.txt`.
- After changing any `stdlib/*.agency` file, rebuild with `make` (compiles stdlib to `.js`). After changing `tests/agency/**` fixtures, regenerate with `make fixtures`.
- **Ignore `.worktrees/` and `runs/`** — those are separate worktrees / run artifacts, not part of this change. Only touch `packages/agency-lang/` canonical paths.
- **Doc convention** (`docs/site/cli/doc.md`): a function's description is its in-body `"""…"""` **docstring** — that is also the LLM tool description. Put `@param name - description` lines in the docstring (per `docs/site/guide/partial-application.md`) so PFA strips bound params from the tool description. Use `/** */` doc comments only for the `@module` block and for **type** definitions, not above functions. A docstring is metadata: it does not change the constructed node, so it does not affect any golden output.
- Commit after each task.

---

## File Structure

**Part A (refactor):**
- `lib/stdlib/layout/sizing.ts` — **new.** `SizingContext`, `NodeHandler` types + shared width helpers (`resolveOwnWidth`, `resolveContainer`, `innerWidthAfterChrome`, `nonNegativeInteger`, `setAttr`).
- `lib/stdlib/layout/render.ts` — slim orchestrator: `HANDLERS`, `resolveNode`, `renderNode`, `resolveSizes`, `_viewport`, `_render`, color logic.
- `lib/stdlib/layout/box.ts`, `axis.ts`, `nodes.ts`, `table.ts` — each gains an exported `NodeHandler` and absorbs its sizer.
- `lib/stdlib/layout.ts` — `_internal` exposes `HANDLERS`; keeps derived `RENDERERS`/`SIZERS`.

**Part B (extract std::table):**
- `stdlib/table.agency` — **new** Agency module (table types + builders + `table()` + re-export `render`).
- `stdlib/layout.agency` — remove table surface; update `@module` doc.
- `stdlib/policy.agency`, `examples/layoutDemo.agency`, `tests/agency/layout/table-*.agency`, `tests/agency/layout/width-sizing.agency` — repoint `table` import to `std::table`.

**Part C (chart):**
- `lib/stdlib/layout/barchart.ts` — **new** handler (uses termcolors).
- `lib/stdlib/layout/nodes.ts` — `NodeType` gains `"barchart"`.
- `lib/stdlib/layout/render.ts` — `HANDLERS` gains `barchart`.
- `lib/stdlib/layout/barchart.test.ts` — **new** TS unit + render tests.
- `lib/stdlib/layout.ts` — `_internal` exposes chart helpers.
- `stdlib/chart.agency` — **new** Agency module.
- `tests/agency/chart/basic.agency` (+ `.test.json`) — **new** execution test.

---

# PART A — Layout reorg (no behavior change)

The safety net for all of Part A is the existing `lib/stdlib/layout.test.ts`. It must pass **unchanged** after every task.

### Task A1: Extract `sizing.ts`

**Files:**
- Create: `lib/stdlib/layout/sizing.ts`
- Modify: `lib/stdlib/layout/render.ts` (remove the moved helpers, import them instead)

- [ ] **Step 1: Create `sizing.ts`** with the helpers currently in `render.ts`, plus the two shared types.

```ts
// lib/stdlib/layout/sizing.ts
// Shared width-resolution helpers + handler type used by every node
// type's `size` half. Extracted from render.ts so per-concern handler
// files can import them without depending on the whole dispatcher.
//
// The import of `resolveNode` from render.ts forms a benign cycle: it
// is only ever called inside `resolveContainer`'s function body, so
// module loading completes before any call happens (same pattern the
// renderers already use for `renderNode`).
import { Block } from "./block.js";
import { LayoutNode, parseWidth } from "./nodes.js";
import { resolveNode } from "./render.js";

export type SizingContext = {
  // The width an unsized node should adopt. Undefined when the parent
  // does not impose a width on its children (e.g. row children).
  defaultWidth: number | undefined;
  // The width that percentages and "full" compute against.
  percentBasis: number | undefined;
};

// One node type's two behaviors, paired. `size` is phase 1 (resolve
// widths top-down); `render` is phase 2 (paint to a Block).
export type NodeHandler = {
  size: (node: LayoutNode, ctx: SizingContext) => LayoutNode;
  render: (node: LayoutNode) => Block;
};

export function resolveOwnWidth(node: LayoutNode, ctx: SizingContext): number | undefined {
  const width = parseWidth(node.attrs.width);
  if (width === null) return ctx.defaultWidth;
  if (width.kind === "cells") return width.value;
  const pct = width.kind === "full" ? 100 : width.value;
  if (ctx.percentBasis === undefined) {
    throw new Error(
      `std::layout: width "${node.attrs.width}" on this ${node.type} ` +
      `requires a sized ancestor (set an explicit width on the parent ` +
      `or one of its ancestors).`,
    );
  }
  return Math.floor((ctx.percentBasis * pct) / 100);
}

export function resolveContainer(
  node: LayoutNode,
  ownWidth: number | undefined,
  childCtx: SizingContext,
): LayoutNode {
  const children = node.children.map((child) => resolveNode(child, childCtx));
  const annotated = ownWidth === undefined ? node : setAttr(node, "resolvedWidth", ownWidth);
  return { ...annotated, children };
}

export function innerWidthAfterChrome(own: number | undefined, chrome: number): number | undefined {
  if (own === undefined) return undefined;
  return Math.max(0, own - chrome);
}

export function nonNegativeInteger(raw: unknown): number {
  const value = typeof raw === "number" ? raw : 0;
  return Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
}

export function setAttr(node: LayoutNode, key: string, value: unknown): LayoutNode {
  return { ...node, attrs: { ...node.attrs, [key]: value } };
}
```

- [ ] **Step 2: In `render.ts`, delete** the now-moved definitions: the `SizingContext` type and the functions `resolveOwnWidth`, `resolveContainer`, `innerWidthAfterChrome`, `nonNegativeInteger`, `setAttr`. **Add** an import at the top:

```ts
import {
  NodeHandler,
  SizingContext,
  innerWidthAfterChrome,
  nonNegativeInteger,
  resolveContainer,
  resolveOwnWidth,
  setAttr,
} from "./sizing.js";
```

(The remaining sizers `sizeBox`/`sizeRow`/`sizeColumn`/`sizeTable`/`sizeText` stay in `render.ts` for now and use the imported helpers.)

- [ ] **Step 3: Run the layout tests.**

Run: `pnpm exec vitest run lib/stdlib/layout.test.ts`
Expected: PASS (same count as before).

- [ ] **Step 4: Commit.**

```bash
git add lib/stdlib/layout/sizing.ts lib/stdlib/layout/render.ts
git commit -m "refactor(layout): extract shared sizing helpers into sizing.ts"
```

---

### Task A2: Introduce the `HANDLERS` registry (as a view over existing tables)

This adds the single dispatch table without moving any size/render code yet, so it stays trivially green.

**Files:**
- Modify: `lib/stdlib/layout/render.ts`
- Modify: `lib/stdlib/layout.ts` (expose `HANDLERS` on `_internal`)

- [ ] **Step 1: In `render.ts`,** keep the existing `SIZERS` and `RENDERERS` objects in place. Declare `HANDLERS` **immediately after the `SIZERS` object** (it reads both at module-eval time, so it must come after both — placing it earlier triggers a TDZ `ReferenceError`). Then update the bodies of `resolveNode` and `renderNode` (wherever they currently sit — their bodies run at call time, so they may reference `HANDLERS` regardless of line order) to dispatch through `HANDLERS`:

```ts
// declare right after the `SIZERS` object:
export const HANDLERS: Record<NodeType, NodeHandler> = Object.fromEntries(
  (Object.keys(RENDERERS) as NodeType[]).map((t) => [
    t,
    { size: SIZERS[t], render: RENDERERS[t] },
  ]),
) as Record<NodeType, NodeHandler>;
```

```ts
// rewrite these two existing functions' bodies:
export function resolveNode(node: LayoutNode, ctx: SizingContext): LayoutNode {
  return HANDLERS[node.type].size(node, ctx);
}

export function renderNode(node: LayoutNode): Block {
  const handler = HANDLERS[node.type];
  if (!handler) {
    throw new Error(`std::layout: unknown node type "${node.type}"`);
  }
  return handler.render(node);
}
```

- [ ] **Step 2: In `layout.ts`,** add `HANDLERS` to the `_internal` export object (next to `RENDERERS`). Import it from `./layout/render.js` where the other render exports come from:

```ts
// add HANDLERS to the existing import from "./layout/render.js"
// and add it to the _internal object literal:
//   HANDLERS,
```

- [ ] **Step 3: Run the layout tests.**

Run: `pnpm exec vitest run lib/stdlib/layout.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit.**

```bash
git add lib/stdlib/layout/render.ts lib/stdlib/layout.ts
git commit -m "refactor(layout): add HANDLERS dispatch table over existing sizers/renderers"
```

---

### Task A3: Relocate each type's sizer into its per-concern file

Now move the size functions next to their renderers and build `HANDLERS` from per-file `NodeHandler` exports. `SIZERS`/`RENDERERS` become derived views for the test surface.

**Files:**
- Modify: `lib/stdlib/layout/box.ts`, `axis.ts`, `nodes.ts`, `table.ts`, `render.ts`

- [ ] **Step 1: `box.ts`** — move `sizeBox` here and export a handler. Add imports `resolveContainer`, `resolveOwnWidth`, `NodeHandler` from `./sizing.js`, and `BORDER_CELLS` from `./border.js` (if not already imported). Append:

```ts
function sizeBox(node: LayoutNode, ctx: SizingContext): LayoutNode {
  const own = resolveOwnWidth(node, ctx);
  const padding = nonNegativeInteger(node.attrs.padding);
  const inner = innerWidthAfterChrome(own, BORDER_CELLS + 2 * padding);
  return resolveContainer(node, own, { defaultWidth: inner, percentBasis: inner });
}

export const box: NodeHandler = { size: sizeBox, render: composeBox };
```

Add `SizingContext`, `nonNegativeInteger`, `innerWidthAfterChrome` to the `./sizing.js` import as needed. (`composeBox` is already defined in this file.)

- [ ] **Step 2: `axis.ts`** — move `sizeRow` and `sizeColumn` here and export handlers:

```ts
function sizeRow(node: LayoutNode, ctx: SizingContext): LayoutNode {
  const own = resolveOwnWidth(node, ctx);
  const gap = nonNegativeInteger(node.attrs.gap);
  const gapTotal = Math.max(0, node.children.length - 1) * gap;
  const inner = innerWidthAfterChrome(own, gapTotal);
  return resolveContainer(node, own, { defaultWidth: undefined, percentBasis: inner });
}

function sizeColumn(node: LayoutNode, ctx: SizingContext): LayoutNode {
  const own = resolveOwnWidth(node, ctx);
  return resolveContainer(node, own, { defaultWidth: own, percentBasis: own });
}

export const row: NodeHandler = { size: sizeRow, render: composeRow };
export const column: NodeHandler = { size: sizeColumn, render: composeColumn };
```

Add the needed imports from `./sizing.js` (`NodeHandler`, `SizingContext`, `resolveOwnWidth`, `resolveContainer`, `innerWidthAfterChrome`, `nonNegativeInteger`).

- [ ] **Step 3: `nodes.ts`** — move `sizeText` and the `passthrough` sizer here and export leaf handlers paired with `LEAF_RENDERERS`:

```ts
function sizeText(node: LayoutNode, ctx: SizingContext): LayoutNode {
  const own = resolveOwnWidth(node, ctx);
  if (own === undefined) return node;
  return setAttr(node, "wrapWidth", own);
}

function passthrough(node: LayoutNode, _ctx: SizingContext): LayoutNode {
  return node;
}

export const text:  NodeHandler = { size: sizeText,    render: LEAF_RENDERERS.text };
export const raw:   NodeHandler = { size: passthrough, render: LEAF_RENDERERS.raw };
export const space: NodeHandler = { size: passthrough, render: LEAF_RENDERERS.space };
export const hline: NodeHandler = { size: passthrough, render: LEAF_RENDERERS.hline };
export const vline: NodeHandler = { size: passthrough, render: LEAF_RENDERERS.vline };
```

Add imports from `./sizing.js` (`NodeHandler`, `SizingContext`, `resolveOwnWidth`, `setAttr`). Note: `sizing.ts` imports `parseWidth` from `nodes.ts`, and `nodes.ts` now imports from `sizing.ts` — this is a benign type/function cycle (calls happen inside function bodies).

- [ ] **Step 4: `table.ts`** — move `sizeTable` here (it delegates to the existing `_resolveTableWidths`) and export a handler:

```ts
function sizeTable(node: LayoutNode, ctx: SizingContext): LayoutNode {
  return _resolveTableWidths(node, resolveOwnWidth(node, ctx));
}

export const table: NodeHandler = { size: sizeTable, render: composeTable };
```

Add imports from `./sizing.js` (`NodeHandler`, `SizingContext`, `resolveOwnWidth`). (`composeTable` and `_resolveTableWidths` already live here.)

- [ ] **Step 5: `render.ts`** — delete the per-type sizer functions (`sizeBox`, `sizeRow`, `sizeColumn`, `sizeTable`, `sizeText`, `passthrough`) and the inline `SIZERS` and `RENDERERS` object literals. Import the per-file handlers and build `HANDLERS` from them; re-derive `RENDERERS`/`SIZERS` for back-compat:

```ts
import { box } from "./box.js";
import { column, row } from "./axis.js";
import { hline, raw, space, text, vline } from "./nodes.js";
import { table } from "./table.js";

export const HANDLERS: Record<NodeType, NodeHandler> = {
  box, row, column, table,
  text, raw, space, hline, vline,
};

// Derived views kept so the test surface (_internal) and any external
// readers that referenced these keep working.
export const RENDERERS: Record<NodeType, (n: LayoutNode) => Block> = Object.fromEntries(
  Object.entries(HANDLERS).map(([k, h]) => [k, h.render]),
) as Record<NodeType, (n: LayoutNode) => Block>;

export const SIZERS: Record<NodeType, NodeHandler["size"]> = Object.fromEntries(
  Object.entries(HANDLERS).map(([k, h]) => [k, h.size]),
) as Record<NodeType, NodeHandler["size"]>;
```

Remove the now-unused imports in `render.ts` (`composeColumn`, `composeRow`, `composeBox`, `composeTable`, `LEAF_RENDERERS`, `_resolveTableWidths`, `BORDER_CELLS`, `nonNegativeInteger`, `innerWidthAfterChrome`, `resolveContainer`, etc.) — keep only what `render.ts` still uses (`resolveNode` callers, `parseWidth`, `stripAnsi`, `pad`, `growToWidth`, the viewport/color/`_render` code, `resolveSizes`). Let `tsc` guide removal.

- [ ] **Step 6: Verify the build and tests.**

Run: `pnpm run build 2>&1 | tail -20`
Expected: no TypeScript errors.

Run: `pnpm exec vitest run lib/stdlib/layout.test.ts`
Expected: PASS (unchanged).

- [ ] **Step 7: Commit.**

```bash
git add lib/stdlib/layout/
git commit -m "refactor(layout): co-locate each node type's sizer with its renderer"
```

---

# PART B — Extract `std::table`

### Task B1: Create `stdlib/table.agency`

**Files:**
- Create: `stdlib/table.agency`

- [ ] **Step 1: Create `stdlib/table.agency`** with the table types, builder helpers, and constructor moved verbatim from `layout.agency`, importing the shared types from `std::layout` and re-exporting `render`:

```ts
import { LayoutNode, Width, Alignment, BorderStyle } from "std::layout"
export { render } from "std::layout"

/** @module
  ## Module: std::table

  Tabular layout for terminal output. Columns line up across header /
  body / footer; the outer frame uses the same `BorderStyle` enum as
  `std::layout`'s `box`. Two construction styles, same result:

  - **Data form (LLM-callable, JSON-friendly):** pass `header`, `body`,
    `footer` as nested arrays of strings or `LayoutNode`s.
  - **Block form (Agency-author ergonomics):** a trailing `as t { ... }`
    block with `t.header(...)`, `t.row(...)`, `t.footer(...)`.

  Render a table with `render` (re-exported here from `std::layout`).
*/

/**
 * A table cell. Either a bare string (auto-coerced to a styled `text`
 * leaf at render time) or any pre-built LayoutNode (e.g.
 * `text("-50", fgColor: "red")`).
 */
export type Cell = string | LayoutNode

// Row alias for table body / footer. The parser doesn't currently
// accept `Cell[][]` directly where `Cell` is a union; aliasing the
// row type first sidesteps that.
export type CellRow = Cell[]

/**
 * Per-column configuration for a `table`. All fields are optional;
 * omitted columns default to start-aligned with no minimum width.
 *
 * @param align - Horizontal alignment of every cell in this column
 * @param minWidth - Lower bound on column width; widens narrow columns
 * @param width - Optional per-column constraint. A number caps the
 *   column's content width in cells. `"X%"` takes a percentage of the
 *   table's remaining inner width. `"full"` is not allowed here.
 * @param fgColor - Default foreground color for every cell in this
 *   column that doesn't carry its own `fgColor`.
 */
export type ColumnSpec = {
  align?: Alignment;
  minWidth?: number;
  width?: Width;
  fgColor?: string
}

/**
 * Methods available inside a `table`'s trailing `as t { ... }` block.
 */
export type TableBuilder = {
  columns: any;
  caption: any;
  header: any;
  row: any;
  footer: any
}

def _setTableColumns(state: any, specs: ColumnSpec[]): any {
  state.columns = specs
  return null
}

def _setTableCaption(state: any, text: string): any {
  state.caption = text
  return null
}

def _setTableHeader(state: any, ...cells: Cell[]): any {
  state.header = cells
  return null
}

def _addTableRow(state: any, ...cells: Cell[]): any {
  state.body.push(cells)
  return null
}

def _addTableFooter(state: any, ...cells: Cell[]): any {
  state.footer.push(cells)
  return null
}

def _makeTableBuilder(state: any): TableBuilder {
  return {
    columns: _setTableColumns.partial(state: state),
    caption: _setTableCaption.partial(state: state),
    header: _setTableHeader.partial(state: state),
    row: _addTableRow.partial(state: state),
    footer: _addTableFooter.partial(state: state)
  }
}

export def table(
  title: string = "",
  titleColor: string = "",
  borderStyle: BorderStyle = "rounded",
  borderColor: string = "",
  caption: string = "",
  cellPadding: number = 1,
  width: Width = null,
  columns: ColumnSpec[] = null,
  header: Cell[] = null,
  body: CellRow[] = null,
  footer: CellRow[] = null,
  headerDivider: boolean = true,
  footerDivider: boolean = true,
  rowDividers: boolean = false,
  columnDividers: boolean = true,
  block: (TableBuilder) -> void = null,
): LayoutNode {
  """
  Render data as a bordered table layout node. When calling this as an
  LLM tool, use the data form: pass `header`, `body`, and `footer` as
  arrays of cells (every row must have the same number of cells).
  Render the result with `render`.

  @param title - Title shown in the top border
  @param caption - Caption shown beneath the table
  @param columns - Per-column configuration (alignment, width, color)
  @param header - Header cells
  @param body - Body rows, each an array of cells
  @param footer - Footer rows, each an array of cells
  @param borderStyle - Frame style: "rounded", "heavy", "double", or "light"
  @param cellPadding - Horizontal padding inside each cell, in cells
  @param width - Table width in cells, or "full" / "N%"
  """
  const bodyArr: any[] = []
  if (body != null) {
    for (r in body) {
      bodyArr.push(r)
    }
  }
  const footerArr: any[] = []
  if (footer != null) {
    for (r in footer) {
      footerArr.push(r)
    }
  }
  const state: any = {
    header: header,
    body: bodyArr,
    footer: footerArr,
    columns: columns,
    caption: caption
  }
  if (block != null) {
    block(_makeTableBuilder(state))
  }
  const attrs: any = {
    title: title,
    titleColor: titleColor,
    borderStyle: borderStyle,
    borderColor: borderColor,
    caption: state.caption,
    cellPadding: cellPadding,
    columns: state.columns,
    header: state.header,
    body: state.body,
    footer: state.footer,
    headerDivider: headerDivider,
    footerDivider: footerDivider,
    rowDividers: rowDividers,
    columnDividers: columnDividers
  }
  if (width != null) {
    attrs.width = width
  }
  return {
    type: "table",
    attrs: attrs,
    children: []
  }
}
```

- [ ] **Step 2: Commit** (build happens in Task B3 after the layout side is updated).

```bash
git add stdlib/table.agency
git commit -m "feat(table): add std::table Agency module (constructors moved from std::layout)"
```

---

### Task B2: Remove table from `std::layout` and repoint all consumers

**Files:**
- Modify: `stdlib/layout.agency`
- Modify: `stdlib/policy.agency`
- Modify: `examples/layoutDemo.agency`
- Modify: `tests/agency/layout/table-block-form.agency`, `table-render.agency`, `table-data-form.agency`, `table-no-mutate.agency`, `width-sizing.agency`

- [ ] **Step 1: In `layout.agency`,** delete the table surface that now lives in `std::table`: the `Cell`, `CellRow`, `ColumnSpec`, `TableBuilder` type definitions; the `_setTableColumns`, `_setTableCaption`, `_setTableHeader`, `_addTableRow`, `_addTableFooter`, `_makeTableBuilder` helpers; and the `table()` constructor. Leave `LayoutNode`, `Alignment`, `BorderStyle`, `Width`, and all of box/row/column/text/raw/space/hline/vline/render intact.

- [ ] **Step 2: In `layout.agency`'s `@module` doc comment,** remove the table-specific prose and add a pointer line, e.g.:

```
  Tables moved to their own module — see `std::table`.
```

- [ ] **Step 3: Repoint `stdlib/policy.agency`** line 1:

```ts
// before:
// import { table, render, text } from "std::layout"
// after:
import { render, text } from "std::layout"
import { table } from "std::table"
```

- [ ] **Step 4: Repoint `examples/layoutDemo.agency`** line 1:

```ts
import { box, row, column, text, hline, vline, render } from "std::layout"
import { table } from "std::table"
```

- [ ] **Step 5: Repoint the table test files.** Set line 1 of each:

`tests/agency/layout/table-block-form.agency`:
```ts
import { text } from "std::layout"
import { table } from "std::table"
```

`tests/agency/layout/table-render.agency`:
```ts
import { render, text } from "std::layout"
import { table } from "std::table"
```

`tests/agency/layout/table-data-form.agency`:
```ts
import { text } from "std::layout"
import { table } from "std::table"
```

`tests/agency/layout/table-no-mutate.agency`:
```ts
import { table } from "std::table"
```

`tests/agency/layout/width-sizing.agency`:
```ts
import { box, render, text } from "std::layout"
import { table } from "std::table"
```

- [ ] **Step 6: Commit.**

```bash
git add stdlib/layout.agency stdlib/policy.agency examples/layoutDemo.agency tests/agency/layout/
git commit -m "refactor(layout): move table out of std::layout into std::table; repoint consumers"
```

---

### Task B3: Rebuild and verify table behavior is unchanged

**Files:** none (build + test only)

- [ ] **Step 1: Rebuild stdlib** (compiles `table.agency`, the edited `layout.agency` and `policy.agency` to `.js`).

Run: `make`
Expected: completes without error.

- [ ] **Step 2: Run each table agency test against its existing expected output** (the `.test.json` files are unchanged — the table node JSON and rendered strings must be byte-identical).

Run:
```bash
for f in table-data-form table-block-form table-render table-no-mutate width-sizing; do
  echo "== $f =="; pnpm run agency test tests/agency/layout/$f.agency;
done 2>&1 | tee /tmp/table-tests.txt
```
Expected: every test PASS. If any expected-output mismatch appears, the move changed behavior — stop and diff.

- [ ] **Step 3: Sanity-check the doc generation** still works for the new module.

Run: `pnpm run agency doc stdlib -o /tmp/stdlibdoc >/dev/null 2>&1 && ls /tmp/stdlibdoc/table.md && echo OK`
Expected: prints the path and `OK`.

- [ ] **Step 4: Commit** any regenerated `.js` fixtures produced by `make`.

```bash
git add -A stdlib/ tests/agency/layout/
git commit -m "build: regenerate stdlib + fixtures after std::table extraction"
```

---

# PART C — The bar chart

### Task C1: Pure chart math helpers + unit tests

**Files:**
- Create: `lib/stdlib/layout/barchart.ts`
- Create: `lib/stdlib/layout/barchart.test.ts`

- [ ] **Step 1: Write the failing unit tests** for the pure helpers.

```ts
// lib/stdlib/layout/barchart.test.ts
import { describe, expect, test } from "vitest";
import {
  barCells,
  baselineColumn,
  dataRange,
  resolveColor,
  resolveKeys,
  stackSegments,
  validateChart,
} from "./barchart.js";
import { color } from "../../utils/termcolors.js";

describe("barCells", () => {
  test("scales magnitude to cells", () => {
    expect(barCells(50, 100, 20)).toBe(10);
    expect(barCells(82, 91, 20)).toBe(18);
  });
  test("uses absolute value and guards zero span", () => {
    expect(barCells(-50, 100, 20)).toBe(10);
    expect(barCells(5, 0, 20)).toBe(0);
  });
});

describe("baselineColumn", () => {
  test("is 0 when all data is non-negative", () => {
    expect(baselineColumn(0, 100, 20)).toBe(0);
  });
  test("places zero at the interior when data has negatives", () => {
    expect(baselineColumn(-50, 100, 30)).toBe(10);
  });
});

describe("dataRange", () => {
  test("stacked ranges over row sums and includes zero", () => {
    expect(dataRange([{ label: "a", values: [120, 80, 30] }], "stacked")).toEqual({ min: 0, max: 230 });
  });
  test("grouped ranges over individual values", () => {
    expect(dataRange([{ label: "a", values: [82, -41] }], "grouped")).toEqual({ min: -41, max: 82 });
  });
});

describe("stackSegments", () => {
  test("largest-remainder distribution sums exactly to total cells", () => {
    const segs = stackSegments([120, 80, 30], 230, 20);
    expect(segs).toEqual([10, 7, 3]);
    expect(segs.reduce((a, b) => a + b, 0)).toBe(20);
  });
});

describe("resolveKeys", () => {
  test("auto-assigns colors and symbols round-robin", () => {
    expect(resolveKeys([{ name: "a" }, { name: "b" }], "█")).toEqual([
      { name: "a", color: "blue", symbol: "█" },
      { name: "b", color: "green", symbol: "▓" },
    ]);
  });
  test("supplies one implicit key when none given", () => {
    expect(resolveKeys(null, "█")).toEqual([{ name: "", color: "blue", symbol: "█" }]);
  });
});

describe("resolveColor", () => {
  test("named color matches termcolors", () => {
    expect(resolveColor("blue")("x")).toBe(color.blue("x"));
  });
  test("empty name is identity", () => {
    expect(resolveColor("")("x")).toBe("x");
  });
});

describe("validateChart", () => {
  test("rejects values/keys length mismatch", () => {
    expect(() =>
      validateChart(
        [{ name: "a", color: "blue", symbol: "█" }],
        [{ label: "Q1", values: [1, 2] }],
        "grouped",
      ),
    ).toThrow(/Q1/);
  });
  test("rejects mixed-sign stacked bar", () => {
    expect(() =>
      validateChart(
        [
          { name: "a", color: "blue", symbol: "█" },
          { name: "b", color: "green", symbol: "▓" },
        ],
        [{ label: "Q1", values: [10, -5] }],
        "stacked",
      ),
    ).toThrow(/mixes positive and negative/);
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `pnpm exec vitest run lib/stdlib/layout/barchart.test.ts`
Expected: FAIL — `Cannot find module './barchart.js'`.

- [ ] **Step 3: Create `barchart.ts`** with the types, palette, and pure helpers.

```ts
// lib/stdlib/layout/barchart.ts
// Horizontal bar chart renderer for std::chart.
//
// Value→cell scaling and the largest-remainder rounding in
// `stackSegments` (so stacked segments sum exactly to the bar length)
// are adapted from chartscii (MIT, https://github.com/tool3/chartscii).
import { color } from "../../utils/termcolors.js";
import { Block } from "./block.js";
import { visualWidth } from "./ansi.js";
import { LayoutNode } from "./nodes.js";
import { NodeHandler, SizingContext, resolveOwnWidth, setAttr } from "./sizing.js";

export type BarKey = { name: string; color?: string; symbol?: string };
export type Bar = { label: string; values: number[] };
export type BarMode = "stacked" | "grouped";

export type ResolvedKey = { name: string; color: string; symbol: string };

export const DEFAULT_COLORS = ["blue", "green", "brightYellow", "magenta", "cyan", "red"];
export const DEFAULT_SYMBOLS = ["█", "▓", "▒", "░"];
const DEFAULT_BAR_AREA = 40;
const TRACK_CHAR = "·";

export function resolveColor(name: string): (s: string) => string {
  if (!name) return (s) => s;
  if (name.startsWith("#")) return (s) => (color as any).hex(name)(s);
  const fn = (color as any)[name];
  return typeof fn === "function" ? (s) => fn(s) : (s) => s;
}

export function resolveKeys(keys: BarKey[] | null, barChar: string): ResolvedKey[] {
  const list = keys && keys.length > 0 ? keys : [{ name: "" } as BarKey];
  return list.map((k, i) => ({
    name: k.name ?? "",
    color: k.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length],
    symbol: k.symbol ?? (i === 0 ? barChar : DEFAULT_SYMBOLS[i % DEFAULT_SYMBOLS.length]),
  }));
}

export function dataRange(data: Bar[], mode: BarMode): { min: number; max: number } {
  const quantities =
    mode === "stacked"
      ? data.map((b) => b.values.reduce((a, c) => a + c, 0))
      : data.flatMap((b) => b.values);
  let min = 0;
  let max = 0;
  for (const q of quantities) {
    if (q < min) min = q;
    if (q > max) max = q;
  }
  return { min, max };
}

export function barCells(value: number, rangeSpan: number, barArea: number): number {
  if (rangeSpan <= 0) return 0;
  return Math.round((Math.abs(value) / rangeSpan) * barArea);
}

export function baselineColumn(rangeMin: number, rangeMax: number, barArea: number): number {
  const span = rangeMax - rangeMin;
  if (rangeMin >= 0 || span <= 0) return 0;
  return Math.round(((0 - rangeMin) / span) * barArea);
}

export function stackSegments(values: number[], rangeSpan: number, barArea: number): number[] {
  const total = values.reduce((a, b) => a + Math.abs(b), 0);
  const totalCells = barCells(total, rangeSpan, barArea);
  if (total <= 0 || totalCells <= 0) return values.map(() => 0);
  const raw = values.map((v) => (Math.abs(v) / total) * totalCells);
  const result = raw.map((x) => Math.floor(x));
  let remaining = totalCells - result.reduce((a, b) => a + b, 0);
  const order = raw
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < order.length && remaining > 0; k++) {
    result[order[k].i] += 1;
    remaining--;
  }
  return result;
}

export function validateChart(keys: ResolvedKey[], data: Bar[], mode: BarMode): void {
  const expected = keys.length;
  for (const bar of data) {
    if (bar.values.length !== expected) {
      throw new Error(
        `std::chart: bar "${bar.label}" has ${bar.values.length} value(s) but there are ${expected} key(s).`,
      );
    }
    for (const v of bar.values) {
      if (!Number.isFinite(v)) {
        throw new Error(`std::chart: bar "${bar.label}" has a non-finite value.`);
      }
    }
    if (mode === "stacked") {
      const hasPos = bar.values.some((v) => v > 0);
      const hasNeg = bar.values.some((v) => v < 0);
      if (hasPos && hasNeg) {
        throw new Error(
          `std::chart: stacked bar "${bar.label}" mixes positive and negative values; uniform sign required.`,
        );
      }
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes.**

Run: `pnpm exec vitest run lib/stdlib/layout/barchart.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add lib/stdlib/layout/barchart.ts lib/stdlib/layout/barchart.test.ts
git commit -m "feat(chart): add pure bar-chart math helpers with unit tests"
```

---

### Task C2: `renderBarChart` + `sizeBarChart`, wire into HANDLERS

**Files:**
- Modify: `lib/stdlib/layout/barchart.ts`
- Modify: `lib/stdlib/layout/nodes.ts` (NodeType += "barchart")
- Modify: `lib/stdlib/layout/render.ts` (HANDLERS += barchart)
- Modify: `lib/stdlib/layout.ts` (_internal exposes chart helpers)
- Modify: `lib/stdlib/layout/barchart.test.ts` (add render tests)

- [ ] **Step 1: Write the failing render tests.** Add `_render` and `LayoutNode` to the **existing top import block** of `barchart.test.ts` (`import { _render } from "./render.js";` and `import { LayoutNode } from "./nodes.js";`), then append the following describe block:

```ts
function chartNode(attrs: Record<string, unknown>): LayoutNode {
  return { type: "barchart", attrs, children: [] };
}

function renderPlain(attrs: Record<string, unknown>): string {
  // color: false → deterministic, ANSI stripped.
  return _render(chartNode(attrs), false);
}

describe("renderBarChart", () => {
  test("single-series bar fills proportionally and shows value + label", () => {
    const out = renderPlain({
      mode: "grouped",
      data: [
        { label: "North", values: [10] },
        { label: "South", values: [5] },
      ],
      barChar: "#",
      showValues: true,
      legend: false,
      // chrome = labelW(5) + 1 + valueW(2) + 1 = 9, so barArea = 9.
      // Test asserts only relative bar length + containment, not exact width.
      resolvedWidth: 18,
    });
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    // North scales to the full bar area; South to roughly half.
    expect(lines[0]).toContain("North");
    expect(lines[0]).toContain("10");
    expect(lines[0].indexOf("#")).toBeGreaterThanOrEqual(0);
    // South's bar is shorter than North's.
    const northBars = (lines[0].match(/#/g) ?? []).length;
    const southBars = (lines[1].match(/#/g) ?? []).length;
    expect(northBars).toBeGreaterThan(southBars);
  });

  test("legend lists each named key", () => {
    const out = renderPlain({
      mode: "stacked",
      keys: [{ name: "web" }, { name: "app" }],
      data: [{ label: "Q1", values: [3, 1] }],
      legend: true,
      showValues: false,
      resolvedWidth: 30,
    });
    expect(out).toContain("web");
    expect(out).toContain("app");
  });

  test("rejects mixed-sign stacked bars at render time", () => {
    expect(() =>
      renderPlain({
        mode: "stacked",
        keys: [{ name: "a" }, { name: "b" }],
        data: [{ label: "Q1", values: [5, -2] }],
      }),
    ).toThrow(/mixes positive and negative/);
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `pnpm exec vitest run lib/stdlib/layout/barchart.test.ts`
Expected: FAIL — `unknown node type "barchart"` (handler not registered yet).

- [ ] **Step 3: Append `renderBarChart` + `sizeBarChart` and internal draw helpers to `barchart.ts`.** First extend the existing block import: change `import { Block } from "./block.js";` to `import { Block, above, beside, pad } from "./block.js";`.

```ts
function fmtValue(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
}

function track(n: number): string {
  return n > 0 ? color.dim(TRACK_CHAR.repeat(n)) : "";
}

function drawBar(
  cells: number,
  baseline: number,
  barArea: number,
  sign: number,
  fill: string,
  colorFn: (s: string) => string,
): string {
  if (sign >= 0) {
    const c = Math.min(cells, barArea - baseline);
    return track(baseline) + colorFn(fill.repeat(c)) + track(barArea - baseline - c);
  }
  const c = Math.min(cells, baseline);
  return track(baseline - c) + colorFn(fill.repeat(c)) + track(barArea - baseline);
}

function drawStack(
  segs: number[],
  keys: ResolvedKey[],
  baseline: number,
  barArea: number,
  sign: number,
): string {
  const total = segs.reduce((a, b) => a + b, 0);
  const body = segs.map((n, i) => resolveColor(keys[i].color)(keys[i].symbol.repeat(n))).join("");
  if (sign >= 0) {
    return track(baseline) + body + track(barArea - baseline - total);
  }
  return track(baseline - total) + body + track(barArea - baseline);
}

type ChartRow = { label: string; bar: string; value: string };

// "What" each data entry becomes: in grouped mode one row per key (label
// + value only on the first); in stacked mode a single row. This is the
// declarative shape — no padding or layout concerns here.
function chartRows(
  data: Bar[],
  keys: ResolvedKey[],
  mode: BarMode,
  valueStrings: string[],
  span: number,
  barArea: number,
  baseline: number,
): ChartRow[] {
  return data.flatMap((bar, bi) => {
    if (mode === "stacked") {
      const sign = bar.values.some((v) => v < 0) ? -1 : 1;
      const segs = stackSegments(bar.values, span, barArea);
      return [{ label: bar.label, bar: drawStack(segs, keys, baseline, barArea, sign), value: valueStrings[bi] }];
    }
    return keys.map((k, ki) => {
      const v = bar.values[ki];
      const bar_ = drawBar(barCells(v, span, barArea), baseline, barArea, Math.sign(v) || 1, k.symbol, resolveColor(k.color));
      return { label: ki === 0 ? bar.label : "", bar: bar_, value: ki === 0 ? valueStrings[bi] : "" };
    });
  });
}

// Stack non-empty blocks vertically. Used for title / legend / body.
function stackBlocks(blocks: Block[]): Block {
  return blocks
    .filter((b) => b.height > 0)
    .reduce((acc, b) => (acc.height === 0 ? b : above(acc, b)), Block.empty());
}

export function renderBarChart(node: LayoutNode): Block {
  const a = node.attrs as any;
  const mode: BarMode = a.mode === "stacked" ? "stacked" : "grouped";
  const data: Bar[] = Array.isArray(a.data) ? a.data : [];
  const keys = resolveKeys(
    Array.isArray(a.keys) ? a.keys : null,
    typeof a.barChar === "string" && a.barChar ? a.barChar : "█",
  );
  validateChart(keys, data, mode);

  const showValues: boolean = a.showValues !== false;
  const wantLegend: boolean = a.legend !== false;
  const resolvedWidth: number | undefined = typeof a.resolvedWidth === "number" ? a.resolvedWidth : undefined;

  const valueStrings = data.map((b) =>
    mode === "stacked"
      ? fmtValue(b.values.reduce((s, v) => s + v, 0))
      : fmtValue(b.values.reduce((m, v) => (Math.abs(v) > Math.abs(m) ? v : m), 0)),
  );
  const labelW = data.length ? Math.max(...data.map((b) => visualWidth(b.label))) : 0;
  const valueW = showValues && valueStrings.length ? Math.max(...valueStrings.map((s) => s.length)) : 0;

  const chrome = labelW + 1 + (showValues ? valueW + 1 : 0);
  const totalW = resolvedWidth ?? chrome + DEFAULT_BAR_AREA;
  const barArea = Math.max(1, totalW - chrome);

  const { min, max: autoMax } = dataRange(data, mode);
  const max = typeof a.max === "number" && a.max > autoMax ? a.max : autoMax;
  const span = max - min;
  const baseline = baselineColumn(min, max, barArea);

  const rows = chartRows(data, keys, mode, valueStrings, span, barArea, baseline);

  // "How" — three aligned columns combined with the Block algebra, the
  // same pad/beside/above approach composeRow and composeTable use. No
  // hand-rolled padding or string concatenation.
  const gap = Block.of(rows.map(() => " "));
  const labelCol = pad(Block.of(rows.map((r) => r.label)), labelW, rows.length, "start", "start");
  const barCol = Block.of(rows.map((r) => r.bar));
  const valueCol = pad(Block.of(rows.map((r) => r.value)), valueW, rows.length, "end", "start");

  const body = showValues
    ? beside(beside(beside(beside(labelCol, gap), barCol), gap), valueCol)
    : beside(beside(labelCol, gap), barCol);

  const title = typeof a.title === "string" && a.title ? Block.of(a.title) : Block.empty();
  const legend =
    wantLegend && keys.some((k) => k.name)
      ? Block.of(keys.map((k) => resolveColor(k.color)(k.symbol) + " " + k.name).join("  "))
      : Block.empty();

  return stackBlocks([title, legend, body]);
}

export function sizeBarChart(node: LayoutNode, ctx: SizingContext): LayoutNode {
  const own = resolveOwnWidth(node, ctx);
  if (own === undefined) return node; // unsized: render falls back to DEFAULT_BAR_AREA
  return setAttr(node, "resolvedWidth", own);
}

export const barchart: NodeHandler = { size: sizeBarChart, render: renderBarChart };
```

- [ ] **Step 4: Add `"barchart"` to the `NodeType` union** in `nodes.ts`:

```ts
export type NodeType =
  | "box" | "row" | "column"
  | "text" | "raw" | "space" | "hline" | "vline"
  | "table" | "barchart";
```

- [ ] **Step 5: Register the handler** in `render.ts` — import and add to `HANDLERS`:

```ts
import { barchart } from "./barchart.js";

export const HANDLERS: Record<NodeType, NodeHandler> = {
  box, row, column, table, barchart,
  text, raw, space, hline, vline,
};
```

- [ ] **Step 6: Expose chart helpers on `_internal`** in `layout.ts` so tests can reach them via the pinned surface. Add to the imports and the `_internal` object:

```ts
import { barCells, baselineColumn, dataRange, resolveKeys, stackSegments, renderBarChart } from "./layout/barchart.js";
// ...add to _internal: barCells, baselineColumn, dataRange, resolveKeys, stackSegments, renderBarChart
```

- [ ] **Step 7: Run the render tests.**

Run: `pnpm exec vitest run lib/stdlib/layout/barchart.test.ts`
Expected: PASS.

- [ ] **Step 8: Run the full layout test file** to confirm no regression from the NodeType/HANDLERS change.

Run: `pnpm exec vitest run lib/stdlib/layout.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit.**

```bash
git add lib/stdlib/layout/barchart.ts lib/stdlib/layout/barchart.test.ts lib/stdlib/layout/nodes.ts lib/stdlib/layout/render.ts lib/stdlib/layout.ts
git commit -m "feat(chart): render horizontal bar charts as a barchart layout node"
```

---

### Task C3: `std::chart` Agency module

**Files:**
- Create: `stdlib/chart.agency`

- [ ] **Step 1: Create `stdlib/chart.agency`.**

```ts
import { LayoutNode, Width } from "std::layout"
export { render } from "std::layout"

/** @module
  ## Module: std::chart

  Horizontal bar charts for terminal output. A `barChart(...)` returns a
  layout node; render it with `render` (re-exported here from
  `std::layout`), so a chart nests inside `box` / `row` / `column`.

  Two construction styles, same result:

  - **Data form (LLM-callable, JSON-friendly):** pass `keys` and `data`
    arrays. `data[i].values` aligns to `keys` by index.

    ```ts
    import { barChart, render } from "std::chart"

    const c = barChart(
      title: "Revenue by quarter",
      mode: "stacked",
      keys: [{ name: "web", color: "blue" }, { name: "app", color: "green" }],
      data: [
        { label: "Q1", values: [120, 80] },
        { label: "Q2", values: [98, 90] },
      ],
    )
    print(render(c))
    ```

  - **Block form (Agency-author ergonomics):**

    ```ts
    const c = barChart(title: "Revenue", mode: "stacked") as ch {
      ch.key("web", color: "blue")
      ch.key("app", color: "green")
      ch.bar("Q1", 120, 80)
      ch.bar("Q2", 98, 90)
    }
    ```

  Keys get a distinct color and fill symbol automatically when omitted,
  so charts stay readable even when color is disabled. Negative values
  draw left of a zero baseline; stacked bars must be uniform-sign.
*/

/** A series. `color`/`symbol` auto-assign if omitted. */
export type BarKey = {
  name: string;
  color?: string;
  symbol?: string
}

/** One category. `values` aligns to `keys` by index. */
export type Bar = {
  label: string;
  values: number[]
}

export type BarMode = "stacked" | "grouped"

/** Methods inside a `barChart` trailing `as c { ... }` block. */
export type ChartBuilder = {
  key: any;
  bar: any
}

def _addKey(state: any, name: string, color: string = "", symbol: string = ""): any {
  const k: any = { name: name }
  if (color != "") {
    k.color = color
  }
  if (symbol != "") {
    k.symbol = symbol
  }
  state.keys.push(k)
  return null
}

def _addBar(state: any, label: string, ...values: number[]): any {
  state.data.push({ label: label, values: values })
  return null
}

def _makeChartBuilder(state: any): ChartBuilder {
  return {
    key: _addKey.partial(state: state),
    bar: _addBar.partial(state: state)
  }
}

export safe def barChart(
  title: string = "",
  mode: BarMode = "grouped",
  keys: BarKey[] = null,
  data: Bar[] = null,
  showValues: boolean = true,
  legend: boolean = true,
  max: number = 0,
  barChar: string = "█",
  width: Width = null,
  block: (ChartBuilder) -> void = null,
): LayoutNode {
  """
  Render a horizontal bar chart as a layout node. When calling this as
  an LLM tool, use the data form: pass `keys` (one per series) and
  `data` (one entry per category, whose `values` array lines up with
  `keys` by index). Render the result with `render`.

  @param title - Heading shown above the chart
  @param mode - "grouped" draws one bar per key; "stacked" stacks the keys into one bar
  @param keys - Series definitions. Each key may set a color (a termcolors name like "blue" or a hex string like "#cc7a4a") and a fill symbol; both auto-assign when omitted
  @param data - Categories to plot. Each has a `label` and a positional `values` array aligned to `keys`
  @param showValues - Show the numeric value beside each bar
  @param legend - Show a legend listing the named keys
  @param max - Fix the axis maximum; 0 derives it from the data
  @param barChar - Default fill cell for the first / single series
  @param width - Chart width in cells, or "full" / "N%"
  """
  const keysArr: any[] = []
  if (keys != null) {
    for (k in keys) {
      keysArr.push(k)
    }
  }
  const dataArr: any[] = []
  if (data != null) {
    for (d in data) {
      dataArr.push(d)
    }
  }
  const state: any = {
    keys: keysArr,
    data: dataArr
  }
  if (block != null) {
    block(_makeChartBuilder(state))
  }
  const attrs: any = {
    title: title,
    mode: mode,
    keys: state.keys,
    data: state.data,
    showValues: showValues,
    legend: legend,
    max: max,
    barChar: barChar
  }
  if (width != null) {
    attrs.width = width
  }
  return {
    type: "barchart",
    attrs: attrs,
    children: []
  }
}
```

- [ ] **Step 2: Build stdlib.**

Run: `make`
Expected: completes without error; `stdlib/chart.js` is produced.

- [ ] **Step 3: Smoke-test from the CLI** that a chart renders. Create `/tmp/chartsmoke.agency`:

```ts
import { barChart, render } from "std::chart"
node main() {
  const c = barChart(
    title: "Sales",
    data: [
      { label: "North", values: [82] },
      { label: "South", values: [58] },
    ],
  )
  print(render(c, color: false))
}
```

Run: `pnpm run agency /tmp/chartsmoke.agency`
Expected: prints a title line and two labeled bar rows where North's bar is longer than South's.

- [ ] **Step 4: Commit.**

```bash
git add stdlib/chart.agency stdlib/chart.js
git commit -m "feat(chart): add std::chart Agency module (barChart constructor + builder)"
```

---

### Task C4: Agency execution test (both construction forms)

**Files:**
- Create: `tests/agency/chart/basic.agency`
- Create: `tests/agency/chart/basic.test.json`

- [ ] **Step 1: Write the test source** `tests/agency/chart/basic.agency`. It builds the same chart two ways and renders with `color: false`.

```ts
import { barChart, render } from "std::chart"

// Data-param form.
node testDataForm() {
  const c = barChart(
    title: "Q",
    mode: "stacked",
    keys: [{ name: "web" }, { name: "app" }],
    data: [
      { label: "Q1", values: [3, 1] },
      { label: "Q2", values: [2, 2] },
    ],
    width: 24,
  )
  return render(c, color: false)
}

// Block form — must produce identical output.
node testBlockForm() {
  const c = barChart(title: "Q", mode: "stacked", width: 24) as ch {
    ch.key("web")
    ch.key("app")
    ch.bar("Q1", 3, 1)
    ch.bar("Q2", 2, 2)
  }
  return render(c, color: false)
}
```

- [ ] **Step 2: Capture the rendered output** to fill in the expected strings (golden test — the implementation defines the bytes).

Run: `pnpm run agency run tests/agency/chart/basic.agency testDataForm 2>/dev/null` (or run via a tiny `main` wrapper) and copy the exact rendered string. Do the same for `testBlockForm`; the two must match.

Then write `tests/agency/chart/basic.test.json` (replace `<RENDERED>` with the captured, JSON-escaped string — identical for both nodes):

```json
{
  "tests": [
    {
      "nodeName": "testDataForm",
      "input": "",
      "expectedOutput": "<RENDERED>",
      "evaluationCriteria": [{ "type": "exact" }]
    },
    {
      "nodeName": "testBlockForm",
      "input": "",
      "expectedOutput": "<RENDERED>",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

- [ ] **Step 3: Run the agency test.**

Run: `pnpm run agency test tests/agency/chart/basic.agency 2>&1 | tee /tmp/chart-test.txt`
Expected: both nodes PASS. (If they differ, the block and data forms diverged — fix `barChart` before continuing.)

- [ ] **Step 4: Commit.**

```bash
git add tests/agency/chart/
git commit -m "test(chart): add agency execution test covering block + data construction"
```

---

### Task C5: Regenerate docs and final verification

**Files:** none (build/docs/test only)

- [ ] **Step 1: Regenerate stdlib reference docs** (chart + table pages are generated from the new modules' docstrings).

Run: `make doc`
Expected: completes; `docs/site/stdlib/chart.md` and `docs/site/stdlib/table.md` exist.

- [ ] **Step 2: Run the structural linter.**

Run: `pnpm run lint:structure`
Expected: no new violations.

- [ ] **Step 3: Run the layout + chart TS tests together.**

Run: `pnpm exec vitest run lib/stdlib/layout.test.ts lib/stdlib/layout/barchart.test.ts 2>&1 | tail -20`
Expected: all PASS.

- [ ] **Step 4: Commit** the regenerated docs.

```bash
git add docs/site/stdlib/
git commit -m "docs(chart,table): regenerate stdlib reference for new modules"
```

---

## Self-Review notes (resolved)

- **Spec coverage:** Part A (handler reorg) → Tasks A1–A3. Part B (extract std::table, hard move, repoint all 7 consumers) → B1–B3. Part C (chart node, dual construction, negatives/baseline, stacked uniform-sign, legend, termcolors, tests, docs) → C1–C5. All spec sections map to a task.
- **Type consistency:** `NodeHandler`/`SizingContext` defined once in `sizing.ts` and imported everywhere. Chart helper names (`barCells`, `baselineColumn`, `dataRange`, `stackSegments`, `resolveKeys`, `resolveColor`, `validateChart`, `renderBarChart`, `sizeBarChart`, `barchart`) are identical across `barchart.ts`, its tests, and `_internal`. Agency `barChart` attrs (`title`, `mode`, `keys`, `data`, `showValues`, `legend`, `max`, `barChar`, `width`) match what `renderBarChart` reads.
- **Golden outputs:** Table fixtures are asserted byte-identical (renderer untouched). The new chart fixture is captured from the implementation (standard golden-test practice) and cross-checked block-vs-data for equality.
```
