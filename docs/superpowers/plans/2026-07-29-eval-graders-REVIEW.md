# Review: Graders for `agency eval` — Implementation Plan

**Plan:** /Users/adityabhargava/agency-lang/docs/superpowers/plans/2026-07-29-eval-graders.md
**Reviewed:** 2026-07-29, against branch `adit/remove-pairwise-optimize-loop` at commit ee90c6880.

## Verdict

The plan is well-structured and honest about its costs. It addresses all six spec-review findings, the task ordering is right (move, then export, then new code, then rewiring, then CLI), and the TDD steps are real tests, not ceremony. But it has one bug that would silently multiply the optimizer's LLM spend and break every existing eval-run test, and one scoring choice that makes the reported number useless the moment any input fails. Both have simple fixes. There is also a branching mistake that would prevent Task 1 from applying at all.

## Significant findings

### 1. Default grading inside `evalRunLoadedInputs` double-grades the optimizer and breaks the existing tests

Task 5 Step 4 adds grading to the tail of `evalRunLoadedInputs`, defaulting to the goal judge unless `grade: false` is passed. Two callers never pass that flag:

- **The optimizer.** `runInputViaEval` calls `evalRunLoadedInputs` for every candidate, on every input (`lib/optimize/baseOptimizer.ts:289`). After Task 5, each of those calls would also run a goal-judge LLM grading pass inside the run step — whose result is thrown away, because the optimizer grades again through `gradeInput`. That is one extra LLM call per input per candidate per iteration, silently.
- **Every existing test.** `lib/cli/eval/run.test.ts` calls `evalRunLoadedInputs` with inline `runner`/`extractor` fakes and no `grade` flag. Default-on grading would construct a real `LlmJudge` and invoke `runAgency` — a real judge subprocess — in unit tests. Task 5 Step 8 expects `lib/cli/eval` to PASS; it will not.

The fix is to put the default at the layer the owner's decision was actually about: the *command*. Let `evalRunLoadedInputs` grade only when `opts.graders` is provided (no `grade` flag needed at all), and resolve "no `--graders` means the goal judge" in `evalRun` — exactly where the plan already resolves `--graders` and `eval.graders` (Task 5 Step 5) — and in `evalGrade` (Task 6 already does this correctly). Then `--no-grade` becomes "don't pass graders down", the optimizer path needs no change, and the library primitive stays inert by default. This also removes the `grade?: boolean` plumbing from the library signature.

### 2. Reporting `gatedObjective()` zeroes the whole run when one input fails

Task 5 Step 4 and Task 6 Step 3 both set `objective: scorecard.gatedObjective()`. Task 3 marks every errored or no-output input `gatesPassed: false` (correct — that was spec-review finding 5). Put together: one crashed input out of fifty makes the reported objective for the entire run `0`, because `gatedObjective()` collapses to 0 when *any* gate fails anywhere.

That defeats the spec's own rule — "an errored input scores 0 **and is counted, not skipped**" — which describes an average with a zero in it, not a zeroed average. It also makes the tracked number worthless under any flakiness: 0.71 this week, 0.00 next week because one input timed out, 0.72 after.

`Scorecard.objective()` already does the right thing: it is the mean of `inputScores()`, where a gate-failed input contributes 0 per input (`lib/eval/grading/scorecard.ts` — `inputScores` zeroes gate-failed inputs, `objective` averages them). So:

- `EvalRunGrading.objective` should be `scorecard.objective()` — the counted-not-skipped mean.
- `gatesPassed` keeps driving the exit code, unchanged.
- `gatedObjective()` remains what optimizers compare candidates on — an acceptance policy, not a reporting number.

Related cosmetic issue: the per-input print appends `(gate failed)` for ungraded inputs even when the user configured zero `mustPass` graders — there is no gate to have failed. Print the `ungradedReason` for those rows instead.

### 3. The branch is created from the wrong base

Task 1 Step 1 branches `adit/eval-graders` from `main`. Everything in this plan builds on PR #726's branch: the current `BaseOptimizer.gradeInput`/`gradedOutput` shapes Task 4 edits, and the ee90c6880 extract semantics ("output is always the return value") that Task 3's `buildAgentRun` depends on. PR #726 is still open — on `main`, Task 1's edits do not apply. Either state "merge #726 first" as a precondition, or branch from `adit/remove-pairwise-optimize-loop` and note the PR will need rebasing after #726 lands.

## Moderate findings

### 4. Task 1's "Files: Modify" list is incomplete

The plan lists seven stay-behind files to re-point. The actual importer set (grep for `./grading/`, `../grading/`, `goalJudgeFile`, `gradeBreakdown`, `gradingModule` outside the moved tree) also includes:

