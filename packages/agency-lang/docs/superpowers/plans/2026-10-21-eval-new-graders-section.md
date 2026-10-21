# `eval new`: a graders section — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Below the five fields of the `agency eval new` form, a "graders" section where each grader is added through its own questions, and save writes `graders.json` beside `test.json`.

**Architecture:** The form's cursor stops naming a field and starts naming a row: one of the five fields, or one question of one grader. A new pure module, `graders.ts`, holds the questions each kind asks as a table, turns a grader's answers into the object `graders.json` holds, and back. Validation reuses the `graders.json` parser's own rules through one new function on it, so the form never re-derives what a valid grader is. The view grows the section and a scroll offset, and the command grows four keys.

**Tech Stack:** TypeScript, vitest, the TUI toolkit in `lib/tui/`.

**Spec:** `docs/superpowers/specs/2026-10-20-graders-as-data-and-eval-edit-design.md`, Part 2. Linear: ADI-30. Depends on nothing open; `graders.json` (ADI-29) is merged. `agency eval edit` (ADI-31) has its own plan, `2026-10-21-eval-edit.md`, and builds on this one.

## Background

Read `docs/dev/evals/eval-new.md` and `docs/dev/evals/graders-json.md` first. The short version follows.

`agency eval new <suite-dir>` is a form with five fields: folder name, description, input, files, goal. Its state is a plain object (`FormState` in `lib/eval/newTest/form.ts`) and every change is a reducer case (`reduceForm`). Every field is live: a typed key lands in the field under the cursor at once, through the line editor in `lib/tui/lineEditor.ts`. The cursor is a `FieldName`, and `FIELDS` is the one table that defines a field: name, label, required, whether Ctrl+E opens `$EDITOR` on it, and the help shown while it is empty.

The command, `lib/cli/eval/new.ts`, owns the terminal and the key tables. A key table is a `KeyBinding<FormAction>[]` (`lib/tui/keymap.ts`): each binding has keys, help, an optional hint for the footer, an optional `when`, and `run`. The mode's table is consulted first; a key it does not name is typed into the field. No letter is ever bound, because letters are typed. The three effects (open the editor, validate, write) are "intents": the reducer leaves the state alone, `performIntent` in `new.ts` runs the effect, and the outcome comes back as another action. The footer shows the hints from the current table, or the current message, or one of two yes/no questions, each a `mode`.

`lib/eval/newTest/formView.ts` draws it: one row per field, the cursor row as a `textInput` with a background, a long value wrapped under the value column. `lib/eval/newTest/write.ts` validates (`validateForm` returns `Problem[]`, each naming a field) and writes the folder through a staging directory that is renamed into place.

The headless tests drive the real screen: `lib/cli/eval/new.test.ts` feeds keys through `ScriptedInput` once the recorded frame shows what a person would react to, and reads frames back from `FrameRecorder`. `formView.test.ts` renders one state to a frame and asserts on its text.

`graders.json` is a list of graders in five kinds. `lib/eval/gradersJson/schema.ts` holds one strict zod schema per kind in `KIND_SCHEMAS`, cross-field rules in `RULES` (a must-pass goal needs `passingScore`; a number grader has `full` and `zero` or `max`, never a mix, and `full` differs from `zero`; a must-pass number grader needs `max`; `tool` and `repeated` only with `count: "toolCalls"`; `messageStartsWith` only with `count: "errors"`; a checklist `context` is relative and never climbs out), and `parseGradersJson(text, filePath)`, which throws an `Error` whose message names the file, the grader's index, and where it has one, the field or the grader's name. The parse goes element by element in a private `parseSpec`.

The TUI toolkit scrolls a column when its style has `scrollable: true` and a `scrollOffset` (`lib/debugger/ui.ts:403` is an example). `followCursor(scrollTop, cursorIdx, viewportRows)` in `lib/tui/scroll.ts` returns the offset that keeps a line in view without jitter.

## File structure

```text
lib/eval/gradersJson/schema.ts        + graderProblem(element): the first problem with one element, as data
lib/eval/newTest/graders.ts           NEW: the questions per kind as tables; answers <-> graders.json objects
lib/eval/newTest/graders.test.ts
lib/eval/newTest/form.ts              the cursor is a Row; graders in the state; add, remove, pick
lib/eval/newTest/write.ts             grader problems through graderProblem; graders.json in the staging folder
lib/eval/newTest/formView.ts          the section; choice rows; a scroll offset that follows the cursor
lib/cli/eval/new.ts                   Ctrl+N, Ctrl+X, Left, Right; the scroll follow after each key
docs/dev/evals/eval-new.md            a section on the graders section
docs/site/cli/eval.md                 the user's view of adding a grader
```

Every existing test file beside these keeps its tests; where a signature changes, the test changes with it in the same task.

## Global Constraints

