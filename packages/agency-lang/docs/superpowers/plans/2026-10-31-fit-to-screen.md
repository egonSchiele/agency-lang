# Fit Tables and Diffs to the Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tables from `std::ui/table` and highlighted diffs from `std::syntax` never come out wider than the terminal, and the skill review prompt shows the skill instead of only its name.

**Architecture:** The layout module learns to shrink a table's widest columns until the table fits the width it is given, which is the terminal width when nothing else says otherwise. The diff renderer stops padding its colored bars past the terminal's edge. The approval prompt renders its table at the width the prompt wraps to, and the skill review interrupt prints the skill above the prompt, the same way edits print their diff.

**Tech Stack:** TypeScript (vitest), Agency stdlib (`.agency`), agency-js tests.

**Spec:** None. This plan comes from an investigation in conversation. The Background section below records what was found and stands in for a spec.

## Background

### What the user saw

When `agency agent` learns a skill, it raises a `std::skills::review` interrupt with four fields: `dir`, `name`, `description`, and `body`. The approval policy draws them as a two-column table (`prettyPrintInterruptData` in `stdlib/policy.agency`). Two things went wrong:

1. The table was wider than the terminal. In the short view, the prompt wrapped every table line again, so the top border took three rows and the `dir` row took two. The prompt shows at most six rows of body, so only `dir` and `name` fit, and the description and body never appeared.
2. Pressing `v` printed the whole table unchanged, and the terminal wrapped each over-wide line. Each row was padded with spaces out to the width of the description, so a row of spaces and a stray `│` followed every row.

The same session showed a second bug in a `std::edit` prompt. The diff printed above the prompt had solid green blank rows after every added line.

### Why the table is too wide

Nothing in the table code ever compares the table to the screen.

- `sizeTable` (`lib/stdlib/layout/table.ts:616`) takes the table's width from its own `width` setting and nothing else. The policy sets none, so the table has no width. The layout context carries the terminal width as `availableWidth` (set in `resolveSizes`, `lib/stdlib/layout/render.ts:114`), and plain text wraps at it (`wrapWidthFor`, `lib/stdlib/layout/nodes.ts:155`), but the table ignores it.
- `resolveColumnWidths` (`lib/utils/columnWidths.ts:31`) gives each column with no width setting the width of its longest cell (`fixedWidthFor`, line 66). The space left over is only used by columns set as a percentage. No step makes a column narrower.
- A text cell wraps at its column's width, and every column is as wide as its longest cell, so nothing wraps.

A reproduction at an 80-column viewport, with rows `dir`, `name`, and a 150-character description, rendered every line 174 characters wide. Setting `width: "full"` on the table made the frame 80 wide but left the columns at 174, so that is broken too.

### Why the prompt wraps the table a second time

The footer wraps its body to `max(20, columns - 1) - 1` columns and indents it by one (`bodyLines` and `renderInterruptFooter`, `lib/stdlib/cli.ts:566-600`). Even a table that fits the terminal exactly is two columns too wide for that and gets wrapped again. So the policy has to render the table at the prompt's width, not the terminal's.

### Why the diff has blank green rows

With a language set, `diff()` gives each changed line a red or green background and pads it with spaces to the widest line in the whole diff (`blockWidth`, `lib/utils/diff.ts:261`, used by `diffBody` in `lib/stdlib/syntax.ts:44`). The skill file has a one-line `description:` of over 300 characters, so every changed line was padded to about 300 columns, and the terminal wrapped the padding onto the next rows. Unchanged lines get no background and no padding, which is why they looked normal.

### Why the skill should print above the prompt

Even once the table fits, six rows hold a border, `dir`, `name`, and part of the description. The policy already has a rule for interrupts whose content is the thing being judged: `renderInterruptDiff` prints the change above the prompt, and the prompt's table keeps only the short fields that name it (see "Code changes are shown as a diff" in `docs/dev/agents/approval-policies.md`). A skill draft is that kind of content, so it should follow the same rule.

## Global Constraints

