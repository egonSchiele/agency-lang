# Layout Module Design

**Status:** spec, awaiting implementation plan
**Module:** `std::layout`
**Date:** 2026-06-02

## Goal

A composable text-layout module for terminal output. Users describe a
layout declaratively with a small set of nested containers (`box`,
`row`, `column`) and leaf primitives (`text`, `add`, `hline`, `vline`,
`space`); the module produces an ANSI-styled multi-line string ready
for `print`.

The immediate driver is the agency-agent's startup banner: a bordered
panel with an embedded title (Claude-Code style), a left column of
welcome text + tips, and a right column showing a random comic panel.
The broader use is any CLI tool that wants boxed/columned output —
status dashboards, help screens, summary tables, splash screens.

Agency already has the analogous abstraction for interactive UIs in
`stdlib/ui.agency` (TUI elements). The layout module is the sibling
for static text.

## Non-goals (in the first cut)

- Flex sizing (`width: 1fr`, `auto`, grid-track allocation).
- Text wrapping / truncation. If content overflows, it overflows.
- Cross-axis alignment beyond `start | center | end`.
- Animation, dynamic redraw, ANSI cursor positioning. This module
  produces a string; the caller decides what to do with it.
- Unicode East-Asian width handling. Each character counts as one
  column; the comic panels use block-element characters which are all
  single-width.

## Architecture

Two sharply separated layers:

| Layer    | Input          | Output         | Where the logic lives    |
| -------- | -------------- | -------------- | ------------------------ |
| Data     | builder calls  | `LayoutNode`   | `stdlib/layout.agency`   |
| Render   | `LayoutNode`   | styled string  | `lib/stdlib/layout.ts`   |

The data layer is pure: builder methods produce nodes; nothing renders.
The render layer is pure: it takes a tree, returns a string. The two
sides communicate only through the `LayoutNode` shape.

Why this split matters:
- The tree can be inspected, serialized to JSON, manipulated, and
  asserted against in tests independently of the renderer.
- The renderer can change implementation entirely (different border
  style, different ANSI strategy, a future SVG backend) without
  touching the API.
- Tests come in two layers — tree-shape tests and rendered-output
  tests — and each layer covers a real failure mode.

## Data model

Every node has the same shape, no exceptions:

```ts
type LayoutNode = {
  type: NodeType;
  attrs: Record<string, unknown>;
  children: LayoutNode[];
};

type NodeType =
  | "box"
  | "row"
  | "column"
  | "text"
  | "raw"
  | "space"
  | "hline"
  | "vline";
```

- **Leaves** (`text`, `raw`, `space`, `hline`, `vline`) have
  `children: []`.
