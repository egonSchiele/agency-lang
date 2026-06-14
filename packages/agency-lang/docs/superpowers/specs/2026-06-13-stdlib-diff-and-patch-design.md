# Design: `diff` and `patch` stdlib functions

Date: 2026-06-13
Status: Approved (pending spec review)

## Summary

Add two pure, string-returning functions to the `std::syntax` module:

- **`diff(oldText, newText, options)`** — a flexible, human-readable diff
  renderer (color, inline word-highlighting, per-side line numbers, context
  windowing, hunk headers, file labels, change summary).
- **`patch(oldText, newText, filename, options)`** — a standard **unified
  diff** that `std::fs::applyPatch` (and `git apply`) can apply.

Both sit on a shared line-level diff + hunk/context engine in
`lib/utils/diff.ts`. The existing `std::fs::printDiff` tool and its
`_printDiff` helper are **deleted**; callers use `print(diff(...))` instead.
`edit` is unchanged as the single public file-editing tool.

## Motivation

The current `std::fs::printDiff` only prints a colored, full-context, word-level
diff to stdout. It is inflexible: you cannot get the diff as a string, limit
context, add line numbers, label the sides, or produce something a patch tool
can apply. We want a composable `diff` that returns a string, plus a dedicated
`patch` for machine-applicable output.

`diff` and `patch` are kept separate on purpose. `applyPatch` parses a standard
unified diff: `--- a/file` / `+++ b/file` headers, `@@ -l,c +l,c @@` hunk
headers, and hunk-body lines where context is prefixed by a single space,
removals by `-`, additions by `+`, with content immediately after the tag
character. The `diff` display format deliberately differs (two-space context
prefix, `- `/`+ ` with a trailing space, optional color / word-highlight /
line-number gutter / summary). Those display features are invalid inside a
unified diff, so overloading one function to serve both display and patch
output would let a user silently produce a broken patch. Two functions with one
shared engine keeps each correct by construction.

## Architecture

### Shared engine (`lib/utils/diff.ts`)

Factor the file into three layers:

1. **`computeHunks(oldText, newText, { context, ignoreWhitespace })`** —
   computes a line-level diff and groups it into hunks. Returns a structured
   representation:

   ```ts
   type DiffLine = { kind: "context" | "delete" | "insert"; text: string; oldNo: number | null; newNo: number | null };
   type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: DiffLine[] };
   ```

   - `context` is the number of unchanged lines kept on each side of a change.
     When omitted (the `diff` default), the whole input is one hunk (full
     context). When set to `N`, runs of unchanged lines longer than `2N`
     collapse, splitting output into multiple hunks.
   - `ignoreWhitespace` normalizes each line (collapse runs of whitespace,
     trim) for the *comparison* only; the original text is preserved for
     rendering.
   - Line-level diffing reuses the existing diff-match-patch line-mode recipe
     (`diff_linesToChars_` → `diff_main` → `diff_charsToLines_`). No new
     dependency.

2. **`renderDiff(hunks, opts)`** — human-readable display. Consumes the hunks
   and applies, per options: per-side line-number gutter, `@@` hunk headers,
   `---`/`+++` labels, leading summary line, ANSI color, and inline
   word-highlighting (the existing Option-3 behavior) within replacement line
   pairs. Word-highlighting only runs when `colored` is true.

3. **`renderPatch(hunks, oldLabel, newLabel)`** — standard unified-diff text:
   `--- <oldLabel>` / `+++ <newLabel>`, `@@` headers, and ` `/`-`/`+`
   single-char-prefixed body lines. No color, gutter, word-highlight, or
   summary.

`formatDiff(oldText, newText, { colorize })` remains as a thin back-compat shim
over `computeHunks` + `renderDiff` (full context, colored, no gutter/labels) so
existing callers (`lib/optimize/reporter.ts`, `lib/cli/test.ts`,
`lib/optimize/sourceMutator.ts`) are untouched and keep their current output.

### TS shims (`lib/stdlib/syntax.ts`)

New file (or new exports) exposing:

```ts
export function _diff(oldText: string, newText: string, opts: DiffOpts): string;   // computeHunks + renderDiff
export function _patch(oldText: string, newText: string, filename: string, opts: PatchOpts): string; // computeHunks + renderPatch
```

`_syntaxHighlight` already lives in the syntax stdlib-lib; `_diff`/`_patch`
join it.

### Agency wrappers (`stdlib/syntax.agency`)

