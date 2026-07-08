# `raw` Wrapping + SGR-aware Wrap + Shrink-to-fit Ceiling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `std::ui/layout`'s `raw` reflow to its container by default (with a `wrap: false` escape hatch), make wrapping preserve embedded ANSI cleanly (no style bleed into borders/padding), and make width-less containers shrink-to-fit-but-cap at the available width so content wraps instead of overflowing.

**Architecture:** Three coordinated layers in `lib/stdlib/layout/` (TS render side) plus `stdlib/ui/layout.agency` (Agency data-construction side): (1) an SGR-aware `wrapText` that makes each emitted visual line self-contained; (2) an `availableWidth` ceiling threaded through the sizing context so content-driven leaves wrap at the terminal/parent width; (3) a `wrap` attribute on `raw` that reuses the same wrap/size machinery as `text` minus styling.

**Tech Stack:** TypeScript (runtime/render), Agency (stdlib source), vitest (TS unit tests), Agency test framework (`tests/agency/layout/*.agency` + `.test.json`).

**Design doc:** `docs/superpowers/specs/2026-07-07-raw-wrapping-design.md`

## Global Constraints

- **No dynamic imports** anywhere (repo rule).
- Use **objects not maps**, **arrays not sets**, **types not interfaces** (repo rule).
- After editing `stdlib/ui/layout.agency`, run **`make`** before running any Agency test (a plain `pnpm run build` does not rebuild the stdlib the CLI/tests load). Pure `lib/stdlib/layout/*.ts` changes are exercised by vitest directly and do **not** need `make`.
- **`make fixtures` does NOT regenerate `tests/agency/layout/*.test.json`** — it only rewrites `tests/typescriptGenerator/` fixtures (`scripts/regenerate-fixtures.ts`, `fixturesDir = tests/typescriptGenerator`). Agency-layout fixtures are hand-edited from captured actual output.
- The repo owner **reviews before committing**; treat each "Commit" step as "stage + request approval to commit" unless told otherwise.
- v1 SGR state model is **sequence-accumulation**: `\x1b[0m` / `\x1b[m` clears the active run; any other `…m` SGR sequence accumulates. Partial attribute-off codes (`22`/`23`/`24`/`39`/`49`) and compound resets (`\x1b[0;31m`) are documented non-goals.
- **`row` caps its children at the row's available width** (spec §3) — children stay shrink-to-fit (no `defaultWidth`) but get a wrap ceiling so a lone wide child wraps instead of overflowing. Horizontal width *distribution* among multiple row children is a non-goal.
- **A leaf never gets `wrapWidth ≤ 0`** — when chrome ≥ available width the leaf degrades to overflow (visible), never to empty (`width <= 0` makes `wrapText` return `[]`).

---

## File Structure

- `lib/stdlib/layout/ansi.ts` — add SGR state tracking + `reinjectSgr`; `wrapText` returns self-contained lines. (Task 1)
- `lib/stdlib/layout/sizing.ts` — add optional `availableWidth` to `SizingContext`. (Task 2)
- `lib/stdlib/layout/render.ts` — seed root `availableWidth` from the viewport. (Task 2)
- `lib/stdlib/layout/box.ts` — pass child `availableWidth` (inner space). (Task 2)
- `lib/stdlib/layout/axis.ts` — column and row pass a ceiling to children. (Task 2)
- `lib/stdlib/layout/nodes.ts` — `wrapWidthFor` helper (ceiling + `≤0` guard); `sizeText`/`sizeRaw`; shared wrapped-block render helper. (Task 2 + Task 3)
- `stdlib/ui/layout.agency` — `raw` gains `wrap`; `_addRaw`; docstrings + module doc. (Task 3)
- `lib/stdlib/layout.test.ts` — TS unit tests for all of the above.
- `tests/agency/layout/builders.test.json` — reconcile `raw` attrs fixture. (Task 3)
- `tests/agency/layout/raw-wrap.agency` + `.test.json` — end-to-end integration. (Task 4)

---

## Task 1: SGR-aware `wrapText`

Make each emitted visual line re-open the SGR state active at its start and close with `RESET` when a style is still open — so styling never bleeds across line boundaries (including literal `\n` boundaries, since the pass runs over the flattened segment list). `wrapSingleLine` and `breakLongToken` are unchanged; the fix is a post-pass over their output.

**Files:**
- Modify: `lib/stdlib/layout/ansi.ts` (the `wrapText` function ~line 19; add two helpers above it; `CSI` already exists at line 151)
- Test: `lib/stdlib/layout.test.ts` (the `describe("wrapText", …)` block ~line 59)

**Interfaces:**
- Consumes: `RESET` (`ansi.ts:153`), `CSI` (`ansi.ts:151`), existing `wrapSingleLine`, `breakLongToken`.
- Produces: `wrapText(content: string, width: number): string[]` — same signature, now emits self-contained ANSI lines. Consumed by Task 2/3 leaf renderers.