- **Containers** (`box`, `row`, `column`) carry their content in
  `children`. `box`'s children, if more than one, are implicitly
  wrapped in a `column` (matches the natural reading of "stack of
  things inside a border").

Uniform shape lets the renderer dispatch table key by `type` and the
tree-walking utilities stay generic.

### Node attrs reference

| Node     | Required attrs          | Optional attrs                                                                                                            |
| -------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `text`   | `content: string`       | `fgColor`, `bgColor`, `bold`, `italic`, `dim`, `underline`, `align`                                                       |
| `raw`    | `content: string`       | `align`                                                                                                                   |
| `space`  | `count: number`         | —                                                                                                                         |
| `hline`  | `char: string`          | `length: number`, `fgColor`, `bold`, `dim`                                                                                |
| `vline`  | `char: string`          | `length: number`, `fgColor`, `bold`, `dim`                                                                                |
| `row`    | —                       | `gap: number`, `align: "start" \| "center" \| "end"`                                                                      |
| `column` | —                       | `gap: number`, `align: "start" \| "center" \| "end"`                                                                      |
| `box`    | —                       | `title`, `titleColor`, `borderStyle: "rounded" \| "heavy" \| "double" \| "light"`, `borderColor`, `padding: number`       |

`align` on a container governs how short children sit in the
cross-axis: in a `row`, short children's vertical position; in a
`column`, narrow children's horizontal position.

## Render primitive: `Block`

The entire renderer is built on one primitive: a `Block`, an
immutable 2D rectangle of styled text. Render handlers compose
Blocks using a small set of operators; they never touch indices or
build strings directly.

```ts
class Block {
  readonly lines: readonly string[];

  static empty(): Block;
  static of(content: string | string[]): Block;

  get height(): number;
  get width(): number;   // ANSI-stripped visual width

  toString(): string;
}
```

Free operators (top-level functions in `layout.ts`):

```ts
function beside(left: Block, right: Block): Block;
function above(top: Block, bottom: Block): Block;
function pad(block: Block, w: number, h: number,
             hAlign?: Align, vAlign?: Align): Block;
function styled(block: Block, style: Style): Block;
function bordered(block: Block, opts: BorderOpts): Block;
```

- `beside` and `above` auto-pad the shorter dimension to match.
- `pad` is the single place padding math lives.
- `styled` wraps every line of the block in an SGR sequence + RESET,
  so multi-line styled blocks remain correctly styled across line
  boundaries.
- `bordered` draws a frame in the chosen style, optionally embedding
  a title into the top edge.

Internal helpers (not exported):

```ts
function visualWidth(s: string): number;  // ANSI-stripped length
function sgr(style: Style): string;        // empty string if no style
function padLine(line: string, w: number, align: Align): string;
```

`visualWidth` is the single point of ANSI awareness. Every place that
needs a width consults it. The renderer never calls `.length` on a
styled string.

## Render dispatch

```ts
const HANDLERS: Record<NodeType, (node: LayoutNode) => Block> = {
  text:   (n) => styled(Block.of(n.attrs.content as string),
                        styleOf(n.attrs)),
  raw:    (n) => Block.of(n.attrs.content as string),
  space:  (n) => Block.of(Array(n.attrs.count as number).fill("")),
  hline:  (n) => styled(Block.of((n.attrs.char as string)
                                  .repeat(n.attrs.length as number)),
                        styleOf(n.attrs)),
  vline:  (n) => styled(Block.of(Array(n.attrs.length as number)
                                  .fill(n.attrs.char as string)),
                        styleOf(n.attrs)),
  row:    (n) => composeRow(n),
  column: (n) => composeColumn(n),
  box:    (n) => bordered(render(asColumn(n.children)), n.attrs),
};

export function render(node: LayoutNode): string {
  return HANDLERS[node.type](node).toString();
}
```

`composeRow`, `composeColumn`, and `composeBox` are the only handlers
that need more than one line. They are still declarative: a map over
children followed by a reduce with `beside` / `above`.

## Stretchy line resolution

A `vline` inside a `row` should match the row's height; an `hline`
inside a `column` should span the column's width. Hard-coding this
inside the leaf handler would couple leaves to parent context.

The clean resolution: `row` / `column` runs a single preprocess pass
over its children that fills in `length` on any stretchy line child
using the measured cross-axis size of its non-stretchy siblings.

```ts
function composeRow(node: LayoutNode): Block {
  const resolved = resolveStretchyChildren(node.children, "row");
  const blocks = resolved.map(render).map(Block.of);
  return blocks.reduce(beside, Block.empty());
}
```

A child is "stretchy" if its `type` is `vline` (in a row) or `hline`
(in a column) and its `length` attr is unset.

Edge cases:
- Row of only stretchy children → length defaults to 1.
- A stretchy line whose siblings are all empty → height 0; the line
  renders as nothing. This is the right behavior: a separator
  between two empty things has no length.

## Public API

### Top-level container functions

```agency
def box(title, titleColor, borderStyle, borderColor, padding, block): LayoutNode
def row(gap, align, block): LayoutNode
def column(gap, align, block): LayoutNode
safe def render(node): string
```

All container functions accept a trailing block via the standard
Agency `as name { ... }` syntax. The block populates the container's
children. Calling a container with no block produces a container
with `children: []`.

### Builder methods

The block receives a `LayoutBuilder`, a record of methods that append
children to the parent container's `children` array. The builder is
modeled directly on `stdlib/ui.agency`'s `Builder`:

```agency
type LayoutBuilder = {
  text:   (content, fgColor, bgColor, bold, italic, dim, underline, align) => LayoutNode;
  add:    (content, align) => LayoutNode;
  space:  (count) => LayoutNode;
  hline:  (char, length, fgColor, bold, dim) => LayoutNode;
  vline:  (char, length, fgColor, bold, dim) => LayoutNode;
  row:    (gap, align, block) => LayoutNode;
  column: (gap, align, block) => LayoutNode;
  box:    (title, titleColor, borderStyle, borderColor, padding, block) => LayoutNode;
}
```

Every method:
1. Constructs a `LayoutNode` from its arguments.
2. Pushes it onto the parent's `children` array.
3. Returns the same `LayoutNode` (so the caller can capture it if
   needed; matches `stdlib/ui.agency`).

The builder is the entire data-construction surface. It does no
rendering, no measurement, no string manipulation.

### Example: the agent splash

```agency
const splash = box(title: "Agency v0.3.0",
                   titleColor: "orange",
                   padding: 1) as outer {
  outer.row(gap: 2) as r {
    r.column(padding: 1) as left {
      left.text("Welcome, ${user}!", bold: true, align: "center")
      left.space(1)
      left.add(figure)
    }
    r.vline()
    r.column(padding: 1) as right {
      right.text("Getting started", fgColor: "orange", bold: true)
      right.text("Tell me what you'd like to build.")
      right.text("/help · /clear · /exit", dim: true)
    }
  }
}

print(render(splash))
```

The `splash` value is a `LayoutNode` tree. `render` consumes it.

## Border styles and title embedding

| Style    | TL | TR | BL | BR | H | V |
| -------- | -- | -- | -- | -- | - | - |
| rounded  | ╭ | ╮ | ╰ | ╯ | ─ | │ |
| heavy    | ┏ | ┓ | ┗ | ┛ | ━ | ┃ |
| double   | ╔ | ╗ | ╚ | ╝ | ═ | ║ |
| light    | ┌ | ┐ | └ | ┘ | ─ | │ |

All border characters come from a single table keyed by
`borderStyle`. No handler inlines a `╭` directly.

Title embedding pattern (Claude-Code style):

```
╭─ Title ──────────────────────╮
│                              │
```

- One `─` between the top-left corner and the title.
- Title is space-padded on both sides: `" Title "`.
- Remaining width filled with `─` until the top-right corner.
- Title is styled with `titleColor`; the border characters with
  `borderColor`. Each segment is `styled()`'d independently and
  concatenated.

If the title is wider than the box's natural content width, the box
grows to fit the title. (No truncation.)

## ANSI / styling

- Style attrs accepted on every node where it makes sense.
- Color values: named (`"red"`, `"orange"`, `"#cc7a4a"`) or hex.
  Named-color resolution uses a small internal table; hex is parsed
  to RGB and emitted as a 24-bit SGR sequence.
- The orange that matches Claude Code's banner is `#cc7a4a` (or
  named `"orange"` once we map it). Defined in one place.