- The five kinds and their fields are exactly the ones `lib/eval/gradersJson/schema.ts` accepts. The form never writes a field the parser does not know.
- No letter may be bound as a key. Letters type into the row under the cursor (spec, "Left to the builder", and `eval-new.md`).
- Rows appear as you answer, on one screen. No one-question-per-screen wizard (spec, "Decided by the owner").
- Every typed answer is kept. Changing an earlier answer hides rows that no longer apply and shows them again on changing back. Only the rows that apply are written (spec, Part 2).
- A key on a grader's first row removes the grader, after a y/n question.
- Save writes `test.json` and, when there is at least one grader, `graders.json`, both in the staged folder that is renamed into place. A test may have graders and an empty goal.
- Run `pnpm run typecheck` after every edit. Save test output to a file. Format with `pnpm run fmt:ts` before committing. Do not run the full agency test suite locally.
- No `Map`, no `Set`, no `interface`, no dynamic import, no `...(x ? { x } : {})` spread, no one-line `if`, no magic numbers. Read `docs/dev/contributing/anti-patterns.md` before each task.

## Review Focus

- A grader whose kind is never picked (its only row is "what to check", empty) must be reported at save as a problem on that row, not written as `{ "kind": "" }`. Pinned in Task 4.
- Typing letters on a choice row (kind, measure, count, must pass) must do nothing, so `s` on "must pass" cannot change it; Left and Right are the only way to pick. Pinned in Task 3.
- Changing a count from "tool calls" to "errors" after typing a tool name must hide the tool rows and keep the name: changing back shows it again, and the written `graders.json` for "errors" has no `tool`. Pinned in Tasks 2 and 3.
- Must pass on a goal grader must fill `passingScore` with 0.5 when it is empty, and leave a typed value alone. Pinned in Task 3.
- A form taller than the terminal must scroll to keep the cursor row visible, and Up at the top of the section must bring the fields back into view. Pinned in Tasks 5 and 6.
- A goal typed beside a grader is never judged; the form must say so on the goal row rather than let the person believe both run. Pinned in Tasks 5 and 6, and an owner call (see Task 5).

---

### Task 1: The parser reports one grader's first problem as data

**Files:**
- Modify: `lib/eval/gradersJson/schema.ts` (the private `parseSpec`, around line 177)
- Test: `lib/eval/gradersJson/schema.test.ts`

The form validates a grader by handing the parser the object it would write. The parser already knows every rule; what it lacks is a way to answer with a field name instead of a thrown message, so the form can put the cursor on the right row. This task adds that and makes `parseSpec` use it, so the messages `parseGradersJson` throws do not change.

**Interfaces:**
- Produces: `type GraderProblem = { field: string | null; text: string }`, `checkSpec(element: unknown): { spec: GraderSpec } | { problem: GraderProblem }`, and `graderProblem(element: unknown): GraderProblem | null`, a one-line wrapper over `checkSpec` for the form, all exported. The element is parsed once: `parseSpec` uses the spec `checkSpec` returns. `field` is the first path segment of a zod issue (`"max"`, `"points"`, `"name"`), `"kind"` for a missing or unknown kind or a non-object element, and `null` for a cross-field rule from `RULES`. `text` is the message without the file and index prefix: `must be an object with a kind`; `unknown kind "rubric"`; for a zod issue, `${path}: ${issue.message}` as today; for a rule, the rule's problem as today, without the `(name)` part.
- `parseSpec` becomes: `const checked = checkSpec(element)`; a problem is thrown with the same prefixes it builds now (`${filePath}: grader ${index}: ...` for a field problem, `${filePath}: grader ${index} (${name}): ...` for a rule, the name read from the element); otherwise `checked.spec` is returned.

- [ ] **Step 1: Write the failing tests**

```ts
describe("graderProblem", () => {
  it("names the field for a missing or bad field", () => {
    expect(graderProblem({ kind: "goal", name: "g" })).toEqual({ field: "goal", text: expect.stringContaining("goal") });
    expect(graderProblem({ kind: "count", name: "c", count: "errors", max: -1 })?.field).toBe("max");
  });
  it("names kind for an unknown kind or a non-object", () => {
    expect(graderProblem({ kind: "rubric", name: "r" })).toEqual({ field: "kind", text: 'unknown kind "rubric"' });
    expect(graderProblem("nope")).toEqual({ field: "kind", text: "must be an object with a kind" });
  });
  it("has no field for a cross-field rule", () => {
    expect(graderProblem({ kind: "goal", name: "g", goal: "x", mustPass: true })).toEqual({
      field: null,
      text: "a must-pass goal grader needs passingScore",
    });
  });
  it("is null for a good grader", () => {
    expect(graderProblem({ kind: "command", name: "c", command: "true" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run lib/eval/gradersJson/schema.test.ts > /tmp/claude-501/schema.txt 2>&1; tail -20 /tmp/claude-501/schema.txt`
Expected: fail, `graderProblem` is not exported.

- [ ] **Step 3: Implement `graderProblem` and route `parseSpec` through it**

- [ ] **Step 4: Run the whole file and typecheck**

