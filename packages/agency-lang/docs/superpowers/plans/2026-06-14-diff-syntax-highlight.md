# Syntax-highlighted tinted diff mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `language` parameter to `std::syntax::diff` that renders changed lines with a dim red/green background and syntax-highlighted code on top, plus a colored line-number gutter.

**Architecture:** `renderDiff` (in `lib/utils/diff.ts`) keeps the shared scaffold (hunks, gutter, block width) and gains an injected `renderBody(code, kind, width)` hook for the highlighted code path. The highlighter and background-aware themes live in `lib/stdlib/syntax.ts`, which builds `renderBody` when a language is given and passes it through. `diff.ts` does no syntax highlighting and no escape-code manipulation. The background is produced by cli-highlight itself via a `makeBgTheme(rgb)` theme variant (each palette entry chained with `.bgRgb(...)`), so there is no ANSI post-processing.

**Tech Stack:** TypeScript, cli-highlight (existing), `termcolors` (`color.bgRgb`, chainable), vitest unit tests, Agency-js tests.

**Spec:** `docs/superpowers/specs/2026-06-14-diff-syntax-highlight-design.md`

---

## Background the engineer needs

- **Build:** after changing TS in `lib/` or any `stdlib/*.agency`, run `make` from `packages/agency-lang/`. For TS-only unit tests, `pnpm test:run <path>` (vitest) is enough; the Agency tests need the full `make`.
- **stdlib wiring:** `stdlib/syntax.agency` is a thin wrapper importing TS helpers from `agency-lang/stdlib-lib/syntax.js` → `dist/lib/stdlib/syntax.js` (compiled from `lib/stdlib/syntax.ts`). `stdlib/*.js` and `dist/**` are gitignored build artifacts — never stage them.
- **Color:** use `color` from `lib/utils/termcolors.ts`. Its functions are chainable and lazy: `blue.bgRgb(60,0,0)` returns a new function; calling it on text emits `<fg><bg>text<reset>`. `color.bgRgb(r,g,b)("   ")` yields `\x1b[48;2;r;g;bm   \x1b[0m`.
- **cli-highlight themes:** `highlight(code, { language, theme, ignoreIllegals: true })` where `theme` maps token types → style functions. Every run of text (including whitespace and unmatched text via the `default` style) is passed through a style function, so a theme that sets a background backgrounds the whole line. Verified: per-token `\x1b[0m` resets are zero-width and immediately followed by the next segment's background, so the background is continuous.
- **Agency-js tests** live in `tests/agency-js/stdlib/<name>/` with `agent.agency`, `test.js` (Node harness; imports compiled `agent.js`, writes `__result.json`), `fixture.json` (expected). Run with `pnpm run a test js tests/agency-js/stdlib/<name>`. Generated `agent.js`/`__result.json` are gitignored.
- **Git:** commit messages with apostrophes go via a file (`git commit -F msgfile`). End messages with the `Co-Authored-By` trailer. No amend/force-push. This work starts on a fresh branch off `main` (handled at execution time by the worktree skill).

---

## Current shape (for reference)

`lib/utils/diff.ts` exports `DiffLine` (`{kind: "context"|"delete"|"insert", text, oldNum, newNum}`), `Hunk`, `RenderDiffOpts`, `computeHunks`, `renderDiff`, `renderPatch`, `formatDiff`. `renderDiff` already renders the inline `-`/`+` mode and a line-number gutter via a local `gutter()` closure and `renderHunkBody`/`renderReplacement`. `gutterWidth(hunks)` returns the width of the largest line number.

`lib/stdlib/syntax.ts` defines palette consts (`blue`, `yellow`, … all `color.hex(...)`), `vscodeDarkTheme`, `syntaxHighlight(code, language)` (maps `"agency"`→`"ts"`, special-cases markdown), and `_diff(oldText, newText, context, lineNumbers, color, oldLabel, newLabel, ignoreWhitespace, hunkHeaders, summary)`.

`stdlib/syntax.agency` defines `diff(oldText, newText, context=-1, lineNumbers=false, color="auto", oldLabel="", newLabel="", ignoreWhitespace=false, hunkHeaders=false, summary=false)`.