- Use types, not interfaces; objects, not maps; arrays, not sets. No dynamic imports.
- `lib/tui/table.ts` also calls `resolveColumnWidths`. The TUI table's behavior must not change, so do not change what `resolveColumnWidths` returns. Shrinking is a new function that only the stdlib table calls.
- A table that already fits keeps its natural width. Only a table wider than its limit changes.
- Columns with a fixed width (`{ width: 30 }`) or a percentage width are never shrunk. Only columns with no width setting are.
- Text the agent or a model wrote goes through `stripControlChars` before it reaches the terminal, as the existing policy code does.
- Run `make` after changing any file in `stdlib/`. Run `pnpm run fmt:ts` on the TypeScript files you changed, by name. Run `pnpm run typecheck` after each task.
- Save test output to a file and read the file, so a failure never needs a second run.
- Commit messages go in a file and are passed with `git commit -F`.

## Review Focus

1. **A table inside a box or column.** The cap must be the container's inner width, not the terminal's, so a bordered box holding a table still lines up. Test in Task 1.
2. **A title longer than the limit.** Today an unsized table grows to fit its title. With a limit, the title must wrap inside the frame instead. Test in Task 1.
3. **Output that is not a terminal.** With no terminal, the viewport defaults to 80 columns (`DEFAULT_VIEWPORT`, `render.ts:24`), so a piped program's tables now wrap at 80, as its plain text already does. A diff with no terminal keeps its old behavior, because Task 3 only caps when the terminal size is known. Test in Task 3.
4. **A table that cannot fit even fully shrunk**, for example a fixed 50-column first column on a 40-column screen. It should overflow as before, never shrink a column below its `minWidth`, and never throw. Test in Task 1.
5. **An agent-written skill with control characters in its description or body.** The new preview must strip them, as the tool review diff does. Test in Task 4.

---

### Task 1: Tables shrink to fit their width

**Files:**
- Modify: `lib/utils/columnWidths.ts` (add `fitColumnWidths`)
- Modify: `lib/stdlib/layout/table.ts:253-291` (`_resolveTableWidths`), `:525-605` (`composeTable` title handling), `:616-620` (`sizeTable`)
- Modify: `stdlib/ui/table.agency:117-160` (the `width` docstring on `table()`)
- Test: `lib/utils/columnWidths.test.ts`, `lib/stdlib/layout.test.ts`
- Create: `docs/dev/stdlib/ui-layout-widths.md`, with pointers in `CLAUDE.md` (Standard library section) and `.claude/skills/agency-stdlib-docs/SKILL.md`

**Interfaces:**
- Produces: `fitColumnWidths(widths: number[], plan: ColumnPlan[], available: number): number[]` in `lib/utils/columnWidths.ts`.
- Produces: `_resolveTableWidths(node: LayoutNode, resolvedWidth: number | undefined, maxWidth: number | undefined): LayoutNode`. It writes `attrs.maxWidth` when `maxWidth` is defined, and `composeTable` reads it.

- [ ] **Step 1: Write the failing unit tests for `fitColumnWidths`**

Add a `describe("fitColumnWidths")` block to `lib/utils/columnWidths.test.ts`, reusing the file's `natural` and `cells` helpers. Give each plan entry its real `index`.

```ts
it("leaves widths alone when they already fit", () => {
  expect(fitColumnWidths([10, 20], [natural(10), natural(20)], 40)).toEqual([10, 20]);
});
it("shrinks only the widest column when that is enough", () => {
  expect(fitColumnWidths([11, 150], [natural(11), natural(150)], 73)).toEqual([11, 62]);
});
it("levels the widest columns down together", () => {
  expect(fitColumnWidths([30, 30, 5], [natural(30), natural(30), natural(5)], 45)).toEqual([20, 20, 5]);
});
it("gives an odd leftover cell to the leftmost shrunk column", () => {
  expect(fitColumnWidths([30, 30], [natural(30), natural(30)], 41)).toEqual([21, 20]);
});
it("never shrinks a fixed-width column", () => {
  expect(fitColumnWidths([30, 200], [cells(30), natural(200)], 33)).toEqual([30, 3]);
});
it("stops at minWidth and leaves the table too wide", () => {
  const plan: ColumnPlan[] = [
    { index: 0, parsed: null, natural: 1, minWidth: 50 },
    { index: 1, parsed: null, natural: 200, minWidth: 0 },
  ];
  expect(fitColumnWidths([50, 200], plan, 33)).toEqual([50, 1]);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm vitest run lib/utils/columnWidths.test.ts > /tmp/fit-task1-unit.log 2>&1; tail -30 /tmp/fit-task1-unit.log`
