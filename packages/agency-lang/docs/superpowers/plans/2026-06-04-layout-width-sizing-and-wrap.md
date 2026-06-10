# Layout Width Sizing + Text Wrap Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add top-down width sizing to `std::layout`. Users can mark a root container with `width: "full"` (terminal columns), give an exact column count with `width: 80`, or give child containers `width: "33%"` / `"50%"` / etc. (fraction of parent's available width). The same machinery applies uniformly to `box`, `row`, `column`, and `table` — and, for `table`, to each `ColumnSpec` (per-column percentage or fixed cells). Text content inside any width-constrained container auto-wraps on word boundaries (with char-break fallback for over-long single words). No height sizing, no truncation option, no error-on-overflow — wrap is the only overflow policy for text content. `raw` remains the explicit verbatim escape hatch and may overflow visibly.

**Why now:** The table primitive shipped without per-column or table-level sizing. Real-world callers want `width: 80` for a status table, or "first column is exactly 2 cells, last column fills the rest". Width sizing is a cross-cutting problem — `box`/`row`/`column` need it too — so building one top-down resolver pass that every container reads from is cheaper than bolting per-feature sizing into each renderer.

**Architecture:** Insert a top-down `resolveSizes` pass between build and render. The renderer stays a dumb bottom-up function from node → block. The resolver walks the tree once with a viewport size and annotates every container with `attrs.resolvedWidth` (a number, or `undefined` for content-driven). Text leaves and table text-cells inside a width-constrained container get an `attrs.wrapWidth` annotation that the renderer honours. Compose functions read resolved widths and grow their output to fit. Tables have a table-specific dispatch branch in the resolver (their children are rows, not width-distributed siblings — the per-column distribution is its own axis).

```diagram
╭─────────╮     ╭──────────────────╮     ╭───────────╮     ╭──────────╮
│  build  │────▶│  resolveSizes    │────▶│  compose  │────▶│ toString │
│ (Agency)│     │  (TS, top-down)  │     │ renderers │     │          │
╰─────────╯     ╰──────────────────╯     ╰───────────╯     ╰──────────╯
                  inputs: viewport          reads:
                  outputs: per-node         attrs.resolvedWidth
                  resolvedWidth +           attrs.wrapWidth
                  wrapWidth annotations     (+ table column layouts)
```

**Tech Stack:** TypeScript (TS bridge + Vitest unit tests), Agency (stdlib wrapper + integration tests in `tests/agency/layout/`)

**Out of scope (deferred to a follow-up plan if needed):**
- Height sizing (terminal rows is a less useful constraint — content normally extends past the viewport).
- `width: "fill"` / `"flex"` to consume remaining space after fixed-percentage siblings.
- `text(..., wrap: false)` opt-out — `raw` already serves the "do not transform" use case.
- A `truncate` overflow policy or wrap/truncate selector. This plan implements wrap only.
- Auto-fit of unsized table columns into table-level slack (today: unsized columns are content-driven, leftover space becomes trailing slack — same as `row`).

**Decisions locked in upfront (from design discussion):**