Run: `pnpm vitest run lib/eval/gradersJson > /tmp/claude-501/schema.txt 2>&1; tail -5 /tmp/claude-501/schema.txt && pnpm run typecheck`
Expected: every existing message test still passes; typecheck clean.

- [ ] **Step 5: Commit**

Commit message: `graders.json: graderProblem reports one grader's first problem as data (ADI-30)`.

---

### Task 2: The questions each kind asks, as tables

**Files:**
- Create: `lib/eval/newTest/graders.ts`
- Test: `lib/eval/newTest/graders.test.ts`

This module is pure and knows nothing about the screen. It says what a grader draft is, which questions a draft shows, and how a draft becomes the object `graders.json` holds.

**Interfaces:**
- Produces:
  - `type Answers = Record<string, string>`: every answer typed, keyed by question name. Never pruned: an answer to a hidden question stays.
  - `type GraderDraft = { answers: Answers }`.
  - `type ChoiceOption = { value: string; label: string }`.
  - `type QuestionSpec = { name: string; label: string; input: QuestionInput; output: Output; when?: (answers: Answers) => boolean }` with `type QuestionInput = { kind: "text"; long: boolean; help: string; repeat: boolean } | { kind: "choice"; options: ChoiceOption[]; unset: string | null }` and `type Output = "text" | "number" | "yesNo" | "list" | "none"`. `output` says how the answer becomes a field of the `graders.json` object, and nothing else in this module knows the conversion: `text` writes the string when non-empty; `number` writes `Number(text)` when it parses and the raw text when it does not, so the parser refuses it; `yesNo` writes `true` for `yes` and nothing for `no`; `list` collects the repeating rows `name.0`, `name.1`, ... into an array under `${name}s`; `none` writes nothing (the question only decides which rows are asked). A text question with `repeat: true` is asked once per non-empty answer plus one more. A choice with `unset` set shows that help while unanswered and has no default; a choice with `unset: null` reads as its first option while unanswered. There is no `required` flag: the parser's schema says what is required, and the form hands it the object.
  - `KIND_QUESTION: QuestionSpec`: name `kind`, label `what to check`, a choice with `unset: "pick with ← →"` and these options in order: `goal` "judge the reply against a goal", `checklist` "check the reply against a list of points", `number` "a number from the run against a limit", `count` "count things in the trace", `command` "run a command over the agent's files".
  - `KIND_QUESTIONS: Record<GraderSpec["kind"], QuestionSpec[]>` (`GraderSpec` from `lib/eval/gradersJson/schema.ts`):
    - `goal`: `goal` (text, long, output text, label "goal", help "what a good reply does").
    - `checklist`: `point` (text, long, repeat, output list, label "point", help "one thing the reply must do"), `context` (text, output text, label "context file", help "a file under graderFiles/ the judge reads as background (optional)").
    - `number`: `measure` (choice, no unset, output text; the options are `MEASURES` from `schema.ts` mapped through `MEASURE_LABELS: Record<(typeof MEASURES)[number], string>`: `llmCalls` "LLM calls", `costUsd` "cost in dollars", `agentSeconds` "agent seconds", `tokensIn` "tokens in", `tokensOut` "tokens out", so a measure added to the schema without a label fails typecheck here), `scoring` (choice, no unset, output none: `atMost` "pass when at most a limit", `between` "a line from a full-score value to a zero-score value"), `max` (text, output number, label "at most", when `scoring` is `atMost`), `full` (text, output number, label "full score at", when `between`), `zero` (text, output number, label "zero score at", when `between`).
    - `count`: `count` (choice, no unset, output text; the options are `COUNTS` from `schema.ts` through `COUNT_LABELS` the same way: `toolCalls` "tool calls", `errors` "errors", `llmCalls` "LLM calls"), `tool` (text, output text, label "which tool", help "any tool (optional)", when `count` is `toolCalls`), `repeated` (choice `no`/`yes`, output yesNo, label "only repeats", when `toolCalls`), `messageStartsWith` (text, output text, label "message starts with", help "any message (optional)", when `errors`), `max` (text, output number, label "at most", help "0").
    - `command`: `command` (text, long, output text, label "command", help "runs in the agent's working directory; $AGENCY_GRADER_FILES names the grader-only files"), `timeoutSec` (text, output number, label "timeout (seconds)", help "600 (optional)").
  - `TAIL_QUESTIONS: QuestionSpec[]`, asked after the kind's own: `name` (text, output text, label "name", help "letters, digits, - and _"), `mustPass` (choice `no`/`yes`, output yesNo, label "must pass"), `passingScore` (text, output number, label "passing score", help "0.5", when `kind` is `goal` and `mustPass` is `yes`), `weight` (text, output number, label "weight", help "1 (optional)").
  - `YES_NO: ChoiceOption[]` = `no` "no", `yes` "yes".
  - `questionsFor(draft: GraderDraft): QuestionSpec[]`: `KIND_QUESTION`, then, when the kind is picked, the kind's questions and the tail, each kept only when it has no `when` or its `when(answers)` is true. Two readings of the spec's "each answer makes the next row appear" are settled here. Rows that depend on a choice (the kind, the count, the scoring, must pass) appear when the choice is made; every text row of a kind appears as soon as the kind is picked, because an optional text row (a tool name, a context file) has no "answered" moment that could reveal the next one. The exception is a repeating question, which reveals one row at a time, since a filled point is an answer. And `passingScore` is asked after `mustPass` rather than among the goal kind's own questions, because it only applies once must pass is yes; the tail therefore runs name, must pass, passing score (goal only), weight, one row longer than the spec's "name, must pass, and weight". A question with `repeat: true` is expanded: one row per non-empty answer `name.0`, `name.1`, ..., plus one more empty row, so a filled row makes the next appear. The expanded rows are copies of the spec with names `name.<i>` and labels `${label} ${i + 1}`.
  - `choiceValue(answers: Answers, question: QuestionSpec): string`: the answer, or for a choice with `unset: null`, its first option when the answer is empty.
  - `labelOf(question: QuestionSpec, value: string): string`: the option label for a choice value; the value itself for text.
  - `kindOf(draft: GraderDraft): GraderSpec["kind"] | null`.
  - `autoFill(answers: Answers): Answers`: one table, `AUTO_FILL: { when: (answers) => boolean; name: string; value: string }[]`, with one row: when `kind` is `goal`, `mustPass` is `yes`, and `passingScore` is empty, set `passingScore` to `0.5`. Applied by the reducer after a pick.
  - `specObjectFor(draft: GraderDraft): Record<string, unknown>`: the object `graders.json` holds. One loop: for each question `questionsFor` shows, convert its answer by its `output` (one table, `OUTPUTS: Record<Output, (name, answers) => [key, value] | null>`) and set the key when the conversion gave a value. Nothing a hidden question answered is written.
  - `draftFromSpec(spec: GraderSpec): GraderDraft`: the inverse, for `eval edit`, through the same table read the other way (`OUTPUTS[output].read(spec, name) => Answers`): a number as `String(n)`, a `yesNo` as `yes`/`no`, a list as `name.0`, `name.1`, ..., and `scoring` from which of `max` or `full` the spec carries, which is the one `none` question and the one place a `read` looks at a sibling field.

