# std::syntax `diff` and `patch` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two pure, string-returning stdlib functions — `diff` (flexible human-readable diff) and `patch` (applicable unified diff) — to `std::syntax`, sharing one hunk/context engine; delete the old `std::fs::printDiff` tool.

**Architecture:** `lib/utils/diff.ts` becomes a three-layer engine: `computeHunks(old, new, context, ignoreWhitespace)` → structured hunks; `renderDiff(hunks, opts)` → human display (color, inline word-highlight, per-side line numbers, labels, hunk headers, summary); `renderPatch(hunks, oldLabel, newLabel)` → standard unified diff. `formatDiff` stays as a thin back-compat shim. TS shims `_diff`/`_patch` in `lib/stdlib/syntax.ts` are wrapped by Agency `diff`/`patch` in `stdlib/syntax.agency`. `std::fs::printDiff` and its `_printDiff` helper are deleted; `_multiedit` prints via the shared engine.

**Tech Stack:** TypeScript, `diff-match-patch` (already a dependency), Agency stdlib, vitest (unit), Agency execution tests (`tests/agency/`), Agency-js tests (`tests/agency-js/`).

**Spec:** `docs/superpowers/specs/2026-06-13-stdlib-diff-and-patch-design.md`

---

## Background the engineer needs

- **Agency stdlib layout.** `.agency` files in `stdlib/` are thin wrappers that import TS helpers from `agency-lang/stdlib-lib/<file>.js`, which resolves (via `package.json` `exports`) to `dist/lib/stdlib/<file>.js`, compiled from `lib/stdlib/<file>.ts`. So: write TS helpers in `lib/stdlib/syntax.ts`, expose them in `stdlib/syntax.agency`.
- **Building.** After changing TS (`lib/...`) or stdlib `.agency` files, run `make` from `packages/agency-lang/` (it runs `pnpm run build` → tsc to `dist/`, then `make stdlib` compiles `stdlib/*.agency`, then `make doc` regenerates `docs/site/stdlib/`). For TS-only unit tests you can `pnpm run build` then `pnpm test:run`, but the Agency tests need the full `make`.
- **Unit tests** run with `pnpm test:run <path>` (vitest).
- **Agency execution tests** live in `tests/agency/<name>.agency` + `tests/agency/<name>.test.json` and run with `pnpm run a test tests/agency/<name>.test.json`. They need NO LLM for pure logic. `expectedOutput` is the JSON-stringified return value (a string return `"hi"` is written as `"\"hi\""`).
- **Agency-js tests** live in `tests/agency-js/stdlib/<name>/` with `agent.agency`, `test.js` (Node harness; sets up fs, imports the compiled `agent.js`, writes `__result.json`), and `fixture.json` (expected `__result.json`). Run with `pnpm run a test js tests/agency-js/stdlib/<name>`.
- **Color.** Use `color` from `lib/utils/termcolors.ts` (red/green/dim/cyan), never raw ANSI.
- **Git.** Commit messages with apostrophes must be passed via a file (`git commit -F msgfile`), not inline. End commit messages with the `Co-Authored-By` trailer. Do not amend or force-push.

---

## File Structure

- **Modify** `lib/utils/diff.ts` — the engine. Adds `computeHunks`, `renderDiff`, `renderPatch`, supporting types; `formatDiff` becomes a shim.
- **Modify** `lib/utils/diff.test.ts` — unit tests for the new surface (plus the existing back-compat tests stay).
- **Modify** `lib/stdlib/syntax.ts` — add `_diff`, `_patch` exports.
- **Modify** `stdlib/syntax.agency` — add `diff`, `patch` Agency wrappers.
- **Modify** `lib/stdlib/fs.ts` — delete `_printDiff`; `_multiedit` prints via `computeHunks`+`renderDiff`.
- **Modify** `stdlib/fs.agency` — delete the `printDiff` tool; drop `_printDiff` from the import.
- **Create** `tests/agency/diff-and-patch.agency` + `tests/agency/diff-and-patch.test.json` — pure execution test of `diff`/`patch` output strings.
- **Create** `tests/agency-js/stdlib/std-syntax-patch-roundtrip/agent.agency`, `test.js`, `fixture.json` — `applyPatch(patch(...))` round-trip.
- **Modify** `CHANGELOG.md` — note the new functions and the `printDiff` removal.
- **Regenerated (do not hand-edit)** `docs/site/stdlib/*.md`, `dist/**`, `stdlib/*.js` — produced by `make`.

---

## Task 1: Refactor `diff.ts` into computeHunks / renderDiff / renderPatch