*Universal width semantics (apply to `box`, `row`, `column`, `table`, and `ColumnSpec`):*
- `width` accepts: `number` (cells), `"full"` (root only), `"X%"` (percentage of parent's available width).
- `"full"` is **root-only**. Nested `"full"` is a runtime error from `resolveSizes`. (Type-level enforcement is not expressible with the current Agency type system.)
- Percentages may sum to **less than 100** — remaining space is trailing slack (no auto-fill). Summing to **more than 100** is allowed but the last child(ren) may be clipped to 0 width; document this.
- `gap`, border, padding, and (for tables) `cellPadding` + interior column dividers are subtracted from the parent's resolved width **before** distributing percentages. Matches CSS `box-sizing: border-box`.
- Fixed widths (`width: 2`) are a **target width** and a hard wrap constraint for wrappable text content. Not a floor. `ColumnSpec.minWidth` continues to be the floor knob; the two are independent.
- `raw` does **not** wrap, ever. Documented asymmetry: `text` wraps, `raw` is verbatim and can visibly overflow a fixed-width container.
- Long `box` / `table` titles do **not** force an explicitly resolved container wider. When an explicit resolved width leaves too little room for an embedded title, wrap the title text inside the frame as normal text instead of truncating or widening. (For content-driven containers, keep today's title-driven growth.)
- Wrap is **word-boundary** by default with **char-break fallback** for single words longer than the column.
- Wrap is **ANSI-aware** via `visualWidth` (already exists).
- Non-TTY viewport fallback: **80 columns × 24 rows**. Overridable via `render(tree, { viewport: { cols, rows } })`.

*Table-specific:*
- `table(width: ...)` sets the table's outer width (the bordered frame). Resolved the same way `box(width: ...)` is.
- `ColumnSpec.width: "X%"` is a percentage of the **table's remaining resolved inner width** after subtracting table chrome, fixed columns, and natural unsized columns. NOT a percentage of terminal/parent.
- `ColumnSpec.width: N` (number) is a hard cap on the column's content width; text cells in that column wrap to `N` cells. Cell-level fixed/percentage on a cell node (e.g. a `box(width: 10)` used as a cell) is independent and resolves like any nested container.
- Unsized columns inside a width-constrained table are **content-driven**. Their natural width is measured first; the resolver then distributes percentages from `table.resolvedWidth - chrome - sum(fixedColumns) - sum(naturalUnsizedColumns)`. If the sum exceeds available width the last percentage column(s) shrink; if it's less, slack accumulates at the right edge of the table.
- The existing `minWidthForTitle` floor (table-level title bumps inner width) continues to win when the title is wider than the natural cell grid AND no explicit table width is set. If `table.resolvedWidth` is set explicitly, the resolved width wins; if it's smaller than `minWidthForTitle`, wrap the title inside the table frame instead of widening or truncating. Logging a warning is not in scope.

---

## File Structure

### New files

```
(none — all changes happen in existing files)
```

### Modified files

```
lib/stdlib/layout/render.ts            # New: _viewport, resolveSizes, resolveNode, resolveChild,
                                       #      growToWidth. Updated: render() entry point.
lib/stdlib/layout/ansi.ts              # New: wrapText, wrapSingleLine, breakLongToken (live next to visualWidth)
lib/stdlib/layout/border.ts            # Updated: explicit-width boxes do not grow to fit long titles;
                                       #          over-long titles wrap inside the frame.
lib/stdlib/layout/nodes.ts             # New: parseWidth + Width type (used by render.ts and table.ts).
                                       # Updated: ColumnSpec gains optional `width`.
                                       # Updated: text leaf renderer reads attrs.wrapWidth.
lib/stdlib/layout/box.ts               # composeBox reads attrs.resolvedWidth and grows.
lib/stdlib/layout/axis.ts              # composeRow / composeColumn read attrs.resolvedWidth and grow.
lib/stdlib/layout/table.ts             # New: _resolveTableWidths (per-column width distribution +
                                       #      cell wrapWidth annotation).
                                       # Updated: _computeColumnLayouts honours resolved column widths
                                       #          (skips natural measurement when width is fixed).
                                       # Updated: composeTable reads attrs.resolvedWidth and grows.
lib/stdlib/layout.ts                   # Re-export new types/functions (Viewport, Width, wrapText).
                                       # Update `_internal` with new helpers used by layout.test.ts.
lib/stdlib/layout.test.ts              # New unit tests for each new helper.
stdlib/layout.agency                   # New `width` param on box / row / column / table and their
                                       #     _add* / builder helpers.
                                       # New `Width` type alias.
                                       # ColumnSpec gains optional `width`.
                                       # Optional `cols` / `rows` params on `render`.
docs/site/stdlib/layout.md             # Regenerated by `make doc`.
examples/layoutDemo.agency             # Add a section demoing full-width + 33% three-column layout +
                                       #     a sized table with one fixed and one percentage column.
tests/agency/layout/width-sizing.agency      # New: integration tests for box/row/column sizing.
tests/agency/layout/width-sizing.test.json
tests/agency/layout/text-wrap.agency         # New: integration tests for wrap behaviour.
tests/agency/layout/text-wrap.test.json
tests/agency/layout/table-width.agency       # New: integration tests for table + column sizing.
tests/agency/layout/table-width.test.json
```

No changes to the `Block` primitive, `pad`, `beside`, `above`, or `styled` operators — they already do everything we need. `bordered` / `buildTopEdge` may need a small explicit-width title path so long titles wrap instead of widening fixed-width boxes.

---

## Task 1: Viewport + size types + plumbing

**Files:**
- Modify: `lib/stdlib/layout/render.ts` (or wherever the public `render` lives today)
- Modify: `lib/stdlib/layout/nodes.ts`
- Modify: `lib/stdlib/layout.test.ts`
- Modify: `stdlib/layout.agency`

Lay the foundation: viewport detection, the `Width` type the resolver will operate on, and the new `width` parameter on `box`/`row`/`column`/`table`/`ColumnSpec` and their `_add*` / builder helpers. No resolver yet — just the surface and types.

- [ ] **Step 1: `_viewport` helper + `Viewport` type**

```ts
// lib/stdlib/layout/render.ts

// Viewport describes the rendering surface. Width drives sizing;
// height is reported for future use but currently unread by the
// resolver.
export type Viewport = { cols: number; rows: number };

const DEFAULT_VIEWPORT: Viewport = { cols: 80, rows: 24 };

// Read terminal dimensions from process.stdout. Returns
// DEFAULT_VIEWPORT (80×24) when stdout is not a TTY (piped, captured,
// tests) — every call site that cares can override via the public
// `render(tree, { viewport })` option.
export function _viewport(): Viewport {
  return {
    cols: process.stdout.columns ?? DEFAULT_VIEWPORT.cols,
    rows: process.stdout.rows    ?? DEFAULT_VIEWPORT.rows,
  };
}
```

Tests in `layout.test.ts`:
- `_viewport()` returns `process.stdout.columns / rows` when set.
- Falls back to 80×24 when `process.stdout.columns` is `undefined`.

- [ ] **Step 2: `Width` discriminated type + parser**

Lives in `lib/stdlib/layout/nodes.ts` so both `render.ts` and `table.ts` can import without forming a new cycle (nodes.ts is leaf).

```ts
// lib/stdlib/layout/nodes.ts

// Width is one of: a plain number, "full", or a percentage like "50%".
// Parsed by `parseWidth` into a tagged union the resolver consumes.
export type Width =
  | { kind: "cells";   value: number }
  | { kind: "full" }
  | { kind: "percent"; value: number };  // 0–100, may exceed

export function parseWidth(raw: unknown): Width | null {
  if (raw == null) return null;
  if (typeof raw === "number") return { kind: "cells", value: raw };
  if (raw === "full") return { kind: "full" };
  if (typeof raw === "string") {
    const m = raw.match(/^(\d+(?:\.\d+)?)%$/);
    if (m) return { kind: "percent", value: parseFloat(m[1]) };
  }
  throw new Error(
    `std::layout: invalid width ${JSON.stringify(raw)}. ` +
    `Expected a number, "full", or "<n>%" (e.g. "50%").`,
  );
}
```

Tests:
- `parseWidth(null)` → `null`, `parseWidth(undefined)` → `null`
- `parseWidth(20)` → `{ kind: "cells", value: 20 }`
- `parseWidth("full")` → `{ kind: "full" }`
- `parseWidth("33%")` → `{ kind: "percent", value: 33 }`
- `parseWidth("33.5%")` → `{ kind: "percent", value: 33.5 }`
- `parseWidth("foo")` throws with a helpful message.
- `parseWidth("100")` throws (no `%`, not a number).

- [ ] **Step 3: `width` param on `box`, `row`, `column`, `table` + their `_add*` / builder mirrors**

```agency
// stdlib/layout.agency

export type Width = number | "full" | string  // string carries "X%"

export def box(
  title: string = "",
  titleColor: string = "",
  borderStyle: BorderStyle = "rounded",
  borderColor: string = "",
  padding: number = 1,
  width: Width = null,                       // NEW
  children: LayoutNode[] = null,
  block: (LayoutBuilder) -> void = null,
): LayoutNode {
  // ... unchanged body, plus `width: width` in attrs
}
```

Apply the same `width: Width = null` insertion to:
- `row`, `column`, `table`, and their `_addBox`, `_addRow`, `_addColumn` mirrors.
- If the implementation branch already has a `LayoutBuilder.table` / `_addTable` helper, add `width` there too. The current stdlib does **not** have one, and adding nested-table builder support is out of scope for this plan.
- The `TableBuilder.row(...)` / `TableBuilder.header(...)` / `TableBuilder.footer(...)` methods do NOT take width — row width comes from the table's column widths.

Stored in `attrs.width` (raw — the resolver parses it).

Test in `tests/agency/layout/width-sizing.agency`:
- Build `box(width: "full")` and assert the returned node has `attrs.width === "full"`.
- Build `table(width: 80)` and assert `attrs.width === 80`.

- [ ] **Step 4: `width` field on `ColumnSpec`**

```agency
// stdlib/layout.agency

export type ColumnSpec = {
  align?: Alignment;
  minWidth?: number;
  width?: Width;            // NEW
  fgColor?: string
}
```

```ts
// lib/stdlib/layout/nodes.ts

export type ColumnSpec = {
  align?: Align;
  minWidth?: number;
  width?: unknown;          // NEW — parsed by parseWidth at resolve time
  fgColor?: string;
};
```

Tests:
- `_validateTable` already checks `columns` is an array of objects; verify that an `unknown` `width` field is accepted as-is (parsing happens later).
- Build a `table({ columns: [{ width: "50%" }, { width: 10 }, {}] })` and assert the columns array is preserved on `attrs.columns`.

---

## Task 2: `resolveSizes` — top-down width resolution (non-table containers)

**Files:**
- Modify: `lib/stdlib/layout/render.ts`
- Modify: `lib/stdlib/layout.test.ts`

The core of the feature. A pure tree-walking function that takes a node tree + viewport and returns a new tree where every container has `attrs.resolvedWidth` (number | undefined) and every text leaf inside a width-constrained container has `attrs.wrapWidth` (number | undefined). The renderer reads these annotations; it does not call this function. Tables get a separate dispatch arm covered in Task 5.

- [ ] **Step 1: Skeleton + root resolution**

```ts
// Resolve every node's width, top-down. Returns a new tree (does not
// mutate). Caller passes the viewport so this stays a pure function.
//
// Resolved values:
//   * resolvedWidth: number | undefined
//     - undefined = content-driven (current behaviour)
//     - number    = target width for this container; wrappable text is
//                   constrained to fit it, while raw content remains
//                   verbatim and may overflow visibly
//   * wrapWidth: number | undefined  (text leaves only)
//     - undefined = no wrap (current behaviour)
//     - number    = wrap content to this column width
export function resolveSizes(
  node: LayoutNode,
  viewport: Viewport,
): LayoutNode {
  const rootWidth = resolveRootWidth(node, viewport);
  return resolveNode(node, rootWidth);
}

function resolveRootWidth(node: LayoutNode, viewport: Viewport): number | undefined {
  const w = parseWidth(node.attrs.width);
  if (w === null) return undefined;             // content-driven root
  if (w.kind === "cells")   return w.value;
  if (w.kind === "full")    return viewport.cols;
  if (w.kind === "percent") {
    // A percentage at the root is meaningless — there's no parent.
    throw new Error(
      `std::layout: width "${node.attrs.width}" on root has no parent ` +
      `to take a percentage of. Use "full" or a number.`,
    );
  }
}
```

- [ ] **Step 2: Recursive resolve with chrome subtraction**

```ts
function resolveNode(node: LayoutNode, resolvedWidth: number | undefined): LayoutNode {
  // Tables have their own width-distribution axis (per-column, not
  // per-child). Delegate to the table-aware resolver.
  if (node.type === "table") {
    return _resolveTableWidths(node, resolvedWidth);
  }

  if (node.children.length === 0) {
    return annotate(node, resolvedWidth, undefined);
  }

  // Available width for children = own width minus chrome (border + padding + gaps).
  const available =
    resolvedWidth !== undefined
      ? Math.max(0, resolvedWidth - chromeWidth(node))
      : undefined;

  const resolvedChildren = node.children.map((child) =>
    resolveChild(node, child, available),
  );

  return {
    ...node,
    attrs: { ...node.attrs, resolvedWidth },
    children: resolvedChildren,
  };
}

// Bytes the container itself eats out of resolvedWidth before children get any:
//   * box border: 2 columns
//   * box padding: 2 * padding columns
//   * row gap:    (numChildren - 1) * gap columns  (column gap doesn't eat width)
function chromeWidth(node: LayoutNode): number {
  let chrome = 0;
  if (node.type === "box") {
    chrome += 2;                                     // left + right border
    chrome += 2 * ((node.attrs.padding as number) ?? 0);
  }
  if (node.type === "row") {
    const gap = (node.attrs.gap as number) ?? 0;
    chrome += Math.max(0, node.children.length - 1) * gap;
  }
  return chrome;
}
```

- [ ] **Step 3: Distribute available width to children**

```ts
function isContainer(node: LayoutNode): boolean {
  return node.type === "box" || node.type === "row" || node.type === "column" || node.type === "table";
}

// Resolve one child using the parent's available width. Important rule:
// an unsized *container* child inside a width-constrained parent inherits
// the parent's available width as its resolution context. This is what
// makes `box(width:"full") > row > [box(width:"33%"), ...]` work: the
// unsized row is resolved against the box's inner width, so its percentage
// children have a parent width to reference.
function resolveChild(
  node: LayoutNode,
  child: LayoutNode,
  available: number | undefined,
): LayoutNode {
  const childWidth = resolveChildWidth(node, child, available);

  if (child.type === "text") {
    // Explicit child width wins; otherwise text in a constrained parent wraps
    // to the parent's available content width.
    return annotate(child, undefined, childWidth ?? available);
  }
  if (child.type === "raw") {
    return child;
  }
  if (isContainer(child)) {
    // Unsized containers inherit the constrained context so their own
    // percentage descendants can resolve. Content-driven parents still pass
    // undefined and preserve today's behavior.
    return resolveNode(child, childWidth ?? available);
  }
  return resolveNode(child, childWidth);
}

// Returns the explicit width requested by a child, if any.
function resolveChildWidth(
  node: LayoutNode,
  child: LayoutNode,
  available: number | undefined,
): number | undefined {
  const w = parseWidth(child.attrs.width);
  if (w === null) return undefined;
  if (w.kind === "cells") return w.value;
  if (w.kind === "full") {
    throw new Error(
      `std::layout: width "full" is only valid at the root. ` +
      `Use "100%" if you mean "fill the parent".`,
    );
  }
  if (w.kind === "percent") {
    if (available === undefined) {
      throw new Error(
        `std::layout: child uses width "${child.attrs.width}" but the ` +
        `parent ${node.type} has no resolved width to take a percentage of. ` +
        `Set a width on the parent or one of its ancestors.`,
      );
    }
    return Math.floor((available * w.value) / 100);
  }
}
```

Decision check: for `column`, unsized children inherit the column's full available width because a column is single-axis, not horizontally distributing siblings. A column child with `width: "50%"` still resolves against the column's own available width.

- [ ] **Step 4: Annotate text leaves with `wrapWidth`**

```ts
function annotate(
  node: LayoutNode,
  resolvedWidth: number | undefined,
  wrapWidth: number | undefined,
): LayoutNode {
  return {
    ...node,
    attrs: {
      ...node.attrs,
      ...(resolvedWidth !== undefined ? { resolvedWidth } : {}),
      ...(wrapWidth     !== undefined ? { wrapWidth }     : {}),
    },
  };
}

// `resolveChild` above annotates text leaves at the parent level because
// that is where the parent's available content width is known. Raw leaves
// do NOT receive wrapWidth (verbatim by contract).
```

Refactor the recursion so text-leaf annotation happens at the parent level (where the parent's `available` is known), not at the child level (where it would need to look up).

- [ ] **Step 5: Tests**

Tests in `layout.test.ts` for `resolveSizes` (non-table cases):
- Single content-driven node: no annotations added.
- `box(width: "full")` with viewport 100: root gets `resolvedWidth: 100`.
- `box(width: 50)`: root gets `resolvedWidth: 50` regardless of viewport.
- `box(width: "full") > row > [box(width:"33%"), box(width:"33%"), box(width:"34%")]`: each leaf box gets ~33 columns after chrome subtraction.
- Same shape with an unsized intermediate `row`: the row inherits the box's inner width for resolution, so its percentage children do not throw.
- `row(gap: 2)` with three 33% children: per-child width = floor((parentAvailable - 4) / 3).
- `box(padding: 2, width: 20)`: inner child gets 20 - 2 (border) - 4 (padding) = 14 columns.
- `box > text("long string")` with `box(width: 30)`: text node gets `wrapWidth: 28` (after border subtraction).
- `raw` inside a width-constrained box does NOT receive `wrapWidth`.
- Error: percentage at root → throws helpfully.
- Error: `"full"` on non-root → throws.
- Error: percentage child of a content-driven parent → throws.

(Table-specific tests live in Task 5.)

---

## Task 3: `wrapText` — word-wrap with ANSI-aware char-break fallback

**Files:**
- Modify: `lib/stdlib/layout/ansi.ts` (lives next to `visualWidth` since both are pure ANSI string ops)
- Modify: `lib/stdlib/layout.test.ts`

A pure function: given a string and a target column width, return an array of wrapped lines. ANSI-aware (uses `visualWidth`). Preserves explicit `\n` boundaries — wraps each "paragraph" independently. Word-boundary preferred; single words longer than the column get char-broken.

- [ ] **Step 1: `wrapText(content, width)` signature + line-by-line dispatch**

```ts
// Wrap `content` to fit within `width` columns. Returns an array of
// wrapped lines suitable for `Block.of(wrapped)`. Preserves explicit
// newlines in the input: each input line is wrapped independently.
//
// `width` is a hard limit measured in visual columns (ANSI-aware).
// If `width <= 0`, returns an empty array (no room to render).
export function wrapText(content: string, width: number): string[] {
  if (width <= 0) return [];
  return content.split("\n").flatMap((line) => wrapSingleLine(line, width));
}
```

- [ ] **Step 2: `wrapSingleLine` — word-wrap with char-break fallback**

```ts
function wrapSingleLine(line: string, width: number): string[] {
  if (visualWidth(line) <= width) return [line];

  const words = line.split(/(\s+)/);  // keep whitespace as its own tokens
  const out: string[] = [];
  let current = "";

  for (const token of words) {
    const tentative = current + token;
    if (visualWidth(tentative) <= width) {
      current = tentative;
      continue;
    }
    // Token doesn't fit. Flush current (if any), then handle token.
    if (current.length > 0 && current.trim().length > 0) {
      out.push(current);
      current = "";
    }
    if (visualWidth(token) <= width) {
      // Whole word fits on its own line
      current = token;
    } else {
      // Word longer than column — char-break it
      for (const chunk of breakLongToken(token, width)) {
        if (visualWidth(current + chunk) <= width) {
          current += chunk;
        } else {
          if (current.length > 0) out.push(current);
          current = chunk;
        }
      }
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

// Break a string longer than `width` into `width`-sized chunks.
// ANSI-aware: never splits inside a CSI escape sequence.
function breakLongToken(token: string, width: number): string[] {
  // Walk the string, accumulating visual columns. When an SGR sequence
  // appears, copy it whole regardless of column count.
  // Implementation: a small state machine. See test fixtures for
  // expected behaviour with embedded SGR.
  // ...
}
```

- [ ] **Step 3: Tests for `wrapText`**

- Plain short line: returns `[line]`.
- Width 0: returns `[]`.
- `"hello world", 5` → `["hello", "world"]`.
- `"hello world", 8` → `["hello", "world"]` (won't fit both, even though sum is 11).
- `"a b c d e", 4` → wraps greedily; locked-in convention: **trailing whitespace stripped per output line**.
- Multiple paragraphs preserve newlines: `"foo\nbar baz", 5` → `["foo", "bar", "baz"]`.
- Long single word: `"abcdefghij", 4` → `["abcd", "efgh", "ij"]`.
- ANSI: `"\x1b[31mhello\x1b[0m world", 5` → `["\x1b[31mhello\x1b[0m", "world"]` (escape sequence stays attached to "hello").
- Edge: empty string → `[""]` (preserves the one-row contract from the leaf renderer).
- Width covers exactly the content: no wrap, no trailing whitespace.

Decision locked in: **trailing whitespace on wrapped lines is stripped** (cleaner ASCII output, matches what user expects to see in a bordered panel). Document explicitly.

---

## Task 4: Wire `resolveSizes` + `wrapText` into the renderer (non-table)

**Files:**
- Modify: `lib/stdlib/layout/render.ts` (`render` entry point, `growToWidth` helper)
- Modify: `lib/stdlib/layout/nodes.ts` (text renderer reads `attrs.wrapWidth`)
- Modify: `lib/stdlib/layout/box.ts` (composeBox grows to `resolvedWidth`)
- Modify: `lib/stdlib/layout/axis.ts` (composeRow/composeColumn grow to `resolvedWidth`)
- Modify: `lib/stdlib/layout.test.ts`

Connect the new pieces to the existing pipeline. `render` now calls `resolveSizes` first. Compose functions read `attrs.resolvedWidth` and grow their output. The `text` renderer reads `attrs.wrapWidth` and routes content through `wrapText` before building the block. The table renderer wiring is Task 5 (it shares `growToWidth` and `wrapText`).

- [ ] **Step 1: `growToWidth` helper**

```ts
// lib/stdlib/layout/render.ts

// Pad a block to at least `targetWidth` columns. If the block is
// already wider, returns unchanged. (Wrap, not truncation, is the
// overflow policy in this PR — but text wrap should mean the block
// is already ≤ targetWidth, so this is just defensive padding for
// containers whose resolved width exceeds their content.)
export function growToWidth(block: Block, targetWidth: number): Block {
  if (block.width >= targetWidth) return block;
  return pad(block, targetWidth, block.height, "start", "start");
}
```

- [ ] **Step 2: `text` renderer uses `wrapWidth`**

```ts
// In LEAF_RENDERERS in lib/stdlib/layout/nodes.ts:
text: (n) => {
  const content   = (n.attrs.content   as string)         ?? "";
  const align     = (n.attrs.align     as Align)          ?? "start";
  const wrapWidth = (n.attrs.wrapWidth as number | undefined);

  const lines = wrapWidth !== undefined
    ? wrapText(content, wrapWidth)
    : content.split("\n");

  const block = Block.of(lines);
  const padded = pad(block, block.width, block.height, align, "start");
  return styled(padded, styleOf(n.attrs));
},
```

(Note: `alignedTextBlock` is no longer reusable as-is because we need to build from a pre-wrapped string array. Inline the logic; it's three lines. `alignedTextBlock` stays for the `raw` renderer.)

- [ ] **Step 3: Compose functions grow to `resolvedWidth`**

```ts
// composeBox (lib/stdlib/layout/box.ts): after `bordered(...)`, grow if necessary.
function composeBox(node: LayoutNode): Block {
  // ... existing body builds `framed: Block` ...
  const resolved = node.attrs.resolvedWidth as number | undefined;
  return resolved !== undefined ? growToWidth(framed, resolved) : framed;
}

// composeAxis (lib/stdlib/layout/axis.ts): after joining children, grow if necessary.
function composeAxis(node: LayoutNode, axis: Axis): Block {
  // ... existing body builds `combined: Block` ...
  const resolved = node.attrs.resolvedWidth as number | undefined;
  return resolved !== undefined ? growToWidth(combined, resolved) : combined;
}
```

- [ ] **Step 4: `render` entry point + viewport option**

```ts
// Public render: optionally accepts a viewport override (caller
// knows better than process.stdout, e.g. snapshot tests).
export function render(
  node: LayoutNode,
  opts?: { viewport?: Viewport },
): string {
  const viewport = opts?.viewport ?? _viewport();
  const resolved = resolveSizes(node, viewport);
  return renderNode(resolved).toString();
}

// _render (the Agency-side bridge) gains the same option:
export function _render(
  node: LayoutNode,
  color: "auto" | boolean,
  cols?: number,
  rows?: number,
): string {
  const viewport: Viewport | undefined =
    cols !== undefined && cols > 0 ? { cols, rows: rows ?? 24 } : undefined;
  const out = render(node, { viewport });
  // ... existing color stripping logic
}
```

And in `stdlib/layout.agency`:

```agency
export safe def render(
  node: LayoutNode,
  color: "auto" | boolean = "auto",
  cols: number = 0,        // 0 means "auto-detect from terminal"
  rows: number = 0,
): string {
  return _render(node, color, cols, rows)
}
```

Lock in the sentinel: `cols == 0` → use `_viewport()`. Document in the `render` docstring.

- [ ] **Step 5: Integration tests**

Tests in `layout.test.ts`:
- `render(box(width:"full"), { viewport:{cols:40, rows:24} })` produces a 40-column-wide box (count visual chars on each output line).
- `render(box(width:"full") containing row of three 33% boxes, viewport 40)` produces three boxes whose widths sum to ≤ 40 (after chrome).
- `render(box(width:30) with text("long " * 20))` wraps the text and the output is exactly 30 columns wide.
- `render(box(width:12, title:"a very long title"))` keeps the box width at 12 and wraps the title inside the frame instead of truncating or widening.
- `raw` inside a width-constrained box overflows naturally (doesn't wrap).

---

## Task 5: Table width sizing + per-column sizing + cell wrap

**Files:**
- Modify: `lib/stdlib/layout/table.ts`
- Modify: `lib/stdlib/layout.test.ts`

Apply the same width-and-wrap machinery to tables. The resolver gets a table-specific dispatch arm (`_resolveTableWidths`) that distributes the table's resolved width across columns according to each `ColumnSpec.width`, then annotates each cell so the existing text wrap path (Task 4 Step 2) handles cell content.

Design rationale: tables can't reuse `distributeChildWidths` because their "children" axis (rows) is orthogonal to the width-distribution axis (columns). The same per-column `Width` semantics from Task 2 apply, but the chrome model is different — interior column dividers and per-column `cellPadding` both eat into the table's inner width.

- [ ] **Step 1: `_tableChromeWidth(columns, attrs)` helper**

```ts
// Width consumed by the table's frame + per-column padding + interior
// dividers, before any cell content gets a single cell.
//
// Layout (columnDividers=true, 3 cols, cellPadding=1):
//   │ <P><col0><P> │ <P><col1><P> │ <P><col2><P> │
//   ^outer        ^div            ^div           ^outer
//
// chrome = 2 (outer borders) + nCols * 2 * cellPadding + (nCols-1)
//          if columnDividers else 0.
function _tableChromeWidth(
  columnCount: number,
  cellPadding: number,
  columnDividers: boolean,
): number {
  const borders = 2;
  const padding = columnCount * 2 * cellPadding;
  const dividers = columnDividers ? Math.max(0, columnCount - 1) : 0;
  return borders + padding + dividers;
}
```

Tests:
- `_tableChromeWidth(3, 1, true)` → 2 + 6 + 2 = 10.
- `_tableChromeWidth(3, 0, false)` → 2.
- `_tableChromeWidth(1, 2, true)` → 2 + 4 + 0 = 6.

- [ ] **Step 2: `_resolveTableWidths(node, resolvedWidth)`**

```ts
// Top-down width resolver for tables. Called from the global
// resolveNode dispatch when node.type === "table". Returns a new
// table node with:
//   * attrs.resolvedWidth         — the table's own resolved width (forwarded)
//   * attrs.resolvedColumnWidths  — number[] of cell content widths per column
//   * each cell in attrs.body/header/footer gets attrs.wrapWidth set
//     if it is a text leaf in a width-constrained column.
//
// Behavior summary:
//   * Always validates/coerces the table attrs first by calling
//     `_validateTable`. The top-down resolver runs before `composeTable`,
//     and raw Agency table attrs may still contain bare string cells.
//   * resolvedWidth undefined → content-driven table. Fixed ColumnSpec.width
//     values are honored; percentage columns throw because there is no table
//     width to take a percentage from.
//   * resolvedWidth set       → distribute inner = resolvedWidth - chrome
//     across columns by spec.
export function _resolveTableWidths(
  node: LayoutNode,
  resolvedWidth: number | undefined,
): LayoutNode {
  const attrs       = node.attrs;
  const { header, body, footer, columnCount } = _validateTable(attrs);
  const columns     = (attrs.columns as ColumnSpec[] | null | undefined) ?? [];
  const cellPadding = clampCellPadding(attrs.cellPadding);
  const columnDividers = (attrs.columnDividers as boolean) ?? true;

  const sections = { header, body, footer };
  const chrome = _tableChromeWidth(columnCount, cellPadding, columnDividers);

  const resolvedColumnWidths = distributeColumnWidths({
    columns,
    columnCount,
    sections,
    resolvedWidth,
    chrome,
  });

  const annotatedSections = annotateCellsWithWrap(sections, resolvedColumnWidths);

  return {
    ...node,
    attrs: {
      ...attrs,
      ...(resolvedWidth !== undefined ? { resolvedWidth } : {}),
      resolvedColumnWidths,
      header: annotatedSections.header,
      body:   annotatedSections.body,
      footer: annotatedSections.footer,
    },
  };
}
```

Notes:
- `clampCellPadding` already exists in `table.ts` (or is inlined — extract it if not).
- `_resolveTableWidths` must call `_validateTable` because it runs before `composeTable` and needs string cells coerced to `LayoutNode`s before wrap annotations. `composeTable` may still call `_validateTable` for backwards compatibility with tests that call `composeTable` directly.

- [ ] **Step 3: `distributeColumnWidths` — per-column width math**

```ts
// Returns the per-column CONTENT width (excludes cellPadding — that's
// added back by _layoutCell when rendering).
//
// Algorithm:
//   1. For each column, compute its "ask":
//        - fixed (cells): exact ask = w.value.
//        - percent:       ask = floor((available - sumOfFixed - sumOfNatural) * w.value / 100)
//          (only meaningful when `available` is finite)
//        - none:          ask = natural content width
//   2. If `available` is undefined (content-driven table):
//        - Fixed columns get their fixed width.
//        - Percent columns are an ERROR (no available width to take from)
//          unless the table grows naturally — which we can't predict.
//          Throw the same helpful error as resolveChildWidth.
//        - Unsized columns get their natural width.
//   3. If `available` is set:
//        - Subtract chrome (already done — caller passes available = resolvedWidth - chrome).
//        - Pay fixed columns first.
//        - Pay unsized columns their natural width (capped at remaining space).
//        - Distribute remaining space across percentage columns.
//        - Clamp every result to >= 0; clamp to >= spec.minWidth if set.
function distributeColumnWidths(args: {
  columns: ColumnSpec[];
  columnCount: number;
  sections: { header: LayoutNode[]; body: LayoutNode[][]; footer: LayoutNode[][] };
  resolvedWidth: number | undefined;
  chrome: number;
}): number[] {
  const { columns, columnCount, sections, resolvedWidth, chrome } = args;
  const natural = measureNaturalColumnWidths(sections, columnCount);
  const parsed = Array.from({ length: columnCount }, (_, c) =>
    parseWidth(columns[c]?.width)
  );

  const available = resolvedWidth !== undefined
    ? Math.max(0, resolvedWidth - chrome)
    : undefined;

  // Validate: no "full" allowed at column level.
  for (let c = 0; c < columnCount; c++) {
    if (parsed[c]?.kind === "full") {
      throw new Error(
        `std::layout: column[${c}].width "full" is not allowed. ` +
        `Use a number or percentage.`,
      );
    }
  }

  // Validate: percentage columns need a table-level width.
  if (available === undefined) {
    for (let c = 0; c < columnCount; c++) {
      if (parsed[c]?.kind === "percent") {
        throw new Error(
          `std::layout: column[${c}] uses a percentage width but the table ` +
          `has no resolved width to take a percentage of. ` +
          `Set width: on the table or one of its ancestors.`,
        );
      }
    }
  }

  // Pay fixed and unsized.
  const widths = new Array<number>(columnCount).fill(0);
  let remaining = available ?? Infinity;
  for (let c = 0; c < columnCount; c++) {
    const p = parsed[c];
    if (p?.kind === "cells") {
      widths[c] = p.value;
      remaining -= p.value;
    } else if (p === null) {
      widths[c] = natural[c];
      remaining -= natural[c];
    }
  }
  remaining = Math.max(0, remaining);

  // Distribute remaining across percentage columns (proportional to their %).
  const percentIndices = [] as number[];
  let totalPct = 0;
  for (let c = 0; c < columnCount; c++) {
    if (parsed[c]?.kind === "percent") {
      percentIndices.push(c);
      totalPct += (parsed[c] as { kind: "percent"; value: number }).value;
    }
  }
  for (const c of percentIndices) {
    const pct = (parsed[c] as { kind: "percent"; value: number }).value;
    // When percents sum to > 100, scale each by its share of the total so they
    // collectively consume exactly `remaining` cells. When they sum to ≤ 100,
    // each gets its literal share of the remaining width and slack stays at
    // the right edge.
    const share = totalPct > 100 ? pct / totalPct : pct / 100;
    widths[c] = Math.floor(remaining * share);
  }

  // Apply per-column minWidth floor. If minWidth floors exceed the available
  // table width, the table may grow past resolvedWidth; minWidth is the user's
  // explicit floor knob and wins over the target-width request.
  for (let c = 0; c < columnCount; c++) {
    const min = columns[c]?.minWidth ?? 0;
    if (widths[c] < min) widths[c] = min;
  }

  return widths;
}
```

Lock in the percent math in the unit tests (a worked example for each):
- 2 cols, both `"50%"`, inner = 20 → `[10, 10]`.
- 3 cols, all `"33%"`, inner = 30 → `[9, 9, 9]` (one cell of slack to the right; matches box/row rounding loss).
- 1 fixed (`width: 4`) + 1 percent (`"50%"`), inner = 20 → `[4, 8]` (50% of 16 remaining).
- 2 cols, `"80%"` and `"40%"`, inner = 20 (sum > 100) → scaled to fit: `[13, 7]` (`floor(20 * 80/120)` and `floor(20 * 40/120)`).
- Percent + no table width → throws.

- [ ] **Step 4: `annotateCellsWithWrap` — set `wrapWidth` on text cells**

```ts
// For every cell across header/body/footer, if it's a text leaf and
// its column has a resolved width, annotate it with wrapWidth so the
// existing text renderer (Task 4 Step 2) wraps the content.
//
// Non-text cells (raw, nested box/row/column, nested table) are
// recursed into via the global resolveNode — they participate in
// width sizing as nested roots with resolvedWidth = column's content width.
function annotateCellsWithWrap(
  sections: { header: LayoutNode[]; body: LayoutNode[][]; footer: LayoutNode[][] },
  resolvedColumnWidths: number[],
): { header: LayoutNode[]; body: LayoutNode[][]; footer: LayoutNode[][] } {
  const annotateCell = (cell: LayoutNode, colWidth: number): LayoutNode => {
    if (cell.type === "text") {
      return { ...cell, attrs: { ...cell.attrs, wrapWidth: colWidth } };
    }
    // raw → leave alone (verbatim contract).
    if (cell.type === "raw") return cell;
    // Anything else (nested container or table): recurse through the
    // global resolver, treating colWidth as the child's resolved width.
    return resolveNode(cell, colWidth);
  };
  return {
    header: sections.header.map((cell, c) => annotateCell(cell, resolvedColumnWidths[c] ?? 0)),
    body:   sections.body.map((row) => row.map((cell, c) => annotateCell(cell, resolvedColumnWidths[c] ?? 0))),
    footer: sections.footer.map((row) => row.map((cell, c) => annotateCell(cell, resolvedColumnWidths[c] ?? 0))),
  };
}
```

Forward declaration: `annotateCellsWithWrap` calls `resolveNode` from `render.ts`. To avoid a hard cycle, either (a) inject `resolveNode` as a parameter or (b) keep the existing `render.ts ↔ table.ts` cycle pattern (functions imported at module top, called inside function bodies — already how `renderNode` is used in `table.ts`).

- [ ] **Step 5: `_computeColumnLayouts` honours resolved column widths**

Today, `_computeColumnLayouts` measures the natural content width of each column. Update it to:

```ts
function _computeColumnLayouts(
  rows: LayoutNode[][],
  columnCount: number,
  columns: ColumnSpec[],
  cellPadding: number,
  resolvedColumnWidths: number[] | undefined,   // NEW
): { layouts: ColumnLayout[]; cellBlocks: Block[][] } {
  // ... existing cell-rendering body ...
  for (let c = 0; c < columnCount; c++) {
    const measured = /* unchanged */;
    const spec = columns[c] ?? {};
    const resolved = resolvedColumnWidths?.[c];
    layouts.push({
      width:       resolved ?? Math.max(measured, spec.minWidth ?? 0),
      align:       spec.align ?? "start",
      cellPadding,
      fgColor:     spec.fgColor ?? "",
    });
  }
  return { layouts, cellBlocks };
}
```

`composeTable` passes `attrs.resolvedColumnWidths` (set by `_resolveTableWidths`) into the call. When `resolveSizes` wasn't run (e.g. a TS-side unit test that builds a node by hand and calls `composeTable` directly), `resolvedColumnWidths` is undefined and the existing measured-content path runs — full backward compatibility.

- [ ] **Step 6: `composeTable` grows to `resolvedWidth`**

```ts
function composeTable(node: LayoutNode): Block {
  // ... existing body builds `framed: Block` ...
  const resolved = node.attrs.resolvedWidth as number | undefined;
  return resolved !== undefined ? growToWidth(framed, resolved) : framed;
}
```

The natural cell grid already fills `_innerTableWidth(layouts)` cells when `resolvedColumnWidths` is set, so the framed block should already be exactly `resolvedWidth` wide — `growToWidth` is defensive padding for the case where the user set `width` smaller than the title floor (`minWidthForTitle`).

- [ ] **Step 7: Tests**

TS unit tests in `lib/stdlib/layout.test.ts` for `_resolveTableWidths`:
- Content-driven table, no column widths → `resolvedColumnWidths` matches the natural content width, no cells annotated with `wrapWidth`.
- Content-driven table, one column fixed (`width: 4`) → that column gets 4, others natural; text cell in that column gets `wrapWidth: 4`.
- `table(width: 40)` with 2 columns, both `"50%"`, cellPadding 1, columnDividers true → chrome = 2 + 4 + 1 = 7, inner = 33, each column = floor(33 * 0.5) = 16.
- `table(width: 20)` with cols `[{width: 2}, {}, {width: "50%"}]` → fixed pays 2 (col 0), unsized pays natural (col 1), col 2 gets 50% of remaining inner.
- Percentage in column without table width → throws helpful error.
- `"full"` in column → throws.
- `minWidth: 5` on a column → column never drops below 5 even if percent math says less.

TS unit tests for `_tableChromeWidth`:
- See Step 1 (already enumerated).

Integration tests live in Task 6.

---

## Task 6: User-facing integration tests + demo

**Files:**
- Create: `tests/agency/layout/width-sizing.agency` + `.test.json`
- Create: `tests/agency/layout/text-wrap.agency` + `.test.json`
- Create: `tests/agency/layout/table-width.agency` + `.test.json`
- Modify: `examples/layoutDemo.agency`

Lock the user-visible contract from Agency, not TS. These run the full pipeline and assert on the rendered string.

- [ ] **Step 1: `width-sizing.agency`**

Test cases:
- `testFullWidth()` — `box(width: "full")` with explicit viewport via `render(..., cols: 60)`. Returns the rendered string; fixture asserts exact width of 60.
- `testThreeColumn()` — full-width box with a row of three `33%` child boxes. Fixture asserts the rendered string matches a known layout.
- `testFiftyFifty()` — full-width box with a row of two `50%` boxes.
- `testPercentSummingTo80()` — three `25%` + one `5%`. Slack at right.
- `testFixedWidthBox()` — `box(width: 30)` directly (no `"full"`). Fixture asserts exact width 30 regardless of viewport.
- `testPercentageAtRootThrows()` — wrap in `try` block, assert the error message.

- [ ] **Step 2: `text-wrap.agency`**

Test cases:
- `testWrapInsideBox()` — `box(width: 20)` with `text("the quick brown fox jumps over the lazy dog")`. Assert the rendered string has 4–5 lines all ≤ 18 cells (20 - 2 border).
- `testLongWordBreaks()` — `box(width: 10)` with `text("supercalifragilisticexpialidocious")`. Assert the word is broken across lines.
- `testRawDoesNotWrap()` — `box(width: 10)` with `raw("a very long banner string that should not be touched")`. Assert the raw content is on one line (overflowing the box visibly).
- `testWrapPreservesExplicitNewlines()` — `text("line 1\nline 2 is much longer than the column")` with `width: 12`. Assert line 1 stays as-is and line 2 wraps.

- [ ] **Step 3: `table-width.agency` (NEW)**

Test cases:
- `testTableFullWidth()` — `table(width: "full", columns: [{}, {}], header: ["a", "b"], body: [["x","y"]])` with viewport 40. Fixture: exact 40-cell-wide table.
- `testTableFixedWidth()` — `table(width: 30, ...)`. Fixture: exact 30-cell-wide table regardless of viewport.
- `testColumnFixedWidth()` — table with `columns: [{width: 2}, {width: 10}, {}]` and a row whose first cell is `"hello world"`. Fixture: first column's content is wrapped to 2 cells, rest renders naturally.
- `testColumnPercentages()` — `table(width: 40, columns: [{width: "25%"}, {width: "75%"}], body: [...])`. Fixture: pinned column widths after chrome subtraction.
- `testFixedAndPercentMix()` — `table(width: 40, columns: [{width: 4}, {}, {width: "50%"}])`. Fixture: column 0 = 4, column 1 = natural, column 2 = 50% of remaining inner.
- `testCellWraps()` — column with `width: 8` containing `text("the quick brown fox")`. Fixture: cell content wraps to ≤ 8 cells over multiple visual lines, table row grows in height.
- `testRawCellDoesNotWrap()` — column with `width: 8` containing `raw("ABCDEFGHIJKLMNOP")`. Fixture: raw content overflows the column visibly (no wrap).
- `testColumnPercentWithoutTableWidthThrows()` — `table(columns: [{width: "50%"}], body: [["x"]])`. Wrap in `try`; assert error message names the column index.
- `testColumnFullThrows()` — `table(columns: [{width: "full"}], ...)`. Assert error.
- `testColumnMinWidthIsFloor()` — `table(width: 30, columns: [{width: "10%", minWidth: 5}, {}, {}])`. 10% of inner might be 2, but `minWidth: 5` floors it.

- [ ] **Step 4: Update `examples/layoutDemo.agency`**

Add a new section after the existing demos:

```agency
// 5) Full-width three-column splash, demonstrating top-down sizing
//    and text wrap inside fixed-width cells.
const splash = box(width: "full", title: "Status", padding: 1) as outer {
  outer.row(gap: 2) as r {
    r.box(width: "33%", title: "Commands") as b {
      b.text("/help shows the help screen")
      b.text("/exit quits the session")
    }
    r.box(width: "33%", title: "Shortcuts") as b {
      b.text("Ctrl-C interrupts the current operation")
      b.text("Ctrl-D submits the current input buffer")
    }
    r.box(width: "33%", title: "Tips") as b {
      b.text("Long lines automatically wrap to fit the column width.")
    }
  }
}
print(render(splash))

// 6) Sized table with a fixed first column and a percentage last column.
const sized = table(
  title: "Build summary",
  width: "full",
  columns: [
    { width: 2, align: "end" },        // line numbers, exactly 2 cells
    {},                                 // file path, content-driven
    { width: "30%" },                   // notes column, 30% of inner
  ],
  header: ["#", "file", "notes"],
  body: [
    [text("1"), text("lib/foo.ts"), text("renamed; updated callers throughout the codebase")],
    [text("2"), text("lib/bar.ts"), text("ok")],
  ],
)
print(render(sized))
```

Manual smoke-check: `pnpm run agency examples/layoutDemo.agency` should render both demos correctly, with the "Tips" text wrapped across multiple lines and the "notes" cell in row 1 wrapped to ~30% of the terminal width.

---

## Task 7: Doc updates

**Files:**
- Modify: `stdlib/layout.agency` (module-level docstring + per-function docstrings)
- Run: `make doc` (regenerates `docs/site/stdlib/layout.md`)

- [ ] **Step 1: Module docstring section**

Add a new "Sizing and wrap" section to the `@module` block in `stdlib/layout.agency`:

```
### Sizing and wrap

Every container (`box`, `row`, `column`, `table`) accepts a `width`
parameter:

- `width: "full"` (root only) fills the terminal columns.
- `width: 80` sets an exact column count.
- `width: "50%"` takes 50% of the parent's available width.

Inside a `table`, each `ColumnSpec` accepts the same `width` field —
a percentage column is sized as a share of the table's inner width
(after borders, cell padding, and interior dividers).

Text inside a width-constrained container or column automatically
wraps at word boundaries. Long single words are broken at the
column width. `raw` content is never wrapped — use `text` if you
want wrapping.

Width is the only sized dimension. There is no height sizing and
no truncation: content that overflows wraps, or (for `raw`) extends
visibly past the container.
```

- [ ] **Step 2: Per-function docstring updates**

`@param width` description on `box`, `row`, `column`, `table`:

```
@param width - Optional width constraint. `"full"` (root only) fills the
   terminal columns. `"X%"` takes a percentage of the parent's
   available width. A number sets an exact column count. Unset
   (default) means content-driven width.
```

Add a `width` documentation paragraph to the `ColumnSpec` type docstring:

```
width - Optional per-column constraint. A number caps the column's
   content width in cells (text wraps if the cap is exceeded). `"X%"`
   takes a percentage of the table's inner width (after borders,
   cell padding, and interior dividers). `"full"` is not allowed at
   the column level. Unset means the column is content-driven; in a
   width-constrained table, content-driven columns take their natural
   width and slack flows to the percentage columns (if any) or to
   trailing space.
```

- [ ] **Step 3: Regenerate site docs**

```
make doc
```

Verify the generated `docs/site/stdlib/layout.md` reflects the new params, new ColumnSpec field, and module section.

---

## Acceptance criteria

This plan is complete when:

- [ ] All unit tests in `lib/stdlib/layout.test.ts` pass (including new `parseWidth`, `wrapText`, `resolveSizes`, `_tableChromeWidth`, `_resolveTableWidths` tests).
- [ ] All agency tests in `tests/agency/layout/` pass (existing + new `width-sizing`, `text-wrap`, `table-width`).
- [ ] `pnpm run lint:structure` clean.
- [ ] `make` (full build + doc regen) clean.
- [ ] `examples/layoutDemo.agency` runs end-to-end and renders both the splash and the sized-table demos correctly in an interactive terminal.
- [ ] `pnpm run agency examples/layoutDemo.agency 2>&1 | cat` (non-TTY path) also renders correctly using the 80-column fallback.
- [ ] Manual check: a deeply nested width-constrained tree (e.g. `box(width:"full") > row > box(width:"50%") > table(width:"100%", columns:[{width:"50%"},{width:"50%"}])`) sizes correctly through 4+ levels.
- [ ] Manual check: `table(width: 80)` with mixed fixed/percent/unsized columns + a cell containing a long sentence → cell wraps inside its column, table is exactly 80 cells wide, surrounding rows grow to the wrapped cell's height (this last bit is already how the row renderer composes — verify nothing regressed).

## Risks / things to watch

- **Cross-pass annotations on `attrs`.** Storing `resolvedWidth` / `wrapWidth` / `resolvedColumnWidths` on `attrs` mixes user data with resolver output. If this becomes painful (e.g. snapshot tests of node trees include the annotations), move to a side-channel `WeakMap<LayoutNode, ResolvedInfo>`. For now, the on-attrs approach is fine — easy to debug, easy to test.
- **Wrap and styling interaction.** `text("...", bold: true)` is styled by the renderer after wrap. Confirm in the integration tests that every wrapped line is bolded, not just the first. The current `styled` helper wraps each line independently, which is the correct behaviour, but the test pins the contract.
- **Percentage rounding loss.** Three `33%` children of a 100-cell parent → `floor(100 * 0.33) * 3 = 99`, one cell of slack. Document this; don't try to redistribute the lost cell (over-engineered for v1). Same rule applies to table columns.
- **Column children with `width: "X%"`.** A `column` doesn't subdivide horizontally — `width: "50%"` on a column child takes 50% of the column's resolved width, NOT 50% of half the column's width. The resolver naturally does this; just make sure the integration test covers it.
- **Test for wrapping with embedded ANSI** is the highest-risk unit test. The `breakLongToken` state machine for SGR-aware char-breaking is the most likely place for subtle bugs. Spend extra care there; include fixtures with adjacent SGR sequences, sequences spanning multiple line breaks, and bare CSI (no SGR) sequences.
- **Table chrome math is easy to get wrong.** `_tableChromeWidth` is the single source of truth for "how much does the table frame eat". Don't inline the math anywhere else (don't reuse `chromeWidth` from `resolveSizes`). The most likely bug is forgetting that `columnDividers: false` removes `(N-1)` cells, or that `cellPadding` is applied **per column** not per row.
- **Title floor vs. resolved width.** `minWidthForTitle` is a content-driven floor. If a user explicitly sets `table(width: 20, title: "A very long title")`, the resolved width wins and the title wraps inside the frame. Confirm with an integration test that this doesn't widen or crash.
- **Cell wrap of nested non-text cells.** A cell that's a nested `box` with its own content needs to be resolved (recursive `resolveNode`) at the column's content width. The `annotateCellsWithWrap` helper does this. Confirm with an integration test that a `box` cell inside a width-constrained table column renders at the column's width, not its natural width.
- **Backward compatibility for `composeTable` direct callers.** If anything in the codebase or tests calls `composeTable` without going through `render`/`resolveSizes`, `attrs.resolvedColumnWidths` will be undefined and `_computeColumnLayouts` falls back to natural measurement. Verify no existing tests regress.
