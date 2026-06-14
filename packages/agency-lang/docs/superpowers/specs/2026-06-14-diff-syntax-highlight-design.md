# Design: syntax-highlighted, background-tinted diff mode

Date: 2026-06-14
Status: Approved (pending spec review)

## Summary

Add an opt-in rendering mode to `std::syntax::diff` that shows changed lines
with a **full-line background tint** (dim red for deletions, dim green for
insertions) and the line's code **syntax-highlighted** on top, with a
line-number gutter. It is triggered by a new `language` parameter; when
`language` is empty (the default) or color is off, `diff` renders exactly as it
does today.

This is the "line-tint" fidelity level: the whole changed line is uniformly
tinted. The per-word *brighter* background seen in some references is
explicitly out of scope (see [Out of scope](#out-of-scope)).

## Motivation

Today `diff` colors changed lines with a foreground red/green and highlights
changed words inline. That reads well for prose but flattens code: every token
is the same red or green, losing the syntax structure. A background-tinted,
syntax-highlighted view (like an IDE / `git`-pager diff) keeps the code
readable as code while still making additions and deletions obvious.

## Triggering and interaction with existing options

- New parameter `language: string = ""` (the last parameter of `diff`).
- **Enabled** when `language` is non-empty **and** color resolves on.
  - `language` examples: `"agency"`, `"ts"`, `"python"`, `"json"`. It is passed
    straight to the existing highlighter, which maps `"agency"` → `"ts"`.
- **Disabled** (falls back to today's inline `-`/`+` rendering) when:
  - `language` is `""`, or
  - color resolves off — i.e. `color: false`, or `color: "auto"` resolved to
    off (non-TTY / `NO_COLOR`). Syntax highlighting and background tints are
    ANSI-only, so a plain-text diff cannot carry them.
- All other options keep working unchanged: `context` windowing, `hunkHeaders`,
  `oldLabel`/`newLabel`, `summary`, `ignoreWhitespace`, `lineNumbers`. The
  tinted mode only changes how each line's body and gutter are rendered.
- For the full screenshot look, callers set both `language` and
  `lineNumbers: true`. The two are independent; tinted mode works without line
  numbers (gutter is then just the `-`/`+`/space marker).
- `patch` is untouched — unified diffs are always plain.

## Architecture

There are **two coloring code paths**, sharing one layout scaffold:

- **Inline path** (today's behavior): foreground red/green with inline
  changed-word highlighting. Unchanged.
- **Highlighted path** (new): background-tinted, syntax-highlighted lines.

`renderDiff` in `lib/utils/diff.ts` owns the shared scaffold — hunk walking,
the line-number/marker gutter, and computing the block width. It does **not**
know how to syntax-highlight and contains **no escape-code manipulation** for
the new mode. The per-line body is produced by one of the two paths:

- Inline: the existing in-`renderDiff` rendering.
- Highlighted: an **injected** body renderer passed in `RenderDiffOpts`:

  ```ts
  renderBody?: (code: string, kind: "context" | "delete" | "insert", width: number) => string
  ```

  When `renderBody` is present and `colored` is true, `renderDiff` uses the
  highlighted path: it computes the block width, calls `renderBody` for each
  line's code, and prepends the gutter.

The `_diff` shim in `lib/stdlib/syntax.ts` (where cli-highlight and the theme
live) constructs `renderBody` when `language` is set, and passes it through.
This keeps `diff.ts` free of stdlib imports and free of theme/ANSI knowledge,
and keeps all hunk/gutter/layout logic in one place.

## Rendering details

### Background-aware highlighting (no ANSI post-processing)

cli-highlight wraps **every** run of source — keywords, strings, operators,
whitespace, and unmatched text (via the `default` style) — in a theme style
function; there are no raw unstyled spans. So if the theme itself sets a
background, every emitted segment carries it. The per-segment full resets
(`\x1b[0m`) are zero-width (immediately followed by the next segment's
background open, with no character between), so the background is **continuous**
with no gaps. This was verified empirically against cli-highlight.

The highlighted `renderBody` therefore:

- **Context line:** `syntaxHighlight(code, language)` with the normal VS Code
  theme — no background, no padding.
- **Deleted line:** `syntaxHighlight(code, language)` with a **red-background
  theme**, then pad the trailing space to `width` with the red background and a
  final reset.
- **Inserted line:** same with a **green-background theme**.

Background-aware themes are built by a factory:

```ts
function makeBgTheme(rgb: [number, number, number]): Theme
// each entry of the existing VS Code palette, with `.bgRgb(...rgb)` chained on,
// so cli-highlight emits foreground + background per segment.
```

The only manual step is padding the trailing spaces out to the block width with
the background — intrinsic to drawing a rectangular bar, not a workaround.

### Block width

`renderDiff` computes the block width as the maximum visual width of the raw
line text (`DiffLine.text`, ANSI-free, so a plain length/`visualWidth`) across
displayed lines, and passes it to `renderBody`. The colored bars form a tidy
rectangle sized to content; this deliberately does **not** read
`process.stdout.columns`, keeping `diff` self-contained.

### Gutter

- Per-side line number (existing logic: old number on delete lines, new number
  elsewhere) followed by the `-` / `+` / space marker.
- On changed lines the number and marker are colored (red for delete, green for
  insert); on context lines they are dim.
- When `lineNumbers` is false, the gutter is just the marker.

### Background colors

Defined once in `lib/stdlib/syntax.ts` (so the theme and the trailing pad share
them): dim red ≈ `(60, 0, 0)`, dim green ≈ `(0, 45, 0)` — tunable.

## Testing

TS unit tests:

- `lib/utils/diff.test.ts`, `renderDiff` with a **stub `renderBody`** (e.g. one
  that wraps code in sentinel markers): context vs delete vs insert get the
  right `kind`; `width` is the max line width; the gutter numbers/markers on
  changed lines are colored; without `renderBody` or with `colored: false`,
  output is identical to today (existing tests stay green).
- `lib/stdlib/syntax.test.ts` (or co-located), for `makeBgTheme` /
  the highlighted `renderBody`: a changed line's output carries the background
  code across all segments (bg-open count ≥ reset count) and ends in a reset;
  a context line carries no background; padding reaches the requested width.

One pure Agency execution test (`tests/agency/`, no LLM): `diff(old, new, color:
true, language: "ts")` returns a string containing both a background SGR code
and a foreground highlight code.

A manual visual check against the reference screenshots.

## Out of scope

- **Per-word brighter background** on the changed token(s). With the
  background-aware theme this becomes more tractable (the changed span could use
  a brighter-bg theme variant), but composing per-character bg intensity with
  the highlighter's token boundaries is still extra work; deferred as a possible
  follow-up.
- **Full-terminal-width** bars (padding to `process.stdout.columns`).
- Changing `patch`, or any non-color/plain-text behavior.
- Side-by-side rendering.
