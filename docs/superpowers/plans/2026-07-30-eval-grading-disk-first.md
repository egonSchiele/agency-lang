# Eval grading goes disk-first

**Mode:** pairing on branch `adit/eval-refactor`, directly in `/Users/adityabhargava/agency-lang/packages/agency-lang`. No PR — the owner reviews the tree between iterations. Per plan review: one WIP commit at the end of each task (squashed later), so a failure surfacing in the Task 5 sweep is attributable to a task. All paths below are relative to `packages/agency-lang` unless absolute.

**Plan v2** — incorporates `/Users/adityabhargava/agency-lang/docs/superpowers/plans/2026-07-30-eval-grading-disk-first-REVIEW.md` (all points adopted).

**Goal:** make the run directory the one and only interface between running an agent and grading one. Grading's input is a run directory on disk; the in-memory handoff paths are deleted.

**Decisions this plan implements (frozen in `/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-30-eval-cleanups-design.md`):**

1. Grading is disk-first. One path for run data: read the JSON artifacts off disk. The cost is one bounded JSON write + read, accepted deliberately.
2. An errored agent run scores zero, always. Graders never see it; the salvaged record is never graded.
3. `AgentRun` (the result of `runAgent`) keeps `output` but loses `record`. The full evidence lives only on disk.
4. The grader-facing shape renames to `LoadedRun` — evidence loaded off disk — resolving the two-types-named-`AgentRun` collision.

## Background: how the pieces sit today

`runAgent` (`lib/eval/run/runAgent.ts`) executes one agent and returns:

```ts
type AgentRun =
  | { status: "success"; output: unknown; record: EvalRecord; runDir: string; workdir: string }
  | { status: "error"; errorMessage: string; record?: EvalRecord; runDir: string; workdir: string };
```

It also writes everything to disk: `<runDir>/agent/statelog.jsonl`, `<runDir>/agent/eval-record.json`, `<runDir>/agent/error.txt` on failure. So the `record` field is a duplicate of a file that already exists.

Grading has three entry shapes today. `gradeRun` (`lib/eval/grading/gradeRun.ts`) accepts `EvalRunResult | ReadEvalRunResult | string` and adapts each inside (`toEntries`). The in-memory branch (`EvalRunResult`) is what `eval run --grade` uses (`lib/cli/eval/run.ts:284` passes the in-memory summary); the string branch is what `eval grade` uses (`lib/cli/eval/grade.ts:47` passes a run directory). The in-memory branch has its own disk-reading workaround, `readInputSpec`, which re-reads `input.json` to recover the goal/expected values that graders need — silently degrading to a bare input if that fails.

The loader already exists: `readEvalRun` (`lib/eval/readRun.ts`) turns a run directory into `{ runDir, inputsById }`, reading `summary.json`, each `input.json`, and locating each record and error file. The string branch of `gradeRun` already goes through it.

What a grader receives is `GraderInput` (`lib/eval/grading/types.ts`), whose `run` field is the grading-side `AgentRun`:

```ts
export type AgentRun = {   // lib/eval/grading/types.ts — RENAMES to LoadedRun
  output: JSON;
  recordPath: string;
  workdir: string;
  record: EvalRecord;
};
```

It is built by `lookUpOutput` (`lib/eval/grading/gradeRun.ts`), which reads `eval-record.json` off disk and pulls the last `evalOutputs` value. Note: this means the record read is ALREADY disk-first on every path. The redesign deletes the in-memory suite bookkeeping, not something load-bearing.

The optimizer (`lib/optimize/baseOptimizer.ts:246`) calls `gradeInput(input, result, ctx)` per input, where `result` is an `EvalRunInputResult` — a paths-plus-status pointer to a run on disk. That is already disk-first in the sense that matters (the record is read from `result.evalRecordPath`), so `gradeInput` keeps its signature. Only the suite-level `gradeRun` union collapses.

The errored-run policy already exists in two places: `toEntries` marks in-memory errored inputs ungraded, and `loadedEntry` marks disk-loaded `failed`/`missing` inputs ungraded. Ungraded means: score 0, gates fail, reason recorded, no grader runs. This plan keeps that policy and makes it the loader's explicit output rather than something two branches each re-derive.

## Out of scope (next pairing iterations, queued in the living spec)

