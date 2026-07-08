# Design: `raw` wrapping, SGR-aware wrap, and shrink-to-fit width ceiling

**Date:** 2026-07-07
**Status:** Approved (design) — ready for implementation plan
**Module:** `std::ui/layout` (`stdlib/ui/layout.agency` + `lib/stdlib/layout/*`)

## Problem

Putting pre-colored, long-line content inside a `box` currently produces a
shredded box with no visible styling. The trigger case:

```
node main() {
  const res = diff(file1 catch "", file2 catch "", color: true)  // long lines + ANSI
  const panel = box(title: "Hello", padding: 1) as b {
    b.raw(res)
  }
  print(render(panel))
}
```

Three independent defects combine here:

1. **`raw` never wraps.** Its sizing handler is `passthrough` (`lib/stdlib/layout/nodes.ts:164`),
   so it never receives a `wrapWidth`; the ~280-column diff line is emitted intact.
2. **A width-less box does not bound its content.** `resolveSizes` seeds the root
   with `defaultWidth: undefined` (`render.ts:108`), so an unsized box stays
   content-driven and grows to the longest line. That line overflows the terminal,
   which then hard-wraps every row and scatters the borders.
3. **Wrapping is not SGR-aware.** Even when content *does* wrap (via `text`), the
   opening SGR lands on the first visual row and the `\x1b[0m` only on the last;
   the middle rows carry no codes, so inside a box the **borders and padding of the
   wrapped rows inherit the color/dim** (they render while the SGR is still open).

