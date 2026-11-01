# Fit Tables and Diffs to the Screen

> **For agentic workers:** Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A table whose cells are wider than the terminal wraps its widest columns, highlighted diffs stop padding at the terminal's edge, and the skill review prompt shows the skill.

**Why:** A table's `width` sizes its frame, but each column with no width of its own always takes the width of its longest cell (`fixedWidthFor`, `lib/utils/columnWidths.ts:66`), and nothing makes a column narrower. Diffs pad every changed line to the longest line in the diff (`blockWidth`, `lib/utils/diff.ts:261`). Neither checks the terminal width.

**Rules:** Run `make` after changing `stdlib/`. Format changed TypeScript with `pnpm exec prettier --write <the changed .ts files>` (`pnpm run fmt:ts` formats every file in the package). Run `pnpm run typecheck`. Save test output to a file. Commit with `git commit -F <file>`.

### 1. Tables shrink to fit

- [ ] Add `fitColumnWidths(widths: number[], plan: ColumnPlan[], available: number): number[]` to `lib/utils/columnWidths.ts`. Columns with no width of their own (`parsed === null`) shrink to one shared width: the largest one that makes the total fit `available`. A column already narrower than that keeps its width, and no column goes below `Math.max(minWidth, 1)`. Leftover cells go to the leftmost shrunk columns. A table that already fits comes out unchanged, because the shared width is then at least its widest column. When even every column at its floor does not fit, return the floors and let the table overflow. Do not change `resolveColumnWidths`, because the TUI table (`lib/tui/table.ts`) also calls it.
- [ ] In `lib/stdlib/layout/table.ts`, `sizeTable` passes `ctx.availableWidth` (the terminal width at the root, a container's inner width inside a box or row) to `_resolveTableWidths` as a third argument, `maxWidth`. After `resolveColumnWidths`, if `resolvedWidth ?? maxWidth` is defined, run the widths through `fitColumnWidths` with that width minus the chrome.
- [ ] Raw cells never wrap (`annotateCellsWithWrap`, `table.ts:323-326`), so a shrunk column holding one would push its row past the right border. In `planColumns`, set `minWidth` to the column's natural width for any column with a raw cell, so `fitColumnWidths` leaves it alone.
- [ ] Tests in `lib/utils/columnWidths.test.ts`:
  - `fitColumnWidths([10, 20], [natural(10), natural(20)], 40)` is `[10, 20]`.
  - `fitColumnWidths([11, 150], [natural(11), natural(150)], 73)` is `[11, 62]`.
  - `fitColumnWidths([30, 30], [natural(30), natural(30)], 41)` is `[21, 20]`.
  - `fitColumnWidths([30, 200], [cells(30), natural(200)], 33)` is `[30, 3]`.
  - `fitColumnWidths([50, 200], [cells(50), natural(200)], 33)` is `[50, 1]`: the fixed column alone is wider than 33, so the other one drops to its floor.
- [ ] Tests in `lib/stdlib/layout.test.ts`, at viewport `{ cols: 40, rows: 24 }`:
  - The table `[["dir", "/a"], ["description", "word ".repeat(40).trim()]]` resolves to column widths `[11, 22]`, and its widest rendered line is 40.
  - The table `[["a", "b"]]` still renders 9 wide.
  - A table whose second column holds a 60-character raw cell keeps that column at 60.
- [ ] In `stdlib/ui/table.agency`, add to the `width` docstring: "With no width, a table whose cells are wider than the terminal wraps its widest columns. With no terminal, the limit is 80 columns. Raw cells do not wrap, so their columns do not shrink."
- [ ] Run the layout execution tests, which are the likeliest to depend on the old overflow: `pnpm run agency test tests/agency/layout > /tmp/fit-layout.log 2>&1`. If one fails, read it before changing it, and say in the commit message why its expected output changed.
- [ ] Write `docs/dev/stdlib/ui-layout-widths.md`, a short page: the limit a table gets (`availableWidth`), the shrink rule, the raw-cell exception, the 80-column default, and why `fitColumnWidths` is kept apart from `resolveColumnWidths`. Add a pointer under "Standard library" in `CLAUDE.md` and in `.claude/skills/agency-stdlib-docs/SKILL.md`.

### 2. The prompt renders its table at the prompt's width

The footer wraps its body to `max(20, columns - 1) - 1`, so a table as wide as the terminal still gets wrapped a second time.

- [ ] In `lib/stdlib/cli.ts`, add `interruptBodyWidth(columns: number): number`, which returns that number, and put it on `_internal`. Change `bodyLines(body, wrapWidth)` to wrap at `wrapWidth` as given, and have both its callers, `bodyIsTruncated` and `renderInterruptFooter`, pass `interruptBodyWidth(columns)`. Add `_interruptBodyWidth()`, which returns `interruptBodyWidth(_termWidth())`.
- [ ] In `stdlib/ui/cli.agency`, add `@capabilities(terminal) export def interruptBodyWidth(): number`.
- [ ] In `stdlib/policy.agency`, give `prettyPrintInterruptData` and `renderObjAsTable` a `cols: number = 0` parameter, and pass it to `render`. `askUser` passes `cols: interruptBodyWidth()`.
- [ ] Tests in `lib/stdlib/cli.test.ts`: `interruptBodyWidth(60)` is 58. At `columns: 60`, a body of `"x".repeat(58)` renders on one footer line and `"x".repeat(59)` on two.
- [ ] The test that the policy passes `cols` is in task 4.

### 3. Diff bars stop at the terminal's edge

- [ ] In `lib/utils/diff.ts`, split the plain text of the gutter out of `highlightGutter` into `gutterText(line, numWidth, lineNumbers): string`, and have `highlightGutter` color it. Add `maxWidth?: number` to `RenderDiffOpts`. In `renderDiff`, give each changed line this bar width, so the gutter's width comes from the gutter itself and no terminal means no cap:

  ```ts
  const barWidth = (line: DiffLine): number => {
    if (opts.maxWidth === undefined) {
      return blockW;
    }
    const gutterWidth = gutterText(line, numWidth, opts.lineNumbers ?? false).length;
    return Math.max(0, Math.min(blockW, opts.maxWidth - gutterWidth));
  };
  ```

- [ ] In `_diff` (`lib/stdlib/syntax.ts`), pass `maxWidth: host.terminal.size()?.columns`.
- [ ] Test in `lib/utils/diff.test.ts`, with the existing `stub`: diffing `"aa\nbb"` against `"aa\n" + "B".repeat(300)`, with line numbers and `maxWidth: 80`, gives the line `2 + <insert:76:BBB…>`. The existing test with no `maxWidth` must still give `<insert:2:BB>`.

### 4. The skill review prints the skill above the prompt

- [ ] In `stdlib/policy.agency`, add `static const PROMPT_HIDDEN_FIELDS: Record<string, string[]>`. It maps `std::edit` and `std::toolbox::review` to the fields they hide today, and `std::skills::review` to `["description", "body"]`. Remove the two early `return renderObjAsTable(...)` branches at the top of `prettyPrintInterruptData`. Keep the null, string, and array branches where they are, so an array payload never reaches `renderObjAsTable`. In the object branch, pass the effect's list as `excludeKeys`. Look the effect up only when `keys(PROMPT_HIDDEN_FIELDS).includes(effect)`, so an effect named like an `Object.prototype` property (`toString`) gets no list instead of a function.
- [ ] Add `renderSkillDraft(data)`, written like `renderSourceDiff`: strip `data.name`, `data.description`, and `data.body` with `stripControlChars` first, then color and highlight the stripped text. Stripping after coloring would turn every color code into visible text. It returns `⏺ Skill: <name>` in yellow, then the description, a blank line, and `highlight(body, language: "markdown")`. `renderInterruptDiff` returns it for `std::skills::review`.
- [ ] Tests in `tests/agency-js/policy-code-diffs` (`test.js` runs with stdout piped, so `interruptBodyWidth()` is 78 on every machine):
  - Give the existing `std::edit` interrupt a long `dir`, `"/work/" + "a".repeat(200)`. Assert that every printed line containing `│` is at most 78 wide.
  - Raise the skill review the way `designSkill` does, as `let answer = interrupt std::skills::review(…)`, so it takes the `expectsValue` path. Put the escape sequence at the end of its description. Add a third `"a"` answer. Assert that `⏺ Skill: tv-tables` is printed, the description is printed, the body text appears exactly once, and `promptsDrawn` is 3.
  - Also run `tests/agency-js/policy-prompt-array-data`, which covers the array branch.
- [ ] In `docs/dev/agents/approval-policies.md`, "Code changes are shown as a diff", add one paragraph: a skill review prints its draft above the prompt the same way, and `PROMPT_HIDDEN_FIELDS` lists what each such effect leaves out of the prompt's table.