- Extracting the suite loop out of `lib/cli/eval/run.ts` into a library `evaluateSuite`, and the raw-vs-loaded option type renames (Change 6).
- Pointing `baseOptimizer` at the new surface / removing its `cli/` import.
- Absorbing the stdlib's `_prepareInput`/`_finalizeInput` pipeline; the Agency `Input.files` field.
- The empty-suite guard; the `EvalRunResult` execution/grading restructure (undecided).
- `judgeSuite` (`lib/eval/judge/suite.ts`) also accepts run-dir-or-loaded via `coerceRun` — same disease, but touching the judge path now widens the diff for no design gain. Logged for the suite iteration.

---

### Task 1: Slim `AgentRun` — keep `output`, drop `record`

**Files:**
- Modify: `lib/eval/run/runAgent.ts`
- Test: `lib/eval/run/runAgent.test.ts`

The success arm becomes `{ status: "success"; output: unknown; runDir: string; workdir: string }`; the error arm becomes `{ status: "error"; errorMessage: string; runDir: string; workdir: string }` (the salvaged `record?` field goes — salvage still gets *written to disk* on failed runs, that behavior stays).

- [ ] **Step 1: update the type and both return sites in `runAgent.ts`.** In `run()`: the success return drops `record`; `fail` loses its `record?` parameter. On the `!result.ok` branch, replace the current `await this.extractRecord(undefined).catch(() => undefined)` (whose parse result would now be discarded and whose catch swallows extractor crashes silently) with a new private method that exists for the disk side effect and says so by name:

```ts
/** Best-effort: write the salvaged eval record to disk for diagnosis.
 *  Never affects the result — an errored run scores zero regardless. */
private async salvageRecord(): Promise<void> {
  try {
    await this.extractRecord(undefined);
  } catch (err) {
    console.warn(`salvage extraction failed for ${this.options.runDir}: ${errMessage(err)}`);
  }
}
```

`extractRecord` itself is unchanged (the success path still needs the parse for `output` and for the "nothing extracted" check). Update the `AgentRun` arm doc comments: evidence lives at `<runDir>/agent/eval-record.json`; `output` is a convenience copy of the record's last eval output.
- [ ] **Step 2: update the tests.** `"a failed run still extracts its statelog…"` currently asserts `run.record?.evalOutputs[0].value` — change it to read the salvage off disk: `JSON.parse(fs.readFileSync(path.join(runDir, "agent", "eval-record.json"), "utf8"))` and assert the same value. Grep the test file for any other `.record` access.
- [ ] **Step 3: run and check.** `pnpm test:run lib/eval/run 2>&1 | tee <scratchpad>/t1.log` (the session scratchpad directory, NOT `/tmp`), confirm green, `pnpm run typecheck`. The typechecker will list any other consumer of `.record` — expected: none outside this file and its tests (verified by grep before writing this plan; `lib/cli/eval/run.ts`'s `toInputResult` uses only `status`/`errorMessage`).
- [ ] **Step 4: WIP commit** (message via a file, not inline, because of apostrophes): `wip: AgentRun returns output, not record`.

### Task 2: Rename the grading-side `AgentRun` to `LoadedRun`

**Files:**
- Modify: `lib/eval/grading/types.ts`, `lib/eval/grading/gradeRun.ts`, `lib/eval/grading/scorecard.ts`, `lib/eval/grading/testUtils.ts`, `lib/eval/public.ts`, `lib/optimize/public.ts`, `lib/eval/public.test.ts`
- Tests: mechanical follow-through in any grader test importing the name

- [ ] **Step 1: rename in `types.ts`** with a doc comment carrying the distinction: `AgentRun` (in `lib/eval/run/runAgent.ts`) is the outcome of executing; `LoadedRun` is that run's evidence loaded off disk by grading's loader.
- [ ] **Step 2: follow the compiler.** `scorecard.ts` (`InputGrades.run: LoadedRun | null`), `gradeRun.ts` (`OutputLookup`, imports), `testUtils.ts` (rename the `agentRun(output)` helper to `loadedRun(output)` and its doc), and BOTH public surfaces: `lib/eval/public.ts:14` (the grader-authoring entry point — review caught that the plan originally listed only the optimizer one) and `lib/optimize/public.ts:24`. Fix the stale "the AgentRun" comment at `lib/optimize/reflectionFeedback.test.ts:8`.
- [ ] **Step 3: pin the type exports as contract.** `lib/eval/public.test.ts` guards only runtime value exports (`GRADING_NAMES`), so a type export can vanish silently. Decision: the grader-authoring types ARE contract. Add a compile-time guard to `public.test.ts` — a type-only import that fails typecheck if any disappears:

```ts
// Types are erased at runtime, so GRADING_NAMES cannot guard them; this
// import line is the guard — typecheck fails if a contract type vanishes.
import type { LoadedRun, Grade, GraderOptions, Input, Score } from "./public.js";
```

(Adjust the list to what `public.ts` actually exports after the rename; a `type X = LoadedRun` no-op reference is fine to silence unused-import lint if needed.)
- [ ] **Step 4:** `pnpm run typecheck`, then `pnpm test:run lib/eval/grading lib/optimize 2>&1 | tee` to a scratchpad file; failures should be import renames only.
- [ ] **Step 5: WIP commit**: `wip: grading-side AgentRun renamed to LoadedRun`.

### Task 3: Collapse `gradeRun` to one input: a run directory

**Files:**
- Modify: `lib/eval/grading/gradeRun.ts`, `lib/eval/readRun.ts`, `lib/cli/eval/run.ts`
- Test: `lib/cli/eval/run.test.ts`, `lib/eval/grading/gradeRun.test.ts`, `lib/eval/readRun.test.ts`

- [ ] **Step 0: move `readInputSpec`'s tolerance into the loader before deleting it.** (Review must-fix.) `readOptionalJson` in `readRun.ts` checks existence but parses unprotected, so a corrupt `input.json` would throw out of `readEvalRun` and take the whole grading pass down — after every agent has already run and been paid for, the exact failure `lookUpOutput`'s doc forbids. Change `readOptionalJson` to warn and return `undefined` on a parse error (same degrade `readInputSpec` performs today: graders lose goal/expected for that input, nothing more). And wrap the `readJson` of `summary.json` so a corrupt summary — now the single point of failure for all grading — throws an error that names the file:

```ts
function readOptionalJson<T>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return readJson<T>(filePath);
  } catch (error) {
    // Degrade, do not throw: grading runs after every agent has been paid for,
    // and one corrupt per-input file must not take the whole pass down.
    console.warn(`readEvalRun: could not parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}