Expected: FAIL, because `fitColumnWidths` is not exported.

- [ ] **Step 3: Implement `fitColumnWidths` in `lib/utils/columnWidths.ts`**

A column can shrink only when `plan[i].parsed === null`. Its floor is `Math.max(plan[i].minWidth, 1)`. If the widths already add up to `available` or less, return them unchanged. Otherwise lower the widest shrinkable columns together to one level:

```
find the largest level L where
  sum over shrinkable columns of max(floor_i, min(width_i, L))
  + sum of the other columns' widths  <=  available
set each shrinkable column to max(floor_i, min(width_i, L))
hand any cells still left over, one each, to the columns that were cut
  to exactly L, from left to right
if even every floor does not fit, return the floors (the table overflows)
```

Add a comment above the function saying it is the stdlib table's shrink step and that the TUI table does not call it.

- [ ] **Step 4: Run the unit tests and confirm they pass**

Run: `pnpm vitest run lib/utils/columnWidths.test.ts > /tmp/fit-task1-unit.log 2>&1; tail -30 /tmp/fit-task1-unit.log`
Expected: PASS, including the existing `resolveColumnWidths` tests.

- [ ] **Step 5: Write the failing layout tests**

Add `describe("table — fits its width")` to `lib/stdlib/layout.test.ts`, after the `"table — width resolution"` block. Use the file's `tableNode`, `_internal.resolveSizes`, `_internal.visualWidth`, and `stripAnsi`, and render with `render(tree, { cols: 40, rows: 24 })` so the viewport is explicit. A two-column table with padding 1 and a divider has 7 columns of chrome (`_tableChromeWidth(2, 1, true)`).

```ts
const long = "word ".repeat(40).trim();

test("an unsized table wider than the viewport shrinks its widest column", () => {
  const tree = tableNode({ body: [["dir", "/a"], ["description", long]] });
  const resolved = _internal.resolveSizes(tree, { cols: 40, rows: 24 });
  expect(resolved.attrs.resolvedColumnWidths).toEqual([11, 22]);
  const lines = stripAnsi(render(tree, { cols: 40, rows: 24 })).split("\n");
  expect(Math.max(...lines.map(_internal.visualWidth))).toBe(40);
});

test("a table that fits keeps its natural width", () => {
  const lines = stripAnsi(render(tableNode({ body: [["a", "b"]] }), { cols: 40, rows: 24 })).split("\n");
  expect(lines.map(_internal.visualWidth)).toEqual([9, 9, 9]);
});

test("width: 'full' shrinks unsized columns to the frame", () => {
  const lines = stripAnsi(render(tableNode({ width: "full", body: [["k", long]] }), { cols: 40, rows: 24 })).split("\n");
  expect(lines.every((line) => _internal.visualWidth(line) === 40)).toBe(true);
});

test("a table inside a sized box fits the box, not the viewport", () => {
  const box = node("box", { width: 30, border: true }, [tableNode({ body: [["k", long]] })]);
  const lines = stripAnsi(render(box, { cols: 80, rows: 24 })).split("\n");
  expect(Math.max(...lines.map(_internal.visualWidth))).toBe(30);
});

test("a title longer than the viewport wraps inside the frame", () => {
  const title = "a long title ".repeat(10).trim();
  const lines = stripAnsi(render(tableNode({ title, body: [["x"]] }), { cols: 30, rows: 24 })).split("\n");
  expect(Math.max(...lines.map(_internal.visualWidth))).toBeLessThanOrEqual(30);
  expect(lines.join(" ")).toContain("a long");
});

test("a fixed column that cannot fit overflows without throwing", () => {
  const tree = tableNode({ columns: [{ width: 50 }, {}], body: [["x", long]] });
  const resolved = _internal.resolveSizes(tree, { cols: 40, rows: 24 });
  expect(resolved.attrs.resolvedColumnWidths).toEqual([50, 1]);
});
```

Check how the file's `node(...)` helper builds a box (line 16) and what attribute turns on a box border, and adjust the box test to match. The box test is there to show the cap comes from the container.

- [ ] **Step 6: Run the layout tests and confirm the new ones fail**

Run: `pnpm vitest run lib/stdlib/layout.test.ts > /tmp/fit-task1-layout.log 2>&1; grep -E "✓|✗|×|FAIL|Tests" /tmp/fit-task1-layout.log | tail -40`
Expected: the new tests FAIL; every existing test passes.

