# Review: `eval new` graders section plan (ADI-30)

Plan: `2026-10-21-eval-new-graders-section.md`. Reviewed against `origin/main` at d85eb14e3, which has `graders.json` (#1234) merged. The main checkout is behind that commit and has no `lib/eval/gradersJson/`, so every line number below is from `origin/main`.

Verdict: the shape is right (row cursor, question tables, validation through the parser) and six of the seven tasks can be built as written. Task 5 cannot: the scrolling mechanism it names does not scroll child elements. One design gap needs an owner call before Task 4: a goal is silently not judged once a test has graders.

## Blocking

### 1. `scrollable: true` on a column does not scroll its children (Task 5)

The plan puts the body in one column with `scrollable: true` and `scrollOffset: state.scrollTop`, with `lib/debugger/ui.ts:403` as the example. That example wraps a single `text(pane.content())` with many lines. The renderer applies the offset only to an element's own text content: `renderTextContent` slices `content.split("\n")` by the offset (`lib/tui/render/renderer.ts:95-100`) and clamps it to `lines.length - innerHeight`. A `line()` child has one line and `height: 1` (`lib/tui/builders.ts:56-58`), so its offset clamps to 0. The children themselves are placed by the layout at fixed, increasing `y` (`lib/tui/layout.ts:237-253`) with no slicing. The toolkit's own test of the feature uses one `text()` element (`lib/tui/test/renderer.test.ts:98-110`). So the form would draw every row at its unscrolled position and the terminal would clip the bottom.

What the toolkit does have is `lib/tui/scrollList.ts`: `clampScroll`, `followCursor`, slice the visible items, wrap them in a flex-start column, and hand back the new `scrollTop` for the caller to store. It has no callers today. The form should slice its own lines the same way:

- One function builds the body as a flat list of one-line elements tagged with their row: `bodyLines(state, width): { row: Row; element: Element }[]`. The non-cursor rows already produce one `line` per wrapped line (`formView.ts:69-71`). The cursor row today is one `row` element of height `n` holding a `textInput` (`formView.ts:92-98`); split it into `n` one-line rows, the first `n - 1` as `line` with the cursor background and the last as a `textInput` of height 1 holding only the last wrapped row. The text input draws its block cursor as a cell at the end of its last line (`renderer.ts:283-290`), so the split changes nothing on screen.
- `scrolledToCursor` calls `bodyLines`, finds the last line of the cursor row, and runs `followCursor` and `clampScroll` on line indices with a viewport of `height - 1`.
- `renderForm` slices `bodyLines` by `state.scrollTop`.

This deletes `rowLayout`. Its description, "computed with the same wrapping the drawing uses", is a second computation of the wrapping that will drift from the first; with `bodyLines` there is one. The Task 5 tests then read: `bodyLines` gives a wrapped row more than one line; `scrolledToCursor` keeps the cursor's last line inside height 10 and returns to 0 on a field row.

### 2. A goal with graders is never judged, and the form does not say so (Tasks 4 and 5; owner call)

The bundled goal judge scores only a test that carries no graders (`lib/eval/grading/gradeRun.ts:188-190`), and the loader stops requiring a goal once `graders` is set (`lib/eval/loadInputs.ts:239`). So a person who fills the goal field and adds one count grader gets a test whose goal is dead. The "no graders" line under the heading says what happens without graders; nothing says what happens with them. The spec covers the empty-goal case ("A test may have graders and an empty goal") and is silent on this one.

Options, for the owner: a dim note on the goal row while graders exist ("not judged while the test has graders; add a goal grader to judge it"); or `validateForm` turns a non-empty goal plus graders into a problem; or the form adds a goal grader from the goal on save. The first is one line in the view and no new rule. Whichever is chosen, pin it in the Task 6 headless test "a test with a grader and no goal saves", because that test is where the other half (a grader and a goal) would be written next.

## Should fix

### 3. An empty checklist lands its problem on the kind row (Tasks 2 and 4)

With no point filled, `specObjectFor` writes `points: []`, zod reports `points: Array must contain at least 1 element(s)`, `graderProblem` returns field `points`, and Task 4 rule 3 sends a field that names no shown question to the kind row. The question rows are named `point.0`, `point.1`, so the commonest checklist mistake puts the cursor two rows above where the fix goes. Make the first point row required in Task 2 (`point.0` keeps `required: true`, the expanded copies after it do not), so Task 4 rule 2 reports `point 1 is required` on the right row before the parser is consulted.

### 4. `parseSpec` would parse twice (Task 1)

`graderProblem(element)` returns only the problem, and the plan has `parseSpec` read the name "after the zod parse passed, as parseSpec does today". That is a second `safeParse` of every element. Build `graderProblem` over a function that returns either the parsed spec or the problem, `checkSpec(element): { spec: GraderSpec } | { problem: GraderProblem }`, and let `parseSpec` use the spec from it. `graderProblem` is then a one-line wrapper for the form.

### 5. Ctrl+D is the toolkit's half-page-down (Task 6)

`cursorBindings` in `lib/tui/keymap.ts:75` binds Ctrl+D to "down half a page", and that table is the movement every Agency TUI shares. The form does not use `cursorBindings`, so nothing breaks, but a key that pages in the logs viewer and deletes in the form is the kind of thing muscle memory finds. Pick a key that table does not use. Ctrl+N is fine. Left and Right are safe on text rows: `lineEditAction` returns null for any named key (`lib/tui/lineEditor.ts:31-34`), so with the `when` guard off they fall through and do nothing.

### 6. The round-trip test cannot hold for `false` (Task 2)

`draftFromSpec` turns `mustPass: false` into `no`, and `specObjectFor` writes `no` as absent, so `specObjectFor(draftFromSpec(spec))` is not `toEqual(spec)` for a spec that spells out `false`. Same for `repeated: false`. State the test as "round-trips every kind, with `false` read back as absent", and keep the sample specs in `schema.test.ts:9-39` as the five inputs. For `eval edit` this is harmless, because the dirty baseline runs both sides through `specObjectFor`.

### 7. Derive the measure and count options from the schema's lists (Task 2)

`MEASURES` and `COUNTS` are exported from `lib/eval/gradersJson/schema.ts:33,46`. The plan writes the five measures and three counts out again as option lists. Make the labels a `Record<(typeof MEASURES)[number], string>` and build the options by mapping the list, so adding a measure to the schema without a label fails `pnpm run typecheck` in the form.

### 8. The Task 6 headless test is one Enter short

After typing the name: Enter moves to must pass, Enter moves to weight, and a third Enter on weight (the last row) is the save. The plan's "Enter ×2 (must pass, weight) → write this test?" stops on the weight row. The harness feeds the next key only when its `when` matches, and then asserts every step ran (`lib/cli/eval/new.test.ts:41`), so a miscount hangs until the assertion fails.

## Minor

- Task 3 says `new.ts` should compile with the smallest change. The two reads of `state.values[state.cursor]` in `performIntent` (`new.ts:155`) and `fieldSpec(state.cursor)` (`new.ts:79`) are the ones that stop compiling; `valueAt` and `isLong` replace them.
- The `AUTO_FILL` table with one row is fine as a table. Say in the dev doc that the table exists so a second default is one row, or it reads as ceremony.
- `scrolledToCursor` runs after every key, so `clampScroll` also handles rows disappearing (a grader removed, a count changed). Worth one sentence in the dev doc.
- Task 7's user doc: `docs/site/cli/eval.md` is hand-written CLI documentation, so editing it is right.

## Altitude pass

- `graders.ts` is a new table of labels, help text, and visibility rules. The visibility rules (`tool` and `repeated` only with `toolCalls`, `messageStartsWith` only with `errors`, `max` or `full` and `zero` by `scoring`) restate four rules from `RULES` in `schema.ts:93-137`. That is the right place for a second copy: the form hides rows, and the parser still refuses the file. Validation itself goes through `graderProblem`, so there is no third copy. Nothing in the plan re-derives what a valid grader is.
- `rowLayout` is the one piece that re-derives something (the wrapping). Finding 1 removes it.
- `scrollList` and the renderer's `list` element both already know how to keep a multi-line cursor item in view (`renderer.ts:237-247` follows the last row of the selected item). The form cannot use `list` because its cursor row is a text input, but the behaviour to copy is there.

## What was checked and held

- `KeyBinding.when` and `hintsFrom` (`lib/tui/keymap.ts:7-56`): the `when` on Ctrl+D and Left/Right hides their hints as the plan expects.
- `formatKey` names arrows `Left` and `Right` and chords `Ctrl+N` (`lib/tui/input/format.ts:3-35`).
- `Screen.runLoop` closes over the terminal size (`lib/tui/screen.ts:47-51`, `new.ts:190-207`), so `handleKey` can call `scrolledToCursor(next, size.width, size.height)`.
- `parseGradersJson` throws for two graders with one name at file level (`schema.ts:157-160`), so the per-row duplicate check in Task 4 is the only way to land the cursor.
- The staging write (`write.ts:115-140`) takes a second file without change.
- Every message `graderProblem` must keep is pinned in `schema.test.ts:55-80`, so Task 1's "existing message tests still pass" is a real check.