```

Add a `readRun.test.ts` case: a run dir with one corrupt `input.json` still loads, with that input degraded. While in the file: have `readEvalRun` `console.warn` when two summary entries share an `inputId` (the map would silently swallow one — unreachable via the CLI, which validates ids, but `evalRunLoadedInputs` is a programmatic surface whose inputs skip `validateInputs`, and prepare failures all report `inputId: ""`).

- [ ] **Step 1: change the signature.**

```ts
export async function gradeRun(runDir: string, ctx: GradingContext): Promise<Scorecard> {
  const loaded = readEvalRun(runDir);
  const perInput = await Promise.all(
    Object.values(loaded.inputsById).map((input) => gradeEntry(loadedEntry(loaded.runDir, input), ctx)),
  );
  return new Scorecard(perInput);
}
```

Delete: `toEntries`, the `EvalRunResult | ReadEvalRunResult` acceptance, `readInputSpec` (its tolerance moved into the loader in Step 0), and the now-unused imports (`EvalRunResult`, `ReadEvalRunResult` if unreferenced). `loadedEntry`, `gradeEntry`, `gradeInput`, `lookUpOutput`, `ungraded` all stay — they are the disk path.

The new `gradeRun` doc comment states three things (review asked for each): duplicate input ids collapse in the by-id map, so callers must keep ids unique (the CLI validates this; programmatic callers own it); `judgeSuite` still accepts the loaded-or-directory union deliberately — do not "restore consistency" by widening `gradeRun` back, the judge path converges in the suite iteration; and a comment on `Entry`/`loadedEntry` saying its synthesized `EvalRunInputResult` shape (dead `statelogPath: ""`, re-derived status) is inherited from `gradeInput`'s seam with the optimizer (`lib/optimize/baseOptimizer.ts:246`) and collapses when that seam moves — it is not an oversight.

- [ ] **Step 2: switch the inline caller.** `lib/cli/eval/run.ts:284`: `gradeRun(summary, …)` → `gradeRun(summary.runDir, …)`. The ordering is already correct: `writeEvalRunSummary` (line 279) has written `summary.json` and every `input.json`/`eval-record.json` was written per input before this point. Add one sentence of comment: grading deliberately re-reads the artifacts this process just wrote — the run directory is the interface, and this exercises it on every graded run.
- [ ] **Step 3: check `gradeRun.test.ts` — convert some, delete one.** Fixtures already build run directories on disk. The in-memory tests around `gradeRun.test.ts:196` convert to grading the directory. The branch-agreement test at `:202-215` ("produces the same scorecard from a directory path and from an in-memory result") is **deleted, not converted** — after this change there is no second branch to agree with. Anything else that cannot be expressed as files on disk was depending on the in-memory shortcut and follows one of those two fates.
- [ ] **Step 4:** run `pnpm test:run lib/eval lib/cli/eval 2>&1 | tee` to a scratchpad file; then `pnpm run typecheck` and `pnpm run lint:structure`.
- [ ] **Step 5: WIP commit**: `wip: gradeRun takes a run directory`.

### Task 4: Make the errored-run-scores-zero rule the loader's single statement

**Files:**
- Modify: `lib/eval/grading/gradeRun.ts` (possibly `lib/eval/readRun.ts` doc only)
- Test: `lib/eval/grading/gradeRun.test.ts`

With one entry path, the policy lives in exactly one function instead of two branches.

- [ ] **Step 1:** `loadedEntry`'s `reasonByStatus` mapping is now the only place errored/missing runs are diverted from graders. Put the decision on it verbatim: an errored run scores zero, always; the salvaged record on disk is diagnostic evidence and is never graded. Delete the now-redundant duplicate policy comment on `gradeRun`'s old doc block.
- [ ] **Step 2: one new test** making the policy explicit rather than incidental: a run directory whose input errored BUT has a salvageable `eval-record.json` with a plausible output → grader never invoked (use a spy grader), input scored 0, `ungradedReason` mentions the agent error. This is the regression tripwire against someone later "helpfully" grading salvage.
- [ ] **Step 3:** rerun the grading tests to the scratchpad log.
- [ ] **Step 4: WIP commit**: `wip: errored-run-scores-zero stated at the loader`.

### Task 5: Separate grading from the suite runner (`lib/cli/eval/run.ts`)

Added at owner request: the suite runner must not drive grading at all. Today `evalRunLoadedInputs` takes a `graders` option, validates graders, scores the finished run, and writes the grading — six grading imports in `run.ts`. And the score-and-write block (`run.ts:284–298`) is duplicated nearly verbatim in `lib/cli/eval/grade.ts:47–61`, down to the same `objective()`-not-`gatedObjective()` comment. After this task: **executing writes a run directory; grading reads one; only the `evalRun` command composes the two.**

**Files:**
- Create: `lib/eval/grading/gradeSuite.ts`
- Modify: `lib/cli/eval/run.ts`, `lib/cli/eval/grade.ts`
- Test: `lib/cli/eval/run.test.ts` (grading describe block), `lib/cli/eval/grade.test.ts`

- [ ] **Step 1: extract the shared scoring block** into the new single-concept file:

```ts
/** Score a finished run directory into an EvalRunGrading. Pure with respect
 *  to artifacts: reads the run dir, writes nothing — writers stay callers. */