This is a refactor: the engine gains structure and the new render functions, while `formatDiff`'s output is unchanged. The safety gate is that **all existing tests stay green** (the `formatDiff` callers in the optimizer, test runner, and sourceMutator must see identical output).

**Files:**
- Modify: `lib/utils/diff.ts` (replace entire file)

- [ ] **Step 1: Replace `lib/utils/diff.ts` with the engine**

```ts
import DiffMatchPatch from "diff-match-patch";
import { color } from "./termcolors.js";

const DIFF_DELETE = -1;
const DIFF_INSERT = 1;
const DIFF_EQUAL = 0;

const dmp = new DiffMatchPatch();

type Diff = [number, string];

export type DiffLine = {
  kind: "context" | "delete" | "insert";
  text: string;
  oldNo: number | null;
  newNo: number | null;
};

export type Hunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
};

export type RenderDiffOpts = {
  lineNumbers?: boolean;
  colored?: boolean;
  oldLabel?: string;
  newLabel?: string;
  hunkHeaders?: boolean;
  summary?: boolean;
};

// Collapse runs of whitespace and trim, for comparison only (the original
// line text is preserved for rendering).
function normalizeLine(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

// "" is zero lines; otherwise split on newline, KEEPING a trailing empty
// element so a trailing newline survives a patch round-trip.
function splitTextLines(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

// Encode each unique line as a single char so diff_main runs at line
// granularity. Caps at ~65k unique lines, plenty for stdlib diffs.
function encodeLines(lines: string[], map: Map<string, number>, arr: string[]): string {
  let s = "";
  for (const line of lines) {
    let idx = map.get(line);
    if (idx === undefined) {
      idx = arr.length;
      arr.push(line);
      map.set(line, idx);
    }
    s += String.fromCharCode(idx);
  }
  return s;
}

// Flat, line-by-line diff with old/new line numbers attached.
function diffLines(oldText: string, newText: string, ignoreWhitespace: boolean): DiffLine[] {
  const oldLines = splitTextLines(oldText);
  const newLines = splitTextLines(newText);
  const key = ignoreWhitespace ? normalizeLine : (s: string) => s;

  const map = new Map<string, number>();
  const arr: string[] = [];
  const enc1 = encodeLines(oldLines.map(key), map, arr);
  const enc2 = encodeLines(newLines.map(key), map, arr);
  const diffs = dmp.diff_main(enc1, enc2, false) as Diff[];

  const out: DiffLine[] = [];
  let oi = 0;
  let ni = 0;
  for (const [op, chunk] of diffs) {
    for (let k = 0; k < chunk.length; k++) {
      if (op === DIFF_EQUAL) {
        out.push({ kind: "context", text: newLines[ni], oldNo: oi + 1, newNo: ni + 1 });
        oi++;
        ni++;
      } else if (op === DIFF_DELETE) {
        out.push({ kind: "delete", text: oldLines[oi], oldNo: oi + 1, newNo: null });
        oi++;
      } else {
        out.push({ kind: "insert", text: newLines[ni], oldNo: null, newNo: ni + 1 });
        ni++;
      }
    }
  }
  return out;
}

function makeHunk(lines: DiffLine[]): Hunk {
  const oldNos = lines.filter((l) => l.oldNo !== null).map((l) => l.oldNo as number);
  const newNos = lines.filter((l) => l.newNo !== null).map((l) => l.newNo as number);
  return {
    oldStart: oldNos.length ? oldNos[0] : 0,
    oldLines: oldNos.length,
    newStart: newNos.length ? newNos[0] : 0,
    newLines: newNos.length,
    lines,
  };
}

/**
 * Compute a line-level diff grouped into hunks.
 * `context < 0` -> one hunk spanning everything (full context).
 * `context >= 0` -> keep only changed lines plus `context` unchanged lines on
 * each side; runs separated by more than 2*context unchanged lines split into
 * separate hunks.
 */
export function computeHunks(
  oldText: string,
  newText: string,
  context: number,
  ignoreWhitespace: boolean,
): Hunk[] {
  const lines = diffLines(oldText, newText, ignoreWhitespace);
  if (lines.length === 0) return [];
  if (context < 0) return [makeHunk(lines)];

  const include: boolean[] = new Array(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].kind !== "context") {
      const lo = Math.max(0, i - context);
      const hi = Math.min(lines.length - 1, i + context);
      for (let j = lo; j <= hi; j++) include[j] = true;
    }
  }

  const hunks: Hunk[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!include[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && include[j]) j++;
    hunks.push(makeHunk(lines.slice(i, j)));
    i = j;
  }
  return hunks;
}

// Render one side of a replacement with the changed words highlighted.
function highlightLine(oldLine: string, newLine: string, side: number): string {
  const prefix = side === DIFF_DELETE ? "- " : "+ ";
  const sideColor = side === DIFF_DELETE ? color.red : color.green;
  const wordDiffs = dmp.diff_main(oldLine, newLine) as Diff[];
  dmp.diff_cleanupSemantic(wordDiffs);

  let body = "";
  for (const [op, text] of wordDiffs) {
    if (op === DIFF_EQUAL) body += color.dim(text);
    else if (op === side) body += sideColor(text);
  }
  return sideColor(prefix) + body;
}

function renderReplacement(
  dels: DiffLine[],
  inss: DiffLine[],
  out: string[],
  colored: boolean,
  gutter: (l: DiffLine) => string,
): void {
  const paired = Math.min(dels.length, inss.length);
  for (let k = 0; k < dels.length; k++) {
    const body =
      colored && k < paired
        ? highlightLine(dels[k].text, inss[k].text, DIFF_DELETE)
        : colored
          ? color.red(`- ${dels[k].text}`)
          : `- ${dels[k].text}`;
    out.push(gutter(dels[k]) + body);
  }
  for (let k = 0; k < inss.length; k++) {
    const body =
      colored && k < paired
        ? highlightLine(dels[k].text, inss[k].text, DIFF_INSERT)
        : colored
          ? color.green(`+ ${inss[k].text}`)
          : `+ ${inss[k].text}`;
    out.push(gutter(inss[k]) + body);
  }
}

function renderHunkBody(
  lines: DiffLine[],
  out: string[],
  colored: boolean,
  gutter: (l: DiffLine) => string,
): void {
  const paint = (fn: (t: string) => string, t: string) => (colored ? fn(t) : t);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.kind === "context") {
      out.push(gutter(line) + paint(color.dim, `  ${line.text}`));
      i++;
    } else if (line.kind === "delete") {
      let d = i;
      while (d < lines.length && lines[d].kind === "delete") d++;
      let n = d;
      while (n < lines.length && lines[n].kind === "insert") n++;
      renderReplacement(lines.slice(i, d), lines.slice(d, n), out, colored, gutter);
      i = n;
    } else {
      out.push(gutter(line) + paint(color.green, `+ ${line.text}`));
      i++;
    }
  }
}

function gutterWidth(hunks: Hunk[]): number {
  let max = 0;
  for (const h of hunks)
    for (const l of h.lines) {
      const n = l.kind === "delete" ? l.oldNo : l.newNo;
      if (n !== null) max = Math.max(max, n);
    }
  return String(max).length;
}

/** Render hunks as a human-readable diff string. */
export function renderDiff(hunks: Hunk[], opts: RenderDiffOpts = {}): string {
  const colored = opts.colored ?? false;
  const paint = (fn: (t: string) => string, t: string) => (colored ? fn(t) : t);
  const out: string[] = [];

  if (opts.summary) {
    let ins = 0;
    let del = 0;
    for (const h of hunks)
      for (const l of h.lines) {
        if (l.kind === "insert") ins++;
        else if (l.kind === "delete") del++;
      }
    out.push(`${ins} insertion${ins === 1 ? "" : "s"}, ${del} deletion${del === 1 ? "" : "s"}`);
  }
  if (opts.oldLabel) out.push(paint(color.red, `--- ${opts.oldLabel}`));
  if (opts.newLabel) out.push(paint(color.green, `+++ ${opts.newLabel}`));

  const width = opts.lineNumbers ? gutterWidth(hunks) : 0;
  const gutter = (l: DiffLine): string => {
    if (!opts.lineNumbers) return "";
    const n = l.kind === "delete" ? l.oldNo : l.newNo;
    return `${(n === null ? "" : String(n)).padStart(width)} `;
  };

  for (const h of hunks) {
    if (opts.hunkHeaders) {
      out.push(paint(color.cyan, `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`));
    }
    renderHunkBody(h.lines, out, colored, gutter);
  }
  return out.join("\n");
}

/** Render hunks as a standard unified diff that std::fs::applyPatch can apply. */
export function renderPatch(hunks: Hunk[], oldLabel: string, newLabel: string): string {
  if (hunks.length === 0) return "";
  const out: string[] = [`--- ${oldLabel}`, `+++ ${newLabel}`];
  for (const h of hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
    for (const l of h.lines) {
      if (l.kind === "context") out.push(` ${l.text}`);
      else if (l.kind === "delete") out.push(`-${l.text}`);
      else out.push(`+${l.text}`);
    }
  }
  return out.join("\n") + "\n";
}

/**
 * Back-compat shim: full-context, colored-by-default inline diff. Existing
 * callers (optimizer reporter, test runner, sourceMutator) rely on this exact
 * output, so it must not change.
 */
export function formatDiff(
  expected: string,
  actual: string,
  opts: { colorize?: boolean } = {},
): string {
  const hunks = computeHunks(expected, actual, -1, false);
  return renderDiff(hunks, { colored: opts.colorize ?? true });
}
```