---

## File Structure

- **Modify** `lib/utils/diff.ts` — add `renderBody` to `RenderDiffOpts`; add `blockWidth` + `highlightGutter`; branch `renderDiff` into the highlighted code path.
- **Modify** `lib/utils/diff.test.ts` — unit tests for the highlighted path with a stub `renderBody`.
- **Modify** `lib/stdlib/syntax.ts` — add `makeBgTheme`, bg constants, `diffBody`; add a `language` param to `_diff` that builds `renderBody`.
- **Create** `lib/stdlib/syntax.test.ts` — unit test the highlighted `_diff` output carries the backgrounds.
- **Modify** `stdlib/syntax.agency` — add `language: string = ""` to `diff` and pass it through.
- **Create** `tests/agency-js/stdlib/std-syntax-diff-highlight/{agent.agency,test.js,fixture.json}` — end-to-end check that `diff(..., color: true, language: "ts")` returns ANSI with both a background and a foreground code.
- **Regenerated (do not hand-edit)** `docs/site/stdlib/syntax.md` — via `make`.

---

## Task 1: `renderBody` hook + highlighted path in `renderDiff`

**Files:**
- Modify: `lib/utils/diff.ts`
- Test: `lib/utils/diff.test.ts`

- [ ] **Step 1: Add `renderBody` to `RenderDiffOpts`**

In `lib/utils/diff.ts`, change the `RenderDiffOpts` type to:

```ts
export type RenderDiffOpts = {
  lineNumbers?: boolean;
  colored?: boolean;
  oldLabel?: string;
  newLabel?: string;
  hunkHeaders?: boolean;
  summary?: boolean;
  // When present and `colored`, renderDiff uses the highlighted code path:
  // each line's body is produced by this function (syntax highlighting +
  // background tint for changed lines), padded to `width` columns.
  renderBody?: (code: string, kind: DiffLine["kind"], width: number) => string;
};
```

- [ ] **Step 2: Add `blockWidth` and `highlightGutter` helpers**

Add these two functions just above `export function renderDiff` in `lib/utils/diff.ts`:

```ts
// Widest raw line in display columns (line text is ANSI-free, so length is the
// visible width). Changed-line backgrounds pad to this so the bars align.
function blockWidth(hunks: Hunk[]): number {
  let max = 0;
  for (const h of hunks) for (const l of h.lines) max = Math.max(max, l.text.length);
  return max;
}

// Gutter for the highlighted path: line number (per side) + the -/+/space
// marker, colored by change kind (sits on the default background, left of the
// tinted code).
function highlightGutter(line: DiffLine, numWidth: number, lineNumbers: boolean): string {
  const marker = line.kind === "delete" ? "-" : line.kind === "insert" ? "+" : " ";
  const num = line.kind === "delete" ? line.oldNum : line.newNum;
  const numStr = lineNumbers ? `${(num === null ? "" : String(num)).padStart(numWidth)} ` : "";
  const cell = `${numStr}${marker} `;
  if (line.kind === "delete") return color.red(cell);
  if (line.kind === "insert") return color.green(cell);
  return color.dim(cell);
}
```

- [ ] **Step 3: Branch `renderDiff` into the highlighted path**

In `renderDiff`, replace the final hunk loop (the block starting `const width = opts.lineNumbers ? gutterWidth(hunks) : 0;` through the `for (const h of hunks) { ... }`) with:

```ts
  const useHighlight = colored && !!opts.renderBody;
  const numWidth = opts.lineNumbers ? gutterWidth(hunks) : 0;
  const blockW = useHighlight ? blockWidth(hunks) : 0;

  const gutter = (l: DiffLine): string => {
    if (!opts.lineNumbers) return "";
    const n = l.kind === "delete" ? l.oldNum : l.newNum;
    return `${(n === null ? "" : String(n)).padStart(numWidth)} `;
  };

  for (const h of hunks) {
    if (opts.hunkHeaders) {
      out.push(paint(color.cyan, `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`));
    }
    if (useHighlight) {
      for (const line of h.lines) {
        out.push(
          highlightGutter(line, numWidth, opts.lineNumbers ?? false) +
            opts.renderBody!(line.text, line.kind, blockW),
        );
      }
    } else {
      renderHunkBody(h.lines, out, colored, gutter);
    }
  }
  return out.join("\n");
```