- [ ] **Step 1: Write the failing tests**

```ts
describe("questionsFor", () => {
  it("asks only the kind until it is picked", () => { /* names === ["kind"] */ });
  it("asks a kind's questions then the tail", () => { /* count: kind, count, tool, repeated, max, name, mustPass, weight */ });
  it("hides the tool rows for errors and shows messageStartsWith", () => { /* ... */ });
  it("adds a point row after each filled point", () => { /* no points → ["point.0"]; two filled → point.0, point.1, point.2 */ });
  it("asks the passing score only for a must-pass goal", () => { /* mustPass yes → passingScore between mustPass and weight */ });
  it("asks max for at-most scoring and full and zero for between", () => { /* ... */ });
});
describe("specObjectFor", () => {
  it("writes the count example from the spec", () => {
    const draft = { answers: { kind: "count", count: "toolCalls", tool: "fetchMarkdown", repeated: "yes", max: "0", name: "no-repeated-fetches", mustPass: "yes" } };
    expect(specObjectFor(draft)).toEqual({ kind: "count", name: "no-repeated-fetches", count: "toolCalls", tool: "fetchMarkdown", repeated: true, max: 0, mustPass: true });
  });
  it("drops a hidden answer: a tool name typed before switching to errors", () => { /* answers keep tool; object has no tool */ });
  it("leaves an unparseable number as text for the parser to refuse", () => { /* max: "ten" → max: "ten" */ });
  it("never writes a none output, so scoring stays out of the file", () => { /* ... */ });
  it("collects the points in order and skips empty ones", () => { /* ... */ });
  it("round-trips every kind through draftFromSpec, with false read back as absent", () => { /* the five specs from schema.test.ts; specObjectFor(draftFromSpec(spec)) equals spec with any mustPass: false or repeated: false key removed */ });
});
describe("autoFill", () => {
  it("fills 0.5 for a must-pass goal with no passing score, and leaves a typed one", () => { /* ... */ });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run lib/eval/newTest/graders.test.ts > /tmp/claude-501/graders.txt 2>&1; tail -20 /tmp/claude-501/graders.txt`

- [ ] **Step 3: Implement `graders.ts`**

- [ ] **Step 4: Run the tests and typecheck**

- [ ] **Step 5: Commit**

Commit message: `eval new: the questions each grader kind asks, as tables (ADI-30)`.

---

### Task 3: The cursor is a row, and graders live in the form state

**Files:**
- Modify: `lib/eval/newTest/form.ts`
- Test: `lib/eval/newTest/form.test.ts`

