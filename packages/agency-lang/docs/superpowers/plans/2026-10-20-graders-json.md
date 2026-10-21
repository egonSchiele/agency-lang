# graders.json: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A test folder may hold `graders.json`, a list of graders in five kinds, and grading it gives the same scores as the equivalent `graders.ts`.

**Architecture:** A new directory, `lib/eval/gradersJson/`, owns the file: one module parses and validates it, one builds `BaseGrader` instances from it through the existing helpers. A test's existing `graders` field holds the path to either file, and the loaders dispatch on the extension. The run directory stores the JSON by content hash and the run row names it in a field of its own, so a stored run grades the same later. A new bundled judge, the checklist judge, returns one answer per point, and those answers travel on the score row.

**Tech Stack:** TypeScript, zod, vitest, Agency for the judge program.

**Spec:** `docs/superpowers/specs/2026-10-20-graders-as-data-and-eval-edit-design.md`, Part 1. Linear: ADI-29. Merge ADI-28 (plan `2026-10-20-must-pass-threshold.md`) first: the checklist judge overrides `passes()` and must not fall through to the base method, which after ADI-28 throws for a must-pass scalar with no threshold. `agency eval check` from the spec is not in this plan. It is ADI-34.

## Background

Read `docs/dev/evals/eval-grading.md` and `docs/dev/evals/run-directory.md` first. The short version:

A test is a folder with `test.json`. `loadTestDir` in `lib/eval/loadInputs.ts` reads it and, when a `graders.ts` sits beside it, sets `test.graders` to that path. `eval run` bundles the module with esbuild, stores the bundle under the run directory's `graders/` folder, and writes a `run` row whose `graders` field names the bundle. `eval grade` loads graders from that stored bundle when it exists, and from the live module otherwise. This is `snapshotGraders` in `lib/eval/run/runSuite.ts` and `snapshotModuleGraders` in `lib/eval/grading/gradeRun.ts`. A test may also have a `graderFiles/` folder, files for the graders that the agent never sees. `eval run` stores a copy of it too, and every grader receives the stored copy's path as `graderFiles` in its input.

A grader is a `BaseGrader`. Most are made by `grader(fn, options)` in `lib/eval/grading/functionGrader.ts`, which gives `fn` a context with the run's `output`, `workdir`, `record`, `graderFiles`, and two judges, `judges.goal` and `judges.rubric`. The record is an `EvalRecord` from `lib/eval/types.ts`: `metrics` (LLM calls, cost, tokens, tool counts), `events` (every LLM call and tool call in order), `errors`, and `durationMs`. Tool arguments are on `tool_start` events as `argsPreview`, a 200-character preview. No row carries the full arguments.

A grade is `{ score, feedback? }`. After grading, `scoreDrafts` in `lib/eval/grading/gradeSuite.ts` turns each grade into a `ScoreDraft`, and `recordGradingPass` in `lib/runDirectory/mutations.ts` writes it as a `score` row in `annotations.jsonl`. The row's schema is `ScoreAnnotationSchema` in `lib/runDirectory/annotations.ts`. `eval grade` prints rows through `formatGrade` in `lib/cli/eval/formatGrade.ts`. A grader with `samples > 1` runs several times and `aggregateGrades` in `lib/eval/grading/aggregate.ts` folds the grades into one, keeping only `score` and `feedback`.

The bundled judges are Agency programs in `lib/agents/eval/`. `goalJudge.agency` takes `(goal, output, expected)` and returns `{ score, reasoning }`. Each has a TypeScript helper that names the file and pins its hash, so a changed prompt forces a version bump: see `lib/eval/grading/goalJudgeFile.ts` and its test. A judge runs through `runAgency.runStructured(file, node, args, zodSchema)`.

## File structure

```text
lib/eval/gradersJson/schema.ts          zod schema for the file, the GradersJson type, parseGradersJson
lib/eval/gradersJson/schema.test.ts
lib/eval/gradersJson/build.ts           buildGraders: one function per kind
lib/eval/gradersJson/build.test.ts
lib/eval/gradersJson/load.ts            loadGradersJson, snapshotGradersJson, loadGradersJsonSnapshot
lib/eval/gradersJson/load.test.ts
lib/eval/grading/graderSources.ts       the two grader sources (module, JSON) as one table, and the lookups
lib/eval/grading/graderSources.test.ts
lib/eval/gradersJson/endToEnd.test.ts
lib/eval/gradersJson/fixtures/packaging-decision/{test.json,graders.json}
lib/eval/grading/checklistJudgeFile.ts  path + version pin for the checklist judge, like goalJudgeFile.ts
lib/eval/grading/checklistJudgeFile.test.ts
lib/eval/grading/graders/checklistJudge.ts       ChecklistJudge extends BaseGrader
lib/eval/grading/graders/checklistJudge.test.ts
lib/agents/eval/checklistJudge.agency   the judge program
docs/dev/evals/graders-json.md          the dev doc
```

