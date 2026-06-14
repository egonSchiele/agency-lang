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

### Continuous line background (re-arm after resets)

A per-token background theme was tried first but is **insufficient**: real
highlight.js grammars emit some punctuation and whitespace as *unstyled raw
text* (not routed through the `default` style), so a theme-applied background
leaves gaps wherever the highlighter emits raw text — visible as holes in the
colored bar on real code.

So the background is treated as a property of the **line**, not the tokens. The
highlighted `renderBody`:

- **Context line:** `syntaxHighlight(code, language)` with the normal VS Code
  theme — no background, no padding.
- **Changed line (delete/insert):** `syntaxHighlight(code, language)` with the
  **same** normal theme (so changed-line colors match context lines exactly),
  then make the background continuous: prefix the background-open SGR, and
  **re-arm it after every reset** the highlighter emits (`split(reset).join(reset
  + bgOpen)`), so raw/unstyled spans stay backgrounded. Finally pad the trailing
  spaces to `width` and end with a single reset.

This keeps the foreground entirely owned by the canonical `syntaxHighlight`; the
only background handling is "set it, keep it armed across resets, pad to width."
`bgOpen(rgb)` is derived from `termcolors` (`color.bgRgb(...)`) so the SGR format
isn't hardcoded. The dim red/green backgrounds are `(60,0,0)` / `(0,45,0)`.

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
- `lib/stdlib/syntax.test.ts`, for the highlighted `_diff`: a deleted line
  carries the dim-red background SGR, an inserted line the dim-green one, a
  context line carries no background, a foreground code is present, and with
  `color: false` the output is plain with no ANSI.

One end-to-end Agency-js test (`tests/agency-js/stdlib/std-syntax-diff-highlight`,
no LLM): `diff(old, new, color: true, language: "ts")` returns a string
containing both background SGR codes and a foreground highlight code, while
plain mode (no `language`) carries no background.

A manual visual check against the reference screenshots (in particular, that
the colored bars have no gaps over punctuation/whitespace).

## Out of scope

- **Per-word brighter background** on the changed token(s). This needs
  per-character composition of background intensity with the highlighter's
  foreground spans, which is extra work; deferred as a possible
  follow-up.
- **Full-terminal-width** bars (padding to `process.stdout.columns`).
- Changing `patch`, or any non-color/plain-text behavior.
- Side-by-side rendering.