**Interfaces:**
- Consumes: `GraderDraft`, `questionsFor`, `choiceValue`, `autoFill`, `KIND_QUESTION` from Task 2.
- Produces:
  - `type Row = { kind: "field"; name: FieldName } | { kind: "grader"; index: number; question: string }` and `sameRow(a: Row, b: Row): boolean`.
  - `type Problem = { row: Row; text: string }` (was `{ field: FieldName; text }`). Every producer and reader of `Problem` moves with it in this task: `validateForm`, `TestWriteError.row` (was `.field`), `performIntent`, the tests.
  - `FormState` gains `graders: GraderDraft[]` and `scrollTop: number` (0 at start), `cursor` becomes a `Row`, and `FormMode` gains `{ kind: "confirmRemove"; index: number }`.
  - `FormAction` gains `{ kind: "addGrader" }`, `{ kind: "requestRemove" }`, `{ kind: "confirmRemove" }`, `{ kind: "cancelRemove" }`, `{ kind: "pickNext" }`, `{ kind: "pickPrevious" }`.
  - `rowsOf(state: FormState): Row[]`: the five field rows, then for each grader in order one row per question `questionsFor` returns. Movement, "last row", and the view all read this.
  - `questionAt(state: FormState, row: Row): QuestionSpec | null`: the question a grader row names; null for a field row.
  - `valueAt(state: FormState, row: Row): string`: the field value, or the answer (through `choiceValue` for a choice).
  - `isLastRow(state: FormState, row: Row): boolean` replaces `isLastField(name)`.
  - `isChoiceRow(state: FormState, row: Row): boolean` and `isKindRow(row: Row): boolean` (a grader row whose question is `kind`).
  - `isLong(state, row)`: a long field, or a long text question. `new.ts` reads this for Ctrl+E instead of `fieldSpec(cursor).long`.
  - Reducer rules: `moveUp`/`moveDown` step through `rowsOf` and stop at the ends. Typing (`appendText`, `backspace`, `backspaceWord`, `editorReturned`) on a choice row does nothing and clears the message; on a field or text question row it edits the value as today. `addGrader` appends `{ answers: {} }` and puts the cursor on its kind row. `requestRemove` on a kind row sets mode `confirmRemove` with the grader's index; elsewhere it does nothing. `confirmRemove` removes the grader and puts the cursor on the previous row (`rowsOf` just before the removed grader's first row). `cancelRemove` returns to `form`. `pickNext`/`pickPrevious` on a choice row move to the next or previous option (clamped at the ends, no wrap), then apply `autoFill`; on a text row they do nothing. A `saveFailed` puts the cursor on the first problem's row. `isDirty` is true when any field or any grader exists.
  - `editActionFor` is unchanged: whether a key types is still the line editor's call; whether the row takes typing is the reducer's.

- [ ] **Step 1: Write the failing tests**

Add to `form.test.ts`, keeping the existing tests and updating them to `Row` cursors (`{ kind: "field", name: "id" }`) where they read `cursor`:

```ts
it("addGrader appends a grader and puts the cursor on its kind row", () => { /* graders.length 1; cursor { kind: "grader", index: 0, question: "kind" } */ });
it("the rows run fields first, then each grader's questions", () => { /* rowsOf after addGrader + pickNext: 5 + goal's rows */ });
it("letters typed on a choice row change nothing", () => { /* typed("s") on mustPass row leaves answers alone */ });
it("Left and Right pick the previous and next option and stop at the ends", () => { /* kind: pickNext → goal, pickNext ×5 → command; pickPrevious at goal stays goal */ });
it("changing count to errors hides the tool rows and keeps the typed tool name", () => { /* rowsOf has no tool row; answers.tool still "fetchMarkdown"; pickPrevious shows it again */ });
it("must pass on a goal fills the passing score once", () => { /* pickNext on mustPass → passingScore "0.5"; typed value survives a second toggle */ });
it("remove asks only on a kind row, and y removes the grader", () => { /* requestRemove on a name row → mode form; on kind row → confirmRemove; confirmRemove → graders [] and cursor on goal field */ });
it("a failed save moves the cursor to the problem's row", () => { /* row { kind: "grader", index: 0, question: "max" } */ });
it("is dirty with a grader and nothing typed", () => { /* ... */ });
it("the last row is the last grader's last question when there is one", () => { /* ... */ });
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run lib/eval/newTest/form.test.ts > /tmp/claude-501/form.txt 2>&1; tail -30 /tmp/claude-501/form.txt`

- [ ] **Step 3: Implement**

`Problem.row` ripples into `write.ts` (`validateForm`, `TestWriteError`) and `new.ts`: the fallback problem in `performIntent`, the `isLastField` calls, `state.values[state.cursor]` at `new.ts:155` (becomes `valueAt`), and `fieldSpec(state.cursor).long` at `new.ts:79` (becomes `isLong`). Make those compile in this task with the smallest change, and leave their new behaviour to Tasks 4 and 6.

- [ ] **Step 4: Run the tests and typecheck**

Run: `pnpm vitest run lib/eval/newTest lib/cli/eval/new.test.ts > /tmp/claude-501/form.txt 2>&1; tail -5 /tmp/claude-501/form.txt && pnpm run typecheck`
Expected: pass, clean. The headless tests in `new.test.ts` still pass because nothing they drive has changed yet.

