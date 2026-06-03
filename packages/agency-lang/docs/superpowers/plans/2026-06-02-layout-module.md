# Layout Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `std::layout`, a declarative text-layout module that turns a tree of builder calls into an ANSI-styled multi-line string suitable for `print`. First consumer: bordered panels (Claude-Code-style splash screens, summary boxes, side-by-side columns) for CLI tools and the agency-agent.

**Architecture:** Two sharply separated layers. The Agency-side wrapper (`stdlib/layout.agency`) is pure data: builder methods construct `LayoutNode` records and append them to parent `children` arrays. The TS bridge (`lib/stdlib/layout.ts`) is pure render: it consumes a tree and returns a styled string. The render layer is built on one primitive, `Block` (immutable 2D rectangle of styled text), composed via 5 free operators (`beside`, `above`, `pad`, `styled`, `bordered`). All ANSI width math goes through a single `visualWidth` helper.

**Tech Stack:** TypeScript (TS bridge + Vitest unit tests), Agency (stdlib wrapper + tree-shape tests in `tests/agency/`)

**Spec:** `docs/superpowers/specs/2026-06-02-layout-module-design.md`

**Spec amendments applied here** (from spec-review pass):
- Builder method for pre-styled raw strings is named `embed`, not `add`.
- `pad(block, w, h, hAlign?, vAlign?)` interprets `w`/`h` as **target dimensions** (no-op when block already exceeds them).
- `text("a\nb")` produces a 2-row Block (`Block.of(content.split("\n"))`).
- `gap` (on row/column) and `space(n)` (leaf) are **additive** when both are set on the same axis. May reconsider after first real use shows whether both are needed.
- `embed` content is documented as incompatible with outer `styled()` wrapping — the caller is responsible for any styling the embedded string needs. Simplest contract; avoids nested-SGR re-emission complexity.
- `beside` / `above` default to `start` cross-axis alignment when auto-padding the shorter dimension.
- `borderStyle` typed as the string union `"rounded" | "heavy" | "double" | "light"` so the typechecker rejects typos at compile time; the runtime renderer also falls back to `"light"` (with a one-shot console warning) for any other value that slips through.
- Tree-shape tests live in `tests/agency/layout/` (Agency programs that build a tree and assert on its structure), not in `tests/typescriptGenerator/`.
- No `figure` example references in module docs; no agent-splash phase. Agent integration is out of scope for this plan.
- **LLM-callable construction (two-track API).** Containers (`box`, `row`, `column`) accept *either* the trailing `block: builder => void` (Agency-author ergonomics) *or* a `children: LayoutNode[]` array (LLM tool-call / JSON construction), or both (children prepended, block appends after). Top-level leaf constructors (`text`, `embed`, `space`, `hline`, `vline`) are also exported so an LLM can build a sub-tree by emitting nested JSON. The builder methods inside containers delegate to the top-level constructors, then push — single construction codepath, two surface ergonomics.
- **`render(node, color: "auto" | boolean = "auto")`.** `"auto"` (default) checks `process.stdout.isTTY` via a small bridge helper; `true` forces SGR sequences (useful with `| less -R`); `false` strips all styling for plain ASCII output (logs, non-TTY consumers). Stripping reuses the same CSI regex that `visualWidth` uses, applied post-render in one pass.

---

## File Structure

### New files

```
lib/stdlib/layout.ts                    # TS bridge: Block, render, all operators
lib/stdlib/layout.test.ts               # Vitest unit tests for Block + operators + handlers
stdlib/layout.agency                    # Agency wrapper: containers, builder, types
tests/agency/layout/                    # Tree-shape + integration tests in Agency
  builders.agency                       # Each builder method produces expected LayoutNode
  builders.test.json                    # Snapshot of generated tree
  nested.agency                         # Nested containers, child-array ordering
  nested.test.json
  banner.agency                         # Full splash-style render → string check (block: style)
  banner.test.json
  children-style.agency                 # Same tree built via top-level constructors + `children: [...]`
  children-style.test.json              # Asserts structural equality with banner.agency tree
  color-modes.agency                    # render(node, color: true|false) — SGR present vs stripped
  color-modes.test.json
docs/site/stdlib/layout.md              # Auto-generated from `make doc`
```

