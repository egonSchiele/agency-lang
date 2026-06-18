# Inputs Terminology Unification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. (Per the repo owner's standing preference, do **not** use subagent-driven development — implement directly in the main session.)

**Goal:** Make "input" the single term for "the data passed into an agent for one run" across both the eval and optimizer subsystems, eliminating the current `EvalTask`/`tasks` (eval) vs `Input`/`inputs` (optimizer) split.

**Architecture:** Three independent renames landed in sequence. (1) Free up the word "input" by renaming the essentially-unused recorded-value primitive `evalInput()` → `evalValue()`. (2) Collapse the two run-spec types (`EvalTask` and the grading `Input`) into one shared `Input` type defined in the eval layer, updating every TypeScript consumer while leaving the on-disk/CLI/Agency-facing contracts temporarily unchanged. (3) Flip all user- and disk-facing contracts (CLI flag, task-file JSON schema, artifact directory layout, Agency stdlib signatures) to "input". (4) Regenerate docs and update fixtures.

**Tech Stack:** TypeScript (Node, ESM), vitest, the Agency compiler/stdlib (`.agency` + generated `.js`), `make` for stdlib build, `agency doc` for stdlib reference generation.

## Global Constraints

- **Always run `make` after changing any `.agency` stdlib file** (`stdlib/*.agency`, `stdlib/agency/*.agency`). `pnpm run build` alone does not copy stdlib/agents into `dist`.
- **Code style (enforced by structural linter):** objects not maps, arrays not sets, `type` not `interface`, no dynamic imports, no force-push/amend. Run `pnpm run lint:structure` before each commit.
- **Do not run the full agency execution test suite locally** — it is slow/expensive. Run only the specific vitest files named in each task. CI runs the full suite on the PR.
- **`evalOutput()` / `evalOutputs` / `evalOutputRecorded` are NOT renamed.** Only the *input* recorded-value primitive moves to `evalValue` (decision below). The asymmetry (`evalValue` + `evalOutput`) is intentional and owner-approved.
- **This is a hard rename — no back-compat aliases** for the CLI flag, JSON keys, Agency signatures, or artifact directory names.
- Commit after every task. Write commit messages to a file and pass with `git commit -F` (apostrophes on the command line break). End commit messages with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.

---

## Design Decisions (read before starting)

These were settled with the repo owner and are not up for re-litigation during execution:

1. **Collision resolution.** `EvalRecord.evalInputs` / the stdlib `evalInput()` / the `evalInputRecorded` statelog event are the "values an agent *records during a run*" concept — a *different* meaning of "input" that would collide with the run-spec rename. `evalInput()` is essentially unused today, so rename it (and only it) to `evalValue()` to vacate the word. `evalOutput()` stays as-is.
2. **One shared type.** `EvalTask` and the grading `Input` collapse into a single `Input` type. It lives in the **eval layer** (`lib/eval/runTypes.ts`) because the optimizer imports from eval, never the reverse.
3. **Hard rename of user-facing surfaces.** CLI `--tasks` → `--inputs`; task-file JSON top-level `tasks` array → `inputs` and per-item `task_id` → `id`; artifact dirs `runs/<id>/tasks/<task-id>/` → `runs/<id>/inputs/<input-id>/` and `task.json` → `input.json`; Agency stdlib `evalRun`/`optimize`/`evalJudgeSuite` parameter `tasks` → `inputs` and the `EvalTask` Agency type → `Input`.

### The unified `Input` type (final shape)

Defined in `lib/eval/runTypes.ts`, replacing `EvalTask`. `goal` and `working_dir` become first-class optional fields (the optimizer previously smuggled `goal` through `metadata.goal` and dropped `working_dir` entirely):

```ts
/** One invocation of an agent: which node, with which args, plus optional
 *  grading metadata. Shared by the eval runner and every optimizer. */
export type Input = {
  /** Stable identifier. Auto-derived when omitted: the loader generates one
   *  via nanoid; the optimizer derives it positionally (`input-<index>`). */
  id?: string;
  /** What the agent should accomplish — read by the goal judge and the
   *  pairwise judge suite. Optional; the task-file loader requires it. */
  goal?: string;
  /** Named arguments passed to the node. */
  args: Record<string, any>;
  /** Entry node to run. Defaults to the agent's default node at run time. */
  node?: string;
  /** Directory copied into the run's workdir before execution. */
  working_dir?: string;
  /** Freeform, grader-agnostic metadata (tags, expectedOutput, …). */
  metadata?: Record<string, any>;
};
```