Conversion happens once, at `styled()` time. Builders never carry
SGR strings; they carry the attrs that produce them.

## Anti-patterns to avoid

Drawing from `docs/dev/anti-patterns.md` and the lessons of this
design:

1. **Imperative loops in render handlers.** Handlers compose Block
   operations. No `for` loops walking indices and pushing strings.
   If you need a loop, it belongs inside a `Block` operator (where
   it is encapsulated once), not in the dispatch table.

2. **Builder methods that render.** The builder produces data, full
   stop. A method that calls `visualWidth` or constructs an SGR
   sequence has crossed the layer boundary and must be moved.

3. **Leaking ANSI into width math.** Never call `.length` on a
   styled string. Always go through `visualWidth`. There is exactly
   one place in the codebase that strips ANSI; everything else
   delegates.

4. **Special-casing "border: false".** Don't add a flag to disable
   the box's border. Use `row` or `column` instead. Containers
   without borders are different node types, not a `box` with a
   disabled attr.

5. **Builder state outside the children array.** All state for a
   container lives in its `children`. No side channels on the
   builder object. Reordering a container's children must reorder
   its output 1:1.

6. **Stretchy logic in leaf handlers.** `vline` does not know its
   parent's height. `row` resolves it before rendering. Pushing
   resolution down to leaves couples them to context they shouldn't
   see.