(The inline path is unchanged; only the new `useHighlight` branch is added.)

- [ ] **Step 4: Write failing tests for the highlighted path**

Append to `lib/utils/diff.test.ts` (the `strip` helper and the `computeHunks`/`renderDiff` imports already exist at the top):

```ts
describe("renderDiff highlighted path", () => {
  // Stub body renderer: marks kind/width/code so we can assert what renderDiff
  // passed, without depending on a real highlighter.
  const stub = (code: string, kind: string, width: number) => `<${kind}:${width}:${code}>`;

  it("uses renderBody per line with the block width and a colored gutter", () => {
    const hunks = computeHunks("aa\nbb\ncc", "aa\nBB\ncc", -1, false);
    const result = renderDiff(hunks, { colored: true, renderBody: stub, lineNumbers: true });
    const lines = strip(result).split("\n");
    // width is the widest line ("aa"/"bb"/... = 2)
    expect(lines).toEqual([
      "1   <context:2:aa>",
      "2 - <delete:2:bb>",
      "2 + <insert:2:BB>",
      "3   <context:2:cc>",
    ]);
    // changed-line gutters are colored red / green
    expect(result).toContain(color.red("2 - "));
    expect(result).toContain(color.green("2 + "));
  });

  it("falls back to inline when not colored, even if renderBody is set", () => {
    const hunks = computeHunks("a", "b", -1, false);
    const withBody = renderDiff(hunks, { colored: false, renderBody: stub });
    const plain = renderDiff(hunks, { colored: false });
    expect(withBody).toBe(plain);
    expect(withBody).not.toContain("<delete");
  });

  it("uses the inline path when renderBody is absent", () => {
    const hunks = computeHunks("a", "b", -1, false);
    expect(renderDiff(hunks, { colored: true })).toBe(
      `${color.red("- ")}${color.red("a")}\n${color.green("+ ")}${color.green("b")}`,
    );
  });
});
```

- [ ] **Step 5: Run the tests**

Run: `pnpm test:run lib/utils/diff.test.ts`
Expected: PASS (existing tests + the 3 new ones). If the gutter spacing assertion differs, print `JSON.stringify(strip(result).split("\n"))` and reconcile the expected array to the produced spacing — the key checks are the `<kind:width:code>` bodies and the red/green gutters.

- [ ] **Step 6: Commit**

```bash
git add lib/utils/diff.ts lib/utils/diff.test.ts
git commit -F /tmp/hl-task1.txt   # "Add renderBody hook and highlighted path to renderDiff"
```

---

## Task 2: background themes + `diffBody` + `language` in `_diff`

**Files:**
- Modify: `lib/stdlib/syntax.ts`
- Create: `lib/stdlib/syntax.test.ts`

- [ ] **Step 1: Add `makeBgTheme`, bg constants, and `diffBody`**

In `lib/stdlib/syntax.ts`, just below the `vscodeDarkTheme` definition (after the `} as unknown as Theme;` line), add:

