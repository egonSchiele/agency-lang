# Fit Tables and Diffs to the Screen

> **For agentic workers:** Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Tables and highlighted diffs never come out wider than the terminal, and the skill review prompt shows the skill.

**Why:** A table's `width` sizes its frame, but each column with no width of its own always takes the width of its longest cell (`fixedWidthFor`, `lib/utils/columnWidths.ts:66`), and nothing makes a column narrower. Diffs pad every changed line to the longest line in the diff (`blockWidth`, `lib/utils/diff.ts:261`). Neither checks the terminal width.

**Rules:** Run `make` after changing `stdlib/`. Run `pnpm run fmt:ts` on changed `.ts` files by name, and `pnpm run typecheck`. Save test output to a file. Commit with `git commit -F <file>`.

### 1. Tables shrink to fit

- [ ] Add `fitColumnWidths(widths: number[], plan: ColumnPlan[], available: number): number[]` to `lib/utils/columnWidths.ts`. Columns with no width of their own (`parsed === null`) shrink to one shared width: the largest one that makes the total fit `available`. A column already narrower than that keeps its width, and no column goes below `Math.max(minWidth, 1)`. Leftover cells go to the leftmost shrunk columns. A table that already fits comes out unchanged, because the shared width is then at least its widest column. Do not change `resolveColumnWidths`, because the TUI table (`lib/tui/table.ts`) also calls it.
- [ ] In `lib/stdlib/layout/table.ts`, `sizeTable` passes `ctx.availableWidth` (the terminal width at the root) to `_resolveTableWidths` as a third argument, `maxWidth`. After `resolveColumnWidths`, if `resolvedWidth ?? maxWidth` is defined, run the widths through `fitColumnWidths` with that width minus the chrome.
- [ ] Tests in `lib/utils/columnWidths.test.ts`:
  - `fitColumnWidths([10, 20], [natural(10), natural(20)], 40)` is `[10, 20]`.
  - `fitColumnWidths([11, 150], [natural(11), natural(150)], 73)` is `[11, 62]`.
  - `fitColumnWidths([30, 30], [natural(30), natural(30)], 41)` is `[21, 20]`.
  - `fitColumnWidths([30, 200], [cells(30), natural(200)], 33)` is `[30, 3]`.
- [ ] Tests in `lib/stdlib/layout.test.ts`, at viewport `{ cols: 40, rows: 24 }`:
  - The table `[["dir", "/a"], ["description", "word ".repeat(40).trim()]]` resolves to column widths `[11, 22]`, and its widest rendered line is 40.
  - The table `[["a", "b"]]` still renders 9 wide.
- [ ] In `stdlib/ui/table.agency`, add to the `width` docstring: "With no width, the table is never wider than the terminal; its widest columns wrap first."

### 2. The prompt renders its table at the prompt's width

The footer wraps its body to `max(20, columns - 1) - 1`, so a table as wide as the terminal still gets wrapped a second time.

- [ ] In `lib/stdlib/cli.ts`, add `interruptBodyWidth(columns: number): number`, which returns that number. Make `bodyLines` and `bodyIsTruncated` use it, and put it on `_internal`. Add `_interruptBodyWidth()`, which returns `interruptBodyWidth(_termWidth())`.
- [ ] In `stdlib/ui/cli.agency`, add `@capabilities(terminal) export def interruptBodyWidth(): number`.
- [ ] In `stdlib/policy.agency`, give `prettyPrintInterruptData` and `renderObjAsTable` a `cols: number = 0` parameter, and pass it to `render`. `askUser` passes `cols: interruptBodyWidth()`.
- [ ] Test in `lib/stdlib/cli.test.ts`: `interruptBodyWidth(60)` is 58. A body of `"x".repeat(58)` at `columns: 60` renders on one footer line.

### 3. Diff bars stop at the terminal's edge

- [ ] In `lib/utils/diff.ts`, split the plain text of the gutter out of `highlightGutter` into `gutterText(line, numWidth, lineNumbers): string`, and have `highlightGutter` color it. Add `maxWidth?: number` to `RenderDiffOpts`. In `renderDiff`, each changed line's bar is `Math.min(blockW, maxWidth - gutterText(...).length)` wide, so the gutter's width comes from the gutter itself. In `_diff` (`lib/stdlib/syntax.ts`), pass `maxWidth: host.terminal.size()?.columns`. With no terminal there is no cap.
- [ ] Test in `lib/utils/diff.test.ts`, with the existing `stub`: diffing `"aa\nbb"` against `"aa\n" + "B".repeat(300)`, with line numbers and `maxWidth: 80`, gives the line `2 + <insert:76:BBB…>`.

### 4. The skill review prints the skill above the prompt

- [ ] In `stdlib/policy.agency`, replace the two effect checks at the top of `prettyPrintInterruptData` with one table, `static const PROMPT_HIDDEN_FIELDS: Record<string, string[]>`. It maps `std::edit` and `std::toolbox::review` to the fields they hide today, and `std::skills::review` to `["description", "body"]`. `prettyPrintInterruptData` looks the effect up once, with `PROMPT_HIDDEN_FIELDS[effect] ?? []`. The next effect that prints above the prompt adds one row here.
- [ ] Add `renderSkillDraft(data)`, written like `renderSourceDiff` and `renderReviewFindings`. It returns `⏺ Skill: <name>` in yellow, then the description, a blank line, and `highlight(body, language: "markdown")`, each passed through `stripControlChars`. `renderInterruptDiff` returns it for `std::skills::review`.
- [ ] Test: in `tests/agency-js/policy-code-diffs`, raise a `std::skills::review` interrupt in `main`, with the escape sequence at the end of its description, and add a third `"a"` answer. Assert that `⏺ Skill: tv-tables` is printed, the description is printed, the body text appears exactly once, and `promptsDrawn` is 3.
- [ ] In `docs/dev/agents/approval-policies.md`, "Code changes are shown as a diff", add one paragraph: a skill review prints its draft above the prompt the same way, and `PROMPT_HIDDEN_FIELDS` lists what each such effect leaves out of the prompt's table.