- `lib/optimize/optimizer.ts` (`BaseOptimizerConfig.graders` imports `BaseGrader`)
- `lib/optimize/gepaReflect.ts`
- `lib/optimize/evalCache.ts`
- `lib/optimize/optimizers/example.ts`
- `lib/optimize/optimizers/greedyReflective.ts`

Step 4's grep command is written correctly and will find all of them — the instruction "every hit outside `lib/eval/grading/` must be rewritten" is the operative one. But fix the list, or an implementer following the Files section will treat the extra hits as something unexpected.

### 5. Task 5's test references fixtures that do not exist

The test snippet passes `{ runner: fakeRunner, extractor: fakeExtractor }`. `run.test.ts` has no shared fixtures with those names — each existing test defines `runner`/`extractor` inline (`lib/cli/eval/run.test.ts:52,56,96,...`). The new tests need to do the same, and they need an extractor that writes a real eval record with an `evalOutputs` entry, because grading reads it. Worth spelling out, since an extractor that writes nothing (like the `async () => {}` at line 140) yields a no-output input and a confusing gate failure instead of the objective the test asserts.

### 6. `toEntries` folds "missing record" into "the agent run errored"

For a loaded run, `readEvalRun` distinguishes `status: "ok" | "missing" | "failed"`. The plan maps anything non-`ok` to `status: "error"` with reason `"the agent run errored: unknown error"`. For `missing` — the run succeeded but `eval-record.json` is gone — that message points the user at the wrong problem. Map `missing` to its own reason ("no eval record found on disk") so the breakdown says what actually happened.

## Minor findings

- **`workdirFor` builds the path with string interpolation** (`${runDir}/inputs/${inputId}/workdir`). Use `path.join` like the surrounding code.
- **Task 5 Step 4 references `state.runDir`.** The summary object returned by `writeEvalRunSummary` already carries `runDir`; `summary.runDir` is the safer reference if `state`'s shape differs.
- **Stdlib `evalRun` stays ungraded.** The Agency-side `evalRun` (`lib/stdlib/agencyEval.ts`) drives its own loop and never reaches `evalRunLoadedInputs`' tail, so Agency programs calling `evalRun(...)` get no grading. Deferring is fine — but say it in the plan's scope notes so it reads as a decision, not an oversight.
- **The printed block diverges from the spec.** The spec's example prints one line per *grader* (`exact-match 2/3 pass`); the plan prints one line per *input*. Per-grader is arguably the more useful summary for the reward-hacking lens. Either is fine; pick one and update the other document.

## Claims verified against the code (all hold)

- All six files Task 1 moves individually exist, as do `lib/optimize/public.test.ts` and `validationSplit.ts`.
- Task 2's re-export list matches the current `lib/optimize/public.ts` surface name-for-name, including the `ExactMatchGrader as ExactMatch` aliasing; the additions (`AgentRun`, `GraderContext` on the eval surface) are new but consistent.
- `AgencyRunner`'s constructor takes `(config, runNode = defaultRunner)`, so `new AgencyRunner(config)` works (`lib/eval/grading/agencyRunner.ts:31-35` post-move).
- `BaseGrader.name()` exists; `Scorecard.perInput` is a public readonly field, so the test's `card.perInput[0]` is valid.
- `prepareInput` really does write `input.json` beside the workdir (`lib/eval/runArtifacts.ts:88,105`), so Task 3's disk-read of the spec — and the bug the self-review says it caught — is sound.
- `readEvalRun`'s shape (`inputsById`, optional `input`, optional `recordPath`, `errorMessage` from `error.txt`) matches what `toEntries` consumes.
- `reflectionFeedback.ts` reads `entry.run.recordPath` at line 16 via a `loadRecord` helper (line 63) that becomes dead after Task 3 Step 6, exactly as the plan says; `gradeBreakdown.ts:30` reads `i.run.output`.
- `evalRunLoadedInputs` ends with `return writeEvalRunSummary(state, results)` (`lib/cli/eval/run.ts:216`) and has `config` in scope (line 163).
- `lib/config.ts` is zod-based, so Task 5 Step 6's schema addition fits.
- The shared `gradeInput` in Task 3 Step 7 preserves the current gates-first, short-circuit ordering of `BaseOptimizer.gradeInput`.
- The plan's self-review claims about spec-finding coverage hold, with the exception that finding 6 (default goal judge) is implemented at the wrong layer — see finding 1.

## Limitations of this review

I did not run the plan's test snippets; assertions above about what would pass or fail are reasoned from the code, not executed. I also did not exhaustively check the optimizer test files Task 4 Step 5 must touch beyond confirming the seam grep finds them.