```ts
type DiffOptions = {
  context?: number          # unchanged lines kept around each change; omitted = full context
  lineNumbers?: boolean     # per-side single-column gutter (default false)
  colored?: boolean         # ANSI red/green/dim + inline word-highlight (default false)
  oldLabel?: string         # renders a `--- <oldLabel>` header
  newLabel?: string         # renders a `+++ <newLabel>` header
  ignoreWhitespace?: boolean # whitespace-only changes treated as equal (default false)
  hunkHeaders?: boolean     # `@@ -l,c +l,c @@` separators (default false)
  summary?: boolean         # leading "N insertions, M deletions" line (default false)
}

export safe def diff(oldText: string, newText: string, options: DiffOptions = {}): string

type PatchOptions = {
  context?: number          # context lines per hunk (default 3)
  ignoreWhitespace?: boolean
  newFilename?: string      # override the +++ side path (renames); omit when unchanged
}

export safe def patch(oldText: string, newText: string, filename: string, options: PatchOptions = {}): string
```

Both are `safe` (pure, no side effects) so they are LLM-callable without an
approval prompt. Both carry docstrings (which become tool descriptions).

## Behavior details

### `diff`

- **No options** → byte-identical to today's inline `-`/`+` word-highlighted
  diff at full context. Nothing regresses.
- **`colored` defaults to `false`.** The return value is data — it may be fed
  to an LLM or written to a file — so plain text is the safe default. Terminal
  callers opt into `true`.
- **Line numbers** use the per-side single-column gutter: a `-` line shows the
  old number, a `+`/context line shows the new number.
- **`context: N`** switches to hunk mode (only changes plus N context lines).
  `hunkHeaders: true` adds `@@` separators between hunks. The two are
  independent toggles; hunk headers without a context limit yields a single
  `@@` covering the whole file.
- **`oldLabel`/`newLabel`** render `---`/`+++` header lines for display only
  (no `a/`,`b/` prefixing — that is `patch`'s job).
- **Identical inputs:** at full context, returns the input rendered as all
  dim context lines (today's behavior). With a `context` limit, returns the
  empty string (no hunks).

### `patch`

- Emits a standard unified diff: `--- a/<filename>` / `+++ b/<newFilename ??
  filename>`, `@@` hunk headers, ` `/`-`/`+` body lines.
- **`context` defaults to 3** (the standard); patches need context to locate
  hunks.
- **Empty `oldText`** → `--- /dev/null` (file creation). **Empty `newText`**
  → `+++ /dev/null` (deletion). Matches what `applyPatch` already parses.
- **Renames:** `newFilename` overrides the `+++` side path.
- **Round-trip guarantee:** `applyPatch(patch(old, new, "f.txt"))` reproduces
  `new`. Enforced by test.

## Switch-over of existing callers

- **`lib/utils/diff.ts`** — `formatDiff` becomes the back-compat shim described
  above. Existing callers unchanged.
- **`lib/stdlib/fs.ts`** — delete `_printDiff`. In `_multiedit`, replace the
  `_printDiff(original, contents)` call (guarded by `printDiff && original !==
  contents`) with `console.log(renderDiff(computeHunks(original, contents, {}),
  { colored: true }))` (or a small local helper that mirrors the old look:
  full context, colored, no gutter).
- **`stdlib/fs.agency`** — delete the `printDiff` tool and drop `_printDiff`
  from the import. `edit` keeps its `printDiff: boolean` parameter (the
  after-edit display flag is unrelated to the deleted tool).
- **Docs** — regenerate stdlib reference (`agency doc`); remove any guide/doc
  references to `printDiff`; add `diff`/`patch` reference via their docstrings.

## Testing

Unit tests (`lib/utils/diff.test.ts`, runs under `pnpm test:run`):

- `computeHunks`: context windowing (collapse > 2N), multiple hunks, hunk
  line-number math, `ignoreWhitespace` comparison.
- `renderDiff`: no-options back-compat equals current `formatDiff` output;
  per-side line numbers; `@@` headers; labels; summary; `colored:false` has no
  ANSI; word-highlight only when colored.
- `renderPatch`: header/hunk format; `/dev/null` for create and delete;
  `newFilename` rename; single-char body prefixes.
- Keep the existing `formatDiff` tests green (back-compat).

Agency execution test (`tests/agency/`, no LLM):

- Calls `std::syntax::diff` and `std::syntax::patch` and asserts on the
  returned strings.
- **Round-trip:** `applyPatch(patch(old, new, file))` against a sandbox file
  reproduces `new` (covers create, modify, delete, rename).

## Out of scope (YAGNI)

- Side-by-side / two-column display format.
- Multi-file patches in a single `patch` call (one file per call).
- Tab-width expansion, `--stat`-style histograms, `jsdiff` dependency.
```