```ts
// Dim backgrounds for changed lines (RGB), shared by the themes and the
// trailing-pad code so they always match.
const DIM_RED: [number, number, number] = [60, 0, 0];
const DIM_GREEN: [number, number, number] = [0, 45, 0];

// A copy of the VS Code theme with a background chained onto every style, so
// cli-highlight emits the background as part of each token (no ANSI
// post-processing). `default` covers whitespace/unmatched text, so the whole
// line is backgrounded.
function makeBgTheme(rgb: [number, number, number]): Theme {
  const out: Record<string, unknown> = {};
  for (const [token, style] of Object.entries(vscodeDarkTheme as Record<string, (s: string) => string>)) {
    out[token] = (style as unknown as { bgRgb: (r: number, g: number, b: number) => (s: string) => string }).bgRgb(
      ...rgb,
    );
  }
  return out as unknown as Theme;
}

const RED_BG_THEME = makeBgTheme(DIM_RED);
const GREEN_BG_THEME = makeBgTheme(DIM_GREEN);
const redPad = color.bgRgb(...DIM_RED);
const greenPad = color.bgRgb(...DIM_GREEN);

// Render one diff line's body for the highlighted path. Context lines are
// plainly highlighted; changed lines are highlighted with a background theme
// and padded to `width` with the matching background.
function diffBody(
  code: string,
  kind: "context" | "delete" | "insert",
  width: number,
  language: string,
): string {
  if (kind === "context") return syntaxHighlight(code, language);
  const lang = language === "agency" ? "ts" : language;
  const theme = kind === "delete" ? RED_BG_THEME : GREEN_BG_THEME;
  const pad = kind === "delete" ? redPad : greenPad;
  let body: string;
  try {
    body = highlight(code, { language: lang, theme, ignoreIllegals: true });
  } catch {
    body = pad(code); // on highlighter failure, still show the line tinted
  }
  const padLen = Math.max(0, width - code.length);
  return padLen > 0 ? body + pad(" ".repeat(padLen)) : body;
}
```

- [ ] **Step 2: Add the `language` parameter to `_diff`**

Replace the `_diff` function with:

```ts
export function _diff(
  oldText: string,
  newText: string,
  context: number,
  lineNumbers: boolean,
  color: "auto" | boolean,
  oldLabel: string,
  newLabel: string,
  ignoreWhitespace: boolean,
  hunkHeaders: boolean,
  summary: boolean,
  language: string,
): string {
  const hunks = computeHunks(oldText, newText, context, ignoreWhitespace);
  const colored = color === "auto" ? autoUseColor() : color === true;
  const renderBody = language
    ? (code: string, kind: "context" | "delete" | "insert", width: number) =>
        diffBody(code, kind, width, language)
    : undefined;
  return renderDiff(hunks, {
    lineNumbers,
    colored,
    oldLabel,
    newLabel,
    hunkHeaders,
    summary,
    renderBody,
  });
}
```

Note: there is a parameter named `color` and a module import named `color` (termcolors). The existing `_diff` already shadows the import with the `color` parameter and only uses `autoUseColor()`; `diffBody`/`makeBgTheme` use the module `color` and are defined at module scope (outside `_diff`), so there is no conflict.

- [ ] **Step 3: Write failing tests for the highlighted `_diff`**

Create `lib/stdlib/syntax.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { _diff } from "./syntax.js";

// The dim-red / dim-green background SGR codes diffBody emits.
const RED_BG = "\x1b[48;2;60;0;0m";
const GREEN_BG = "\x1b[48;2;0;45;0m";

describe("_diff highlighted mode", () => {
  // color: true forces coloring on regardless of TTY.
  const run = (oldT: string, newT: string) =>
    _diff(oldT, newT, -1, false, true, "", "", false, false, false, "ts");

  it("backgrounds a deleted line in red and an inserted line in green", () => {
    const out = run("const x = 1", "const x = 2");
    expect(out).toContain(RED_BG);
    expect(out).toContain(GREEN_BG);
    // and it is syntax-highlighted (a foreground truecolor code is present)
    expect(out).toMatch(/\x1b\[38;2;/);
  });

  it("does not background context lines", () => {
    // line 1 unchanged, line 2 changed
    const out = run("keep\nconst x = 1", "keep\nconst x = 2");
    const firstLine = out.split("\n")[0];
    expect(firstLine).not.toContain(RED_BG);
    expect(firstLine).not.toContain(GREEN_BG);
  });

  it("ignores language when color is off (plain inline diff, no ANSI)", () => {
    const out = _diff("a", "b", -1, false, false, "", "", false, false, false, "ts");
    expect(out).not.toContain("\x1b");
    expect(out).toBe("- a\n+ b");
  });
});
```

- [ ] **Step 4: Build and run**

Run: `pnpm run build && pnpm test:run lib/stdlib/syntax.test.ts`
Expected: PASS. If the green bg literal differs, confirm the constant: `node -e "import('./dist/lib/utils/termcolors.js').then(m=>process.stdout.write(JSON.stringify(m.color.bgRgb(0,45,0)('x'))))"` and update `GREEN_BG`/`RED_BG` in the test to the real opening code.