- [ ] **Step 7: Wire the limit through the table**

- `sizeTable` calls `_resolveTableWidths(node, resolveOwnWidth(node, ctx), ctx.availableWidth)`.
- In `_resolveTableWidths`, keep the call to `resolveColumnWidths` as it is, so percentage columns still need an explicit table width. Then, with `limit = resolvedWidth ?? maxWidth`, when `limit` is defined, pass the result through `fitColumnWidths(widths, plan, Math.max(0, limit - chrome))`. Write `maxWidth` onto the attrs.
- In `composeTable`, a table with no `resolvedWidth` but with a `maxWidth` must not grow past `maxWidth` for its title. When `minWidthForTitle(title)` would make it wider, place the title with `placeTitle(title, innerWidth, titleStyle)` (and `wrapText` when frameless), as the resolved-width case does. The table does not pad out to `maxWidth`; `growToWidth` stays for `resolvedWidth` only.

- [ ] **Step 8: Run the layout tests and confirm they pass**

Run: `pnpm vitest run lib/stdlib/layout.test.ts lib/utils/columnWidths.test.ts lib/tui > /tmp/fit-task1-layout.log 2>&1; grep -E "FAIL|Tests" /tmp/fit-task1-layout.log | tail -20`
Expected: PASS for all of them. The `lib/tui` tests are there to prove the TUI table did not change. If an existing layout test relied on a table wider than its viewport, read the test before changing it: if it was checking the old overflow on purpose, update it and say so in the commit message.

- [ ] **Step 9: Update the `table()` docstring and write the dev doc**

In `stdlib/ui/table.agency`, the `width` param becomes: "Table width in cells, or "full" / "N%". With no width, the table is as wide as its content but never wider than the terminal or the box it sits in: the widest columns wrap first. Columns with their own fixed or percentage width never shrink."