- [ ] **Step 1: Update the one changed ANSI test + add the SGR-behavior tests**

In `lib/stdlib/layout.test.ts`, **replace** the existing test at ~line 87 (`"breaks a long colored word …"`) — its expected output changes because each broken piece now self-closes — and **add** the tests below it. The word-boundary ANSI test at ~line 82 (`"keeps ANSI sequences attached …"`) stays as-is (its reset already falls inside the first segment, so its output is unchanged).

```ts
  test("breaks a long colored word at the column boundary, self-closing each line", () => {
    expect(_internal.wrapText("\x1b[31mabcdefghij\x1b[0m", 4)).toEqual([
      "\x1b[31mabcd\x1b[0m",
      "\x1b[31mefgh\x1b[0m",
      "\x1b[31mij\x1b[0m",
    ]);
  });

  test("reopens the active style on each wrapped line and resets at its end", () => {
    expect(_internal.wrapText("\x1b[2mAAAA BBBB CCCC\x1b[0m", 9)).toEqual([
      "\x1b[2mAAAA BBBB\x1b[0m",
      "\x1b[2mCCCC\x1b[0m",
    ]);
  });

  test("accumulates stacked codes and reopens ALL of them on continuation lines", () => {
    // No reset in the input: both fg (31) and bold (1) stay active and must
    // both be reopened on every continuation line. Kills a keep-last-code bug.
    expect(_internal.wrapText("\x1b[31m\x1b[1mred bold text here", 8)).toEqual([
      "\x1b[31m\x1b[1mred bold\x1b[0m",
      "\x1b[31m\x1b[1mtext\x1b[0m",
      "\x1b[31m\x1b[1mhere\x1b[0m",
    ]);
  });

  test("a full reset (\\x1b[0m and \\x1b[m) clears the carried style", () => {
    expect(_internal.wrapText("\x1b[31mred one\x1b[0m two three", 7)).toEqual([
      "\x1b[31mred one\x1b[0m",
      "two",
      "three",
    ]);
    // Empty-params reset `\x1b[m` also clears.
    expect(_internal.wrapText("\x1b[31mfoo\x1b[m bar", 3)).toEqual([
      "\x1b[31mfoo\x1b[m",
      "bar",
    ]);
  });

  test("carries style across a literal newline boundary too", () => {
    // Style opened on one source line, reset two lines later: each emitted
    // visual line is still self-contained. Guards the flatten-then-reinject
    // ordering against a per-source-line refactor.
    expect(_internal.wrapText("\x1b[31mfoo\nbar\x1b[0m", 10)).toEqual([
      "\x1b[31mfoo\x1b[0m",
      "\x1b[31mbar\x1b[0m",
    ]);
  });

  test("non-SGR CSI (cursor/erase) passes through inline and is never reopened", () => {
    // \x1b[2K is a CSI but not an SGR (ends in K). It must not enter the
    // active-style state or be replayed on later lines.
    expect(_internal.wrapText("\x1b[2Kfoo bar", 3)).toEqual([
      "\x1b[2Kfoo",
      "bar",
    ]);
  });

  test("plain text and empty strings are unaffected by SGR handling", () => {
    expect(_internal.wrapText("hello world", 5)).toEqual(["hello", "world"]);
    expect(_internal.wrapText("hello  ", 10)).toEqual(["hello  "]);
    expect(_internal.wrapText("", 5)).toEqual([""]);
    expect(_internal.wrapText("hello", 0)).toEqual([]);
  });
```

- [ ] **Step 2: Run the tests — verify the new/updated ones fail**

Run: `pnpm exec vitest run lib/stdlib/layout.test.ts -t wrapText`
Expected: FAIL — the long-colored-word test and the new SGR tests fail; the plain-text test passes.

- [ ] **Step 3: Implement SGR-aware `wrapText`**

In `lib/stdlib/layout/ansi.ts`, add these helpers immediately above `export function wrapText` (~line 19), then change `wrapText`. Leave `wrapSingleLine` and `breakLongToken` untouched.

```ts
// Matches SGR sequences only (CSI … `m`), not other CSI like cursor/erase.
const SGR_RE = /\x1b\[[\d;]*m/g;

// Track the SGR run active since the last full reset. `\x1b[0m` / `\x1b[m`
// clears it; any other SGR sequence accumulates. (v1: partial attribute-off
// codes and compound resets like `\x1b[0;31m` are treated as accumulating —
// see the layout design doc.)
function updateActiveSgr(active: string, segment: string): string {
  let result = active;
  for (const match of segment.matchAll(SGR_RE)) {
    const params = match[0].slice(CSI.length, -1);
    result = params === "" || params === "0" ? "" : result + match[0];
  }
  return result;
}

// Make each wrapped segment self-contained: re-open the SGR state active at
// its start and close with RESET when anything is still open at its end.
// Each output is derived purely from its inputs so the order of statements
// can't silently break it.
function reinjectSgr(segments: string[]): string[] {
  let active = "";
  return segments.map((segment) => {
    if (segment === "") return "";
    const opened = active;
    const closed = updateActiveSgr(opened, segment);
    active = closed;
    return opened + segment + (closed === "" ? "" : RESET);
  });
}
```

Change `wrapText`:

```ts
export function wrapText(content: string, width: number): string[] {
  if (width <= 0) return [];
  const segments = content.split("\n").flatMap((line) => wrapSingleLine(line, width));
  return reinjectSgr(segments);
}
```

- [ ] **Step 4: Run the tests — verify they pass**

Run: `pnpm exec vitest run lib/stdlib/layout.test.ts -t wrapText`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/stdlib/layout/ansi.ts lib/stdlib/layout.test.ts
git commit -m "feat(layout): SGR-aware wrapText so wrapped lines are self-contained"
```

---

## Task 2: `availableWidth` shrink-to-fit ceiling

Thread an available-width ceiling through the sizing context so a content-driven leaf (no imposed width) wraps at that ceiling instead of overflowing. Short content still passes through `wrapText` unchanged, preserving shrink-to-fit. A leaf never receives `wrapWidth ≤ 0`.

**Files:**
- Modify: `lib/stdlib/layout/sizing.ts:13-20` (`SizingContext`)
- Modify: `lib/stdlib/layout/render.ts:108` (`resolveSizes` root context)
- Modify: `lib/stdlib/layout/box.ts:39-47` (`sizeBox`)
- Modify: `lib/stdlib/layout/axis.ts:147-161` (`sizeColumn`, `sizeRow`)
- Modify: `lib/stdlib/layout/nodes.ts:151-157` (add `wrapWidthFor`, rewrite `sizeText`)
- Test: `lib/stdlib/layout.test.ts` (the `describe("resolveSizes", …)` block)

**Interfaces:**
- Consumes: `wrapText` (Task 1), `resolveOwnWidth`, `innerWidthAfterChrome`, `nonNegativeInteger`, `BORDER_CELLS` (=2).
- Produces: `SizingContext` gains `availableWidth?: number`. New `wrapWidthFor(node, ctx): number | undefined` returns the imposed-or-ceiling wrap width, or `undefined` when unbounded **or `≤ 0`**. Consumed by Task 3's `sizeRaw`.

- [ ] **Step 1: Write/adjust failing sizing tests**

Add these to `describe("resolveSizes", …)` in `lib/stdlib/layout.test.ts`:

```ts
  test("unsized box wraps content at the available width (shrink-to-fit ceiling)", () => {
    // ceiling = viewport 40 − box chrome (2 border, 0 padding) = 38.
    const tree = node("box", { padding: 0 }, [node("text", { content: "x" })]);
    const resolved = _internal.resolveSizes(tree, { cols: 40, rows: 24 });
    expect(resolved.children[0].attrs.wrapWidth).toBe(38);
  });

  test("unsized box ceiling subtracts padding on both sides", () => {
    // chrome = 2 border + 2*2 padding = 6; ceiling = 40 − 6 = 34.
    const tree = node("box", { padding: 2 }, [node("text", { content: "x" })]);
    const resolved = _internal.resolveSizes(tree, { cols: 40, rows: 24 });
    expect(resolved.children[0].attrs.wrapWidth).toBe(34);
  });

  test("nested unsized boxes subtract chrome at each level", () => {
    const tree = node("box", { padding: 0 }, [
      node("box", { padding: 0 }, [node("text", { content: "x" })]),
    ]);
    const resolved = _internal.resolveSizes(tree, { cols: 40, rows: 24 });
    // outer ceiling 40−2 = 38; inner ceiling 38−2 = 36.
    expect(resolved.children[0].children[0].attrs.wrapWidth).toBe(36);
  });

  test("unsized column wraps its children at the available width", () => {
    const tree = node("column", {}, [node("text", { content: "x" })]);
    const resolved = _internal.resolveSizes(tree, { cols: 30, rows: 24 });
    expect(resolved.children[0].attrs.wrapWidth).toBe(30);
  });

  test("never assigns wrapWidth ≤ 0 — content degrades to overflow, not to nothing", () => {
    // chrome 2 + 2*20 = 42 > viewport 30 → ceiling clamps to 0 → no wrapWidth.
    const tree = node("box", { padding: 20 }, [node("text", { content: "hello" })]);
    const resolved = _internal.resolveSizes(tree, { cols: 30, rows: 24 });
    expect(resolved.children[0].attrs.wrapWidth).toBeUndefined();
  });
```

**Replace** the existing test at `lib/stdlib/layout.test.ts:127` (`"row does not give full width to every unsized child"`) — under the new cap rule its children get a wrap ceiling (not `undefined`). Its intent (children are not *filled*) is preserved because `defaultWidth` stays `undefined`; only the wrap ceiling is added:

```ts
  test("row caps unsized children at its width but does not fill them", () => {
    const tree = node("row", { width: 20 }, [
      node("text", { content: "first child is long" }),
      node("text", { content: "second child is long" }),
    ]);
    const resolved = _internal.resolveSizes(tree, { cols: 80, rows: 24 });
    // Ceiling = row inner width (20, gap 0); children wrap at it but stay
    // content-driven (no defaultWidth → not stretched to fill).
    expect(resolved.children[0].attrs.wrapWidth).toBe(20);
    expect(resolved.children[1].attrs.wrapWidth).toBe(20);
  });
```

The existing sized tests at ~line 106 (box 30 → 28), ~line 187 (column 30 child → 30), and the `padding 1.9`/`gap -5` test at ~line 137 must still pass (they exercise the `own`-defined path, unchanged).

- [ ] **Step 2: Run — verify the new/updated tests fail**

Run: `pnpm exec vitest run lib/stdlib/layout.test.ts -t resolveSizes`
Expected: FAIL — the ceiling tests fail (`wrapWidth` currently `undefined`); the row cap test fails (currently `undefined`).

- [ ] **Step 3a: Add `availableWidth` to `SizingContext`**

In `lib/stdlib/layout/sizing.ts`, extend the type (optional, so table/barchart contexts — which impose explicit cell widths — need no change):

```ts
export type SizingContext = {
  // The width an unsized node should adopt (fill). Undefined when the parent
  // does not impose a width on its children.
  defaultWidth: number | undefined;
  // The width that percentages and "full" compute against.
  percentBasis: number | undefined;
  // The max width content may occupy before it must wrap. A content-driven
  // leaf with no imposed width wraps at this ceiling instead of overflowing.
  // Optional: table cell contexts impose explicit widths and omit it.
  availableWidth?: number | undefined;
};
```

- [ ] **Step 3b: Seed the ceiling at the root**

In `lib/stdlib/layout/render.ts`, `resolveSizes` (~line 108):

```ts
  return resolveNode(node, {
    defaultWidth: undefined,
    percentBasis: viewport.cols,
    availableWidth: viewport.cols,
  });
```

- [ ] **Step 3c: Pass the ceiling from `box`**

In `lib/stdlib/layout/box.ts`, `sizeBox`. `available` collapses to a single `innerWidthAfterChrome` call (`own ?? ctx.availableWidth` is `inner`'s input either way):

```ts
function sizeBox(node: LayoutNode, ctx: SizingContext): LayoutNode {
  const own = resolveOwnWidth(node, ctx);
  const padding = nonNegativeInteger(node.attrs.padding);
  const chrome = BORDER_CELLS + 2 * padding;
  const inner = innerWidthAfterChrome(own, chrome);
  const available = innerWidthAfterChrome(own ?? ctx.availableWidth, chrome);
  return resolveContainer(node, own, {
    defaultWidth: inner,
    percentBasis: inner,
    availableWidth: available,
  });
}
```

- [ ] **Step 3d: Pass the ceiling from `column` and `row`**

In `lib/stdlib/layout/axis.ts`. Row keeps `defaultWidth: undefined` (children are not filled) but now passes a ceiling so a lone wide child wraps:

```ts
function sizeColumn(node: LayoutNode, ctx: SizingContext): LayoutNode {
  const own = resolveOwnWidth(node, ctx);
  return resolveContainer(node, own, {
    defaultWidth: own,
    percentBasis: own,
    availableWidth: own ?? ctx.availableWidth,
  });
}

function sizeRow(node: LayoutNode, ctx: SizingContext): LayoutNode {
  const own = resolveOwnWidth(node, ctx);
  const gap = nonNegativeInteger(node.attrs.gap);
  const gapTotal = Math.max(0, node.children.length - 1) * gap;
  const inner = innerWidthAfterChrome(own, gapTotal);
  // Children stay content-driven (no defaultWidth → not filled), but are
  // capped at the row's available width so a lone wide child wraps.
  // Horizontal distribution among multiple children is a non-goal.
  return resolveContainer(node, own, {
    defaultWidth: undefined,
    percentBasis: inner,
    availableWidth: inner ?? ctx.availableWidth,
  });
}
```

- [ ] **Step 3e: Add `wrapWidthFor` and rewrite `sizeText`**

In `lib/stdlib/layout/nodes.ts`, add the shared helper and use it (this is where the `≤ 0` guard lives — a single home shared with `sizeRaw` in Task 3):

```ts
// The wrap width a leaf should use: its imposed width if any, else the
// available ceiling. Returns undefined when unbounded OR when the width is
// ≤ 0 (chrome ≥ available), so the leaf degrades to overflow — never to
// empty (wrapText returns [] for width ≤ 0).
function wrapWidthFor(node: LayoutNode, ctx: SizingContext): number | undefined {
  const own = resolveOwnWidth(node, ctx);
  const width = own ?? ctx.availableWidth;
  return width !== undefined && width > 0 ? width : undefined;
}

function sizeText(node: LayoutNode, ctx: SizingContext): LayoutNode {
  const width = wrapWidthFor(node, ctx);
  if (width === undefined) return node;
  return setAttr(node, "wrapWidth", width);
}
```

- [ ] **Step 4: Run the resolveSizes tests — verify they pass**

Run: `pnpm exec vitest run lib/stdlib/layout.test.ts -t resolveSizes`
Expected: PASS — new ceiling + row-cap + `≤0` guard tests green; existing sized-path tests still green.

- [ ] **Step 5: Run the whole layout unit suite — no regressions**

Run: `pnpm exec vitest run lib/stdlib/layout.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/stdlib/layout/sizing.ts lib/stdlib/layout/render.ts lib/stdlib/layout/box.ts lib/stdlib/layout/axis.ts lib/stdlib/layout/nodes.ts lib/stdlib/layout.test.ts
git commit -m "feat(layout): shrink-to-fit availableWidth ceiling with zero-width guard"
```

---

## Task 3: `raw` gains `wrap` (Agency API + TS handler)

Add a `wrap` parameter to `raw` (default `true`, appended last so positional `raw(content, align)` callers keep working), wire its sizing to `wrapWidthFor` (respecting `wrap: false`), and render `raw` like `text` but with no styling.

**Files:**
- Modify: `lib/stdlib/layout/nodes.ts` (`LEAF_RENDERERS.text` + `.raw` ~line 108-120; add `wrappedBlock`; add `sizeRaw`; `raw` handler ~line 164)
- Modify: `stdlib/ui/layout.agency` (`raw` ~line 103-118, `_addRaw` ~line 224-232, module doc ~line 20)
- Modify: `tests/agency/layout/builders.test.json:18` (raw attrs now include `wrap`)
- Test: `lib/stdlib/layout.test.ts`

**Interfaces:**
- Consumes: `wrapWidthFor` (Task 2), SGR-aware `wrapText` (Task 1), `Block`, `pad`, `styled`, `styleOf`, `setAttr`.
- Produces: `raw` node carries `attrs.wrap: boolean`; `raw.size` sets `wrapWidth` via `wrapWidthFor` unless `wrap === false`; `raw.render` wraps-or-splits without styling. Agency `raw(content, align = "start", wrap = true)`.

- [ ] **Step 1: Write failing TS tests for raw sizing + render + align + no-bleed**

Add a `describe("raw", …)` block to `lib/stdlib/layout.test.ts`:

```ts
describe("raw", () => {
  test("wraps by default (gets a wrapWidth) but not when wrap:false", () => {
    const wrapped = _internal.resolveSizes(
      node("box", { width: 30 }, [node("raw", { content: "x", wrap: true })]),
      { cols: 80, rows: 24 },
    );
    expect(wrapped.children[0].attrs.wrapWidth).toBe(28);

    const preserved = _internal.resolveSizes(
      node("box", { width: 30 }, [node("raw", { content: "x", wrap: false })]),
      { cols: 80, rows: 24 },
    );
    expect(preserved.children[0].attrs.wrapWidth).toBeUndefined();
  });

  test("raw wraps content to the box exactly like text, adding no styling", () => {
    const out = render(
      node("box", { width: 12, padding: 1 }, [
        node("raw", { content: "the quick brown fox" }),
      ]),
      { cols: 80, rows: 24 },
    );
    expect(out).toBe(
      [
        "╭──────────╮",
        "│          │",
        "│ the      │",
        "│ quick    │",
        "│ brown    │",
        "│ fox      │",
        "│          │",
        "╰──────────╯",
      ].join("\n"),
    );
  });

  test("wrapped colored content survives AND never leaves an open SGR at a line boundary", () => {
    const colored = "\x1b[31malpha beta gamma delta epsilon\x1b[0m";
    const out = _render(
      node("box", { width: 16, padding: 1 }, [node("raw", { content: colored })]),
      true, 80, 24,
    );
    // Colors survive (kills a "strip all ANSI" render bug).
    expect(out).toContain("\x1b[31m");
    // No style bleeds past a line boundary → borders/padding stay uncolored.
    // Independent re-implementation of the scan on purpose: a bug shared with
    // updateActiveSgr would otherwise mask itself in this oracle.
    const openAtEnd = (line: string): string => {
      let active = "";
      for (const match of line.matchAll(/\x1b\[[\d;]*m/g)) {
        const params = match[0].slice(2, -1);
        active = params === "" || params === "0" ? "" : active + match[0];
      }
      return active;
    };
    for (const line of out.split("\n")) expect(openAtEnd(line)).toBe("");
  });

  test("raw and text right-align short wrapped lines when align:end", () => {
    const out = render(
      node("box", { width: 10, padding: 0 }, [
        node("raw", { content: "a\nbbbb", align: "end" }),
      ]),
      { cols: 80, rows: 24 },
    );
    // "a" is padded on the LEFT to line up under "bbbb" (right alignment).
    expect(out).toContain("   a");
  });
});
```

- [ ] **Step 2: Run — verify they fail**

Run: `pnpm exec vitest run lib/stdlib/layout.test.ts -t raw`
Expected: FAIL — `raw` currently uses `passthrough` sizing and never wraps.

- [ ] **Step 3a: Add the shared wrapped-block helper + rewrite both leaf renderers**

In `lib/stdlib/layout/nodes.ts`, add the helper and use it in both leaves:

```ts
// Wrap (or split on newlines) then align-pad to a tidy rectangle. Shared by
// `text` and `raw`; `text` additionally wraps the result in `styled`.
function wrappedBlock(content: string, wrapWidth: number | undefined, align: Align): Block {
  const lines = wrapWidth !== undefined ? wrapText(content, wrapWidth) : content.split("\n");
  const block = Block.of(lines);
  return pad(block, block.width, block.height, align, "start");
}
```

```ts
  text: (n) => {
    const content   = asString(n.attrs.content);
    const align     = (n.attrs.align as Align) ?? "start";
    const wrapWidth = n.attrs.wrapWidth as number | undefined;
    return styled(wrappedBlock(content, wrapWidth, align), styleOf(n.attrs));
  },
  raw: (n) => {
    const content   = asString(n.attrs.content);
    const align     = (n.attrs.align as Align) ?? "start";
    const wrapWidth = n.attrs.wrapWidth as number | undefined;
    // No `styled` wrapper: raw carries its own ANSI and must not have
    // styling re-applied over it.
    return wrappedBlock(content, wrapWidth, align);
  },
```

Then delete `alignedTextBlock` if now unused — confirm first: `grep -rn alignedTextBlock lib/stdlib/layout/` (including `layout.ts` `_internal` and the test file). If any non-test caller remains, keep it.

- [ ] **Step 3b: Add `sizeRaw` and update the `raw` handler**

In `lib/stdlib/layout/nodes.ts`, add `sizeRaw` next to `sizeText` (reusing `wrapWidthFor`), and change the `raw` handler export (~line 164):

```ts
function sizeRaw(node: LayoutNode, ctx: SizingContext): LayoutNode {
  // wrap:false preserves exact layout (ASCII art / pre-rendered tables):
  // no wrapWidth, so the renderer splits on newlines only.
  if (node.attrs.wrap === false) return node;
  const width = wrapWidthFor(node, ctx);
  if (width === undefined) return node;
  return setAttr(node, "wrapWidth", width);
}
```

```ts
export const raw: NodeHandler = { size: sizeRaw, render: LEAF_RENDERERS.raw };
```

- [ ] **Step 4: Run the raw TS tests — verify they pass**

Run: `pnpm exec vitest run lib/stdlib/layout.test.ts -t raw`
Expected: PASS.

- [ ] **Step 5: Add `wrap` to the Agency `raw` constructor + builder + docs**

In `stdlib/ui/layout.agency`, change `raw` (~line 103). `wrap` is appended **last** so positional `raw(content, "center")` keeps working:

```
/** A pre-styled string. Wraps to its container by default; pass `wrap: false`
to preserve exact layout. Wrapping is ANSI-aware, so embedded color survives
without bleeding into surrounding borders. */
export safe def raw(content: string, align: Alignment = "start", wrap: boolean = true): LayoutNode {
  """
  A pre-styled string (may carry its own ANSI or newlines). Wraps to the
  container width by default; pass wrap: false to render exactly as-is and
  never reflow (ASCII art, pre-rendered tables).

  @param content - Raw string content (may contain ANSI codes or newlines)
  @param align - For multi-line content, how shorter lines align to the longest
  @param wrap - Reflow to the container width (default true). false preserves the exact layout.
  """
  return {
    type: "raw",
    attrs: {
      content: content,
      align: align,
      wrap: wrap
    },
    children: []
  }
}
```

Update `_addRaw` (~line 224):

```
def _addRaw(
  kids: any[],
  content: string,
  align: Alignment = "start",
  wrap: boolean = true,
): LayoutNode {
  const n = raw(content: content, align: align, wrap: wrap)
  kids.push(n)
  return n
}
```

Update the module-doc line (~line 20) from:

```
  Containers (`box`, `row`, `column`) take a `width`: a number of columns,
  `"50%"` of the parent, or `"full"` for the whole terminal. Text wraps to
  fit; `raw` content never wraps.
```

to:

```
  Containers (`box`, `row`, `column`) take a `width`: a number of columns,
  `"50%"` of the parent, or `"full"` for the whole terminal. Content wraps to
  fit its container; pass `wrap: false` to `raw` to preserve exact layout
  (ASCII art, pre-rendered tables). Unsized containers shrink to fit their
  content but cap at the available width, wrapping anything longer.
```

- [ ] **Step 6: Reconcile the `raw` attrs fixture**

`tests/agency/layout/builders.test.json:18` asserts the exact `raw` node attrs. Update its `expectedOutput` to append `wrap` (matching the `content, align, wrap` attrs order):

```json
      "expectedOutput": "{\"type\":\"raw\",\"attrs\":{\"content\":\"\\u001b[31mpre-styled\\u001b[0m\",\"align\":\"start\",\"wrap\":true},\"children\":[]}",
```

- [ ] **Step 7: Rebuild the stdlib and run the builders fixture**

Run: `make`
Then: `pnpm run agency test tests/agency/layout/builders.agency 2>&1 | tee /tmp/builders.out`
Expected: PASS (the `raw` node now serializes with `"wrap":true`).

- [ ] **Step 8: Commit**

```bash
git add lib/stdlib/layout/nodes.ts stdlib/ui/layout.agency lib/stdlib/layout.test.ts tests/agency/layout/builders.test.json
git commit -m "feat(layout): raw gains wrap param, wraps to container by default"
```

---

## Task 4: End-to-end integration + regression guard

Prove the whole stack wires together from Agency source through render: `raw` wraps in a sized box, an unsized box caps + wraps at the viewport, colored content survives with clean borders, `wrap: false` forwards through the builder, and no existing layout fixture regressed.

**Files:**
- Create: `tests/agency/layout/raw-wrap.agency`
- Create: `tests/agency/layout/raw-wrap.test.json`

**Interfaces:**
- Consumes: `box`, `raw`, `render` from `std::ui/layout` (Task 3).

- [ ] **Step 1: Write the Agency integration test file**

Create `tests/agency/layout/raw-wrap.agency`:

```
import { box, raw, render } from "std::ui/layout"

// raw now wraps to the box exactly like text (default wrap: true).
node testRawWrapsInBox(): string {
  const panel = box(width: 12) as b {
    b.raw("the quick brown fox")
  }
  return render(panel, color: false)
}

// Unsized box caps + wraps long content at the pinned viewport (headline fix).
node testUnsizedBoxCapsAndWraps(): string {
  const panel = box() as b {
    b.text("the quick brown fox jumps over the lazy dog again")
  }
  return render(panel, color: false, cols: 16)
}

// Unsized box shrink-to-fits short content (does NOT blow up to full width).
node testUnsizedBoxShrinkToFit(): string {
  const panel = box() as b {
    b.text("hi")
  }
  return render(panel, color: false, cols: 40)
}

// wrap: false forwards through the builder and preserves the exact node.
node testRawWrapFalseNode(): LayoutNode {
  return raw("ascii-art-line", wrap: false)
}
```

- [ ] **Step 2: Capture actual output and author the fixture**

`make fixtures` does NOT regenerate these — author `raw-wrap.test.json` by capturing. First build and run each node to see its real output:

Run: `make && pnpm run agency run tests/agency/layout/raw-wrap.agency 2>&1 | tee /tmp/raw-wrap-capture.out`
(Or run each node individually if `run` executes only `main`; use a temporary `main` that prints each, or rely on Step 3's test runner output.)

`testRawWrapsInBox` is known exactly — Agency `box` defaults `padding: 1`, so a width-12 box has inner width 8, identical to the existing `testRenderWrap` fixture. Author the others from `/tmp/raw-wrap-capture.out`, verifying by eye that: the unsized-cap output is a box whose every line is ≤ 16 cols; the shrink-to-fit output is a small box (far narrower than 40); and the `wrap:false` node serializes with `"wrap":false`.

```json
{
  "tests": [
    {
      "nodeName": "testRawWrapsInBox",
      "input": "",
      "expectedOutput": "\"╭──────────╮\\n│          │\\n│ the      │\\n│ quick    │\\n│ brown    │\\n│ fox      │\\n│          │\\n╰──────────╯\"",
      "evaluationCriteria": [{ "type": "exact" }]
    },
    {
      "nodeName": "testUnsizedBoxCapsAndWraps",
      "input": "",
      "expectedOutput": "<PASTE captured string; verify every line ≤ 16 cols>",
      "evaluationCriteria": [{ "type": "exact" }]
    },
    {
      "nodeName": "testUnsizedBoxShrinkToFit",
      "input": "",
      "expectedOutput": "<PASTE captured string; verify it is a small box, not 40 wide>",
      "evaluationCriteria": [{ "type": "exact" }]
    },
    {
      "nodeName": "testRawWrapFalseNode",
      "input": "",
      "expectedOutput": "{\"type\":\"raw\",\"attrs\":{\"content\":\"ascii-art-line\",\"align\":\"start\",\"wrap\":false},\"children\":[]}",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

- [ ] **Step 3: Run the integration test**

Run: `pnpm run agency test tests/agency/layout/raw-wrap.agency 2>&1 | tee /tmp/raw-wrap.out`
Expected: PASS. If a render node fails, inspect `/tmp/raw-wrap.out`, confirm the actual output is correct wrapping (each line within the pinned `cols`), and correct the fixture string — do **not** change the code to match a wrong expectation.

- [ ] **Step 4: Regression-check every layout fixture**

Run each existing layout test and confirm none regressed from the ceiling/raw changes:

Run: `for f in tests/agency/layout/*.agency; do echo "== $f =="; pnpm run agency test "$f"; done 2>&1 | tee /tmp/layout-all.out`
Expected: all PASS. Any failure will be a fixture whose content is in an **unsized** container with a line longer than its viewport (now wrapped where it previously overflowed). For each: verify in `/tmp/layout-all.out` that the new output is correctly wrapped, then **hand-edit** that `.test.json`'s `expectedOutput` to the new string (`make fixtures` will NOT do this). Review with `git diff tests/agency/layout/` to confirm the change is only the expected wrapping.

- [ ] **Step 5: Commit**

```bash
git add tests/agency/layout/raw-wrap.agency tests/agency/layout/raw-wrap.test.json
# plus any hand-edited fixtures reconciled in Step 4
git commit -m "test(layout): end-to-end raw wrapping, ceiling, and fixture reconciliation"
```

---

## Self-Review

**Spec coverage:**

- Spec §1 (`raw` gains `wrap`, default true, no self-styling) → Task 3.
- Spec §2 (SGR-aware `wrapText`; self-contained at *every* boundary incl. `\n`; `breakLongToken` participates) → Task 1 (`reinjectSgr` over the flattened list; tests: long-colored-word, dim, stacked-codes, newline-carried, non-SGR-CSI, `\x1b[m`).
- Spec §3 (`availableWidth` ceiling: root, box, column, **row cap**) → Task 2 (Steps 3a–3d). Row cap is now implemented per spec (was reversed in the prior draft; corrected).
- Spec §4 (leaf sizing/render; `own ?? availableWidth`; `wrap:false`; shared helper) → Task 2 (`wrapWidthFor`, `sizeText`) + Task 3 (`wrappedBlock`, `sizeRaw`).
- Spec §5 examples → Task 3 render tests + Task 4 execution tests.
- Back-compat: only long-line-in-bounded/ceilinged content changes → Task 1 Step 1 (updates the one affected unit test), Task 2 Step 1 (replaces `:127`), Task 3 Step 6 (`builders.test.json`), Task 4 Step 4 (fixture sweep). The `wrapWidth ≤ 0` guard additionally fixes a pre-existing bug where a too-narrow sized box (`width: 3, padding: 1`) rendered its text as nothing — now it overflows visibly.
- Testing plan: every listed case has a concrete test — self-contained lines (T1), full-reset clears (T1), **stacked codes reopened (T1, real two-code input)**, plain unchanged (T1), raw wraps / `wrap:false` preserves (T3.1, T4), unsized shrink-to-fit + cap (T2 sizing + T4 execution), colored content clean borders **and survival** (T3.3), **align when wrapping (T3.4)**, nested ceiling (T2), zero-width guard (T2).
- Non-goals honored: Style-parser, row horizontal distribution, compound-reset handling, #453 — all left out with code comments where relevant.

**Placeholder scan:** the only intentional placeholders are the two Task 4 fixture strings that must be captured from real output (`make fixtures` can't generate them); every other step has concrete code and exact commands.

**Type consistency:** `SizingContext.availableWidth?: number | undefined` is read by `sizeBox`/`sizeColumn`/`sizeRow`/`wrapWidthFor` and written at root/box/column/row (table cell contexts deliberately omit it — the field is optional for exactly that reason). `wrapWidthFor(node, ctx): number | undefined` is the single source of the ceiling + `≤0` guard, used by both `sizeText` and `sizeRaw`. `wrappedBlock(content, wrapWidth, align)` matches both leaf call sites. `updateActiveSgr`/`reinjectSgr` are file-local to `ansi.ts`; the Task 3 `openAtEnd` test oracle re-implements the scan on purpose (commented). Agency `raw(content, align, wrap = true)` param order matches attrs order and the `builders.test.json` fixture.

---

**Note:** Per your instruction, nothing here has been committed — this plan document is written to disk only. The spec (`2026-07-07-raw-wrapping-design.md`) is being amended in parallel for the four items where the plan now intentionally goes beyond it: `availableWidth` optional, the every-boundary self-contained guarantee, the `raw(content, align, wrap)` signature, and the `wrapWidth ≤ 0` guard.