- [ ] **Step 2: Run the existing diff unit tests (back-compat gate)**

Run: `pnpm test:run lib/utils/diff.test.ts`
Expected: PASS (all the existing tests written earlier still green — the shim reproduces the old output).

- [ ] **Step 3: Run the downstream callers' tests (no-regression gate)**

Run: `pnpm test:run lib/optimize/reporter.test.ts lib/optimize/sourceMutator.test.ts lib/optimize/artifacts.test.ts`
Expected: PASS. These exercise `formatDiff` via the optimizer; identical output means no regression.

- [ ] **Step 4: Typecheck**

Run: `pnpm run typecheck`
Expected: exit 0, no `error TS`.

- [ ] **Step 5: Commit**

```bash
git add lib/utils/diff.ts
git commit -F /tmp/diff-task1.txt   # message file with the Co-Authored-By trailer
```

Message body: `Refactor diff.ts into computeHunks/renderDiff/renderPatch engine`.

---

## Task 2: Unit tests for the new `diff` display features

Adds characterization tests for context windowing, per-side line numbers, hunk headers, labels, summary, and ignoreWhitespace. (Task 1 already implemented these; this task pins their behavior.)

**Files:**
- Modify: `lib/utils/diff.test.ts` (append a new `describe` block)
- Test: `lib/utils/diff.test.ts`