- [ ] **Step 5: Commit**

```bash
git add lib/stdlib/syntax.ts lib/stdlib/syntax.test.ts
git commit -F /tmp/hl-task2.txt   # "Add background-themed highlighting for diff changed lines"
```

---

## Task 3: expose `language` on the Agency `diff` tool

**Files:**
- Modify: `stdlib/syntax.agency`

- [ ] **Step 1: Add the `language` parameter**

In `stdlib/syntax.agency`, change the `diff` function signature and body. Add `language: string = ""` as the last parameter, document it, and pass it to `_diff`:

```ts
export safe def diff(
  oldText: string,
  newText: string,
  context: number = -1,
  lineNumbers: boolean = false,
  color: "auto" | boolean = "auto",
  oldLabel: string = "",
  newLabel: string = "",
  ignoreWhitespace: boolean = false,
  hunkHeaders: boolean = false,
  summary: boolean = false,
  language: string = "",
): string {
  """
  Produce a human-readable diff of two strings and return it as a string.
  Shows the full text by default with changed words highlighted via `-`/`+`
  lines.

  @param oldText - The original text
  @param newText - The updated text
  @param context - Unchanged lines to keep around each change; -1 means show the full text
  @param lineNumbers - Prefix each line with its line number
  @param color - `"auto"` (default) emits ANSI colors only when stdout is a TTY; `true` always; `false` never. Coloring highlights deletions in red and insertions in green inline.
  @param oldLabel - When non-empty, render a `--- <oldLabel>` header
  @param newLabel - When non-empty, render a `+++ <newLabel>` header
  @param ignoreWhitespace - Treat whitespace-only changes as equal
  @param hunkHeaders - Emit `@@ -l,c +l,c @@` separators between change regions
  @param summary - Prefix the diff with an "N insertions, M deletions" line
  @param language - When non-empty (e.g. "agency", "ts", "python") and color is on, render changed lines with a dim red/green background and syntax-highlighted code instead of inline `-`/`+` coloring
  """
  return _diff(oldText, newText, context, lineNumbers, color, oldLabel, newLabel, ignoreWhitespace, hunkHeaders, summary, language)
}
```

- [ ] **Step 2: Build everything**

Run: `make`
Expected: completes without error (recompiles `stdlib/syntax.agency` → `stdlib/syntax.js`, regenerates `docs/site/stdlib/syntax.md`).

- [ ] **Step 3: Smoke-test from Agency**

Create `tests/agency/diff-highlight.agency`:

```ts
import { diff } from "std::syntax"

node main(): string {
  return diff("const x = 1", "const x = 2", color: true, language: "ts")
}
```

Run: `pnpm run a tests/agency/diff-highlight.agency`
Expected: prints a diff where the two changed lines have colored backgrounds and the code is syntax-highlighted (visually inspect). Then delete the scratch file: `rm tests/agency/diff-highlight.agency`.

- [ ] **Step 4: Commit**

```bash
git add stdlib/syntax.agency docs/site/stdlib/syntax.md
git commit -F /tmp/hl-task3.txt   # "Add language option to std::syntax::diff"
```

---

## Task 4: end-to-end Agency-js test

**Files:**
- Create: `tests/agency-js/stdlib/std-syntax-diff-highlight/agent.agency`
- Create: `tests/agency-js/stdlib/std-syntax-diff-highlight/test.js`
- Create: `tests/agency-js/stdlib/std-syntax-diff-highlight/fixture.json`

- [ ] **Step 1: Agent**

Create `tests/agency-js/stdlib/std-syntax-diff-highlight/agent.agency`:

```ts
import { diff } from "std::syntax"

node highlightedDiff(oldText: string, newText: string): string {
  return diff(oldText, newText, color: true, language: "ts")
}

node plainDiff(oldText: string, newText: string): string {
  return diff(oldText, newText, color: true)
}
```

- [ ] **Step 2: Harness**

Create `tests/agency-js/stdlib/std-syntax-diff-highlight/test.js`:

