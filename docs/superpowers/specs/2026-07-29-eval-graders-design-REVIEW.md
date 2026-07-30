# Review: Graders for `agency eval`

**Spec:** /Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-29-eval-graders-design.md
**Reviewed:** 2026-07-29, against branch `adit/remove-pairwise-optimize-loop` at commit ee90c6880.

## Verdict

The direction is right and the altitude is right: this moves an existing library rather than building a second one, reuses the run-or-path union that `judgeSuite` already established, and keeps the search-specific pieces in `optimize/`. I verified the spec's factual claims against the code and most hold (list at the bottom). Six things need fixing or deciding before this goes to a plan. The first two are real gaps in the design; the rest are underspecified seams that will otherwise get decided silently during implementation.

## Significant findings

### 1. `loadGradingModule` is missing from the move table, and it breaks the dependency story

The move table says `lib/optimize/grading/**` ("all of it") moves. But `loadGradingModule` — which the spec's own CLI section says both new commands use — does not live under `grading/`. It lives at `lib/optimize/gradingModule.ts`. If it stays there, `agency eval run --graders` imports upward from `optimize`, which is the exact inversion the whole spec exists to fix. Nothing in the file is optimizer-specific (it esbuild-loads a user module and normalizes it to `BaseGrader[]`), so it should move with the rest. Add it to the table.

### 2. The shared `gradeInput` signature cannot actually run the graders it is given

The spec's signature is `gradeInput(input, result, graders)`. But a class-based grader's entry point is `run({ input, run, runAgency })` — it requires an `AgencyRunner` (`lib/optimize/grading/types.ts:44-48`), which is the capability to execute a judge `.agency` file, and building one requires an `AgencyConfig`. The signature has no way to pass either. This is not a nit: the LLM judge is one of the four built-in graders, and it cannot run without it.

The same omission hides a real design question for `agency eval grade`: who installs the subprocess-approval handler for the judge's `.agency` run? The optimize CLI installs one today; `eval grade` will need the same or LLM-judge grading will stall on approval. The spec should name the extra parameters (runner + config, or a context object) and say where `eval grade` gets them.

### 3. "Everything `eval grade` needs is already on disk" is an overclaim

The section motivating `eval grade` says grader iteration should not cost money or introduce nondeterminism, and that everything needed is on disk. That is true for `ExactMatch`, `Contains`, `Similarity`, and function graders — but an `LlmJudge` grader, or any function grader that calls `ctx.judge(...)`, makes live LLM calls during `eval grade`. The command is still much cheaper than re-running agents, and still the right feature; but the framing should be honest that the no-cost, deterministic loop only holds for non-LLM graders, and the cost/approval plumbing from finding 2 applies here.

### 4. The optimizer adaptation contradicts "the cache stays exactly as it is"

Today the optimizer's run step returns `AgentRun = { output, recordPath }` (`lib/optimize/baseOptimizer.ts:312-313`), and **that** is what `EvalCache` stores. `workdirPath` is discarded at exactly that boundary — `runInputViaEval` reads it off the `EvalRunInputResult` and throws it away. So the promise that class graders gain `workdir` and `record` "with equal power" requires the cached run type to grow, or the cache to store the `EvalRunInputResult` instead. Either way, two things the spec says stay untouched, change:

- `EvalCache`'s stored value type (spec: "stays exactly as it is").
- The `runInput` testing seam, which `docs/dev/writing-optimizers.md` documents as returning `{ output, recordPath }`. Every test using that seam, and the doc, must follow the new shape.

Neither change is bad. But the spec should state the new `AgentRun` (or its replacement) explicitly, because "keeps its run loop and its cache exactly as they are" is currently false under the spec's own grader-context requirements. Also say whether `recordPath` survives on the class-grader input alongside the parsed `record`, since existing user graders may read the path.

### 5. Errored-run scoring is new policy, not moved code — and its gate semantics are unpinned