Modified: `lib/eval/grading/types.ts` (Grade gains `points`), `lib/runDirectory/annotations.ts` and `mutations.ts` (score row gains `points`; run row's graders identity gains `jsonFile`), `lib/eval/grading/gradeSuite.ts`, `lib/eval/grading/gradeBreakdown.ts`, `lib/cli/eval/formatGrade.ts`, `lib/eval/loadInputs.ts`, `lib/eval/runTypes.ts`, `lib/eval/run/runSuite.ts`, `lib/eval/grading/gradingModule.ts`, `lib/eval/grading/gradeRun.ts`, `lib/eval/public.ts`.

## Global Constraints

- The five kinds, their field names, and their scoring rules are exactly as the spec's Part 1 gives them: `goal`, `checklist`, `number`, `count`, `command`.
- A folder with both `graders.ts` and `graders.json` is a load error naming the folder.
- Grader names are unique within a file. Two with one name is a load error naming the file and the name.
- A checklist's `context` is a path under the test's `graderFiles/` folder. The judge reads it from the stored copy every run already carries, so no JSON grader has external files.
- Run `pnpm run typecheck` after every edit. Save test output to a file. Format with `pnpm run fmt:ts` before committing. Do not run the full agency test suite locally. The CLI is `pnpm run agency ...`.
- No `Map`, no `Set`, no `interface`, no dynamic import. Objects, arrays, and `type`.
- Read `docs/dev/contributing/anti-patterns.md` before each task. In particular: the "what" of each kind lives in a table and the "how" in one function that reads it, never a `switch` per kind; no `...(x ? { x } : {})` spreads; every number that is a limit is a named constant; delete only through `safeDelete*` helpers.
- Agency syntax in the judge program follows `docs/site/guide/basic-syntax.md`. Check it parses with `pnpm run ast lib/agents/eval/checklistJudge.agency`.

## Review Focus

- A `graders.json` with a kind nobody defined, such as `"rubric"`, must fail at load with the index and the kind, not at grade time. Pinned in Task 1.
- A `number` grader with both `max` and `full`/`zero`, or with neither, must fail at load. Pinned in Task 1.
- A `count` grader whose narrowing fields do not fit its `count`, such as `{ "count": "errors", "tool": "fetch" }`, must fail at load rather than silently count every error. Pinned in Task 1.
- A `command` grader whose command hangs or reads stdin must fail after its timeout, not hang the grading pass. Pinned in Task 3.
- A checklist grader loaded from a stored run must find its context file in the stored `graderFiles/` copy after the test folder is gone. Pinned in Task 7.

---

### Task 1: Parse and validate the file

**Files:**
- Create: `lib/eval/gradersJson/schema.ts`
- Test: `lib/eval/gradersJson/schema.test.ts`

**Interfaces:**
- Produces:
  - `type GraderSpec = GoalSpec | ChecklistSpec | NumberSpec | CountSpec | CommandSpec`, a discriminated union on `kind`, with the fields the spec names. Shared optional fields on each: `weight?: number`, `mustPass?: boolean`. `GoalSpec` has `goal: string` and `passingScore?: number`. `ChecklistSpec` has `points: string[]` (at least one, none empty) and `context?: string`. `NumberSpec` has `measure: "llmCalls" | "costUsd" | "agentSeconds" | "tokensIn" | "tokensOut"` and either `{ full: number; zero: number }` or `{ max: number }`. `CountSpec` has `count: "toolCalls" | "errors" | "llmCalls"`, `tool?: string`, `repeated?: boolean`, `messageStartsWith?: string`, `max: number`. `CommandSpec` has `command: string` and `timeoutSec?: number`.
  - `type GradersJson = GraderSpec[]`.
  - `parseGradersJson(text: string, filePath: string): GradersJson`. Throws `Error`. Messages: `` `${filePath}: must be a JSON list of graders` `` (also for a JSON syntax error); `` `${filePath}: grader ${index}: unknown kind "${kind}"` ``; `` `${filePath}: grader ${index}: ${zodIssueMessage}` `` for a field problem, where the message names the field; `` `${filePath}: two graders named "${name}"` ``; `` `${filePath}: grader ${index} (${name}): a must-pass goal grader needs passingScore` ``; `` `${filePath}: grader ${index} (${name}): a number grader has either full and zero or max, not both` `` and the same sentence ending "needs full and zero or max" when neither is present; `` `${filePath}: grader ${index} (${name}): ${field} only applies to count "${count}"` `` when `tool` or `repeated` appears without `count: "toolCalls"`, or `messageStartsWith` without `count: "errors"`.

The file has two kinds of rule, and each kind lives in one table so that adding a sixth grader kind or a new cross-field rule is one row, not a new branch:

- `KIND_SCHEMAS: Record<GraderSpec["kind"], ZodObject>`, one strict object schema per kind. `parseGradersJson` reads `kind` off each element, looks it up here, and runs the schema it finds. A `kind` with no row is the unknown-kind error. A zod discriminated union would report an unknown discriminator as "Invalid discriminator value" with no index and no kind, which is why the lookup is a table and not a union.
- `RULES: { applies: (spec: GraderSpec) => boolean; problem: string }[]`, the cross-field rules: must-pass goal needs `passingScore`; number has `full`+`zero` or `max`, not both and not neither; `tool` and `repeated` only with `toolCalls`; `messageStartsWith` only with `errors`. `parseGradersJson` maps each spec over the rules and reports the first that applies, with the index and name in front.

The unique-name check is a third, separate line: collect the names, find the first that appears twice.

- [ ] **Step 1: Write the failing tests**

```ts
describe("parseGradersJson", () => {
  it("parses the five kinds", () => { /* one of each, expect toEqual the input */ });
  it("refuses a file that is not a list", () => {
    expect(() => parseGradersJson("{}", "t/graders.json")).toThrow("t/graders.json: must be a JSON list of graders");
  });
  it("names the index and the kind for an unknown kind", () => {
    expect(() => parseGradersJson('[{"kind":"rubric","name":"r"}]', "t/graders.json")).toThrow('t/graders.json: grader 0: unknown kind "rubric"');
  });
  it("refuses two graders with one name", () => { /* toThrow('two graders named "a"') */ });
  it("requires passingScore on a must-pass goal grader", () => { /* ... */ });
  it("requires exactly one way to score a number grader", () => {
    // both full/zero and max → "not both"; neither → "needs full and zero or max"
  });
  it("refuses a count narrowing field that does not fit the count", () => {
    // { count: "errors", tool: "fetch" } → 'tool only applies to count "toolCalls"'
    // { count: "toolCalls", messageStartsWith: "x" } → 'messageStartsWith only applies to count "errors"'
    // { count: "llmCalls", repeated: true } → 'repeated only applies to count "toolCalls"'
  });
  it("requires at least one non-empty point on a checklist", () => { /* ... */ });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm vitest run lib/eval/gradersJson/schema.test.ts > /tmp/claude-501/schema.txt 2>&1; tail -20 /tmp/claude-501/schema.txt`
Expected: fail, module not found.

- [ ] **Step 3: Implement `schema.ts`**

- [ ] **Step 4: Run the tests and typecheck**

Run: `pnpm vitest run lib/eval/gradersJson/schema.test.ts > /tmp/claude-501/schema.txt 2>&1; tail -5 /tmp/claude-501/schema.txt && pnpm run typecheck`
Expected: pass, clean.

- [ ] **Step 5: Commit**

Commit message: `graders.json: parse and validate the five grader kinds (ADI-29)`.

---

### Task 2: `points` on a grade and on the score row

**Files:**
- Modify: `lib/eval/grading/types.ts:27` (Grade)
- Modify: `lib/runDirectory/annotations.ts:39-54` (ScorePayload) and `:168-185` (ScoreAnnotationSchema)
- Modify: `lib/runDirectory/mutations.ts:476-486` (ScoreDraft) and `:515-530` (recordGradingPass)
- Modify: `lib/eval/grading/gradeSuite.ts:60-80` (scoreDrafts)
- Modify: `lib/eval/grading/gradeBreakdown.ts:5-7` (GradeRow) and `:23-27` (gradeRow)
- Modify: `lib/cli/eval/formatGrade.ts:74-80` (formatGrade)
- Test: `lib/runDirectory/annotations.test.ts`, `lib/eval/grading/gradeSuite.test.ts`, `lib/cli/eval/formatGrade.test.ts`

**Interfaces:**
- Produces: `type Point = { point: string; pass: boolean; evidence: string }`, exported from `lib/eval/grading/types.ts`. `Grade` gains `points?: Point[]`. `ScorePayload`, `ScoreDraft`, and `GradeRow` gain the same optional field. The zod schema for a score row accepts `points` as an optional array of `{ point: string, pass: boolean, evidence: string }`, strict.

`points` lives on `Grade`, not only on the row, because the checklist judge's `passes()` reads it from the grade in the gate loop.

- [ ] **Step 1: Write the failing tests**

In `annotations.test.ts`: a score row with `points` parses, and one with a point missing `evidence` is rejected. In `gradeSuite.test.ts`: `scoreDrafts` copies `grade.points` onto the draft when present and leaves the field absent when not. In `formatGrade.test.ts`: `formatGradeResult` prints, under a grader with points, the feedback line first and then one line per point in the form `      ✓ <point>` or `      ✗ <point>`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run lib/runDirectory/annotations.test.ts lib/eval/grading/gradeSuite.test.ts lib/cli/eval/formatGrade.test.ts > /tmp/claude-501/points.txt 2>&1; tail -30 /tmp/claude-501/points.txt`

- [ ] **Step 3: Thread `points` through the six files**

Copy the field at each hop exactly as `feedback` is copied today.

- [ ] **Step 4: Run the tests and typecheck**

- [ ] **Step 5: Commit**

Commit message: `Score rows carry per-point answers (ADI-29)`.

---

### Task 3: Build graders from the file: number, count, command

**Files:**
- Create: `lib/eval/gradersJson/build.ts`
- Test: `lib/eval/gradersJson/build.test.ts`

**Interfaces:**
- Consumes: `GraderSpec` from Task 1; `grader()` from `lib/eval/grading/functionGrader.ts`; `binary()` and `scalar()` from `lib/eval/grading/grade.ts`; `EvalRecord` from `lib/eval/types.ts`.
- Produces: `buildGraders(specs: GradersJson): BaseGrader[]`. Internally one builder per kind: `numberGrader(spec: NumberSpec): BaseGrader`, `countGrader(spec: CountSpec): BaseGrader`, `commandGrader(spec: CommandSpec): BaseGrader`. Goal and checklist are added in Task 5; until then `buildGraders` throws `Error("not yet: " + kind)` for them.

Each kind separates what it measures from how it scores, so the "what" is a table and the "how" is one short function that reads the table.

**number.** A table `MEASURES: Record<NumberSpec["measure"], { read: (record: EvalRecord) => number; describe: (value: number) => string }>` holds the five measures: `llmCalls` reads `record.metrics.llmCalls` and describes as `"14 LLM calls"`; `costUsd` reads `record.metrics.costUsdTotal` and describes through `formatUsd` from `lib/cli/eval/formatGrade.ts` (move it to a shared module if importing from `cli` is wrong; check where the other eval formatters live); `agentSeconds` reads `record.durationMs / 1000` and describes as `"83s"`; `tokensIn` and `tokensOut` read `tokensInTotal` and `tokensOutTotal` and describe as `"12k tokens in"` and `"3k tokens out"`. The builder reads the measure, then scores it: with `max`, `binary(value <= max, description)`; with `full` and `zero`, `scalar(clamp((zero - value) / (zero - full), 0, 1), description)`. No `switch` on the measure anywhere.

**count.** A table `COUNTS: Record<CountSpec["count"], (record: EvalRecord) => CountRow[]>` selects the rows: `toolCalls` is `record.events` with `kind === "tool_start"`, `errors` is `record.errors`, `llmCalls` is `record.events` with `kind === "llm"`. `CountRow` is a small type with the fields a narrowing can read: `{ tool?: string; args?: string; message?: string }`, built from the record row. Narrowings are predicates composed from the spec: `tool` keeps rows whose `tool` equals it; `messageStartsWith` keeps rows whose `message` starts with it; `repeated` keeps a row whose `tool` and `args` equal an earlier kept row's. The builder selects, filters, counts, and returns `binary(n <= max, `${n} matching row${n === 1 ? "" : "s"}, max ${max}`)`.

**command.** Constants, not literals: `DEFAULT_COMMAND_TIMEOUT_SEC = 600`, `COMMAND_OUTPUT_MAX_BYTES = 16 * 1024 * 1024`, `FEEDBACK_MAX_CHARS = 2000`. When `workdir === ""`, `binary(false, "no working directory was captured")`. Otherwise `spawnSync("sh", ["-c", command], { cwd: workdir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: timeoutSec * 1000, maxBuffer: COMMAND_OUTPUT_MAX_BYTES })`. Pass when `status === 0`. When `error?.code === "ETIMEDOUT"`, fail with feedback `` `timed out after ${timeoutSec}s` ``. Otherwise the feedback is stdout and stderr joined, cut to `FEEDBACK_MAX_CHARS` with a trailing "…" when cut. The agent suite's pytest runner in `evals/agency-agent/lib/checks.ts` does the same spawn today; it stays as it is until that suite converts to command graders, and the dev doc says so.

Every builder passes `{ name, weight, mustPass }` from the spec into `grader()`'s options through one shared helper, `optionsOf(spec)`, so the three fields are read in one place.

- [ ] **Step 1: Write the failing tests**

Build an `EvalRecord` by hand in the test (the type is in `lib/eval/types.ts`; fill `metrics`, `events`, `errors`, `durationMs`, and leave the rest minimal). Call each grader's `run()` with a `GraderInput` whose `run.record` is that record and whose `run.workdir` is a temp dir. The judges and `runAgency` are unused by these three kinds; pass a stub.

```ts
it("number: scores on a line between full and zero", async () => {
  // llmCalls = 15, full 0, zero 30 → value 0.5, feedback "15 LLM calls"
});
it("number: max is pass or fail", async () => { /* agentSeconds 360 > max 300 → pass false */ });
it("count: repeated tool calls match on tool and argsPreview", async () => {
  // three fetchMarkdown starts, two with the same argsPreview → 1 matching row, max 0 → fail
});
it("count: two calls that differ only after the 200-character preview count as repeated", async () => { /* documents the spec's allowance */ });
it("count: errors by message prefix", async () => { /* ... */ });
it("command: exit 0 passes with the output as feedback", async () => { /* sh -c "echo hi" → pass, feedback "hi\n" */ });
it("command: non-zero exit fails", async () => { /* sh -c "exit 3" */ });
it("command: a command that reads stdin does not hang", async () => { /* sh -c "cat" with timeoutSec 5 → returns, pass true because cat sees EOF and exits 0 */ });
it("command: a command past its timeout fails and says so", async () => { /* sh -c "sleep 5" with timeoutSec 1 → pass false, feedback "timed out after 1s" */ });
it("command: no workdir fails with a message", async () => { /* workdir "" → "no working directory was captured" */ });
it("buildGraders passes name, weight and mustPass through", async () => { /* grader.name(), weight(), mustPass() */ });
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run lib/eval/gradersJson/build.test.ts > /tmp/claude-501/build.txt 2>&1; tail -30 /tmp/claude-501/build.txt`

- [ ] **Step 3: Implement `build.ts` for the three kinds**

- [ ] **Step 4: Run the tests and typecheck**

- [ ] **Step 5: Commit**

Commit message: `graders.json: number, count and command graders (ADI-29)`.

---

### Task 4: The checklist judge program and its file helper

**Files:**
- Create: `lib/agents/eval/checklistJudge.agency`
- Create: `lib/eval/grading/checklistJudgeFile.ts`
- Test: `lib/eval/grading/checklistJudgeFile.test.ts`

**Interfaces:**
- Produces: `checklistJudgeFile(): string`, `CHECKLIST_JUDGE_VERSION = 1`, `CHECKLIST_JUDGE_PROMPT_SHA256`, and `ChecklistVerdict`, a zod schema for `{ points: { name: string; pass: boolean | null; evidence: string }[]; note: string }`. The Agency node is `main(points: string[], work: string, context: string = ""): Verdict` with the `Verdict` type from the set-aside spec: `points: Point[]` where `Point = { name: string, pass: boolean | null, evidence: string }`, and `note: string`.

- [ ] **Step 1: Write the failing test**

Copy `goalJudgeFile.test.ts` and adjust the names: the file exists on disk, the file hashes to the pinned constant, and `ChecklistVerdict` accepts a sample verdict.

- [ ] **Step 2: Run it to see it fail**

- [ ] **Step 3: Write the judge program**

Model it on `rubricJudge.agency`. The prompt lists the points by number and asks for yes, no, or cannot tell on each, with a quote from the work as evidence. It says the context is background and not an answer key, and that the answers must come back in the same order as the points. Use `@jsonSchema` descriptions on the type fields as the other judges do. Check it parses: `pnpm run ast lib/agents/eval/checklistJudge.agency > /dev/null`.

- [ ] **Step 4: Write the helper, pin the hash, run the test, typecheck**

Compute the hash with `shasum -a 256 lib/agents/eval/checklistJudge.agency`. The test prints the real hash on a mismatch.

- [ ] **Step 5: Run `make` so the judge is built, then commit**

The bundled agents are built by `make`, not `pnpm run build`. Run `make > /tmp/claude-501/make.txt 2>&1; tail -5 /tmp/claude-501/make.txt`.

Commit message: `The checklist judge: one answer per point (ADI-29)`.

---

### Task 5: `ChecklistJudge` grader, and the goal and checklist builders

**Files:**
- Create: `lib/eval/grading/graders/checklistJudge.ts`
- Test: `lib/eval/grading/graders/checklistJudge.test.ts`
- Modify: `lib/eval/gradersJson/build.ts` (add `goalGrader`, `checklistGrader`)
- Modify: `lib/eval/gradersJson/build.test.ts`
- Modify: `lib/eval/public.ts` (export `ChecklistJudge` and `checklistJudgeFile`)

**Interfaces:**
- Consumes: `ChecklistVerdict`, `checklistJudgeFile()` from Task 4; `Point` from Task 2; `LlmJudge` from `lib/eval/grading/graders/llmJudge.ts`; `asJudgeText` from `lib/eval/grading/goalJudgeFile.ts`.
- Produces:
  - `class ChecklistJudge extends BaseGrader` with options `GraderOptions & { points: string[]; context?: string }`. `defaultName = "checklist"`. The constructor throws `` `${name}: a checklist judge cannot be sampled; its per-point answers do not survive aggregation` `` when `options.samples` is greater than 1. `annotator()` returns `{ kind: "judge", id: `checklist-judge@${CHECKLIST_JUDGE_VERSION}` }` unless `revision` is set, mirroring `LlmJudge`. No `externalFiles`: `context` is a path relative to the run's `graderFiles` directory, read at grade time as `path.join(input.graderFiles, context)`, and when `input.graderFiles` is undefined or the file is missing the grader throws `` `${name}: context file ${context} is not in graderFiles/` ``. `_run` calls `runAgency.runStructured(checklistJudgeFile(), "main", [points, asJudgeText(run.output), contextText], ChecklistVerdict)`. It throws `` `${name}: the judge answered ${answers} points for ${asked} asked` `` when the counts differ. The grade is `scalar(passed / points.length, note)` with `points` set to `[{ point, pass: pass === true, evidence }]` in order, so `null` is a fail. `point` is the input point's text, taken by index, not the short `name` the judge invents. `passes(grade)` is overridden: when `grade.points` is present, true only if every point passed; when absent, the grade's scalar value must be 1. It never calls `super.passes()`, because the base method throws for a must-pass scalar with no threshold and a checklist has none by design. Say both rules in the class comment.
  - `goalGrader(spec: GoalSpec): BaseGrader` is `new LlmJudge({ name, goal, weight, mustPass, threshold: passingScore })`.
  - `checklistGrader(spec: ChecklistSpec): BaseGrader` is `new ChecklistJudge({ name, points, weight, mustPass, context })`.

- [ ] **Step 1: Write the failing tests**

Build the runner the way `llmJudge.test.ts` does: `new AgencyRunner({}, async () => ({ data: verdict }))`, where the second argument is the `runNode` stub and `verdict` is the object the judge would return.

```ts
it("scores the share of points that passed and carries the points", async () => {
  // 3 points, verdict passes 2 → value 0.667 (toBeCloseTo), points.length 3, feedback = note, points[i].point = the input text
});
it("counts cannot-tell as a fail", async () => { /* pass: null → pass false on the point */ });
it("fails the grader when the judge answers the wrong number of points", async () => { /* rejects.toThrow("answered 2 points for 3 asked") */ });
it("reads context from the run's graderFiles copy", async () => { /* write a temp graderFiles dir, assert the stub saw its contents as the third argument */ });
it("fails with a message when the context file is missing", async () => { /* rejects.toThrow("is not in graderFiles/") */ });
it("refuses samples greater than 1", () => { /* constructor throws */ });
it("a must-pass checklist passes only when every point passed", () => { /* passes() on a grade with one false → false; all true → true; no points and value 1 → true */ });
it("goalGrader builds an LlmJudge with the goal and passing score", () => { /* name(), mustPass(), passes({scalar 0.4}) false, passes({scalar 0.6}) true */ });
```

- [ ] **Step 2: Run them to see them fail**

- [ ] **Step 3: Implement the class and the two builders; export from `public.ts`**

- [ ] **Step 4: Run the tests and typecheck**

- [ ] **Step 5: Commit**

Commit message: `graders.json: goal and checklist graders (ADI-29)`.

---

### Task 6: Discover the file beside `test.json`

**Files:**
- Modify: `lib/eval/runTypes.ts:50-57` (the doc comment on `graders`)
- Modify: `lib/eval/loadInputs.ts:148-158` (loadTestDir) and the resolver near `:355-365`
- Test: `lib/eval/loadInputs.test.ts`

**Interfaces:**
- Produces: `Test.graders` holds the path to either `graders.ts` or `graders.json`; the comment says so. `loadTestDir` sets `spec.graders = "./graders.json"` when that file exists and no `graders.ts` does. Both present throws `` `${testDir}: has both graders.ts and graders.json; keep one` ``. `resolveGradersFile` accepts a `.json` file as well as a `.ts` one, and its message at `:360-361` says "must name a graders.ts or graders.json file".

Nothing else in the loader changes: `requireGoal` at `:231` already drops the goal requirement when `graders` is set.

- [ ] **Step 1: Write the failing tests**

Using the temp-dir helpers already in `loadInputs.test.ts`:

```ts
it("discovers graders.json beside test.json and drops the goal requirement", () => { /* test.graders is the absolute .json path; no goal → no error */ });
it("refuses a folder with both graders.ts and graders.json", () => { /* toThrow("has both graders.ts and graders.json") */ });
it("resolves an explicit .json graders path and refuses a missing one", () => { /* ... */ });
```

- [ ] **Step 2: Run them to see them fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the tests and typecheck**

- [ ] **Step 5: Commit**

Commit message: `Loader: discover graders.json beside test.json (ADI-29)`.

---

### Task 7: Live loading, snapshot on `eval run`, and loading from the snapshot

**Files:**
- Create: `lib/eval/gradersJson/load.ts`
- Create: `lib/eval/grading/graderSources.ts`
- Test: `lib/eval/gradersJson/load.test.ts`, `lib/eval/grading/graderSources.test.ts`
- Modify: `lib/eval/grading/gradingModule.ts:55-60` (GradersSnapshot), `:88-95` (RecordedGraders)
- Modify: `lib/runDirectory/annotations.ts:61-70` (GradersIdentity) and `:192-201` (schema)
- Modify: `lib/eval/run/runSuite.ts:352-375` (snapshotGraders) and `:434-441` (the run row)
- Modify: `lib/eval/grading/gradeRun.ts:283-297` (makeGraderModuleCache)
- Test: `lib/eval/run/runSuite.test.ts`, `lib/eval/grading/gradeRun.test.ts`, `lib/runDirectory/annotations.test.ts`

There are two sources a test's graders can come from, a TypeScript module or a JSON file, and three operations on a source: load it live, store it in a run directory, and load it back from the store. Today the module source's three operations are three functions in `gradingModule.ts`. Rather than add an `if` on the file extension at each of the three call sites, this task puts the two sources behind one declarative record and gives the call sites one lookup.

**Interfaces:**
- Produces, in `lib/eval/grading/graderSources.ts` (new; move the three module functions' call sites to it, leave their bodies in `gradingModule.ts`):
  - `type GraderSource = { matchesPath: (path: string) => boolean; matchesRecord: (recorded: RecordedGraders) => boolean; load: (path: string) => Promise<BaseGrader[]>; snapshot: (path: string) => Promise<GradersSnapshot>; loadSnapshot: (gradersDir: string, recorded: RecordedGraders) => Promise<BaseGrader[]> }`.
  - `GRADER_SOURCES: GraderSource[]`, two entries: the module source (matches `.ts`, and a record with `bundleFile`; its three functions are `loadGradingModule`, `snapshotGradingModule`, `loadGradingSnapshot` as they exist today) and the JSON source (matches `.json`, and a record with `jsonFile`; its three functions come from `lib/eval/gradersJson/load.ts` below).
  - `graderSourceForPath(path: string): GraderSource` and `graderSourceForRecord(recorded: RecordedGraders): GraderSource`, each the first entry that matches, throwing `` `no grader source for ${path}` `` otherwise.
- Produces, in `lib/eval/gradersJson/load.ts`:
  - `async loadGradersJson(filePath: string): Promise<BaseGrader[]>`: reads the file, `parseGradersJson`, `buildGraders`, and sets each grader's `revision` to `` `${filePath}@${sha256Text(text)}` ``, as `loadGradingModule` does for a module. It is `async` so a parse error arrives as a rejected promise, as a bad module's does, with no `try`.
  - `async snapshotGradersJson(filePath: string): Promise<GradersSnapshot>`: loads the graders once so a broken file fails before any agent runs, and returns `{ source: filePath, jsonFile: `${sha256}.json`, judgeFiles: {}, files: [{ name: jsonFile, content: text }] }`. `judgeFiles` is empty because no JSON kind has external files.
  - `async loadGradersJsonSnapshot(gradersDir: string, recorded: RecordedGraders): Promise<BaseGrader[]>`: reads the stored JSON named by `recorded.jsonFile`, builds with `buildGraders(parseGradersJson(text, storedPath))`, and sets `revision` to `` `${recorded.source}@${sha256}` ``. A missing stored file throws the same not-found message shape `loadGradingSnapshot` uses.
- Changes:
  - `GradersSnapshot`, `RecordedGraders` and `GradersIdentity` change from `bundleFile: string` to `bundleFile?: string; jsonFile?: string`. The zod schema requires exactly one of them, with `.refine` and the message `"graders needs exactly one of bundleFile and jsonFile"`.
  - `makeGraderModuleCache` in `gradeRun.ts` calls `graderSourceForPath(path).load(path)`. `snapshotModuleGraders` calls `graderSourceForRecord(snapshot).loadSnapshot(gradersDir, snapshot)` where it calls `loadGradingSnapshot` today. `snapshotGraders` in `runSuite.ts` calls `graderSourceForPath(modulePath).snapshot(modulePath)`. None of the three mentions an extension or a field name.
  - The run row in `runSuite.ts:434-441` is built today with the `...(x === undefined ? {} : { ... })` spread, which `docs/dev/contributing/anti-patterns.md` forbids. Build the identity with a small function `gradersIdentityOf(snapshot: TestGraders): GradersIdentity` that assigns `bundleFile` and `jsonFile` with plain `if` statements, and use it there.

- [ ] **Step 1: Write the failing tests**

In `graderSources.test.ts`: `graderSourceForPath("x/graders.json")` is the JSON source and `"x/graders.ts"` the module source; `graderSourceForRecord({ jsonFile })` and `({ bundleFile })` likewise; an unknown path throws. In `load.test.ts`: `loadGradersJson` sets `revision` to `path@sha`; `snapshotGradersJson` returns the JSON under its hash name; a file with an unknown kind rejects through `makeGraderModuleCache`. In `annotations.test.ts`: a run row with `jsonFile` and no `bundleFile` parses; one with both or neither is rejected with the refine message. In `runSuite.test.ts`, beside the existing snapshot test at line 577: a suite test whose `graders` is a `.json` records `jsonFile` on its run row, stores the file under `graders/`, and a checklist grader loaded from that run reads its context from the stored `graderFiles/` copy after the test folder is removed with `safeDeleteDirectoryWithin(tmpRoot, testDir)` from `lib/utils.ts`. In `gradeRun.test.ts`: grading a run directory whose row names a `jsonFile` loads the stored JSON, and a test loaded live with a `.json` graders path grades through the cache.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run lib/eval/grading/graderSources.test.ts lib/eval/gradersJson/load.test.ts lib/runDirectory/annotations.test.ts lib/eval/run/runSuite.test.ts lib/eval/grading/gradeRun.test.ts > /tmp/claude-501/load.txt 2>&1; tail -40 /tmp/claude-501/load.txt`

- [ ] **Step 3: Implement**

Search every reader of `bundleFile` first (`grep -rn bundleFile lib --include=*.ts`) and make each one handle the optional field, so an old run row and a new one both load.

- [ ] **Step 4: Run the tests and typecheck**

- [ ] **Step 5: Commit**

Commit message: `graders.json: live loading, snapshot on run, load from snapshot (ADI-29)`.

---

### Task 8: An end-to-end check against a converted test

**Files:**
- Create: `lib/eval/gradersJson/fixtures/packaging-decision/test.json` and `graders.json`, the seven graders from the spec's Part 1 example written out in full. No `files/`: the test never runs the agent.
- Test: `lib/eval/gradersJson/endToEnd.test.ts`

The fixture lives beside the test, not under `evals/agency-agent/`, because every subfolder there with a `test.json` is a test the CI suite runs at real cost.

- [ ] **Step 1: Write the test**

Load the fixture folder with `loadInputs` and assert the test's `graders` ends in `graders.json`. Build its graders with `loadGradersJson` and assert seven names in order: `takes-a-position`, `grounded-in-repo`, `finds-the-hinge`, `readability`, `llm-calls`, `wall-seconds`, `cost-usd`. Assert `takes-a-position` is must-pass and `passes({ scalar 0.4 })` is false. No LLM call: do not run the judges.

- [ ] **Step 2: Run it, typecheck, commit**

Commit message: `graders.json: packaging-decision as a fixture (ADI-29)`.

Note in the PR that the `readability` grader is a checklist in the JSON version where the TypeScript used a rubric, so the two are siblings, not twins.

---

### Task 9: The dev doc and the index lines

**Files:**
- Create: `docs/dev/evals/graders-json.md`
- Modify: `CLAUDE.md` (the evals list under "Evals and optimizers") and `.claude/skills/agency-evals-docs/SKILL.md` (add the file with `git add -f`; it is gitignored)
- Modify: `docs/dev/evals/eval-grading.md` (one paragraph pointing at the new page)

- [ ] **Step 1: Write the doc**

Cover, in this order, with an example before each explanation: the file and its five kinds; must-pass per kind; how the loader finds the file and refuses both; what `eval run` stores and how `eval grade` loads it; points on the score row; the checklist judge, its version pin, and why its context lives under `graderFiles/`; what is deliberately not in the file (weights per point, a rubric kind, `samples`). Four facts the reader needs that are easy to miss: `agentSeconds` equals wall time today and will subtract prompt waits once ADI-32 lands; `repeated` compares the 200-character `argsPreview` because no row in the record carries the full arguments; a command grader runs inside the run directory's stored workdir and may dirty it, so a command must not depend on a clean one; a must-pass goal grader needs `passingScore` because a scalar gate with no threshold cannot fail. Follow `docs/dev/contributing/general-writing-tips.md` and read `verbal-tics.md` before committing.

- [ ] **Step 2: Add the index lines**

One line in each index, in the form the other evals entries use.

- [ ] **Step 3: Commit**

Commit message: `Docs: graders.json (ADI-29)`.