Notes:
- The grading layer's `Input` (`lib/optimize/grading/types.ts`) is **deleted** and re-imported from `lib/eval/runTypes.ts`. The `JSON` / `JSONPath` / `Score` / `Grade` / `GraderInput` / `GraderOptions` / `GraderScope` types stay in `grading/types.ts`.
- `args`/`metadata` use `Record<string, any>` (eval's existing looseness) rather than the grading layer's `Record<string, JSON>`. Widening `JSON`→`any` is safe for reads; where grading code assigns into a `JSON`-typed slot, keep the existing `as` cast.
- Because `goal` is now first-class, change the goal judge's default path from `["metadata","goal"]` to `["goal"]` (Task 2, Step on `cli/eval/optimize.ts` + `LlmJudge`).
- `rubric` handling in the loader is unchanged (it remains a validation-only field, not part of `Input`).

### Rename map A — collision removal (Task 1)

| Old | New |
|-----|-----|
| `_evalInput` (fn, `lib/stdlib/statelog.ts`) | `_evalValue` |
| `_evalInputs` (reader fn, `lib/stdlib/statelog.ts`) | `_evalValues` |
| `evalInput` (Agency fn, `stdlib/statelog.agency`) | `evalValue` |
| `evalInputs` (Agency reader, `stdlib/statelog.agency`) | `evalValues` |
| `evalInputRecorded()` (method, `lib/statelogClient.ts`) | `evalValueRecorded()` |
| `"evalInputRecorded"` (event type string, everywhere) | `"evalValueRecorded"` |
| `EvalRecord.evalInputs` (field, `lib/eval/types.ts`) | `EvalRecord.evalValues` |
| `StatelogParser.evalInputs()` (`lib/eval/statelogParser.ts`) | `evalValues()` |
| `heuristicInputs` (`lib/eval/extract.ts`) | `heuristicValues` |
| `warnMissingInput` (extract option) | `warnMissingValue` |
| warning text "Call evalInput(prompt)…" | "Call evalValue(prompt)…" |

**Unchanged:** `evalOutput`, `_evalOutput`, `evalOutputs`, `evalOutputRecorded`, `EvalRecord.evalOutputs`, `EvalValue` (the value-shape type keeps its name).

### Rename map B — internal TS unification (Task 2)

| Old | New |
|-----|-----|
| `EvalTask` (type) | `Input` |
| `.task_id` (field) | `.id` |
| `.task` (PreparedEvalTask field, runner/extractor arg) | `.input` |
| `EvalRunTaskResult` (type) | `EvalRunInputResult` |
| `EvalRunTaskResult.taskId` | `.inputId` |
| `EvalRunResult.tasks` | `.inputs` |
| `EvalRunConfig.tasks` / `.tasksSource` | `.inputs` / `.inputsSource` |
| `EvalRunState.tasksDir` / `.tasksSource` | `.inputsDir` / `.inputsSource` |
| `PreparedEvalTask` (type) | `PreparedInput` |
| `PreparedEvalTask.taskDir` / `.taskJsonPath` | `.inputDir` / `.inputJsonPath` |
| `prepareEvalTask` | `prepareInput` |
| `recordEvalTaskPrepareFailure` / `…RunFailure` / `…Success` | `recordInputPrepareFailure` / `…RunFailure` / `…Success` |
| `runEvalTask` (fn, `lib/eval/runEvalTask.ts`) | `runEvalInput` (file → `runEvalInput.ts`) |
| `EvalTaskRunner` | `EvalInputRunner` |
| `EvalRecordExtractor` arg `task` | arg `input` |
| `loadTasks` / `loadTasksFromFile` / `loadTasksFromDirectory` (file `lib/eval/loadTasks.ts`) | `loadInputs` / `loadInputsFromFile` / `loadInputsFromDirectory` (file → `loadInputs.ts`) |
| `normalizeTask` / `validateTasks` / `taskFromGoal` | `normalizeInput` / `validateInputs` / `inputFromGoal` |
| `assertEvalTaskId` (`lib/eval/ids.ts`), field label `"task_id"` | `assertEvalInputId`, label `"id"` |
| `evalRunLoadedTasks` / `EvalRunLoadedTasksOptions` (`lib/cli/eval/run.ts`) | `evalRunLoadedInputs` / `EvalRunLoadedInputsOptions` |
| `ReadEvalRunTask` / `.taskId` / `readEvalRun().tasksById` | `ReadEvalRunInput` / `.inputId` / `.inputsById` |
| `TaskVerdict` (`lib/eval/judge/suite.ts`) / `.taskId` | `InputVerdict` / `.inputId` |
| `normalizeOptimizeTasks` (file `lib/optimize/tasks.ts`) | `normalizeOptimizeInputs` (file → `lib/optimize/inputs.ts`) |
| `OptimizeLoopConfig.runtime.tasks` / `.tasksSource` | `.inputs` / `.inputsSource` |
| `AgencyEvalRunState.tasks` (`lib/stdlib/agencyEval.ts`) | `.inputs` |
| `_initEvalRun` / `_prepareEvalTask` / `_finalizeEvalTask` params/fields | params/fields renamed to input |

**Already correctly named "input" (no change):** everything in `lib/optimize/grading/*` except the deleted local `Input` type — `GraderInput`, `inputScope`, `gradesInput`, `inputId`, `InputGrades`, `RunInput`, `OptimizeTarget.inputs`, `Scorecard.perInput`, `evaluate(inputs)`, `BaseOptimizer.optimizeTargets(source, inputs)`.

**Conversions that disappear** (both sides become `Input`): the `Input→EvalTask` block in `baseOptimizer.runInputViaEval` (currently `lib/optimize/baseOptimizer.ts:151`), the `Input→EvalTask` builders in `lib/optimize/optimizers/greedyReflective.ts:147` and `lib/optimize/optimizers/example.ts:116`, and the `EvalTask→Input` map in `lib/cli/eval/optimize.ts:74`.

### Rename map C — user/disk-facing surfaces (Task 3)

| Old | New | Location |
|-----|-----|----------|
| `--tasks <fileOrDir>` flag | `--inputs <fileOrDir>` | `scripts/agency.ts` (3 sites: eval run, eval judge, eval optimize) |
| opts `.tasks?: string` | `.inputs?: string` | `EvalRunCliOptions`, `EvalOptimizeOptions`, `EvalJudgeOptions` |
| error "Provide exactly one of --tasks or --goal" | "…--inputs or --goal" | `run.ts`, `optimize.ts`, `evalJudge.ts` |
| JSON top-level `"tasks": [...]` | `"inputs": [...]` | task-file loader (`loadInputsFromFile`), `config.json` writer |
| JSON per-item `"task_id"` | `"id"` | loader `normalizeInput`, `config.json` |
| dir segment `"tasks"` | `"inputs"` | `runArtifacts.initializeEvalRun`, `readRun`, `suite.ts`/docs paths |
| file `"task.json"` | `"input.json"` | `runArtifacts.prepareInput`, `readRun` |
| CLI summary `"N/M tasks ok"` | `"N/M inputs ok"` | `scripts/agency.ts` eval-run handler |
| Agency `evalRun(…, tasks: EvalTask[], …)` | `evalRun(…, inputs: Input[], …)` | `stdlib/agency/eval.agency` |
| Agency `EvalTask` type, `task_id` field | `Input` type, `id` field | `stdlib/agency/eval.agency` |
| Agency `optimize(…, tasks, …)`, `evalJudgeSuite(…, tasks, …)` | `…, inputs, …` | `stdlib/agency/eval.agency` |
| Agency `EvalRunResult.tasks` / `EvalRunTaskResult` | `.inputs` / `EvalRunInputResult` | `stdlib/agency/eval.agency` |

---

## Task 1: Free the word "input" — rename `evalInput()` → `evalValue()`

**Files:**
- Modify: `lib/stdlib/statelog.ts` (`_evalInput`→`_evalValue`, `_evalInputs`→`_evalValues`, client call, error text)
- Modify: `stdlib/statelog.agency` (Agency wrappers `evalInput`/`evalInputs` + docstrings)
- Modify: `lib/statelogClient.ts:653-665` (`evalInputRecorded`→`evalValueRecorded`, event type)
- Modify: `lib/logsViewer/summary.ts:57-58` (`case "evalInputRecorded"` → `"evalValueRecorded"`)
- Modify: `lib/eval/types.ts` (`evalInputs` field → `evalValues`; field-presence matrix row; doc comments)
- Modify: `lib/eval/statelogParser.ts:55-56` (`evalInputs()` → `evalValues()`)
- Modify: `lib/eval/extract.ts` (`collectExplicit("evalInputRecorded")` → `"evalValueRecorded"`; `heuristicInputs`→`heuristicValues`; `warnMissingInput`→`warnMissingValue`; warning text; `record.evalInputs`→`record.evalValues`)
- Modify: `lib/cli/eval/run.ts:217` and `lib/optimize/baseOptimizer.ts:171` (comment text mentioning evalInput) and the `warnMissingInput`/`outputFallback` option name in `optimizeEvalRecordExtractor`
- Test: `lib/stdlib/statelog.test.ts`, `lib/eval/statelogParser.test.ts`, `lib/eval/extract.test.ts`

**Interfaces:**
- Produces: stdlib `evalValue(value: any)`; `StatelogClient.evalValueRecorded(...)`; statelog event `type: "evalValueRecorded"`; `EvalRecord.evalValues: EvalValue[]`; `StatelogParser.evalValues()`; extract option `warnMissingValue`.
- Consumes: nothing new.

- [ ] **Step 1: Rename the wire + client.** In `lib/statelogClient.ts`, rename the method `evalInputRecorded` → `evalValueRecorded` and the emitted `type: "evalInputRecorded"` → `type: "evalValueRecorded"`. In `lib/logsViewer/summary.ts`, change `case "evalInputRecorded":` → `case "evalValueRecorded":` and its label string.

- [ ] **Step 2: Rename the stdlib TS impl.** In `lib/stdlib/statelog.ts`: `_evalInput` → `_evalValue` (calls `client.evalValueRecorded`), `_evalInputs` → `_evalValues` (calls `.evalValues()`), and update the JSON-serializable error message from "evalInput/evalOutput value…" to "evalValue/evalOutput value…".

- [ ] **Step 3: Rename the Agency wrapper.** In `stdlib/statelog.agency`, rename the exported `evalInput` → `evalValue` and `evalInputs` → `evalValues`, importing `_evalValue`/`_evalValues`. Update their docstrings (they become tool descriptions): replace `evalInput`/`evalInputRecorded`/`evalInputs[]` references with the `evalValue` equivalents.

- [ ] **Step 4: Rename the record field + parser.** In `lib/eval/types.ts`, rename `EvalRecord.evalInputs` → `evalValues`; update the field-presence matrix row (`evalInputRecorded` → `evalValueRecorded`) and the prose comments referencing `std::statelog.evalInput()`. In `lib/eval/statelogParser.ts`, rename `evalInputs()` → `evalValues()` and its body `this.evalRecord().evalValues`.

- [ ] **Step 5: Rename the extractor.** In `lib/eval/extract.ts`: `collectExplicit("evalInputRecorded", n)` → `"evalValueRecorded"`; `heuristicInputs` → `heuristicValues`; option `warnMissingInput` → `warnMissingValue`; `record.evalInputs` → `record.evalValues`; and the warning constant text from "no evalInput() calls…/Call evalInput(prompt)…" to "no evalValue() calls…/Call evalValue(prompt)…". In `lib/cli/eval/run.ts` (`optimizeEvalRecordExtractor`) and `lib/optimize/baseOptimizer.ts:171`, update the comment and pass `warnMissingValue: false` (was `warnMissingInput: false`).

- [ ] **Step 6: Update the tests** in `lib/stdlib/statelog.test.ts`, `lib/eval/statelogParser.test.ts`, `lib/eval/extract.test.ts` to the new names: spies `evalValueRecorded`, functions `_evalValue`/`_evalValues`, event strings `"evalValueRecorded"`, field `evalValues`, warning substring `"Call evalValue(prompt)"`. Leave all `evalOutput*` assertions untouched.

- [ ] **Step 7: Rebuild stdlib and verify.**

Run: `make`
Then: `pnpm test:run lib/stdlib/statelog.test.ts lib/eval/statelogParser.test.ts lib/eval/extract.test.ts`
Expected: PASS. Also run `pnpm run build` and confirm `tsc` reports no errors referencing `evalInput`/`evalInputs`.

- [ ] **Step 8: Grep for stragglers and commit.**

Run: `grep -rn "evalInput" lib stdlib scripts --include=*.ts --include=*.agency | grep -v dist`
Expected: no matches (only `evalOutput`/`evalValue` remain).
Then: `pnpm run lint:structure`, write the message to `/tmp/msg1.txt`, and `git add -A && git commit -F /tmp/msg1.txt` (message: "Rename evalInput() to evalValue() to free the input term").

---

## Task 2: Unify the run-spec type — `EvalTask` → shared `Input` (internal TS only)

This task renames every TypeScript symbol and reconciles the two types, but leaves the on-disk directory strings, JSON keys, CLI flag, and Agency `.agency` signatures on "tasks" (Task 3 flips those). At the end the build is green and all internal code says "input".

**Files (create/rename):**
- Rename: `lib/eval/loadTasks.ts` → `lib/eval/loadInputs.ts` (+ `loadTasks.test.ts` → `loadInputs.test.ts`)
- Rename: `lib/eval/runEvalTask.ts` → `lib/eval/runEvalInput.ts`
- Rename: `lib/optimize/tasks.ts` → `lib/optimize/inputs.ts` (+ `tasks.test.ts` → `inputs.test.ts`)
- Modify: `lib/eval/runTypes.ts`, `lib/eval/ids.ts`, `lib/eval/runArtifacts.ts`, `lib/eval/readRun.ts`, `lib/eval/judge/suite.ts`, `lib/eval/judge/pairwise.ts`
- Modify: `lib/optimize/grading/types.ts` (delete local `Input`, re-import shared), `lib/optimize/optimizer.ts`, `lib/optimize/types.ts`, `lib/optimize/baseOptimizer.ts`, `lib/optimize/loop.ts`, `lib/optimize/mutator.ts`, `lib/optimize/optimizers/{example,greedyReflective}.ts`
- Modify: `lib/cli/eval/run.ts`, `lib/cli/eval/optimize.ts`, `lib/cli/evalJudge.ts`
- Modify: `lib/stdlib/agencyEval.ts`
- Modify (TS side only): leave `stdlib/agency/eval.agency` and `scripts/agency.ts` for Task 3
- Test: all co-located `.test.ts` for the above

**Interfaces:**
- Produces: `type Input` (shape in Design Decisions) exported from `lib/eval/runTypes.ts`; `EvalRunInputResult`, `EvalRunResult.inputs`, `PreparedInput`, `prepareInput`, `runEvalInput`, `loadInputs`, `inputFromGoal`, `assertEvalInputId`, `evalRunLoadedInputs`, `ReadEvalRunInput`/`inputsById`, `InputVerdict`, `normalizeOptimizeInputs`.
- Consumes: nothing external; this is a closed rename.

- [ ] **Step 1: Define the unified type.** In `lib/eval/runTypes.ts`, replace the `EvalTask` type with the `Input` type from Design Decisions (id?, goal?, args, node?, working_dir?, metadata?). Rename `EvalRunTaskResult` → `EvalRunInputResult` with field `taskId` → `inputId`; rename `EvalRunResult.tasks` → `inputs`; `EvalRunConfig.tasks`/`tasksSource` → `inputs`/`inputsSource`. (`EvalRunCompiledAgent` unchanged.)

- [ ] **Step 2: Point the grading layer at the shared type.** In `lib/optimize/grading/types.ts`, delete the local `Input` type and add `import type { Input } from "@/eval/runTypes.js";` then `export type { Input };` (so existing `import { Input } from "./types.js"` sites keep working). Keep `JSON`, `JSONPath`, `AgentRun`, `Score`, `Grade`, `GraderScope`, `GraderOptions`, `GraderInput`.

- [ ] **Step 3: Rename `ids.ts`.** `assertEvalTaskId` → `assertEvalInputId`; the internal field label union `"task_id"` → `"id"`; keep `assertEvalRunId`. Update the error message accordingly.

- [ ] **Step 4: Rename the loader.** `git mv lib/eval/loadTasks.ts lib/eval/loadInputs.ts` (and the test). Apply rename map B: `loadTasks`→`loadInputs`, `loadTasksFromFile`→`loadInputsFromFile`, `loadTasksFromDirectory`→`loadInputsFromDirectory`, `normalizeTask`→`normalizeInput`, `validateTasks`→`validateInputs`, `taskFromGoal`→`inputFromGoal`. **Keep reading the JSON keys `tasks`/`task_id` for now** (Task 3 flips them) — i.e. still read `parsed.tasks` and `task.task_id`, but build the `Input` object with `id`/`goal`/`args`/`node`/`working_dir`. The `goal` required-non-empty validation and the `goal`+`rubric` conflict check stay.

- [ ] **Step 5: Rename the artifact module (symbols only, not path strings).** In `lib/eval/runArtifacts.ts`: `PreparedEvalTask`→`PreparedInput` (fields `task`→`input`, `taskDir`→`inputDir`, `taskJsonPath`→`inputJsonPath`); `prepareEvalTask`→`prepareInput`; `recordEvalTask*`→`recordInput*`; `EvalRunState.tasksDir`→`inputsDir`/`tasksSource`→`inputsSource`; results use `inputId`. **Leave the literal strings `"tasks"`, `"task.json"`, and the `config.json` keys (`tasksSource`, `tasks`) for Task 3.** (`initializeEvalRun` still does `path.join(runDir, "tasks")` and writes `tasks: args.inputs` — the *value* now comes from the renamed field but the JSON *key* stays until Task 3.)

- [ ] **Step 6: Rename the per-input runner.** `git mv lib/eval/runEvalTask.ts lib/eval/runEvalInput.ts`. `runEvalTask`→`runEvalInput`; `EvalTaskRunner`→`EvalInputRunner`; the `EvalRecordExtractor` arg `task`→`input`; all `args.task`/`task.task_id`→`args.input`/`input.id`; console messages "for task X"→"for input X".

- [ ] **Step 7: Rename readRun + judge.** In `lib/eval/readRun.ts`: `ReadEvalRunTask`→`ReadEvalRunInput` (field `taskId`→`inputId`, `task`→`input`), `tasksById`→`inputsById`, loop over `summary.inputs`. **Keep the `"tasks"`/`"task.json"` path literals for Task 3.** In `lib/eval/judge/suite.ts`: `EvalTask`→`Input`, `TaskVerdict`→`InputVerdict` (`taskId`→`inputId`), iterate `args.inputs`, read `input.id`/`input.goal`, `runX.inputsById`, `missingTask`→`missingInput`. In `lib/eval/judge/pairwise.ts`: `taskId`→`inputId` on the verdict input shape.

- [ ] **Step 8: Rename the eval-run CLI module.** In `lib/cli/eval/run.ts`: `evalRunLoadedTasks`→`evalRunLoadedInputs`, `EvalRunLoadedTasksOptions`→`EvalRunLoadedInputsOptions` (fields `tasks`→`inputs`, `tasksSource`→`inputsSource`); `validateTaskSelection` keeps its name but its return union and internal var read `opts.tasks` (CLI opt stays `tasks` until Task 3). The call to `loadInputs`/`runEvalInput`/`initializeEvalRun` uses the renamed symbols. `EvalRunResult.inputs` in the loop.

- [ ] **Step 9: Collapse the optimizer bridges.** In `lib/optimize/baseOptimizer.ts`, `runInputViaEval` no longer converts `Input`→`EvalTask`; pass the `Input` straight through to `evalRunLoadedInputs({ inputs: [input], inputsSource: "optimize", … })` (use `input.id ?? id` for the id). In `lib/optimize/optimizers/greedyReflective.ts:147` and `example.ts:116`, delete the `Input→EvalTask` map — the judge-suite path now takes `Input[]` directly (`input.id`, `input.goal`). In `lib/optimize/mutator.ts`, read `input.id`/`input.goal` (was `task.task_id`/`task.goal`) and rename the param object field `.tasks`→`.inputs`.

- [ ] **Step 10: Rename the optimize loop + config + helper file.** `git mv lib/optimize/tasks.ts lib/optimize/inputs.ts` (+ test): `normalizeOptimizeTasks`→`normalizeOptimizeInputs`, param/return `EvalTask[]`→`Input[]`, `task.working_dir`→`input.working_dir`. In `lib/optimize/types.ts`, `OptimizeLoopConfig.runtime.tasks`/`tasksSource`→`inputs`/`inputsSource` (type `Input[]`). In `lib/optimize/loop.ts`, rename every `config.runtime.tasks`→`.inputs`, `result.tasks`→`result.inputs`, `taskId`→`inputId`, `pairTaskRecords`→`pairInputRecords`, and the `tasks:`/`taskId` reads in the judge-suite call.

- [ ] **Step 11: Switch the goal judge to first-class `goal`.** In `lib/cli/eval/optimize.ts`, `buildTarget` now maps loaded inputs straight through (drop the `metadata: { goal }` wrapping; set `goal: t.goal` — `t` is already an `Input`). For the `--goal` path, build `[{ id: "input-1", node, args: {}, goal: opts.goal ?? "" }]`. In `buildConfig`, change the `LlmJudge` construction `goalPath: ["metadata", "goal"]` → `goalPath: ["goal"]`. (CLI opt names `tasks`/`goal` unchanged until Task 3.)

- [ ] **Step 12: Rename the stdlib TS bridge.** In `lib/stdlib/agencyEval.ts`: `AgencyEvalRunState.tasks`→`inputs`; params/locals `tasks`→`inputs`, `task`→`input`, `task.task_id`→`input.id`; the `_initEvalRun`/`_prepareEvalTask`/`_finalizeEvalTask`/`_optimize`/`_evalJudgeSuite` signatures take `inputs: Input[]`; `taskFromGoal`→`inputFromGoal`; error "Provide exactly one of --tasks or --goal" → keep wording for now (it mirrors the Agency CLI; Task 3 updates it alongside the flag). Update `console.error` "for task X"→"for input X". **Keep `tasksSource: "stdlib:tasks"`/`"stdlib:evalRun"` string values** as Task 3 decides their final spelling.

- [ ] **Step 13: Update `evalJudge.ts` CLI.** `lib/cli/evalJudge.ts`: `EvalTask`→`Input`, `loadTasks`→`loadInputs`, `tasksFromInlineGoal` builds `Input[]` (`id`/`goal`), `run.tasksById`→`inputsById`, taskId references→inputId. CLI opt `tasks` stays until Task 3.

- [ ] **Step 14: Sweep the tests.** Update every co-located `.test.ts` in the modified/renamed files to the new symbol names and the unified `Input` shape (test fixtures that build inputs inline: `{ id, goal, args }` instead of `{ task_id, goal, args }`). Tests still referencing JSON files keep the `tasks`/`task_id` JSON keys (those flip in Task 3). `lib/optimize/baseOptimizer.test.ts` and `optimizers/*.test.ts` already use `Input` — only adjust if they referenced the dropped `metadata.goal` path; switch to first-class `goal`.

- [ ] **Step 15: Build and verify.**

Run: `pnpm run build`
Expected: `tsc` clean (no `EvalTask`/`task_id`/`tasksById` type errors).
Then: `pnpm test:run lib/eval lib/optimize lib/cli/eval lib/stdlib/agencyEval.test.ts`
Expected: PASS.

- [ ] **Step 16: Grep + commit.**

Run: `grep -rn "EvalTask\b\|EvalRunTaskResult\|task_id\|tasksById\|loadTasks\|prepareEvalTask\|runEvalTask\|normalizeOptimizeTasks" lib --include=*.ts | grep -v dist`
Expected: only matches are JSON-key string literals deliberately left for Task 3 (`"task_id"` in the loader, `"tasks"` in config.json) — no type or symbol references.
Then: `pnpm run lint:structure`; commit via `git commit -F /tmp/msg2.txt` (message: "Unify EvalTask and grading Input into one shared Input type").

---

## Task 3: Flip user- and disk-facing surfaces to "inputs"

Now change the contracts a user sees: CLI flag, task-file JSON schema, on-disk artifact layout, Agency stdlib signatures.

**Files:**
- Modify: `scripts/agency.ts` (3 `--tasks` flags → `--inputs`, opt fields, summary string)
- Modify: `lib/cli/eval/run.ts`, `lib/cli/eval/optimize.ts`, `lib/cli/evalJudge.ts` (opt field `tasks`→`inputs`, error strings, `validateTaskSelection`→`validateInputSelection`)
- Modify: `lib/eval/loadInputs.ts` (read JSON `inputs` array + `id` key)
- Modify: `lib/eval/runArtifacts.ts` (dir `"tasks"`→`"inputs"`, file `"task.json"`→`"input.json"`, `config.json` keys `tasks`/`tasksSource`→`inputs`/`inputsSource`)
- Modify: `lib/eval/readRun.ts` (dir/file path literals)
- Modify: `lib/eval/judge/suite.ts` (any `"tasks"` path literal, if present)
- Modify: `lib/stdlib/agencyEval.ts` (`tasksSource` string values, error wording)
- Modify: `stdlib/agency/eval.agency` (signatures + Agency `EvalTask`→`Input` type + docstrings)
- Modify: `lib/eval/types.ts` (the `source` field doc references `runs/.../tasks/`, if any)
- Test: `loadInputs.test.ts`, `runArtifacts.test.ts`, `readRun.test.ts`, `run.test.ts`, `optimize.test.ts`, `evalJudge.test.ts`, `agencyEval.test.ts`, `tests/agency/subprocess/eval-run-basic.agency`

**Interfaces:**
- Produces: CLI flag `--inputs`; task-file JSON shape `{ "inputs": [{ "id"?, "goal", "args", "node"?, "working_dir"? }] }`; artifact layout `runs/<id>/inputs/<input-id>/{input.json,statelog.jsonl,eval-record.json,workdir/,error.txt}`; Agency `evalRun(compiled, inputs: Input[], …)`.

- [ ] **Step 1: Flip the JSON task-file schema.** In `lib/eval/loadInputs.ts`: read `parsed.inputs` (was `.tasks`) — update the error "must contain a top-level inputs array"; in `normalizeInput`, read `raw.id` (was `task_id`) and require/validate it via `assertEvalInputId` when present (still auto-generate via `makeId` when absent). Update all other field reads to the new names where the JSON key changed (only `task_id`→`id`; `goal`/`args`/`node`/`working_dir` keys are unchanged).

- [ ] **Step 2: Flip the artifact layout.** In `lib/eval/runArtifacts.ts`: `path.join(runDir, "tasks")` → `"inputs"`; field already `inputsDir`; `path.join(taskDir,"task.json")` → `path.join(inputDir,"input.json")`; the `config.json` object keys `tasksSource`→`inputsSource` and `tasks`→`inputs`. In `lib/eval/readRun.ts`: `path.join(resolvedRunDir, "tasks", result.inputId)` → `"inputs"`; `task.json`→`input.json`; read `summary.inputs`. Search `lib/eval/judge/suite.ts` for any `"tasks"` directory literal and flip it.

- [ ] **Step 3: Flip the CLI flag.** In `scripts/agency.ts`, the three `.option("--tasks <fileOrDir>", …)` → `.option("--inputs <fileOrDir>", "Input suite JSON file or directory")`; the inline opt type fields `tasks?: string`→`inputs?: string`; the eval-run summary `${result.tasks.length} tasks ok` → `${result.inputs.length} inputs ok`. In `lib/cli/eval/run.ts`/`optimize.ts`/`evalJudge.ts`: opt field `tasks`→`inputs`, rename `validateTaskSelection`→`validateInputSelection` and its return union `"tasks"`→`"inputs"`, and the error strings "Provide exactly one of --tasks or --goal" → "--inputs". Update `buildTarget`/`evalRun` to call `loadInputs(path.resolve(opts.inputs ?? ""))`.

- [ ] **Step 4: Flip the Agency stdlib surface.** In `stdlib/agency/eval.agency`: rename the Agency `EvalTask` type → `Input` with field `task_id`→`id` (and add the now-first-class `goal`/`working_dir`/`metadata` optional fields to match the TS type); `evalRun(compiled, inputs: Input[], node, …)`; `optimize(…, inputs, …)`; `evalJudgeSuite(…, inputs, …)`; `EvalRunResult.tasks`→`inputs` and `EvalRunTaskResult`→`EvalRunInputResult` (`taskId`→`inputId`); loop `for (input in state.inputs)`; `_prepareEvalTask`→ the renamed TS export; update every docstring + the `## Run a task suite` heading and the inline examples (`{ id: "capital-france", goal: …, args: {} }`) and the `runs/<run-id>/inputs/<input-id>/` path references.

- [ ] **Step 5: Update the stdlib string contracts.** In `lib/stdlib/agencyEval.ts`, set `inputsSource` literal values to `"stdlib:inputs"` / `"stdlib:evalRun"` and the inline-goal source to `"inline:goal"`; update the "Provide exactly one of --inputs or --goal" error wording.

- [ ] **Step 6: Update tests + the agency-js fixture.** Flip JSON-key expectations in `loadInputs.test.ts`/`run.test.ts`/`optimize.test.ts`/`evalJudge.test.ts` to `inputs`/`id`; flip artifact-path assertions in `runArtifacts.test.ts`/`readRun.test.ts` to `inputs/`/`input.json`; update `tests/agency/subprocess/eval-run-basic.agency` to the new `evalRun(..., inputs, ...)` signature and `id` field.

- [ ] **Step 7: Rebuild stdlib, build, verify.**

Run: `make` (stdlib `.agency` changed)
Then: `pnpm run build` (tsc clean)
Then: `pnpm test:run lib/eval lib/cli/eval lib/stdlib/agencyEval.test.ts`
Expected: PASS.
Then run the one affected agency execution test directly: `pnpm run a test tests/agency/subprocess/eval-run-basic.agency 2>&1 | tee /tmp/eval-run-basic.out`
Expected: PASS.

- [ ] **Step 8: Grep + commit.**

Run: `grep -rn '"tasks"\|task_id\|--tasks\|tasksSource' lib scripts stdlib --include=*.ts --include=*.agency | grep -v dist`
Expected: no matches.
Then: `pnpm run lint:structure`; commit via `git commit -F /tmp/msg3.txt` (message: "Rename eval/optimize user-facing surfaces from tasks to inputs").

---

## Task 4: Regenerate docs and update fixtures

**Files:**
- Regenerate: `docs/site/stdlib/agency/eval.md`, `docs/site/stdlib/statelog.md` (via `agency doc` — do NOT hand-edit; they come from `.agency` source docstrings already updated in Tasks 1 & 3)
- Modify (hand-written prose): `docs/site/cli/eval.md`, `docs/site/cli/eval-judge.md`
- Modify: loose fixtures `tasks.json`, `foo-tasks.json` at the package root (rename keys; optionally `git mv` to `inputs.json`/`foo-inputs.json` if referenced anywhere — grep first)
- Note: historical files under `docs/superpowers/plans/` and `docs/superpowers/specs/` are point-in-time records — **do not rewrite them.**

- [ ] **Step 1: Regenerate stdlib reference docs.**

Run: `make` then the `agency doc` command per `docs/site/cli/doc.md` conventions (regenerates `docs/site/stdlib/**`).
Verify `docs/site/stdlib/agency/eval.md` now shows `evalRun(..., inputs: Input[], ...)` and `docs/site/stdlib/statelog.md` shows `evalValue` (not `evalInput`).

- [ ] **Step 2: Update hand-written CLI docs.** In `docs/site/cli/eval.md`: `--tasks`→`--inputs`; "task suite"→"input suite"; the JSON example top-level key `tasks`→`inputs` and `task_id`→`id`; artifact paths `runs/.../tasks/...`→`.../inputs/...`; the `evalInputs` output-field row → `evalValues`; the `evalInput`/`evalOutput` annotation example → `evalValue`/`evalOutput`. In `docs/site/cli/eval-judge.md`: `--tasks`→`--inputs`, task→input wording, `task_id`→`id`.

- [ ] **Step 3: Update loose fixtures.**

Run: `grep -rn "tasks.json\|foo-tasks.json" lib scripts tests docs --include=*.ts --include=*.md | grep -v dist`
If unreferenced, edit `tasks.json`/`foo-tasks.json` to use top-level `"inputs"` and per-item `"id"`. If referenced, `git mv` and update references.

- [ ] **Step 4: Final full-tree grep + verify + commit.**

Run: `grep -rn "evalInput\b\|EvalTask\b\|task_id\|--tasks" lib scripts stdlib docs/site --include=*.ts --include=*.agency --include=*.md | grep -v dist`
Expected: no matches outside `docs/superpowers/` history.
Then: `pnpm run build && pnpm run lint:structure`; commit via `git commit -F /tmp/msg4.txt` (message: "Regenerate docs and update fixtures for inputs terminology").

---

## Self-Review

**1. Spec coverage.**
- Collision (`evalInput`→`evalValue`, `evalOutput` kept): Task 1. ✓
- One shared `Input` type, `goal`/`working_dir` first-class, grading layer re-imports: Task 2 Steps 1–2, 11. ✓
- Bridge collapse (3 conversion sites): Task 2 Step 9. ✓
- Hard rename of CLI flag / JSON schema / artifact dirs / Agency stdlib: Task 3 Steps 1–5. ✓
- Docs + fixtures: Task 4. ✓
- Every file from the exhaustive inventory (`EvalTask`/`task_id` grep) is named in a task's file list. ✓

**2. Placeholder scan.** Rename maps A/B/C give exact old→new pairs (the complete spec for a mechanical rename); the only non-mechanical logic (unified type, bridge collapse, `goalPath` change, loader JSON mapping) is shown in full. No "handle edge cases"/"TBD". ✓

**3. Type consistency.** `Input` (singular shared type), `EvalRunInputResult.inputId`, `EvalRunResult.inputs`, `PreparedInput.input/inputDir/inputJsonPath`, `prepareInput`, `runEvalInput`, `loadInputs`, `inputFromGoal`, `assertEvalInputId`, `evalRunLoadedInputs`, `inputsById`/`ReadEvalRunInput.inputId`, `InputVerdict.inputId`, `normalizeOptimizeInputs`, `evalValue`/`evalValueRecorded`/`evalValues` — used consistently across all four tasks. `evalOutput*` and `EvalValue` (value-shape type) deliberately unchanged. ✓

**Known reconciliation detail (not a gap):** `Input.args`/`metadata` widen the grading layer's `Record<string, JSON>` to `Record<string, any>`; keep existing `as Record<string, AgencyJSON>` casts where grading code assigns into JSON-typed slots (Task 2 Step 2/11). The `rubric` validation field stays loader-only and is intentionally not part of `Input`.