(A fourth, separate defect — `render`'s default `color: "auto"` stripping ANSI even
in an interactive terminal — is tracked in issue #453 and is **out of scope** here.)

This design fixes 1–3 so the naive snippet above "just works": `raw` wraps to the
box, the box bounds itself to the terminal, and the diff's colors render cleanly
without bleeding into the frame.

## Goals

- `raw` reflows to its container by default, while never applying styling of its
  own (embedded ANSI passes through untouched).
- An explicit escape hatch (`wrap: false`) preserves exact layout for ASCII art and
  pre-rendered tables.
- Width-less containers shrink to fit their content but **cap at the available
  width**, wrapping anything longer instead of overflowing.
- Wrapped ANSI content is styled per visual line, so container chrome
  (borders/padding) is never tinted.

## Non-goals

- **Full SGR parser.** v1 tracks styling by sequence-accumulation (below), which is
  correct for set-then-full-reset content (what `std::syntax` and typical
  highlighters emit). Handling partial attribute-off codes (`22`/`23`/`24`/`39`/`49`)
  and compound resets (`\x1b[0;31m`, which v1 accumulates rather than treating the
  leading `0` as a clear — replay stays visually correct but `activeSeq` grows on
  streaming input) without a full reset is a documented limitation and a follow-up.
- **Horizontal width distribution in `row`.** Splitting a horizontal budget among
  several side-by-side children is a real sizing problem left for a follow-up. v1
  only caps each row child at the row's available width so a lone wide child wraps
  instead of overflowing infinitely.
- **The `color: "auto"` TTY bug** (issue #453).
- **A clip strategy for over-wide `wrap: false` content.** It still overflows by
  definition; documented, not clipped.

## Design

### 1. `raw` gains a `wrap` parameter

`stdlib/ui/layout.agency`:

```
export safe def raw(content: string, align: Alignment = "start", wrap: boolean = true): LayoutNode
```

`wrap` is appended **last** (after the existing `align`) so positional callers of
the old `raw(content, align)` signature keep working; the escape hatch reads
naturally as a named argument (`raw(content, wrap: false)`).

- `wrap: true` (default) — reflow to the container's inner width; apply no styling.
- `wrap: false` — render exactly as-is, never reflow (today's behavior).

The `wrap` value is stored in `attrs`. Mirror the parameter through the builder
helper `_addRaw` (`layout.agency`) so `b.raw(content, wrap: false)` works inside a
block. Update the `raw` docstring and the module-doc lines that currently say
*"raw content never wraps"* and warn that nested ANSI *"won't re-apply styling after
those sequences reset"* — both become inaccurate once wrapping is SGR-aware.

### 2. SGR-aware `wrapText` (`lib/stdlib/layout/ansi.ts`)

`wrapText` already measures width correctly (`visualWidth` ignores CSI). The change:
make **every emitted visual line self-contained** — it re-opens whatever SGR state
was active at that point and closes with `RESET` when anything is open. This holds
at *every* line boundary, including a literal `\n` in the content (the pass runs
over the flattened segment list, so a style opened on one source line and reset on
a later one still never bleeds). Then `pad` and `beside` add spaces and border
chars *after* a `RESET`, so the frame stays uncolored.

**State model (v1 — sequence accumulation):** while walking the original line,
maintain `activeSeq`, the run of SGR sequences seen since the last full reset:

- On `\x1b[0m` / `\x1b[m` (full reset): set `activeSeq = ""` (the reset stays inline).
- On any other SGR sequence (CSI ending in `m`): append it to `activeSeq`.
- Non-SGR CSI (cursor moves, etc.) passes through inline and does not affect state.

At each wrap boundary:

- If `activeSeq` is non-empty at the segment end, append `RESET` to close the segment.
- Prefix the next segment with the current `activeSeq` to re-open the state.

Worked example (dim text, wraps after `BBBB`):

```
in : "\x1b[2mAAAA BBBB CCCC\x1b[0m"
out: ["\x1b[2mAAAA BBBB\x1b[0m",   // closes the open dim
      "\x1b[2mCCCC\x1b[0m"]        // reopens dim, then closes
```

Notes:

- Plain (non-ANSI) content produces no state and is byte-identical to today.
- `breakLongToken` (the mid-token break path for tokens longer than `width`) must
  participate in the same state tracking so a color that opens inside an over-long
  token is reopened on continuation lines.
- Later-wins is fine: stacked colors (`\x1b[31m\x1b[32m` with no reset between)
  reopen both; the terminal applies the last.

**Beneficiary:** `text` already calls `wrapText`, so text-with-embedded-ANSI gets
the clean-per-line behavior for free; no change to the `text` handler is required
for this part.

### 3. Shrink-to-fit with an available-width ceiling (`sizing.ts` + containers)

Add a third field to `SizingContext`:

```
type SizingContext = {
  defaultWidth:    number | undefined;   // width an unsized child adopts (fill)
  percentBasis:    number | undefined;   // basis for "%"/"full"
  availableWidth?: number | undefined;   // NEW: ceiling a content-driven child wraps at
};
```

- `defaultWidth` is unchanged: it makes unsized children **fill** a sized parent.
- `availableWidth` is the **max width content may occupy before it must wrap**. It
  is **optional**: the root and every container (`box`/`column`/`row`) set it, but
  table-cell contexts impose explicit cell widths (so `own` is always defined there
  and the ceiling is never consulted) and deliberately omit it — which is why the
  field is optional rather than required, so `table.ts`/barchart need no change.

**Root** (`render.ts` `resolveSizes`): `availableWidth: viewport.cols` (alongside the
existing `defaultWidth: undefined, percentBasis: viewport.cols`).

**Per container**, the child context's `availableWidth` is that container's own
available inner space:

- **box** (`box.ts` `sizeBox`): chrome is `BORDER_CELLS + 2*padding` (`BORDER_CELLS = 2`).
  `childAvailable = innerWidthAfterChrome(own ?? ctx.availableWidth, chrome)` — when
  `own` is defined this is the box's own inner width; when unsized it is the parent
  ceiling minus this box's chrome. (One expression: `own ?? ctx.availableWidth`
  collapses both cases.)
- **column** (`axis.ts` `sizeColumn`): children fill the column width, so
  `childAvailable = own ?? ctx.availableWidth`.
- **row** (`axis.ts` `sizeRow`): `childAvailable = inner ?? ctx.availableWidth`
  (`inner = own − gapTotal`). Children keep `defaultWidth: undefined` (they are not
  *filled*) but get a wrap ceiling, so a lone wide child wraps instead of
  overflowing. Per-child horizontal *distribution* is a non-goal.

Only leaves consume `availableWidth`; containers pass an adjusted ceiling down.

### 4. Leaf sizing/render (`nodes.ts`)

**`sizeText`** and the wrapping branch of `raw.size` resolve their wrap width as
"imposed width, else the ceiling" via a shared `wrapWidthFor` helper. The helper
also **guards against `wrapWidth ≤ 0`**: when chrome ≥ available width (e.g. an
unsized `box(padding: 20)` on a narrow terminal, reachable with no explicit widths
anywhere) the ceiling clamps to `0`; without the guard the leaf would get
`wrapWidth: 0` and `wrapText` returns `[]`, rendering the content as **nothing**.
Returning `undefined` instead degrades to overflow (visible). This also fixes the
pre-existing imposed-width variant (a `box(width: 3, padding: 1)` vanishes its text
today).

```
function wrapWidthFor(node, ctx) {
  const own = resolveOwnWidth(node, ctx);          // imposed width or defaultWidth
  const width = own ?? ctx.availableWidth;         // fall back to the ceiling
  return width !== undefined && width > 0 ? width : undefined;
}
// sizeText:  const w = wrapWidthFor(node, ctx); return w === undefined ? node : setAttr(node, "wrapWidth", w);
// sizeRaw:   if (node.attrs.wrap === false) return node; then the same as sizeText.
```

- If a parent imposes a width (e.g. a sized box → `defaultWidth = inner`), `own` is
  defined and behavior is unchanged (fill + wrap at that width).
- If the parent is content-driven, `own` is undefined and the leaf now wraps at the
  ceiling. Short lines pass through `wrapText` unchanged (`visualWidth <= width`), so
  **shrink-to-fit is preserved**; only over-long lines wrap.

**`raw` handler** becomes conditional on `wrap`:

- `raw.size`: when `attrs.wrap !== false`, use the same wrap-width logic as
  `sizeText`; when `attrs.wrap === false`, `passthrough` (no `wrapWidth`; content is
  preserved and may overflow — the explicit opt-out).
- `raw.render`: if `wrapWidth` is set, `wrapText(content, wrapWidth)`; else
  `content.split("\n")`. Then align-pad **without** a `styled()` wrapper (raw carries
  no style attrs). This is `text`'s renderer minus styling; factor the shared
  "wrap-or-split + align-pad" into one helper reused by both leaves.

### 5. Resulting behavior

```
// naive case — now works with no width, no wrap flag:
box(title: "Hello", padding: 1) as b { b.raw(coloredDiff) }
//   raw wraps (default) → box caps at terminal → clean colored box
//   (still needs color: true until #453 is fixed)

// shrink-to-fit preserved:
box(title: "Status") as b { b.text("OK") }        // small box, hugs "OK"

// explicit full-width panel (unchanged):
box(width: "full") as b { b.text(longLine) }      // fills terminal, wraps

// preserve exact layout (ASCII art / pre-rendered table):
box(width: 40) as b { b.raw(asciiDiagram, wrap: false) }
```

## Backward compatibility / migration

- **Rendering that changes:** `raw` with lines longer than the available width
  inside a container previously overflowed; it now wraps. Width-less containers with
  *short* content are unchanged (shrink-to-fit). Anyone whose layout-sensitive art
  relied on overflow-in-a-box adds `wrap: false`. This is expected to be rare and is
  called out in the module docs.
- **Byte-level `wrapText` change:** SGR-aware wrapping adds `RESET`/re-open sequences
  around wrapped ANSI lines. Any unit test asserting exact `wrapText` output on
  ANSI input is updated; plain-text output is unchanged.
- **`wrapWidth ≤ 0` guard is a strict improvement:** a too-narrow *sized* box
  (`box(width: 3, padding: 1)`) previously rendered its text as nothing; it now
  overflows visibly. No caller relied on the vanish behavior.

## Testing plan

Unit (`lib/stdlib/layout.test.ts` — the single layout unit-test file):

- Each emitted line is self-contained: reopens the active style, closes with `RESET`.
- Full reset (`\x1b[0m` and empty-params `\x1b[m`) clears state; a color after a
  reset does not carry the pre-reset style.
- **Stacked codes** with no intervening reset are **all** reopened (real two-code
  input, e.g. `\x1b[31m\x1b[1m…`, not a single code).
- Style carries across a **literal `\n`** boundary (self-contained at every boundary).
- **Non-SGR CSI** (e.g. `\x1b[2K`) passes through inline and is never reopened.
- Plain content is byte-identical to the pre-change output.
- Width measurement still ignores escape codes; `breakLongToken` preserves state
  across continuation lines.
- Sizing: unsized box/column wrap children at the ceiling; **row caps** children at
  its width (not `undefined`); nested boxes subtract chrome at each level; the
  `wrapWidth ≤ 0` guard leaves content unwrapped (present) rather than empty.

Render-level (TS `render`/`_render`, deterministic — no hand-computed ANSI):

- Colored content in a box **survives** (`toContain("\x1b[…")`) **and** leaves no open
  SGR at any line boundary (borders untinted) — an independent-oracle property test.
- `align: "end"` right-aligns short wrapped lines.

Layout execution tests (`tests/agency/layout/`, `render(color: false, cols: N)`):

- `raw` wraps by default inside a sized box (exact, equals the `text` output).
- Width-less box shrink-to-fits short content but caps + wraps a long line.
- `raw(wrap: false)` forwards through the builder (exact node attrs).

Run `make` after editing the `.agency` stdlib source. **`make fixtures` does not
regenerate `tests/agency/layout/*.test.json`** (it only rewrites
`tests/typescriptGenerator/`); these fixtures are hand-authored from captured output.

## Follow-ups

- **Style-based SGR parser** — decode SGR params into the existing `Style`
  (`fg/bg/bold/dim/italic/underline`), honoring off-codes and 256/24-bit color, and
  re-emit minimal SGR per line. Replaces v1 accumulation; needed only for third-party
  ANSI that uses partial attribute-off codes. Requires extending `sgr()` to emit the
  full SGR space.
- **`row` horizontal width distribution** — real budget-splitting among side-by-side
  children.
- **Issue #453** — `render` `"auto"` color detection under the `agency` CLI runner.

## Code touch-points

- `stdlib/ui/layout.agency` — `raw` signature + `wrap` attr, `_addRaw`, docstrings,
  module doc.
- `lib/stdlib/layout/ansi.ts` — SGR-aware `wrapText` / `wrapSingleLine` /
  `breakLongToken`.
- `lib/stdlib/layout/sizing.ts` — `availableWidth` on `SizingContext`;
  `resolveContainer` threading.
- `lib/stdlib/layout/render.ts` — root `availableWidth = viewport.cols`.
- `lib/stdlib/layout/box.ts`, `axis.ts` — per-container child `availableWidth`.
- `lib/stdlib/layout/nodes.ts` — `sizeText`/`raw` wrap-width fallback; conditional
  `raw` sizing; shared wrap-or-split render helper.