```js
import { writeFileSync } from "fs";
import { highlightedDiff, plainDiff } from "./agent.js";

const RED_BG = "\x1b[48;2;60;0;0m";
const GREEN_BG = "\x1b[48;2;0;45;0m";

const hl = (await highlightedDiff("const x = 1", "const x = 2")).data;
const plain = (await plainDiff("const x = 1", "const x = 2")).data;

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      highlighted: {
        hasRedBg: hl.includes(RED_BG),
        hasGreenBg: hl.includes(GREEN_BG),
        hasForeground: /\x1b\[38;2;/.test(hl),
      },
      // plain mode (no language) must NOT use a background tint
      plain: {
        hasBg: plain.includes(RED_BG) || plain.includes(GREEN_BG),
      },
    },
    null,
    2,
  ),
);
```

- [ ] **Step 3: Expected fixture**

Create `tests/agency-js/stdlib/std-syntax-diff-highlight/fixture.json`:

```json
{
  "highlighted": {
    "hasRedBg": true,
    "hasGreenBg": true,
    "hasForeground": true
  },
  "plain": {
    "hasBg": false
  }
}
```

- [ ] **Step 4: Run**

Run: `pnpm run a test js tests/agency-js/stdlib/std-syntax-diff-highlight`
Expected: `1/1 TS tests passed`. If `hasRedBg`/`hasGreenBg` are false, confirm the exact bg opening codes (same `node -e` check as Task 2 Step 4) and update both `test.js` and the assumption — the codes must match `color.bgRgb(60,0,0)` / `color.bgRgb(0,45,0)`.

- [ ] **Step 5: Commit**

```bash
git add tests/agency-js/stdlib/std-syntax-diff-highlight/agent.agency \
  tests/agency-js/stdlib/std-syntax-diff-highlight/test.js \
  tests/agency-js/stdlib/std-syntax-diff-highlight/fixture.json
git commit -F /tmp/hl-task4.txt   # "Add end-to-end test for highlighted diff mode"
```

---

## Task 5: final verification

**Files:** none (verification only)

- [ ] **Step 1: Full affected-suite run**

Run: `pnpm test:run lib/utils/diff.test.ts lib/stdlib/syntax.test.ts lib/optimize/reporter.test.ts lib/optimize/sourceMutator.test.ts`
Expected: all PASS (the optimizer suites confirm the inline `formatDiff` path is unchanged).

- [ ] **Step 2: Typecheck**

Run: `pnpm run typecheck`
Expected: exit 0, no `error TS`.

- [ ] **Step 3: Agency-js regressions for the fs/syntax tools**

Run: `pnpm run a test js tests/agency-js/stdlib/std-syntax-diff-highlight tests/agency-js/stdlib/std-syntax-patch-roundtrip tests/agency-js/stdlib/std-fs-edit`
Expected: all PASS.

- [ ] **Step 4: Confirm the generated doc shows the new param**

Run: `grep -n "language" docs/site/stdlib/syntax.md`
Expected: the `diff` signature and `@param language` line are present.

---

## Self-Review notes (verified while writing)

- **Spec coverage:** `language` trigger + color-off fallback → Tasks 2, 3 (and the `useHighlight = colored && renderBody` gate in Task 1). Injected `renderBody` architecture → Task 1. Background-aware themes (no post-processing) + `makeBgTheme` + bg colors in syntax.ts → Task 2. Gutter coloring + block-width padding → Tasks 1, 2. Context lines untinted → Task 2 `diffBody` + Task 1 test. Tests (stub renderBody; bg present; agency e2e) → Tasks 1, 2, 4.
- **Type consistency:** `renderBody(code: string, kind: "context"|"delete"|"insert", width: number) => string` is identical in `RenderDiffOpts` (Task 1), `_diff` (Task 2), and the stub (Task 1 test). `diffBody` signature matches its call site. `DIM_RED`/`DIM_GREEN` feed both the themes and the pad functions.
- **No placeholders:** every code step shows full code; commands have expected output.
- **Known soft spots called out:** exact bg SGR literals in tests (Task 2/4 give a `node -e` to confirm); gutter spacing in the Task 1 assertion (reconcile-to-actual note). Block width uses `string.length` (display columns), which can misalign on tabs/wide chars — acceptable for source-line diffs.