export async function gradeSuite(runDir: string, graders: BaseGrader[], config: AgencyConfig): Promise<EvalRunGrading> {
  const scorecard = await gradeRun(runDir, { graders, runAgency: new AgencyRunner(config) });
  return {
    graders: graders.map((grader) => grader.name()),
    // objective(), not gatedObjective(): a gate-failed input already contributes
    // 0 to this mean; gatedObjective() would zero the WHOLE run on any single
    // failure and make the tracked number useless. gatesPassed drives exit codes.
    objective: scorecard.objective(),
    gatesPassed: scorecard.gatesPassed(),
    perInput: breakdown(scorecard),
  };
}
```

(Name open to owner bikeshed; parallels `judgeSuite`. The duplicated comment now exists once, here.)
- [ ] **Step 2: strip grading out of `evalRunLoadedInputs`.** Delete the `graders` option from `EvalRunLoadedInputsOptions` (verified: the optimizer and stdlib never pass it — only the `evalRun` command and tests do), the `validateGraders` call at `run.ts:233`, and the whole grading block at `:280–298`. The function runs agents and returns the written summary, full stop.
- [ ] **Step 3: the `evalRun` command composes.** In `evalRun`: `resolveGraders` as today; `validateGraders(graders, inputs[0])` moves BEFORE the `evalRunLoadedInputs` call (the fail-fast property — a misconfigured grader must not cost a whole suite — is preserved, just owned by the command now); after the run, `gradeSuite(summary.runDir, graders, config)`, then the command writes `writeVerifierGrading` and records `summary.grading` in `summary.json` (the writes stay at the composition layer). `grade.ts` switches its duplicated block to the same `gradeSuite` call, keeping its `--out`-or-verifier write choice.
- [ ] **Step 4: move `resolveGraders`** (and with it the `LlmJudge`/`loadGradingModule` imports) into `lib/cli/eval/graders.ts` — one concept: turning grader flags into grader instances. After this step `run.ts` should have NO grading imports outside the `evalRun` command's composition; `grep -in "grade\|grader" lib/cli/eval/run.ts` hits only the command function and its option docs.
- [ ] **Step 5: tests follow the split.** The grading describe block in `run.test.ts` converts to composing (`evalRunLoadedInputs` then `gradeSuite`) or calling `evalRun`; the "skips grading when no graders are supplied" test is **deleted** — the option it tests no longer exists. `grade.test.ts` should pass unchanged (same behavior, shared implementation).
- [ ] **Step 6:** `pnpm test:run lib/cli/eval lib/eval/grading 2>&1 | tee` to a scratchpad file; typecheck; **WIP commit**: `wip: suite runner no longer drives grading`.

### Task 6: Write the invariant down durably

**Files:**
- Create: `docs/dev/eval-grading.md`

One short page (not a treatise) so a future reader does not "optimize away" the deliberate re-read — which looks exactly like waste to someone without this context.

- [ ] **Step 1: write the doc.** Content: the run directory is the interface between running an agent and grading one; grading's only input is a run directory and it never receives run data in memory; `eval run --grade` deliberately re-reads the artifacts the same process just wrote (one bounded JSON write + read — the accepted price of the separation, revisit only if grading ever needs heavy post-read processing); an errored run scores zero and its salvaged record is evidence, never graded; `readEvalRun` is the single place grading touches the filesystem and owns all parse-failure tolerance; `judgeSuite`'s wider input union is a known, deliberate divergence until the judge path converges.
- [ ] **Step 2:** add the one-line entry to the "Deeper docs" list in `/Users/adityabhargava/agency-lang/CLAUDE.md`.
- [ ] **Step 3: WIP commit**: `wip: eval-grading dev doc`.

### Task 7: Sweep and record

- [ ] **Step 1:** grep for stragglers: `grep -rn "readInputSpec\|toEntries\|ReadEvalRunResult" lib --include="*.ts" | grep -v worktree` — `ReadEvalRunResult` legitimately remains in `readRun.ts` and `judge/suite.ts` (out of scope); nothing else should reference the deleted helpers.
- [ ] **Step 2:** full affected sweep once: `pnpm test:run lib/eval lib/cli/eval lib/optimize 2>&1 | tee` to a scratchpad file; filter `grep FAIL | grep -v worktree` for real failures. Typecheck + `lint:structure`.
- [ ] **Step 3:** audit the diff against `docs/dev/anti-patterns.md` (conditional spreads, narrating comments, near-duplicate types) before handing the tree to the owner.
- [ ] **Step 4:** append the executed-iteration note to the living spec's "Later items" and flag anything discovered mid-flight.

## Self-review notes

- Coverage: decision 1 → Tasks 3+6+7; decision 2 → Task 4; decision 3 → Task 1; decision 4 → Task 2; owner's run/grade separation request → Task 5.
- Known consequence to surface at review: after Task 3, an in-memory-only grading call is impossible by construction. The optimizer is unaffected (it uses `gradeInput`, which keeps its per-input signature and already reads the record from disk).
- `readEvalRun`'s pre-#733-layout fallbacks (`inputs/<id>/eval-record.json`, `error.txt`) stay for now — they are the loader's business and deleting them is part of the open "legacy tolerance" item, not this plan.