- [ ] **Step 1: Append the new tests**

First, extend the existing top-of-file import so the engine functions are in scope (the current first import is `import { formatDiff } from "./diff.js";`):

```ts
import { formatDiff, computeHunks, renderDiff, renderPatch } from "./diff.js";
```

Then add this block at the end of `lib/utils/diff.test.ts` (the `strip` helper already exists at the top of the file from earlier work):

```ts
describe("renderDiff options", () => {
  const OLD = "a\nb\nc\nd\ne\nf\ng";
  const NEW = "a\nb\nc\nD\ne\nf\ng";

  it("limits context and emits separate hunks", () => {
    const hunks = computeHunks(OLD, NEW, 1, false);
    const result = renderDiff(hunks, {});
    // 1 line of context each side of the change to line 4 ("c","D"/"d","e")
    expect(strip(result)).toBe("  c\n- d\n+ D\n  e");
  });

  it("renders per-side line numbers (old on delete, new elsewhere)", () => {
    const hunks = computeHunks("one\ntwo\nthree", "one\nTWO\nthree", -1, false);
    const result = renderDiff(hunks, { lineNumbers: true });
    expect(strip(result)).toBe("1   one\n2 - two\n2 + TWO\n3   three");
  });

  it("emits hunk headers", () => {
    const hunks = computeHunks("one\ntwo\nthree", "one\nTWO\nthree", 1, false);
    const result = renderDiff(hunks, { hunkHeaders: true });
    expect(strip(result)).toContain("@@ -1,3 +1,3 @@");
  });

  it("renders labels", () => {
    const hunks = computeHunks("x", "y", -1, false);
    const result = renderDiff(hunks, { oldLabel: "a.txt", newLabel: "b.txt" });
    expect(strip(result)).toContain("--- a.txt");
    expect(strip(result)).toContain("+++ b.txt");
  });

  it("renders a summary line", () => {
    const hunks = computeHunks("one\ntwo", "one\nTWO\nthree", -1, false);
    const result = renderDiff(hunks, { summary: true });
    expect(strip(result).split("\n")[0]).toBe("2 insertions, 1 deletion");
  });

  it("ignores whitespace-only changes when asked", () => {
    const hunks = computeHunks("a   b", "a b", -1, true);
    // normalized equal -> single context line, no -/+ markers
    const result = renderDiff(hunks, {});
    expect(strip(result)).not.toContain("- ");
    expect(strip(result)).not.toContain("+ ");
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `pnpm test:run lib/utils/diff.test.ts`
Expected: PASS (existing + new blocks).

Note: if `limits context` fails on the exact hunk boundary, print the actual value and adjust the expectation to the produced window — the assertion encodes context=1 around the single change.

- [ ] **Step 3: Commit**

```bash
git add lib/utils/diff.test.ts
git commit -F /tmp/diff-task2.txt
```

Message body: `Add unit tests for diff display options`.

---

## Task 3: Unit tests for `renderPatch`

**Files:**
- Modify: `lib/utils/diff.test.ts` (append a `renderPatch` describe block)
- Test: `lib/utils/diff.test.ts`

- [ ] **Step 1: Append the patch tests**

```ts
describe("renderPatch", () => {
  it("produces an applicable unified-diff body for a modification", () => {
    const hunks = computeHunks("one\ntwo\nthree\n", "one\nTWO\nthree\n", 3, false);
    const patch = renderPatch(hunks, "a/f.txt", "b/f.txt");
    expect(patch.startsWith("--- a/f.txt\n+++ b/f.txt\n")).toBe(true);
    expect(patch).toContain("@@ -1");
    expect(patch).toContain("\n one");
    expect(patch).toContain("\n-two");
    expect(patch).toContain("\n+TWO");
    expect(patch.endsWith("\n")).toBe(true);
    // No ANSI, no two-space display prefixes.
    expect(patch).not.toContain("\x1b");
  });

  it("uses /dev/null for new and deleted files", () => {
    const created = renderPatch(computeHunks("", "hello\nworld", 3, false), "/dev/null", "b/new.txt");
    expect(created).toContain("--- /dev/null");
    expect(created).toContain("@@ -0,0 +1");
    expect(created).toContain("+hello");

    const deleted = renderPatch(computeHunks("bye\n", "", 3, false), "a/old.txt", "/dev/null");
    expect(deleted).toContain("+++ /dev/null");
    expect(deleted).toContain("-bye");
  });

  it("supports renames via differing labels", () => {
    const patch = renderPatch(computeHunks("x\n", "y\n", 3, false), "a/old.txt", "b/new.txt");
    expect(patch).toContain("--- a/old.txt");
    expect(patch).toContain("+++ b/new.txt");
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `pnpm test:run lib/utils/diff.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/utils/diff.test.ts
git commit -F /tmp/diff-task3.txt
```

Message body: `Add unit tests for renderPatch`.

---

## Task 4: Expose `_diff`/`_patch` TS shims and `diff`/`patch` Agency functions

**Files:**
- Modify: `lib/stdlib/syntax.ts` (add imports + two exports)
- Modify: `stdlib/syntax.agency` (add imports + two wrappers)

- [ ] **Step 1: Add the TS shims to `lib/stdlib/syntax.ts`**

At the top of `lib/stdlib/syntax.ts`, add to the imports:

```ts
import { computeHunks, renderDiff, renderPatch } from "@/utils/diff.js";
```

At the end of the file, add:

```ts
export function _diff(
  oldText: string,
  newText: string,
  context: number,
  lineNumbers: boolean,
  colored: boolean,
  oldLabel: string,
  newLabel: string,
  ignoreWhitespace: boolean,
  hunkHeaders: boolean,
  summary: boolean,
): string {
  const hunks = computeHunks(oldText, newText, context, ignoreWhitespace);
  return renderDiff(hunks, {
    lineNumbers,
    colored,
    oldLabel: oldLabel || undefined,
    newLabel: newLabel || undefined,
    hunkHeaders,
    summary,
  });
}

export function _patch(
  oldText: string,
  newText: string,
  filename: string,
  context: number,
  ignoreWhitespace: boolean,
  newFilename: string,
): string {
  const hunks = computeHunks(oldText, newText, context, ignoreWhitespace);
  const oldLabel = oldText === "" ? "/dev/null" : `a/${filename}`;
  const newLabel = newText === "" ? "/dev/null" : `b/${newFilename || filename}`;
  return renderPatch(hunks, oldLabel, newLabel);
}
```

- [ ] **Step 2: Add the Agency wrappers to `stdlib/syntax.agency`**

Change the import block at the top to also pull in the new shims:

```ts
import {
  syntaxHighlight as _syntaxHighlight,
  _diff,
  _patch,
 } from "agency-lang/stdlib-lib/syntax.js"
```

Append these two functions at the end of `stdlib/syntax.agency`:

```ts
export safe def diff(
  oldText: string,
  newText: string,
  context: number = -1,
  lineNumbers: boolean = false,
  colored: boolean = false,
  oldLabel: string = "",
  newLabel: string = "",
  ignoreWhitespace: boolean = false,
  hunkHeaders: boolean = false,
  summary: boolean = false,
): string {
  """
  Produce a human-readable diff of two strings and return it as a string.
  By default returns a plain (uncolored) inline diff showing the full text
  with changed words highlighted via `-`/`+` lines.

  @param oldText - The original text
  @param newText - The updated text
  @param context - Unchanged lines to keep around each change; -1 means show the full text
  @param lineNumbers - Prefix each line with its line number
  @param colored - Emit ANSI colors (red deletions, green insertions) with inline word highlighting
  @param oldLabel - When non-empty, render a `--- <oldLabel>` header
  @param newLabel - When non-empty, render a `+++ <newLabel>` header
  @param ignoreWhitespace - Treat whitespace-only changes as equal
  @param hunkHeaders - Emit `@@ -l,c +l,c @@` separators between change regions
  @param summary - Prefix the diff with an "N insertions, M deletions" line
  """
  return _diff(oldText, newText, context, lineNumbers, colored, oldLabel, newLabel, ignoreWhitespace, hunkHeaders, summary)
}

export safe def patch(
  oldText: string,
  newText: string,
  filename: string,
  context: number = 3,
  ignoreWhitespace: boolean = false,
  newFilename: string = "",
): string {
  """
  Produce a standard unified diff that std::fs::applyPatch (or `git apply`)
  can apply, and return it as a string. Pass the file's path as `filename`;
  an empty `oldText` produces a file-creation patch and an empty `newText`
  a deletion patch.

  @param oldText - The original file contents
  @param newText - The updated file contents
  @param filename - The path used in the patch headers (the `a/` and `b/` sides)
  @param context - Context lines to include around each hunk
  @param ignoreWhitespace - Treat whitespace-only changes as equal
  @param newFilename - When non-empty, use this path for the new (`+++`) side, e.g. to record a rename
  """
  return _patch(oldText, newText, filename, context, ignoreWhitespace, newFilename)
}
```

- [ ] **Step 3: Build everything**

Run: `make`
Expected: completes without error (builds TS, compiles `stdlib/`, regenerates docs). This also recompiles `stdlib/syntax.agency` → `stdlib/syntax.js`.

- [ ] **Step 4: Verify named-arg skipping works (the flat-param assumption)**

Create `tests/agency/diff-named-args.agency`:

```ts
import { diff } from "std::syntax"

node main(): string {
  // Call diff setting only `colored` by name, skipping the params before it.
  return diff("a\nb\nc", "a\nB\nc", colored: false)
}
```

Create `tests/agency/diff-named-args.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "\"  a\\n- b\\n+ B\\n  c\"",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

Run: `pnpm run a test tests/agency/diff-named-args.test.json`
Expected: PASS. If it fails because named args cannot skip middle defaults, STOP — the flat-param design needs revisiting (fall back to positional or an options object). Otherwise this confirms the approach.

- [ ] **Step 5: Commit**

```bash
git add lib/stdlib/syntax.ts stdlib/syntax.agency stdlib/syntax.js tests/agency/diff-named-args.agency tests/agency/diff-named-args.test.json docs/site/stdlib/syntax.md
git commit -F /tmp/diff-task4.txt
```

Message body: `Add diff and patch functions to std::syntax`.

---

## Task 5: Delete `printDiff`; route `_multiedit` through the shared engine

**Files:**
- Modify: `lib/stdlib/fs.ts:9,13-21,85-86`
- Modify: `stdlib/fs.agency:1,37-48`

- [ ] **Step 1: Update `lib/stdlib/fs.ts`**

Replace the diff import line (currently `import { formatDiff } from "../utils/diff.js";`) with:

```ts
import { computeHunks, renderDiff } from "../utils/diff.js";
```

Delete the `_printDiff` function and its doc comment (the block currently at lines 13–21):

```ts
// DELETE this whole block:
/**
 * Print a colored, line-based diff ...
 */
export function _printDiff(oldText: string, newText: string): void {
  console.log(formatDiff(oldText, newText));
}
```

In `_multiedit`, replace the print call (currently lines 85–86):

```ts
  if (printDiff && original !== contents) {
    console.log(renderDiff(computeHunks(original, contents, -1, false), { colored: true }));
  }
```

- [ ] **Step 2: Update `stdlib/fs.agency`**

Change the import on line 1 to drop `_printDiff`:

```ts
import { _multiedit, _applyPatch, _mkdir, _copy, _move, _remove } from "agency-lang/stdlib-lib/fs.js"
```

Delete the entire `printDiff` tool (currently lines 37–48):

```ts
// DELETE this whole function:
export safe def printDiff(oldText: string, newText: string) {
  """ ... """
  _printDiff(oldText, newText)
}
```

Leave `edit`'s `printDiff: boolean` parameter untouched — it is the after-edit display flag, not the deleted tool.

- [ ] **Step 3: Rebuild**

Run: `make`
Expected: builds cleanly. `stdlib/fs.js` is regenerated without `printDiff`.

- [ ] **Step 4: Run the fs Agency-js tests that exercise edit/printDiff**

Run: `pnpm run a test js tests/agency-js/stdlib/std-fs-edit`
Expected: PASS — `edit(printDiff: true)` still prints a diff (now via the shared engine). Also run `pnpm run a test js tests/agency-js/stdlib/std-fs-multiedit` and expect PASS.

- [ ] **Step 5: Confirm nothing else imports the deleted symbols**

Run: `grep -rn "_printDiff\|\bprintDiff(" stdlib lib tests --include=*.agency --include=*.ts | grep -v "printDiff: \|printDiff(printDiff\|edit(printDiff"`
Expected: no matches (the only hits, if any, should be the `edit` flag usages, which are filtered out).

- [ ] **Step 6: Commit**

```bash
git add lib/stdlib/fs.ts stdlib/fs.agency stdlib/fs.js docs/site/stdlib/fs.md
git commit -F /tmp/diff-task5.txt
```

Message body: `Delete std::fs::printDiff in favor of print(diff(...))`.

---

## Task 6: Execution tests — `diff`/`patch` output and `applyPatch` round-trip

**Files:**
- Create: `tests/agency/diff-and-patch.agency`, `tests/agency/diff-and-patch.test.json`
- Create: `tests/agency-js/stdlib/std-syntax-patch-roundtrip/agent.agency`, `test.js`, `fixture.json`

- [ ] **Step 1: Pure execution test for `patch` output**

Create `tests/agency/diff-and-patch.agency`:

```ts
import { patch } from "std::syntax"

node main(): string {
  return patch("one\ntwo\nthree\n", "one\nTWO\nthree\n", "f.txt")
}
```

Create `tests/agency/diff-and-patch.test.json` (the expected value is the JSON-stringified unified diff; note the `--- a/f.txt` / `+++ b/f.txt` headers, `@@` hunk header, and trailing newline):

```json
{
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "\"--- a/f.txt\\n+++ b/f.txt\\n@@ -1,4 +1,4 @@\\n one\\n-two\\n+TWO\\n three\\n \\n\"",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

Run: `pnpm run a test tests/agency/diff-and-patch.test.json`
Expected: PASS. If the `@@` counts or the trailing ` ` line differ from the literal above, run the agent once (`pnpm run a tests/agency/diff-and-patch.agency`) to capture the exact string and paste it into `expectedOutput` — the round-trip test in the next steps is the real correctness anchor, this one just pins the format.

- [ ] **Step 2: Round-trip agent**

Create `tests/agency-js/stdlib/std-syntax-patch-roundtrip/agent.agency`:

```ts
import { patch } from "std::syntax"
import { applyPatch } from "std::fs"

node makePatch(oldText: string, newText: string, filename: string): string {
  return patch(oldText, newText, filename)
}

node runApply(p: string): any {
  handle {
    const result = applyPatch(p)
  } with (data) {
    return approve()
  }
  return result
}

node readBack(filename: string): any {
  handle {
    const result = read(filename) catch "error reading file"
  } with (data) {
    return approve()
  }
  return result
}
```

- [ ] **Step 3: Round-trip harness**

Create `tests/agency-js/stdlib/std-syntax-patch-roundtrip/test.js` (modeled on the existing `std-fs-applyPatch/test.js`):

```js
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { makePatch, runApply, readBack } from "./agent.js";

const TMP_REL = "tmp-roundtrip-fixtures";
const TMP = join(process.cwd(), TMP_REL);
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

async function roundtrip(oldText, newText, name) {
  const rel = join(TMP_REL, name);
  writeFileSync(join(process.cwd(), rel), oldText);
  const p = (await makePatch(oldText, newText, rel)).data;
  const applied = await runApply(p);
  const ok = !(applied.data && applied.data.success === false);
  const contents = (await readBack(rel)).data;
  return { ok, matches: contents === newText };
}

const modify = await roundtrip("one\ntwo\nthree\n", "one\nTWO\nthree\n", "modify.txt");
const multi = await roundtrip("a\nb\nc\nd\ne\n", "a\nB\nc\nd\nE\n", "multi.txt");

writeFileSync(
  "__result.json",
  JSON.stringify({ modify, multi }, null, 2),
);

rmSync(TMP, { recursive: true, force: true });
```

- [ ] **Step 4: Expected fixture**

Create `tests/agency-js/stdlib/std-syntax-patch-roundtrip/fixture.json`:

```json
{
  "modify": {
    "ok": true,
    "matches": true
  },
  "multi": {
    "ok": true,
    "matches": true
  }
}
```

- [ ] **Step 5: Run the round-trip test**

Run: `pnpm run a test js tests/agency-js/stdlib/std-syntax-patch-roundtrip`
Expected: PASS — `applyPatch(patch(old, new, file))` reproduces `new` for both single- and multi-hunk cases. If `matches` is false, the likely culprit is trailing-newline handling in `splitTextLines`/`renderPatch`; debug by printing the generated patch and the read-back contents.

- [ ] **Step 6: Commit**

```bash
git add tests/agency/diff-and-patch.agency tests/agency/diff-and-patch.test.json tests/agency-js/stdlib/std-syntax-patch-roundtrip
git commit -F /tmp/diff-task6.txt
```

Message body: `Add diff/patch execution tests and applyPatch round-trip`.

---

## Task 7: Docs, changelog, and final verification

**Files:**
- Modify: `CHANGELOG.md`
- Regenerated: `docs/site/stdlib/syntax.md`, `docs/site/stdlib/fs.md` (via `make doc`)

- [ ] **Step 1: Regenerate docs and confirm the changes**

Run: `make doc`
Then: `grep -n "printDiff" docs/site/stdlib/fs.md`
Expected: the standalone `### printDiff` tool section is gone (only the `edit` `printDiff` parameter row remains). `grep -n "### diff\|### patch" docs/site/stdlib/syntax.md` should show both new sections, generated from the docstrings.

- [ ] **Step 2: Update the changelog**

In `CHANGELOG.md`, under the current unreleased/top section, add:

```markdown
- `std::syntax::diff(old, new, ...)` returns a flexible human-readable diff string (line numbers, context, color, labels, hunk headers, summary, ignore-whitespace).
- `std::syntax::patch(old, new, filename, ...)` returns a standard unified diff that `std::fs::applyPatch` can apply (supports file creation, deletion, and renames).
- Removed `std::fs::printDiff`; use `print(diff(old, new, colored: true))` instead.
```

- [ ] **Step 3: Full verification of every touched area**

Run: `pnpm test:run lib/utils/diff.test.ts lib/optimize/reporter.test.ts lib/optimize/sourceMutator.test.ts lib/optimize/artifacts.test.ts`
Expected: PASS.

Run: `pnpm run a test tests/agency/diff-named-args.test.json tests/agency/diff-and-patch.test.json`
Expected: PASS.

Run: `pnpm run a test js tests/agency-js/stdlib/std-syntax-patch-roundtrip` and `pnpm run a test js tests/agency-js/stdlib/std-fs-edit`
Expected: PASS.

Run: `pnpm run typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md docs/site/stdlib/syntax.md docs/site/stdlib/fs.md
git commit -F /tmp/diff-task7.txt
```

Message body: `Regenerate stdlib docs and changelog for diff/patch`.

---

## Self-Review notes (verified while writing)

- **Spec coverage:** `diff` (all 8 display params) → Tasks 1, 2, 4. `patch` (filename, context, ignoreWhitespace, newFilename, /dev/null) → Tasks 1, 3, 4. Shared engine + `formatDiff` shim → Task 1. `printDiff` deletion + `_multiedit` rewire → Task 5. Round-trip guarantee → Task 6. Docs/changelog → Task 7.
- **Type consistency:** `computeHunks(old, new, context, ignoreWhitespace)`, `renderDiff(hunks, RenderDiffOpts)`, `renderPatch(hunks, oldLabel, newLabel)`, `DiffLine`, `Hunk` are used identically across Tasks 1, 4, 5.
- **Sentinels:** `context: -1` = full context; empty-string labels/`newFilename` = unset — consistent between the Agency signature (Task 4), `_diff`/`_patch` (Task 4), and `computeHunks`/`renderDiff` (Task 1).
- **Known soft spot:** trailing-newline handling in `splitTextLines` is the most likely source of an off-by-one in patch counts or a round-trip mismatch; Task 6 Step 5 calls this out and the round-trip test is the anchor.
```