7. **Order-dependent attr derivations.** Each derived value comes
   from `attrs` (and, where applicable, from a parent's measured
   dimensions passed in explicitly), not from a mutable intermediate.
   Reading any handler in isolation should be enough to predict its
   output.

8. **Inlining border characters.** All `╭ ╮ ╰ ╯ ─ │ ┏ ┓ ┗ ┛ ━ ┃` etc.
   come from the `BORDER_CHARS` table keyed by `borderStyle`. A
   stray `╭` in a handler is a bug.

9. **Mixing types and behavior in the data tree.** The `LayoutNode`
   shape never grows methods or instance behavior. Operations live
   on the renderer or on `Block`. Data is data.

10. **Conditional special cases at top of render.** No
    `if (children.length === 0) return Block.empty()` at the top of
    every handler. The Block operators already handle empty children
    correctly; let them. (Per "useless special cases" in the
    anti-patterns doc.)

## Implementation phasing

Suggested order; each phase is independently testable.

1. `Block` primitive + free operators (`beside`, `above`, `pad`,
   `styled`) + `visualWidth` + `sgr`. No node types yet.
2. `bordered` (without title).
3. `bordered` (with title embedded in top edge).
4. Render handlers for leaves: `text`, `raw`, `space`, `hline`,
   `vline`.
5. Render handlers for `row` and `column` (without stretchy
   resolution).
6. Stretchy line resolution pass.
7. Render handler for `box`.
8. Agency wrappers in `stdlib/layout.agency`: top-level containers
   + builder methods.
9. Smoke test: a small `.agency` script that renders a fixture
   layout and prints it.
10. Replace agent splash in `lib/agents/agency-agent/agent.agency`.

## Test plan

Two layers, matching the architecture:

**Tree-shape tests (`tests/typescriptGenerator/...` or new
`tests/agency-js/`):**
- Each builder call produces the expected `LayoutNode` shape.
- Nested builders produce the expected child arrays.
- Attrs are forwarded correctly from builder method signature to
  node `attrs`.

**Render tests (Vitest unit, in `lib/stdlib/layout.test.ts`):**
- `Block` operators (`beside`, `above`, `pad`, `styled`,
  `bordered`) given fixed inputs produce expected outputs.
- Each render handler given a small fixture `LayoutNode` produces
  the expected string. Use snapshot or inline string fixtures.
- ANSI-aware width: styled content composes at the right
  visual width.

**Integration test:**
- Full banner tree → expected string (golden file under
  `tests/fixtures/layout/banner.txt`).

**Edge cases to cover explicitly:**
- Empty children in every container type.
- Multi-line text inside a row (row height grows).
- Multi-line text in column (column width grows to widest line).
- `vline` inside nested rows (stretchy resolution walks correctly).
- Box title wider than natural content width.
- Two stretchy children in a single row (both default to length 1).
- Styled content with mixed fg/bg in row composition.

## Open questions (proposals, awaiting plan review)

**Cascade of styles?** Should `column(fgColor: "red") { text("hi") }`
make "hi" red?
*Proposal: no cascade.* Each node carries its own style. Avoids the
React-context-style implicit-dependency problem and keeps the data
tree fully self-describing.

**`space` orientation?** Single primitive `space(n)` whose meaning
depends on the parent container, or separate `hspace(n)` and
`vspace(n)`?
*Proposal: single `space(n)`*, oriented by parent. Inside a row, it
inserts n columns of padding; inside a column, n rows. Matches CSS
flex `gap` intuition.

**Where do width / height hints live?** Add `width`, `minWidth`,
`maxWidth` attrs to every node now, or wait until needed?
*Proposal: wait.* Adding them prematurely (per "Don't add features
beyond what the task requires") risks shaping the API around
hypothetical use. Add when a real use case arrives.

**Color name table location?** Define it in `layout.ts`, or share
with `markdown.ts`'s renderer / `syntax.ts`?
*Proposal: define in `layout.ts` for now.* If a second module wants
it, lift to `utils/`. Don't pre-extract.