- [ ] **Step 5: Commit**

Commit message: `eval new: the cursor is a row, graders live in the form state (ADI-30)`.

---

### Task 4: Validation and the write

**Files:**
- Modify: `lib/eval/newTest/write.ts`
- Test: `lib/eval/newTest/write.test.ts`

**Interfaces:**
- Consumes: `specObjectFor`, `questionsFor`, `kindOf` from Task 2; `graderProblem` from Task 1; `Row`, `Problem` from Task 3.
- Produces:
  - `validateForm(state, checks)`: as today for the five fields, except `goal` is required only when `state.graders` is empty. Then the graders, from one source: for each grader in order, `graderProblem(specObjectFor(draft))` from Task 1, and when it answers, one `Problem` whose text is the parser's and whose row is `rowForField(draft, field)`. Then `duplicateNames(graders)`: the second of two graders with one name gets `two graders named "${name}"` on its name row, the one check the parser makes only at file level. The form holds no rule of its own about what a grader needs.
  - `rowForField(draft: GraderDraft, field: string | null): Row`: the grader row for the question the field came from. A field that is a shown question's name is that row; a field that is a `list` output's key (`points`) is the first row of that repeating question (`point.0`); `kind` and `null` (a cross-field rule) are the kind row. An unpicked kind reaches this path as `unknown kind ""` from the parser, so no form rule is needed for it.
  - `gradersJsonText(graders: GraderDraft[]): string`: `JSON.stringify(graders.map(specObjectFor), null, 2)` plus a newline.
  - `writeTest(state)`: as today, plus `graders.json` written into the staging folder when `state.graders.length > 0`. Callers validate first; `writeTest` does not re-validate graders.
  - `TestWriteError` carries `row: Row`.

- [ ] **Step 1: Write the failing tests**

```ts
it("a goal is not required once the test has a grader", () => { /* no goal + one valid command grader → no problems */ });
it("an unpicked kind is one problem on the kind row, in the parser's words", () => { /* text 'unknown kind ""' */ });
it("a non-number and a missing name are named by row, with the parser's words", () => { /* count with max "ten" → row max, text contains "max"; then no name → row name */ });
it("an empty checklist lands on its first point row", () => { /* ... */ });
it("a cross-field rule from the parser lands on the kind row with the parser's words", () => { /* number, between, mustPass yes → "a must-pass number grader needs max" on kind row */ });
it("a parser field problem lands on its row", () => { /* goal grader with passingScore "2" → row passingScore, text contains "passingScore" */ });
it("two graders with one name are reported on the second", () => { /* ... */ });
it("writes graders.json beside test.json, and the loader builds the graders", async () => { /* loadInputs(suite)[0].graders ends with graders.json; loadGradersJson gives the names in order; test.json has no goal */ });
it("writes no graders.json when there are no graders", () => { /* ... */ });
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run lib/eval/newTest/write.test.ts > /tmp/claude-501/write.txt 2>&1; tail -30 /tmp/claude-501/write.txt`

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the tests and typecheck**

- [ ] **Step 5: Commit**

Commit message: `eval new: validate graders through the parser and write graders.json (ADI-30)`.

---

### Task 5: The section on screen, and scrolling

**Files:**
- Modify: `lib/eval/newTest/formView.ts`
- Test: `lib/eval/newTest/formView.test.ts`