### Modified files

```
docs/site/guide/stdlib.md               # Add a paragraph linking to std::layout
                                        # (only if such an index exists; otherwise skip)
```

No modifications to `std::ui` — the two modules coexist. Each gets a docstring note pointing at the other to disambiguate the overlapping `box` / `row` / `column` names.

---

## Task 1: `Block` primitive + free operators + `visualWidth` + `sgr`

**Files:**
- Create: `lib/stdlib/layout.ts`
- Create: `lib/stdlib/layout.test.ts`

This task lays the entire render foundation. No node types yet; nothing renders an Agency tree. The goal is a working `Block`, the five operators, and the two internal helpers (`visualWidth`, `sgr`) — each unit-tested with explicit string fixtures. Every later task composes these.

- [ ] **Step 1: `visualWidth` and `sgr`**

```ts
// lib/stdlib/layout.ts
// Strip CSI sequences (SGR `m`, cursor moves `A`-`G`, clears `J`/`K`).
// The renderer never calls `.length` on a styled string; everything
// that needs a width goes through here.
function visualWidth(s: string): number {
  return s.replace(/\x1b\[[\d;]*[A-Za-z]/g, "").length;
}

type Style = {
  fgColor?: string;
  bgColor?: string;
  bold?: boolean;
  italic?: boolean;
  dim?: boolean;
  underline?: boolean;
};

// Build an SGR start sequence for `style`. Returns "" when no
// style attribute is set so callers never write `\x1b[m` (which is
// equivalent to RESET on some terminals).
function sgr(style: Style): string {
  // ... see spec §"ANSI / styling" for the named-color table
}
```

- [ ] **Step 2: `Block` class**

```ts
type Align = "start" | "center" | "end";

class Block {
  readonly lines: readonly string[];
  private constructor(lines: readonly string[]) {
    this.lines = lines;
  }
  static empty(): Block { return new Block([]); }
  static of(content: string | string[]): Block {
    // Crucially: `Block.of("a\nb")` splits on `\n` into a 2-row
    // block. This is what makes multi-line text "just work".
    if (typeof content === "string") {
      return new Block(content.split("\n"));
    }
    return new Block(content);
  }
  get height(): number { return this.lines.length; }
  get width(): number {
    let w = 0;
    for (const line of this.lines) {
      const lw = visualWidth(line);
      if (lw > w) w = lw;
    }
    return w;
  }
  toString(): string { return this.lines.join("\n"); }
}
```

- [ ] **Step 3: `padLine` internal + `pad` operator (target-dimension semantics)**

```ts
// Pad a single visual-line `line` to `w` columns with `align`.
// ANSI-aware: uses `visualWidth(line)`, not `line.length`.
function padLine(line: string, w: number, align: Align = "start"): string {
  const lw = visualWidth(line);
  if (lw >= w) return line;
  const extra = w - lw;
  switch (align) {
    case "start":  return line + " ".repeat(extra);
    case "end":    return " ".repeat(extra) + line;
    case "center": {
      const left  = Math.floor(extra / 2);
      const right = extra - left;
      return " ".repeat(left) + line + " ".repeat(right);
    }
  }
}

// `w` and `h` are *target* dimensions. No-op for either axis when
// the block already meets or exceeds the target.
function pad(
  block: Block, w: number, h: number,
  hAlign: Align = "start", vAlign: Align = "start",
): Block {
  // 1) pad each line to target width
  // 2) prepend/append empty rows to reach target height
  // ...
}
```

- [ ] **Step 4: `styled` operator (per-line SGR wrap)**

```ts
// Wrap *every* line individually with the SGR start sequence + RESET
// so the styling survives `\n` boundaries (many terminals reset SGR
// at newline). When `style` is empty, returns the block unchanged.
function styled(block: Block, style: Style): Block {
  const start = sgr(style);
  if (start === "") return block;
  const RESET = "\x1b[0m";
  return Block.of(block.lines.map(l => start + l + RESET));
}
```

- [ ] **Step 5: `beside` and `above` operators (auto-pad shorter axis with `start` alignment)**

```ts
// Place `left` and `right` side by side. Shorter block gets padded
// to the taller's height (bottom-padded by empty lines, `start`
// vertical alignment).
function beside(left: Block, right: Block): Block {
  if (left.lines.length === 0) return right;
  if (right.lines.length === 0) return left;
  const h = Math.max(left.height, right.height);
  const lw = left.width;
  const lp = pad(left,  lw, h, "start", "start").lines;
  const rp = pad(right, right.width, h, "start", "start").lines;
  return Block.of(lp.map((l, i) => l + rp[i]));
}

function above(top: Block, bottom: Block): Block {
  // Pad narrower of the two to the wider's width with `start`
  // horizontal alignment, then concatenate `lines`.
}
```

- [ ] **Step 6: Unit tests for everything in this task**

Put a snapshot-free, explicit-string test file at `lib/stdlib/layout.test.ts`. One block per operator. Cover:

- `visualWidth("\x1b[31mhi\x1b[0m") === 2`
- `Block.of("a\nb").height === 2 && .width === 1`
- `pad(Block.of("hi"), 5, 1, "center").toString() === "  hi "`
- `styled(Block.of("a\nb"), { bold: true })` wraps each line with bold + reset
- `beside(Block.of(["a", "b"]), Block.of("c")).toString() === "ac\nb "` (shorter right block bottom-padded)
- `above(Block.of("aa"), Block.of("b")).toString() === "aa\nb "` (narrower bottom right-padded? no — `start` = LEFT-padded i.e. trailing space). Assert exact output.

**Validation:** `pnpm test:run lib/stdlib/layout.test.ts` passes.

---

## Task 2: `bordered` without title

**Files:**
- Modify: `lib/stdlib/layout.ts`
- Modify: `lib/stdlib/layout.test.ts`

Adds the `bordered` operator and the `BORDER_CHARS` table. No title embedding yet.

- [ ] **Step 1: `BORDER_CHARS` table — single source of truth**

```ts
type BorderStyle = "rounded" | "heavy" | "double" | "light";

type BorderChars = {
  tl: string; tr: string; bl: string; br: string;
  h: string;  v: string;
};

const BORDER_CHARS: Record<BorderStyle, BorderChars> = {
  rounded: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
  heavy:   { tl: "┏", tr: "┓", bl: "┗", br: "┛", h: "━", v: "┃" },
  double:  { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" },
  light:   { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
};

// Resolve any string to a known style. Falls back to "light" with a
// one-shot warning. Type-checker still catches typos at compile
// time; this is the runtime guard for `borderStyle` values that
// arrive untyped (e.g. from JSON).
let warnedUnknownStyles = new Set<string>();
function resolveBorderStyle(s: string): BorderStyle {
  if (s in BORDER_CHARS) return s as BorderStyle;
  if (!warnedUnknownStyles.has(s)) {
    warnedUnknownStyles.add(s);
    console.warn(`std::layout: unknown borderStyle "${s}"; falling back to "light"`);
  }
  return "light";
}
```

- [ ] **Step 2: `bordered` operator (no title yet)**

```ts
type BorderOpts = {
  borderStyle?: BorderStyle;
  borderColor?: string;
  padding?: number;
};

function bordered(block: Block, opts: BorderOpts): Block {
  const ch = BORDER_CHARS[resolveBorderStyle(opts.borderStyle ?? "rounded")];
  const inner = (opts.padding ?? 0) > 0
    ? pad(block, block.width + 2 * opts.padding!, block.height + 2 * opts.padding!, "center", "center")
    : block;
  const w = inner.width;
  const colorStart = sgr({ fgColor: opts.borderColor });
  const colorEnd   = colorStart === "" ? "" : "\x1b[0m";
  const top    = colorStart + ch.tl + ch.h.repeat(w) + ch.tr + colorEnd;
  const bottom = colorStart + ch.bl + ch.h.repeat(w) + ch.br + colorEnd;
  const sides  = inner.lines.map(l =>
    colorStart + ch.v + colorEnd + padLine(l, w) + colorStart + ch.v + colorEnd
  );
  return Block.of([top, ...sides, bottom]);
}
```

- [ ] **Step 3: Tests for each border style + padding + borderColor**

**Validation:** `pnpm test:run lib/stdlib/layout.test.ts` passes. Visual inspection: tests use multi-line string fixtures with the actual box-drawing characters embedded; the diff on failure shows exactly what the renderer produced.

---

## Task 3: `bordered` with title embedded in top edge

**Files:**
- Modify: `lib/stdlib/layout.ts`
- Modify: `lib/stdlib/layout.test.ts`

Adds title support to the existing `bordered`. Title is space-padded on both sides and embedded in the top edge after the top-left corner.

- [ ] **Step 1: Extend `BorderOpts` and `bordered` to take `title`, `titleColor`**

Top edge becomes:

```
╭─ Title ──────────────╮
```

Three styled segments concatenated: `tl + h`, ` Title ` (with `titleColor`), `h.repeat(remaining) + tr`. Each segment gets its own SGR wrap to keep the title color independent from `borderColor`.

If `visualWidth(title) + 4 > w`, grow the box to fit the title (no truncation). Recompute `w` and re-pad inner accordingly.

- [ ] **Step 2: Tests covering** (a) short title fits inside the natural width, (b) long title forces box to grow, (c) title color differs from border color, (d) title with embedded ANSI (already-styled title is layered cleanly via `styled()` per-segment).

**Validation:** `pnpm test:run lib/stdlib/layout.test.ts` passes.

---

## Task 4: Leaf render handlers (`text`, `raw`/`embed`, `space`, `hline`, `vline`)

**Files:**
- Modify: `lib/stdlib/layout.ts`
- Modify: `lib/stdlib/layout.test.ts`

Introduces the `LayoutNode` type and the HANDLERS dispatch table. Leaves only; containers come next.

- [ ] **Step 1: `LayoutNode` type and the HANDLERS skeleton**

```ts
type NodeType =
  | "box" | "row" | "column"
  | "text" | "raw" | "space" | "hline" | "vline";

export type LayoutNode = {
  type: NodeType;
  attrs: Record<string, unknown>;
  children: LayoutNode[];
};

const HANDLERS: Record<NodeType, (n: LayoutNode) => Block> = {
  // filled in below
};

export function render(node: LayoutNode): string {
  return HANDLERS[node.type](node).toString();
}
```

- [ ] **Step 2: `text` handler**

`text`'s `content` may contain `\n`. Use `Block.of(content)` (handles split), then `styled(block, styleOf(attrs))`. If `align` is set, pad to the block's own width (no-op alone; the align matters when the parent container measures width and asks for `pad`-to-width — but the leaf handler itself just wraps).

Edge: `text("")` → `Block.of("")` is `["",]` (one empty line). Document that empty `text` still occupies one row; callers wanting "nothing" use `space(0)` or just omit.

- [ ] **Step 3: `raw` handler** (the renderer-side counterpart of the `embed` builder)

```ts
raw: (n) => Block.of(n.attrs.content as string),
```

No `styled()` wrap. The content is responsible for its own styling.

- [ ] **Step 4: `space` handler — placeholder that throws if invoked directly**

```ts
space: (n) => {
  throw new Error(
    "std::layout: `space` must be resolved by its parent row/column. " +
    "Found one outside a container at render time."
  );
},
```

The real handling lives in `composeRow` / `composeColumn` (Task 6) — same place stretchy lines get resolved. Defensive throw to catch leaks.

- [ ] **Step 5: `hline` and `vline` handlers**

When `length` is set: `Block.of(char.repeat(length))` for hline, `Block.of(Array(length).fill(char))` for vline, then `styled()`.

When `length` is unset: throw the same "must be resolved by parent" error. The actual fill happens in `composeRow` / `composeColumn`.

- [ ] **Step 6: Tests for each leaf handler.**

**Validation:** `pnpm test:run lib/stdlib/layout.test.ts` passes.

---

## Task 5: `row` and `column` handlers (no stretchy resolution)

**Files:**
- Modify: `lib/stdlib/layout.ts`
- Modify: `lib/stdlib/layout.test.ts`

Renders containers via `beside` (row) / `above` (column) reductions over child blocks. Stretchy lines and `space` still throw at this stage — Task 6 fixes that.

- [ ] **Step 1: `composeRow`**

```ts
function composeRow(node: LayoutNode): Block {
  if (node.children.length === 0) return Block.empty();
  const align: Align = (node.attrs.align as Align) ?? "start";
  const gap   = (node.attrs.gap as number)   ?? 0;
  const blocks = node.children.map(c => HANDLERS[c.type](c));
  // Align children to the row's height before composing (so `align`
  // takes effect even without explicit padding).
  const h = blocks.reduce((m, b) => Math.max(m, b.height), 0);
  const aligned = blocks.map(b => pad(b, b.width, h, "start", align));
  // Reduce with `beside`, inserting `gap` columns of empty space
  // between siblings.
  return reduceWithGap(aligned, beside, gap, "row");
}
```

`reduceWithGap` is a tiny helper that inserts a `Block.of(" ".repeat(gap))` (row) or `Block.of(Array(gap).fill(""))` (column) between siblings.

- [ ] **Step 2: `composeColumn`** — symmetric.

- [ ] **Step 3: Wire into HANDLERS, drop the placeholder throws for `row` / `column`.**

- [ ] **Step 4: Tests:**
  - Row of two `text` children
  - Column of mixed-width children — column width grows to widest
  - Row of multi-line text — row height grows to tallest
  - Empty container → empty Block
  - `gap` produces visible spacing between siblings
  - `align: "center"` on a row centers shorter children vertically; on a column centers narrower children horizontally

**Validation:** `pnpm test:run lib/stdlib/layout.test.ts` passes.

---

## Task 6: Stretchy line + `space` resolution pass

**Files:**
- Modify: `lib/stdlib/layout.ts`
- Modify: `lib/stdlib/layout.test.ts`

Single preprocess pass inside `composeRow` and `composeColumn`. Walks the children once, resolves each `vline`/`hline` without `length` and each `space` to a concrete value based on the container's measured cross-axis size (for lines) or the container's main axis (for `space`).

- [ ] **Step 1: `resolveDynamicChildren(children, axis)` helper**

```ts
function resolveDynamicChildren(
  children: LayoutNode[],
  axis: "row" | "column",
): LayoutNode[] {
  // Pass 1: render non-dynamic children to measure cross-axis size
  // (row → height, column → width). Dynamic: stretchy lines (the
  // perpendicular one) and `space` nodes.
  const concrete = children.filter(c => !isDynamic(c, axis));
  const concreteBlocks = concrete.map(c => HANDLERS[c.type](c));
  const cross = axis === "row"
    ? Math.max(1, ...concreteBlocks.map(b => b.height))
    : Math.max(1, ...concreteBlocks.map(b => b.width));

  // Pass 2: rewrite each child's attrs to fill in the missing
  // `length` or `count`.
  return children.map(c => {
    if (axis === "row" && c.type === "vline" && c.attrs.length == null) {
      return { ...c, attrs: { ...c.attrs, length: cross } };
    }
    if (axis === "column" && c.type === "hline" && c.attrs.length == null) {
      return { ...c, attrs: { ...c.attrs, length: cross } };
    }
    if (c.type === "space") {
      // `space(n)` is `n` columns of empty in a row; `n` rows in a column.
      const n = (c.attrs.count as number) ?? 1;
      return axis === "row"
        ? { ...c, type: "raw" as NodeType,
            attrs: { content: " ".repeat(n) }, children: [] }
        : { ...c, type: "raw" as NodeType,
            attrs: { content: Array(n).fill("").join("\n") }, children: [] };
    }
    return c;
  });
}
```

Edge case from spec: "Row of only stretchy children → length defaults to 1" — the `Math.max(1, ...)` floor handles this. "Stretchy line whose siblings are all empty → height 0" is handled by `Math.max(1, ...)` defaulting to 1; if you'd prefer the original behavior (render as nothing), swap to `Math.max(0, ...)`. **Decision:** use `1` for safety (a visible separator is more useful than an invisible one).

- [ ] **Step 2: Call from `composeRow` / `composeColumn` BEFORE measuring & laying out.**

- [ ] **Step 3: Tests:**
  - `row` with one `text` and one `vline()` → vline matches text height
  - `column` with one `text` and one `hline()` → hline matches text width
  - `row` with `space(3)` between two `text`s → 3 columns of gap
  - `row(gap: 1)` with `space(3)` → 1 + 3 = 4 cols (additive, per spec amendment)
  - Row of only stretchy children → length 1

**Validation:** `pnpm test:run lib/stdlib/layout.test.ts` passes.

---

## Task 7: `box` render handler

**Files:**
- Modify: `lib/stdlib/layout.ts`
- Modify: `lib/stdlib/layout.test.ts`

Wraps the child tree in a `bordered` call. Children with `length > 1` get implicitly wrapped in a `column` (spec).

- [ ] **Step 1: `box` handler**

```ts
box: (n) => {
  const inner: LayoutNode = n.children.length === 1
    ? n.children[0]
    : { type: "column", attrs: {}, children: n.children };
  const innerBlock = HANDLERS[inner.type](inner);
  return bordered(innerBlock, {
    title:       n.attrs.title       as string | undefined,
    titleColor:  n.attrs.titleColor  as string | undefined,
    borderStyle: n.attrs.borderStyle as BorderStyle | undefined,
    borderColor: n.attrs.borderColor as string | undefined,
    padding:     n.attrs.padding     as number   | undefined,
  });
},
```

- [ ] **Step 2: Tests** covering single-child box, multi-child auto-column, box with title, box with padding, box of borderStyle "heavy" / "double", box with `text` inside.

**Validation:** `pnpm test:run lib/stdlib/layout.test.ts` passes.

---

## Task 8: Agency wrappers (`stdlib/layout.agency`)

**Files:**
- Create: `stdlib/layout.agency`

The data-construction surface. Mirrors `stdlib/ui.agency`'s `Builder` shape (records of methods that append to a shared child array). No rendering, no measurement, no string ops.

- [ ] **Step 1: Module docstring + `LayoutNode` type alias**

Include a "see also `std::ui` for interactive widgets" line in the module doc, mirroring an equivalent note added to `stdlib/ui.agency`. (Or: separate cleanup task — note in TODO and move on.)

- [ ] **Step 2: `LayoutBuilder` record type and `_makeBuilder(kids)` factory**

Modeled on the `Builder` type and `_makeBuilder` helper in `stdlib/ui.agency`. Each method:
1. Constructs a `LayoutNode` from its arguments.
2. Pushes it onto `kids`.
3. Returns the same `LayoutNode`.

- [ ] **Step 3: Top-level leaf constructors (LLM-callable)**

These produce `LayoutNode` records without pushing to any parent. The builder methods inside containers (Step 5) delegate to these so there's one construction codepath.

```agency
export safe def text(
  content: string,
  fgColor: string = "",
  bgColor: string = "",
  bold: boolean = false,
  italic: boolean = false,
  dim: boolean = false,
  underline: boolean = false,
  align: "start" | "center" | "end" = "start",
): LayoutNode { ... }

export safe def embed(content: string, align: "start" | "center" | "end" = "start"): LayoutNode { ... }
export safe def space(count: number = 1): LayoutNode { ... }
export safe def hline(char: string = "─", length: number = 0,
                      fgColor: string = "", bold: boolean = false, dim: boolean = false): LayoutNode { ... }
export safe def vline(char: string = "│", length: number = 0,
                      fgColor: string = "", bold: boolean = false, dim: boolean = false): LayoutNode { ... }
```

`length: 0` is the "unset / stretchy" sentinel for `hline` / `vline`; the resolution pass in `composeRow` / `composeColumn` (Task 6) fills in the parent's measured cross-axis size.

The `embed` docstring explicitly notes: "the content is rendered as-is and is **not** wrapped in any outer styling. If the embedded string carries its own ANSI sequences, nesting it inside a styled `text` or styled `box` will not re-style it after the inner sequences reset."

- [ ] **Step 4: Top-level container exports (two-track: `block` and/or `children`)**

```agency
export def box(
  title: string = "",
  titleColor: string = "",
  borderStyle: "rounded" | "heavy" | "double" | "light" = "rounded",
  borderColor: string = "",
  padding: number = 0,
  children: LayoutNode[] = null,
  block: (LayoutBuilder) => void = null,
): LayoutNode { ... }

export def row(
  gap: number = 0,
  align: "start" | "center" | "end" = "start",
  children: LayoutNode[] = null,
  block: (LayoutBuilder) => void = null,
): LayoutNode { ... }

export def column(
  gap: number = 0,
  align: "start" | "center" | "end" = "start",
  children: LayoutNode[] = null,
  block: (LayoutBuilder) => void = null,
): LayoutNode { ... }

export safe def render(
  node: LayoutNode,
  color: "auto" | boolean = "auto",
): string {
  return _render(node, color)  // bridge call
}
```

Each container body builds its `kids` array in this order: start with `children` if non-null (copy in), then run `block(_makeBuilder(kids))` if non-null (appends more). Either, both, or neither is valid (neither → empty container). This is the entire two-track surface — the builder methods inside `_makeBuilder` already produce identical nodes via the Step 3 constructors.

The `borderStyle` union literal is what makes the typechecker reject `borderStyle: "round"` at compile time. The TS runtime additionally falls back to `"light"` with a warning (Task 2 step 1) for any value that gets in via untyped paths (e.g. JSON arriving from an LLM tool call where the field was typed `string`).

- [ ] **Step 5: Builder leaf methods (delegate to top-level constructors)**

```agency
// Inside _makeBuilder(kids):
text:   (...args) → const n = text(...args);   kids.push(n); return n
embed:  (...args) → const n = embed(...args);  kids.push(n); return n
space:  (count)   → const n = space(count);    kids.push(n); return n
hline:  (...args) → const n = hline(...args);  kids.push(n); return n
vline:  (...args) → const n = vline(...args);  kids.push(n); return n
row:    (...args, block) → const n = row(..., block: block);    kids.push(n); return n
column: (...args, block) → const n = column(..., block: block); kids.push(n); return n
box:    (...args, block) → const n = box(..., block: block);    kids.push(n); return n
```

No node-construction logic lives in builder methods — they're thin "construct + push" wrappers. A bug in node shape can only exist in the top-level constructor.

- [ ] **Step 6: Bridge functions in `lib/stdlib/layout.ts`**

```ts
export function _render(node: LayoutNode, color: "auto" | boolean): string {
  const useColor = color === "auto"
    ? process.stdout.isTTY === true
    : color === true;
  const rendered = render(node);  // the existing internal `render`
  return useColor ? rendered : stripAnsi(rendered);
}

// Reuses the same CSI regex as `visualWidth` for a single source of
// truth on what counts as a stylable escape sequence.
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[\d;]*[A-Za-z]/g, "");
}
```

The Agency-side `render(node, color)` is a one-line wrapper around `_render`.

**Validation:**
- `PATH="./node_modules/.bin:$PATH" pnpm run agency compile stdlib/layout.agency` succeeds.
- The compiled module is reachable via `import { box, row, column, text, embed, space, hline, vline, render } from "std::layout"` from a sample `.agency` file.
- Compile-time error when a test file uses `borderStyle: "round"` (typo) — the union literal must reject it before runtime.

---

## Task 9: Agency tree-shape + integration tests

**Files:**
- Create: `tests/agency/layout/builders.agency` + `.test.json`
- Create: `tests/agency/layout/nested.agency` + `.test.json`
- Create: `tests/agency/layout/banner.agency` + `.test.json`

Three programs exercise the public API end-to-end. They live in `tests/agency/` because each runs the compiled Agency program, captures its return value, and compares against a JSON fixture.

- [ ] **Step 1: `builders.agency`** — calls each builder method once with representative args, returns the produced `LayoutNode`. The fixture asserts every node has the right `type` and `attrs` keys.

- [ ] **Step 2: `nested.agency`** — builds a 3-deep nested tree (`box > row > column > text`) and returns the root. The fixture verifies `children` ordering matches source-code order, and verifies no styling/rendering leaked into the data tree.

- [ ] **Step 3: `banner.agency`** — builds a small "splash"-like layout (box with title + two-column inner row + vline separator + a couple of styled lines) and calls `render(...)`, returning the resulting string. The fixture is the exact expected multi-line string.

- [ ] **Step 4: `children-style.agency`** — exercises the LLM-callable construction path. Builds the same logical tree as `banner.agency` but using only top-level constructors + `children: [...]` arrays (no `block:` callbacks). Returns the produced `LayoutNode`. The fixture asserts the result is structurally identical to `banner.agency`'s tree — same JSON. Demonstrates the two-track API produces the same data either way.

- [ ] **Step 5: `color-modes.agency`** — calls `render(node, color: true)` and `render(node, color: false)` on the same styled layout, returns both strings. The fixture asserts: (a) the `true` output contains `\x1b[` sequences, (b) the `false` output is identical except all CSI sequences are stripped, (c) `visualWidth` of any line is the same in both outputs.

**Validation:** `pnpm run agency test tests/agency/layout/` runs all five and they pass.

---

## Task 10: Smoke test + docstring polish

**Files:**
- Create: `examples/layout-demo.agency` (or `.agency-tmp/layout-demo.agency` if `examples/` is reserved)
- Modify: `stdlib/layout.agency` (doc polish based on smoke output)
- Modify: `stdlib/ui.agency` (one-line "see also `std::layout`" note)

- [ ] **Step 1:** Write a small `.agency` script that exercises several layouts (single box, two-column row, nested box with title, columns of text with `gap`, `hline` separator), prints each one. Run by hand. The output should be visually appealing on a terminal — adjust any defaults that look wrong (e.g. default padding, default border style).

- [ ] **Step 2:** Add a "see also" line to `stdlib/ui.agency`'s module docstring pointing at `std::layout` for static text output, and a reciprocal note in `stdlib/layout.agency`.

- [ ] **Step 3:** Run `make doc` and visually inspect `docs/site/stdlib/layout.md` — make sure the parameter docs read cleanly and the examples render.

**Validation:** smoke script produces readable output; `make doc` succeeds; spot-check the generated doc page.

---

## Done When

- All TS unit tests in `lib/stdlib/layout.test.ts` pass.
- All Agency tests in `tests/agency/layout/` (5 files) pass.
- `make stdlib` compiles `stdlib/layout.agency` clean.
- `import { box, row, column, text, embed, space, hline, vline, render } from "std::layout"` works from a sample script.
- A test program builds a tree via top-level constructors + `children: [...]` and produces structurally identical output to the same tree built via trailing `block:` syntax.
- `render(node, color: false)` produces output free of `\x1b[` sequences; `render(node, color: true)` includes them; `render(node)` (auto) matches `color: true` when run under a TTY.
- A typo like `borderStyle: "round"` fails to compile (not just fails at runtime).
- The smoke demo script renders without visual glitches in a real terminal.
- `make doc` regenerates `docs/site/stdlib/layout.md` with the new module's API documented.

## Out of scope (deferred)

- Agency-agent splash screen (was spec phase 10; deferred to a follow-up task that depends on this plan).
- Comic-panel data source / random-figure picking (out of scope; the `embed` builder accepts any pre-rendered string, so the splash task can plug one in later).
- Reconsidering `gap` vs `space(n)` overlap — keep both, additive, revisit after real-world usage.
- Width / height hints (`width`, `minWidth`, `maxWidth`) on nodes — wait for a real use case.
- Color-name table extraction into a shared `utils/` module — wait for a second consumer (e.g. `std::markdown` or `std::syntax`) to need it.
- East-Asian width / emoji-aware `visualWidth` — out of scope per spec non-goals.
- Text wrapping / truncation of overflowing content — out of scope per spec non-goals.