The failure section reads as if `gradeInput` owns "an errored run scores 0" for both callers. It does not and should not: the optimizer never reaches grading on a failed run — `runInputViaEval` throws first (`baseOptimizer.ts:308-310`), and that behavior is intentionally unchanged by this spec. The score-0-on-error rule is **new** logic that only the eval-side `gradeRun` needs, for inputs with `status: "error"` (whose `eval-record.json` may not even exist). Say so, so the implementer doesn't try to push it into the shared function and change optimizer semantics by accident.

Separately, pin what an errored input does to `gatesPassed()`. The exit-code section says exit 0 means "no `mustPass` gate failed" — but on an errored input the gates never ran. If `mustPass` graders are configured and an input errored, does the run exit 0 or 2? The natural answer is that an errored input fails every gate (a crash should not pass a suite that has gates), but the spec never says it, and the exit code depends on it.

### 6. Decide the no-`--graders` asymmetry out loud

`agency optimize` without `--graders` defaults to the bundled goal judge — `[new LlmJudge({ name: "goal" })]` (`lib/cli/eval/optimize.ts:177-179`). The spec's `eval run` without `--graders` grades nothing at all. A user whose `inputs.json` is full of `goal` fields may reasonably expect the same default scoring. Lets make `eval run` default to the same goal judge.

## Minor findings

- **Two homes for the score.** `eval run --graders` embeds a `grading` key in `summary.json`; `eval grade` writes a sibling `grading.json`. I think part of the tension here is that the summary.json design ties each run to a grade, whereas a run could be graded multiple times. Keep your spec as is for now, but we will want to rethink this when we talk about how to redesign the workdir.

- **`gradeRun` on a directory needs the record-missing case.** For an errored input the run directory has `error.txt` and possibly no `eval-record.json`. The unit-test list covers "a failed-run input scores 0" in memory; add the on-disk variant so `eval grade` on a partially failed run is exercised.
- The testing section's claim that optimizer suites pass "without edits beyond import paths" is slightly optimistic given finding 4 — the `runInput` seam shape change will touch them. Worth softening so a failing expectation isn't read as a botched move.

## Claims verified against the code (all hold)

- "The word grade does not appear in `lib/cli/eval/run.ts`" — true as of ee90c6880 (0 matches).
- The `lib/optimize/grading/` file inventory matches `ls` exactly, including `graders/{builtinGraders,llmJudge,humanGrader}`.
- `gradeRun`'s parameter union mirrors `judgeSuite` — `EvalRunResult | ReadEvalRunResult | string` with a path coerced through `readEvalRun` (`lib/eval/judge/suite.ts:16,139`).
- `EvalRunInputResult.workdirPath` exists and is unused by grading today (`lib/eval/runTypes.ts:28`).
- Gate-first short-circuit is today's order in `BaseOptimizer.gradeInput`; `gradedOutput` throws on no output (`baseOptimizer.ts:377-380`); after commit ee90c6880, a `null` return already counts as no output at extract time, so the spec's parenthetical is accurate.
- `GraderContext` today is `{ output, input, judge }` and the spec's `judge` signature matches it verbatim (`lib/optimize/grading/functionGrader.ts:9-17`).
- `record.metrics.costUsdTotal` and `record.metrics.toolCounts` exist (`lib/eval/types.ts:194,197`).
- `requireGoal` exists on `loadInputs` and the optimize CLI already threads it (`lib/eval/loadInputs.ts:66`, `lib/cli/eval/optimize.ts:138`).
- Exit code 2 for errored inputs under `--no-continue-on-error` is the code that path uses today (`scripts/agency.ts:474-475`).
- `package.json` has the `./optimize` export to sit the new `./eval` entry beside (line 75).
- `BaseOptimizer` runs agents through `evalRunLoadedInputs` (`baseOptimizer.ts:289`), so "the run half already flows the right way" is accurate.

## Limitations of this review

I did not attempt to enumerate every consumer of `summary.json` to confirm the additive `grading` key is safe (the absent-when-unscored rule makes it very likely). I also did not audit external/user grading modules for reliance on `agency-lang/optimize` internals beyond the exports the spec lists for re-export.