**Interfaces:**
- Consumes: `rowsOf`, `questionAt`, `valueAt`, `isChoiceRow` from Task 3; `labelOf`, `kindOf` from Task 2.
- Produces:
  - `type RowView = { row: Row | null; label: string; value: string; help: string; cursor: boolean; typed: boolean; heading: boolean }`: everything the drawing needs to know about one line of the body, and nothing about where it came from. `row` is null for a line the cursor never visits (a heading, the no-graders line). `typed` is true when the cursor row takes typing, so it is drawn as a text input; false for a choice row, drawn as a `line` on the cursor background with no block cursor, since nothing is typed there.
  - `rowViewsOf(state: FormState): RowView[]`: the "what". The five fields as today; a blank line; the heading `graders`; then either the no-graders line (`no graders: the goal above is judged by the bundled goal judge`, dim) or, per grader, one view per row from `rowsOf`: the kind row labelled `${index + 1}. what to check`, the rest labelled with the question's label indented two more columns than a field label, a choice value shown through `labelOf`, and a choice's `unset` help while it is unanswered (`pick with ← →`). Every value and label from outside goes through `sanitizeUntrusted` here.
  - `drawRow(view: RowView, width: number, labelWidth: number): Element[]`: the "how", one function that replaces today's `fieldRows`, returning one element per screen line, each exactly one line tall. The branches it keeps are the ones the toolkit forces: cursor or not, empty or not, typed or not. It owns the wrapping. The typed cursor row, which today is one `row` of height `n` holding a `textInput` of height `n`, becomes `n` one-line elements: the first `n - 1` are `line`s on the cursor background and the last is a `textInput` of height 1 holding only the last wrapped row. The text input draws its block cursor as a cell at the end of its last line, so the screen does not change.
  - `bodyLines(state: FormState, width: number): { row: Row | null; element: Element }[]`: every line of the body in order, `rowViewsOf(state).flatMap(view => drawRow(view, ...).map(element => ({ row: view.row, element })))`. One place computes the wrapping, and both drawing and scrolling read it.
  - Scrolling is done by slicing, not by the toolkit. A column with `scrollable: true` applies its offset only to an element's own text (`lib/tui/render/renderer.ts:95-100`); its children are placed at fixed positions, so a column of `line`s would not move. `renderForm(args)` is the title, then the elements of `bodyLines(state, width).slice(state.scrollTop, state.scrollTop + viewport)` in a flex-start `column`, then the footer, with `viewport` the body height: `args.height` less the title line, the blank line under it, and the footer line. This is what `lib/tui/scrollList.ts` does for a list of items; the form slices lines rather than items because one row can be several lines and the cursor must follow the last of them.
  - `scrolledToCursor(state: FormState, width: number, height: number): FormState`: `scrollTop` from `followCursor(clampScroll(...), lastLineOfCursorRow, viewport)` (`lib/tui/scroll.ts`), where `lastLineOfCursorRow` is the index in `bodyLines` of the last line whose `row` is the cursor. Run after every key, so `clampScroll` also absorbs rows that vanished (a grader removed, a count changed). A row taller than the viewport shows its end, where the cursor is.
  - On the goal row, while `state.graders` is not empty, one more dim line under the value: `not judged while the test has graders; add a goal grader to judge it`. The bundled goal judge scores only a test with no graders (`lib/eval/grading/gradeRun.ts`, `suiteModuleGraders` and `snapshotModuleGraders` return the test's own graders when it has any), so a goal typed beside a count grader is never read, and the no-graders line only explains the other case. This is the author's call, pending the owner; the alternatives were refusing a non-empty goal beside graders at save, or turning the goal into a goal grader on save.
  - Label width: the widest label across fields and questions plus the gap, computed once from `FIELDS`, `KIND_QUESTION`, every `KIND_QUESTIONS` entry, and `TAIL_QUESTIONS`.

- [ ] **Step 1: Write the failing tests**

```ts
it("shows the no-graders line under the heading when there are none", () => { /* frame contains "graders" and "no graders: the goal above is judged by the bundled goal judge" */ });
it("draws the count example from the spec", () => {
  // graders: [count draft from Task 2's spec test]; frame contains, in order:
  //   "1. what to check   count things in the trace", "count   tool calls", "which tool   fetchMarkdown",
  //   "only repeats   yes", "at most   0", "name   no-repeated-fetches", "must pass   yes"
});
it("the cursor on a choice row shows the pick help while unanswered", () => { /* kind row, "" → "pick with ← →" */ });
it("bodyLines gives a wrapped row more than one line, all tagged with the row", () => { /* ... */ });
it("the typed cursor row is one-line elements with the text input last", () => { /* a goal that wraps to 3 lines → 3 elements for the goal row; the frame still shows the block cursor at the end */ });
it("scrolledToCursor keeps the cursor row's last line inside a short terminal and goes back up for a field", () => {
  // height 10, cursor on the last grader row → scrollTop > 0 and that row's last line is inside the viewport;
  // then cursor on the id field → scrollTop 0
});
it("the frame shows only the lines from scrollTop", () => { /* scrollTop past the fields → frame has no "folder name" */ });
it("the goal row says it is not judged while the test has graders", () => { /* ... */ });
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run lib/eval/newTest/formView.test.ts > /tmp/claude-501/view.txt 2>&1; tail -30 /tmp/claude-501/view.txt`

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the tests and typecheck**

- [ ] **Step 5: Commit**

Commit message: `eval new: draw the graders section and scroll to the cursor (ADI-30)`.

---

### Task 6: The keys, and the headless run

**Files:**
- Modify: `lib/cli/eval/new.ts`
- Test: `lib/cli/eval/new.test.ts`

**Interfaces:**
- Consumes: `isLastRow`, `isChoiceRow`, `isKindRow`, `isLong` from Task 3; `scrolledToCursor` from Task 5.
- Produces, in `formBindings`:
  - `Ctrl+N`, help "add a grader", hint `Ctrl+N grader`, always; runs `addGrader`.
  - `Ctrl+X`, help "remove this grader", hint `Ctrl+X remove`, `when` the cursor is on a kind row; runs `requestRemove`. Not Ctrl+D: `cursorBindings` in `lib/tui/keymap.ts` binds that to half a page down in every other Agency TUI, and a key that pages there and deletes here would catch the hands out.
  - `Left` and `Right`, help "previous option" / "next option", one hint `←→ pick` on `Right`, `when` the cursor is on a choice row; run `pickPrevious` / `pickNext`.
  - `Ctrl+E`'s `when` reads `isLong(state, state.cursor)`.
  - `Enter`'s two bindings read `isLastRow(state, state.cursor)`.
  - A third question table, `CONFIRM_REMOVE_BINDINGS`: `y` runs `confirmRemove`, `n` and `Escape` run `cancelRemove`; `actionFor` consults it in mode `confirmRemove`. The footer for that mode reads `remove this grader?  y / n` (in `formView.ts`, beside the two other footers).
  - `handleKey`: after reducing and performing the intent, `scrolledToCursor(next, size.width, size.height)`.
  - `performIntent`'s fallback problem for a `TestWriteError` without a row becomes `{ row: { kind: "field", name: "id" }, ... }`.

- [ ] **Step 1: Write the failing tests**

Using `drive` and `typing` from the file:

```ts
it("Ctrl+N adds a grader, Right picks a kind, the questions appear, and y writes graders.json", async () => {
  // fill id and goal; Ctrl+N; frame shows "1. what to check" and "pick with ← →";
  // Right ×4 → "count things in the trace"; Enter (to count row); Right → "errors"; Enter; typing("Unknown named argument");
  // Enter; typing("0"); Enter; typing("no-bad-arguments"); Enter (to must pass); Enter (to weight); Enter on weight, the last row → "write this test?"; y
  // (the harness feeds a key only when its `when` matches and asserts every step ran, so a miscounted Enter hangs the test)
  // then: graders.json exists with [{ kind: "count", name: "no-bad-arguments", count: "errors", messageStartsWith: "Unknown named argument", max: 0 }]
});
it("letters on a choice row type nothing and the hints offer ←→ pick", async () => { /* ... */ });
it("Ctrl+X on a kind row asks, y removes, and the no-graders line is back", async () => { /* ... */ });
it("Ctrl+X elsewhere does nothing", async () => { /* ... */ });
it("a save with a missing name lands the cursor on the name row", async () => { /* frame shows the parser's words for the missing name and the name row has the cursor background */ });
it("a tall form scrolls to keep the cursor row on screen, and Up brings the fields back", async () => {
  // height 12; add a grader and move to its last row: frame contains that row and not "folder name";
  // Up until the id row: frame contains "folder name"
});
it("a test with a grader and no goal saves", async () => { /* ... */ });
it("a test with a grader and a goal saves, and the goal row said it is not judged", async () => { /* the frame before y contains "not judged while the test has graders" */ });
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run lib/cli/eval/new.test.ts > /tmp/claude-501/new.txt 2>&1; tail -40 /tmp/claude-501/new.txt`

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run every form test, typecheck, lint**

Run: `pnpm vitest run lib/eval/newTest lib/cli/eval lib/eval/gradersJson > /tmp/claude-501/all.txt 2>&1; tail -5 /tmp/claude-501/all.txt && pnpm run typecheck && pnpm run lint:structure`
Expected: pass, clean, clean.

- [ ] **Step 5: Commit**

Commit message: `eval new: add, remove and pick keys for graders; the form scrolls (ADI-30)`.

---

### Task 7: The docs

**Files:**
- Modify: `docs/dev/evals/eval-new.md`
- Modify: `docs/site/cli/eval.md` (the "Creating a test with a form" section)
- Modify: `CLAUDE.md` and `.claude/skills/agency-evals-docs/SKILL.md` (the `eval-new.md` index line; `git add -f` the skill file)

- [ ] **Step 1: The dev doc**

Add a section "The graders section" after "Every field is live", covering with an example first: the cursor is a `Row`; the questions per kind are tables in `graders.ts` and a sixth kind is one entry there; `questionsFor` and the `when` rule (answers are kept, rows are filtered); the `point` question repeats; validation goes through `graderProblem` so the form holds no second copy of the rules, and how a parser problem finds its row; the three new keys, why Left/Right pick, and why remove is Ctrl+X; scrolling by slicing `bodyLines`, why the toolkit's `scrollable` could not do it, and that `scrolledToCursor` runs after every key so rows that vanish are absorbed; the `AUTO_FILL` table, one row today so a second default is one row; the goal row's note while graders exist. Update the file-list block at the top and the sentence that says the form "writes no grader module". Follow `docs/dev/contributing/general-writing-tips.md`, read `verbal-tics.md` before committing, and keep out the drafting choices: what the reader needs is where the rules live and what is easy to get wrong.

- [ ] **Step 2: The user doc**

In `docs/site/cli/eval.md`, after the paragraph that ends "Add a `graders.ts` beside the file by hand when you want more.", add a short paragraph and the spec's count example as the screen shows it: Ctrl+N adds a grader, the first row picks what to check with the arrow keys, the questions appear below, Ctrl+X on the first row removes it, and save writes `graders.json`. Change the last paragraph's "It does not open an existing one" to stay true until ADI-31 lands.

- [ ] **Step 3: The index lines**

Reword the `eval-new.md` line in both indexes to mention the graders section and the per-kind question tables.

- [ ] **Step 4: Commit**

Commit message: `Docs: the graders section of eval new (ADI-30)`.