Create `docs/dev/stdlib/ui-layout-widths.md`. It covers: the limit each node gets (`availableWidth`, the terminal at the root, a container's inner width below it); the table's shrink rule (widest columns first, only unsized columns, `minWidth` floor, overflow when even the floors do not fit); why `fitColumnWidths` is separate from `resolveColumnWidths` (the TUI table); the title rule; that a table with no terminal wraps at 80 like text; and the diff bar cap from Task 3 (add that paragraph in Task 3). Add a one-line pointer under "Standard library" in `CLAUDE.md` and in `.claude/skills/agency-stdlib-docs/SKILL.md`.

Run `make`, then `pnpm run fmt:ts` on the changed `.ts` files by name, then `pnpm run typecheck > /tmp/fit-typecheck.log 2>&1; tail -5 /tmp/fit-typecheck.log`. Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add lib/utils/columnWidths.ts lib/utils/columnWidths.test.ts lib/stdlib/layout/table.ts lib/stdlib/layout.test.ts stdlib/ui/table.agency docs/dev/stdlib/ui-layout-widths.md CLAUDE.md .claude/skills/agency-stdlib-docs/SKILL.md
git commit -F /tmp/fit-task1-msg.txt   # "std::ui/table: shrink the widest columns to fit the screen"
```

Also add any generated `docs/site/stdlib` page that `make` changed.

---

### Task 2: The approval prompt renders its table at the prompt's width

**Files:**
- Modify: `lib/stdlib/cli.ts:540-600` (`bodyLines`, `bodyIsTruncated`, `renderInterruptFooter`), and add `_interruptBodyWidth` next to `_termWidth` (line 1819)
- Modify: `stdlib/ui/cli.agency` (import `_interruptBodyWidth`, add `interruptBodyWidth()` next to `interruptChoice`)
- Modify: `stdlib/policy.agency:849-921` (`prettyPrintInterruptData`, `renderObjAsTable`), `:975` (`askUser`)
- Test: `lib/stdlib/cli.test.ts` (the `renderInterruptFooter` block, line 709); create `tests/agency-js/policy-prompt-fits-width/` (`agent.agency`, `test.js`, `fixture.json`)
- Modify: `docs/dev/agents/approval-policies.md` ("Reading what you are approving")

**Interfaces:**
- Consumes: Task 1's table limit (`render(node, cols: N)` now fits the table to `N`).
- Produces: `interruptBodyWidth(columns: number): number` in `lib/stdlib/cli.ts` (pure, on `_internal`), `_interruptBodyWidth(): number` (reads the terminal), and `export def interruptBodyWidth(): number` in `std::ui/cli`.
- Produces: `prettyPrintInterruptData(data: any, effect: string = "", cols: number = 0): string` and `renderObjAsTable(obj, excludeKeys: string[] = null, cols: number = 0): string`. Task 4 passes `cols` through.

- [ ] **Step 1: Write the failing unit tests**

In `lib/stdlib/cli.test.ts`, inside `describe("renderInterruptFooter")`:

```ts
it("interruptBodyWidth is the width the footer wraps its body to", () => {
  expect(_internal.interruptBodyWidth(60)).toBe(58);
  expect(_internal.interruptBodyWidth(10)).toBe(19);
});

it("a body line exactly interruptBodyWidth wide is not wrapped again", () => {
  const body = "x".repeat(_internal.interruptBodyWidth(60));
  const lines = _internal.renderInterruptFooter({ ...base, body, columns: 60 });
  expect(lines.filter((line) => line.includes("xxxxxxxx")).length).toBe(1);
});
```

`base` is the fixture the block already defines.

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm vitest run lib/stdlib/cli.test.ts > /tmp/fit-task2-cli.log 2>&1; grep -E "FAIL|Tests" /tmp/fit-task2-cli.log | tail`
Expected: FAIL, because `interruptBodyWidth` is not on `_internal`.

- [ ] **Step 3: Implement the width helper and use it in the footer**

`interruptBodyWidth(columns)` returns `Math.max(MIN_FOOTER_WIDTH, columns - 1) - 1`. `bodyLines` takes this wrap width directly instead of computing `width - 1` itself, and both `renderInterruptFooter` and `bodyIsTruncated` get it from `interruptBodyWidth`, so the footer and the policy cannot drift apart. Add it to `_internal`. `_interruptBodyWidth()` returns `interruptBodyWidth(process.stdout.columns || 80)`, the same fallback `_termWidth` uses.

- [ ] **Step 4: Run the cli tests and confirm they pass**

Run: `pnpm vitest run lib/stdlib/cli.test.ts > /tmp/fit-task2-cli.log 2>&1; grep -E "FAIL|Tests" /tmp/fit-task2-cli.log | tail`
Expected: PASS, including the existing footer tests.

- [ ] **Step 5: Expose it and pass it from the policy**

In `stdlib/ui/cli.agency`, add `@capabilities(terminal) export def interruptBodyWidth(): number`, with the docstring "The width, in columns, that the approval prompt wraps its body to. Render a table at this width so the prompt does not wrap it a second time."

In `stdlib/policy.agency`, add the `cols` parameter to `prettyPrintInterruptData` and `renderObjAsTable`, and call `render(paramTable, cols: cols)` in both the array branch and `renderObjAsTable`. The recursive calls for nested values keep the default `0`. `askUser` calls `prettyPrintInterruptData(intr.data, intr.effect, cols: interruptBodyWidth())`.

- [ ] **Step 6: Write the agency-js test**

Create `tests/agency-js/policy-prompt-fits-width/`, modeled on `tests/agency-js/policy-prompt-array-data/`. The agent raises one `std::edit` whose `dir` is `"/work/" + "a".repeat(200)`, with short `filename`, `before`, and `after`, inside `handle { … } with (data) { return handler(data) }`. `test.js` answers `"a"`, captures `console.log` like `policy-code-diffs/test.js` does, strips ANSI, and writes:

```js
{
  // The prompt's table, found by its border characters.
  tableLinesFit: tableLines.length > 0 && tableLines.every((line) => line.length <= 78),
  // The long dir is still all there, wrapped across rows.
  dirKept: tableLines.join("").replace(/[│\s]/g, "").includes("a".repeat(200)),
}
```

where `tableLines` is every printed line containing `│`. `dirKept` reads only those lines, because the "approve always here" option also prints the dir. 78 is `interruptBodyWidth()` at the 80-column fallback, since the test has no terminal. `fixture.json` expects both `true`.

- [ ] **Step 7: Build and run the agency-js tests**

Run: `make > /tmp/fit-make.log 2>&1; tail -5 /tmp/fit-make.log`, then `pnpm run agency test js tests/agency-js/policy-prompt-fits-width > /tmp/fit-task2-js.log 2>&1; tail -20 /tmp/fit-task2-js.log`, then the same for `tests/agency-js/policy-prompt-array-data` and `tests/agency-js/policy-code-diffs`.
Expected: all three PASS.

- [ ] **Step 8: Update the dev doc and commit**

In `docs/dev/agents/approval-policies.md`, "Reading what you are approving", add one paragraph: the policy renders the interrupt's table at `interruptBodyWidth()`, the width the footer wraps to, because a table rendered at the terminal width is two columns too wide for the footer and gets wrapped a second time. Run `pnpm run fmt:ts` on `lib/stdlib/cli.ts` and `lib/stdlib/cli.test.ts`, and `pnpm run typecheck`. Commit ("Approval prompt: render the data table at the prompt's width").

---

### Task 3: Diff bars stop at the terminal's edge

**Files:**
- Modify: `lib/utils/diff.ts` (`RenderDiffOpts`, around line 30; `renderDiff`, line 281)
- Modify: `lib/stdlib/syntax.ts:150-190` (`_diff`)
- Modify: `stdlib/syntax.agency:139-170` (the `language` docstring on `diff()`)
- Test: `lib/utils/diff.test.ts` (the `"renderDiff highlighted path"` block, line 201)
- Modify: `docs/dev/stdlib/ui-layout-widths.md` (from Task 1)

**Interfaces:**
- Produces: `RenderDiffOpts.maxWidth?: number`, the full width of one output line, gutter included. Undefined means no cap.

- [ ] **Step 1: Write the failing tests**

In `describe("renderDiff highlighted path")`, using the block's `stub`, `strip`, and `computeHunks`:

```ts
it("caps the bar width at maxWidth minus the gutter", () => {
  const hunks = computeHunks("aa\nbb", "aa\n" + "B".repeat(300), -1, false);
  const lines = strip(renderDiff(hunks, { colored: true, renderBody: stub, lineNumbers: true, maxWidth: 80 })).split("\n");
  // gutter "2 + " is 4 columns, so the bar is 76
  expect(lines).toContain(`2 + <insert:76:${"B".repeat(300)}>`);
});

it("caps without line numbers using the 2-column marker", () => {
  const hunks = computeHunks("aa", "B".repeat(300), -1, false);
  const result = strip(renderDiff(hunks, { colored: true, renderBody: stub, maxWidth: 80 }));
  expect(result).toContain("<insert:78:");
});

it("keeps the widest-line width when it is under maxWidth", () => {
  const hunks = computeHunks("aa\nbb", "aa\nBB", -1, false);
  const result = strip(renderDiff(hunks, { colored: true, renderBody: stub, lineNumbers: true, maxWidth: 80 }));
  expect(result).toContain("<insert:2:BB>");
});
```

The existing test `"uses renderBody per line with the block width and a colored gutter"` already covers the case with no `maxWidth`.

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm vitest run lib/utils/diff.test.ts > /tmp/fit-task3.log 2>&1; grep -E "FAIL|Tests" /tmp/fit-task3.log | tail`
Expected: the first two FAIL with width 300 in place of 76 and 78.

- [ ] **Step 3: Implement the cap**

In `renderDiff`, the gutter is `(lineNumbers ? numWidth + 1 : 0) + 2` columns (the number, a space, then the `-`/`+`/space marker and a space). When `opts.maxWidth` is defined, `blockW = Math.min(blockWidth(hunks), Math.max(0, opts.maxWidth - gutter))`. In `_diff`, pass `maxWidth: host.terminal.size()?.columns`, so a diff with no terminal is unchanged. A changed line longer than the bar still prints whole; it wraps with its background, which is fine, because the padding is what produced the empty colored rows.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run lib/utils/diff.test.ts lib/stdlib/syntax.test.ts > /tmp/fit-task3.log 2>&1; grep -E "FAIL|Tests" /tmp/fit-task3.log | tail`
Expected: PASS.

- [ ] **Step 5: Docs and commit**

Add to the `language` param docstring of `diff()`: "Changed-line backgrounds stop at the terminal's width." Add the diff paragraph to `docs/dev/stdlib/ui-layout-widths.md`: the bars pad to the widest line, capped at the terminal width minus the gutter; with no terminal there is no cap. Run `make`, `pnpm run fmt:ts` on the changed files, and `pnpm run typecheck`. Commit ("diff: stop changed-line backgrounds at the terminal's edge").

---

### Task 4: The skill review prints the skill above the prompt

**Files:**
- Modify: `stdlib/policy.agency` (add `renderSkillDraft` near `renderSourceDiff` at line 736; a branch in `renderInterruptDiff` at line 805; a branch in `prettyPrintInterruptData` at line 849)
- Test: `tests/agency-js/policy-code-diffs/` (`agent.agency`, `test.js`, `fixture.json`)
- Modify: `docs/dev/agents/approval-policies.md` ("Code changes are shown as a diff"), `docs/dev/stdlib/skills-write.md`

**Interfaces:**
- Consumes: `prettyPrintInterruptData(data, effect, cols)` and `renderObjAsTable(obj, excludeKeys, cols)` from Task 2.
- Produces: `def renderSkillDraft(data: any): string` in `stdlib/policy.agency`.

- [ ] **Step 1: Extend the test**

In `tests/agency-js/policy-code-diffs/agent.agency`, add a third interrupt inside `main`'s `handle` block, after the tool review:

```
interrupt std::skills::review("Review this skill before it is saved\u001b[2J", {
  dir: "/home/me/.agency-agent/skills",
  name: "tv-tables",
  description: "Show tables in tv when the user asks\u001b[2J",
  body: "# tv\n\nRun `tv agent new` yourself."
})
```

In `test.js`, add a third `"a"` to `answers` and add these fields to the result:

```js
skillHeader: plain.includes("⏺ Skill: tv-tables"),
skillShowsDescription: plain.includes("Show tables in tv when the user asks"),
// The body belongs in the preview and nowhere else.
skillBodyShownOnce: (plain.match(/tv agent new/g) || []).length === 1,
```

In `fixture.json`, set `promptsDrawn` to `3` and add the three new fields as `true`. The existing `controlCharsStripped` check covers the escape sequences in the new interrupt.

- [ ] **Step 2: Run it and confirm it fails**

Run: `make > /tmp/fit-make.log 2>&1; pnpm run agency test js tests/agency-js/policy-code-diffs > /tmp/fit-task4.log 2>&1; tail -30 /tmp/fit-task4.log`
Expected: FAIL on `skillHeader`, because nothing prints the skill above the prompt yet.

- [ ] **Step 3: Implement the preview**

`renderSkillDraft(data)` returns these lines joined with `"\n"`: `color.yellow("⏺ Skill: ${stripControlChars(data.name)}")`, then `stripControlChars(data.description)`, then an empty line, then `highlight(stripControlChars(data.body), language: "markdown")`. In `renderInterruptDiff`, after the `std::toolbox::review` branch, return `renderSkillDraft(intr.data)` for `std::skills::review`. In `prettyPrintInterruptData`, next to the other two effect branches, return `renderObjAsTable(data, excludeKeys: ["description", "body"], cols: cols)` for `std::skills::review`, so the prompt keeps `dir` and `name`. Update the comment above `renderInterruptDiff`: it now covers content to judge, not only diffs.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `make > /tmp/fit-make.log 2>&1; pnpm run agency test js tests/agency-js/policy-code-diffs > /tmp/fit-task4.log 2>&1; tail -30 /tmp/fit-task4.log`
Expected: PASS.

- [ ] **Step 5: Docs and commit**

In `docs/dev/agents/approval-policies.md`, "Code changes are shown as a diff": the section now names three effects. `std::skills::review` prints the whole draft (name, description, body) above the prompt instead of a diff, because the interrupt carries no previous draft to compare against, and its table keeps `dir` and `name`. In `docs/dev/stdlib/skills-write.md`, add one sentence where the review interrupt is described, pointing to that section. Commit ("Skill review: print the draft above the approval prompt").

---

## Not in this plan

- **A nested value inside an interrupt's table** (an object or array field) is rendered as its own table and then dropped into a text cell, which can wrap its border lines. That happened before this change too, and none of the effects in the screenshots have one.
- **Two tables side by side in a `row`** each take the row's full width as their limit, so together they can overflow. Text in a row behaves the same way today.
- **Showing what changed between skill drafts.** The review interrupt carries no previous draft, so the preview shows the whole draft each round. Adding a `previous` field would allow a diff like the tool review's.
