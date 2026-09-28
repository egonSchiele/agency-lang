# Eval cleanups: naming and dead-weight removal after the workdir redesign

**Status:** LIVING LIST — the owner is reviewing the eval code file by file; items get appended as review continues. Do not implement yet.
**Date started:** 2026-07-30
**Follows:** PR #726, #727, #733 (workdir redesign)
**Ground rule:** backward compatibility is NOT required. Nothing external consumes these surfaces yet, so clean breaking changes are preferred over deprecation shims.

---

## Decisions log (settled, do not relitigate)

- **Grading is disk-first (owner, 2026-07-30).** The run directory is the interface between running an agent and grading one; grading's only input is a run directory, and there is exactly ONE path for getting run data — reading the JSON artifacts off disk — never a parallel in-memory handoff. Rationale: running and grading are currently tied too closely together, and the cost of the disk round trip is one JSON write plus one JSON read of bounded data (records already truncate oversized values), which is a small price for the separation. This reasoning would flip only if grading needed heavy post-read processing, which it does not. Consequence: `gradeRun`'s three-way input union (`EvalRunResult | ReadEvalRunResult | string`) collapses to the run-directory form; the loader (`readEvalRun` and friends) becomes the single place grading touches the filesystem.
- **An errored agent run scores zero, always (owner, 2026-07-30).** Graders never see an errored run and the salvaged record is never graded — it is diagnostic evidence for humans and for optimizer reflection, not something that earns points. Stated as an explicit rule at the evaluate layer, not the accident of a record lookup failing.
- **`AgentRun` returns `output` but not `record` (owner, 2026-07-30).** Level 1's result keeps the agent's answer as a convenience (`run.output`), but the parsed eval record stays on disk — anyone who wants the full evidence (graders, reflection, humans) reads `eval-record.json` through the loader. The error arm's salvaged `record?` field goes too; salvage lives only on disk.
- **The grader-facing shape is named `LoadedRun` (owner, 2026-07-30).** Resolves the `AgentRun` name collision: `AgentRun` (lib/eval/run/runAgent.ts) is the outcome of executing; `LoadedRun` (grading) is evidence loaded off disk by the loader.
- **"objective" stays.** The optimizer's frame ("the number being climbed") leaks into eval's user surface, and the ML-eval convention would be "score" — but renaming only the user-facing keys would leave two names for one concept across the eval/optimize seam, which is worse than one slightly-borrowed name. Everything keeps saying `objective`.

---

## Change 1: Remove `working_dir` entirely

**What it was:** the pre-redesign way to give a test its files — a directory cloned wholesale into the workdir, required to *contain the agent file*. That contract fused the two seed ingredients (test files + agent files) into one directory, tying a test to one agent. PR #733 deprecated it behind a warning and a legacy clone path. The owner has decided deprecation is unnecessary: remove it and everything that exists only to keep it working.

**Code inventory (verified on `adit/eval-workdirs`):**

- `lib/eval/runTypes.ts` — delete `Input.working_dir`.
- `lib/eval/loadInputs.ts` — delete the `working_dir` string validation, the `files`/`working_dir` mutual-exclusion check, and the `out.working_dir` resolution line.
- `lib/cli/eval/run.ts` — in `resolveInputSeed`: delete the whole `working_dir` branch (deprecation warning, realpath/directory validation, "must contain the agent file" check, legacy seed construction) **and** the `callerSetSeed` conflict throw, whose only trigger was `working_dir`. `resolveInputSeed` collapses to "input.files → filesDir, else default seed" and may inline into the loop.
- `lib/eval/workspace.ts` — delete `LegacyCloneSeed`, `cloneLegacy()`, and the `kind` branch in `Workspace.create`. The `RunSeed` union collapses to the single seeded shape (keep the name `RunSeed`, drop the `kind` discriminant).
- `lib/utils/projectTree.ts` — **delete the whole file.** Its only remaining consumer is the legacy clone path (verified: `copyProjectTree` is imported solely by `lib/eval/workspace.ts`). `PROJECT_COPY_EXCLUDES` dies with it.
- `lib/optimize/baseOptimizer.ts` — delete the `working_dir: undefined` stripping in `runInputViaEval` and its "conflicts with seed" comment; the field no longer exists to strip.
- `lib/eval/runArtifacts.ts` — drop the stale comment referencing `working_dir` validation.
- Tests: the two `working_dir` validation tests in `lib/cli/eval/run.workdir.test.ts` (reject non-directory; reject caller-seed conflict), the legacy-clone test in `lib/eval/workspace.test.ts`, the `files`+`working_dir` exclusion test in `lib/eval/loadInputs.test.ts`, and the optimizer's "no working_dir on input" assertion in `lib/optimize/baseOptimizer.workdir.test.ts`.
- Docs: the deprecation sentences in `docs/site/cli/eval.md`; any `working_dir` mention in `docs/site/cli/optimize.md`.

**Behavior change:** none to guard. DECIDED (owner, 2026-07-30): no deprecation, no explicit error, no compatibility shim of any kind — the sole user of this project uses `working_dir` nowhere, so it is removed completely and a spec containing it is simply an unknown field like any other.

## Change 2: Rename `agent` → `agentLabel` on run results

**What it is:** `EvalRunResult.agent` holds neither a path nor a name but a display label, `"<absolute agent path>:<node>"`, built by `resolveEvalRunTarget().label`. The name oversells it; nothing re-resolves an agent from it (reproduction data lives in `config.json.provenance`).

**Code inventory:**

- `lib/eval/runTypes.ts` — `EvalRunResult.agent` → `agentLabel`.
- `lib/eval/runArtifacts.ts` — `EvalRunState.agent` → `agentLabel`; `initializeEvalRun` arg; the `config.json` and `summary.json` keys follow (breaking key rename in both artifacts, allowed per ground rule).
- `lib/cli/eval/run.ts` — `agent: target.label` call site.
- Verified non-readers: `readEvalRun` and the judge never read the field; the `target.agent` in `lib/optimize/baseOptimizer.ts:78` is `OptimizeTarget.agent` (a different type, untouched).
- Tests/fixtures: `summary.json` fixtures in `lib/eval/grading/gradeRun.test.ts`, `lib/cli/eval/grade.test.ts`, `lib/eval/readRun.test.ts` write an `agent` key — rename for realism (they don't assert on it).
- Note: `EvalRunLoadedInputsOptions.agent` (the *input* option naming the agent file/target) keeps its name — it genuinely is the agent target; only the result-side label renames.

## Change 3: Remove `inputsSource` (superseded by provenance)

**What it was:** a free-text note of where inputs came from (`"inline:--goal"`, a file path, `"optimize"`, `"test"`), written to `config.json`. PR #733 added `config.json.provenance.inputsSource = { source, sha? }`, which records the same fact plus the resolved commit — strictly more informative. Two records of one fact; keep the better one.

**Code inventory:**

- `lib/eval/runTypes.ts` — delete `EvalRunConfig.inputsSource`.
- `lib/eval/runArtifacts.ts` — delete `EvalRunState.inputsSource`, the `initializeEvalRun` arg, and the top-level `config.json` key (the `provenance.inputsSource` object remains the single record).
- `lib/cli/eval/run.ts` — `EvalRunLoadedInputsOptions.inputsSource` (currently required) is deleted; `provenance` becomes the way a caller states input origin. `loadSuite` already builds it for the CLI path. The `buildProvenance` fallback `?? { source: opts.inputsSource }` becomes `?? { source: "unspecified" }` (or make `provenance` required — decide at implementation; recommendation: keep optional with the explicit `"unspecified"` sentinel so programmatic callers stay ergonomic).
- Callers that today pass `inputsSource` and must switch to `provenance` (or drop it): `lib/optimize/baseOptimizer.ts` (`inputsSource: "optimize"`), `lib/stdlib/agencyEval.ts` (the stdlib `evalRun` binding — passes a source string today; verify what it should record), and every `evalRunLoadedInputs` call in tests (`inputsSource: "test"`).

**Behavior change:** `config.json` loses its top-level `inputsSource` key; the information lives only under `provenance.inputsSource`.

---

## The frame: three layers, each a composition of the one below

Added 2026-07-30 after the owner's review of `run.ts`. This is no longer a list of point fixes — it is the shape the module should have, and the remaining items below serve it. The core criticism it answers: today's `lib/cli/eval/run.ts` interleaves many concepts (target resolution, seed derivation, the input loop, grader resolution and validation, suite loading, provenance, subprocess execution, verifier writing) in one file, and its functions trade in large, near-identical object shapes. Single-concept files with small interfaces instead.

**Level 1 — run one agent, once.** The atom everything else composes:

```ts
const run = await runAgent(pathToAgent, nodeName, args, {
  runDir?, runId?, seedFiles?, verbose?, limits?
});
// → { status: "success" | "error", output?, errorMessage?, record, workdir, runDir }
```

What running an agent needs, and ALL it needs: figure out the agent's files (closure), figure out the test's files (seedFiles), copy both, run the subprocess, save the statelog, extract the record/output. File layout to match, one concept per file:

```text
lib/cli/eval/run/
  runAgent.ts      # the ~40-line composition of the below — readable as the recipe
  seed.ts          # which files go into the run directory
  subprocess.ts    # fork, IPC decisions, limits (owner already extracted this)
  extract.ts       # statelog → record → output
```

**Level 2 — judge finished runs. Never executes an agent.**

```ts
const graded = await evaluate(run, graders);                       // one run
const suite  = await evaluateSuite(pathToAgent, inputs, graders, options);
```

`evaluateSuite` must be writable as `inputs.map(runAgent)` + `evaluate` + summary — if it needs more, the layering is wrong. The suite loop, grader resolution, and summary writing each get their own file; none of them live inside level 1.

**Level 3 — optimize.** Consumes levels 1–2; owns only what is genuinely search: target discovery, mutation, the accept/reject loop.

```ts
const best = await optimize(pathToAgent, inputs, graders, { optimizer: "gepa", iterations: 5 });
```

**Type rule that falls out:** one options type and one result type per level, named for their level. The current near-duplicate shapes (`EvalRunCliOptions` vs `EvalRunLoadedInputsOptions` vs the result types) are the fossil record of the blended file and get consolidated along the layer boundaries. "Provenance" (the record of what commit/hashes fed a run, for reproducibility) becomes one small module with a self-explanatory name rather than logic threaded through the conductor.

## Change 4: Extract subprocess execution from `run.ts` — STARTED BY OWNER

`lib/cli/eval/run/subprocess.ts` exists in the owner's working tree with `makeSubprocessEvalInputRunner` + `runCompiledAgentInSubprocess` moved out. Finishing the job: move `evalInterruptDecision` (it is IPC protocol, not orchestration) and `DEFAULT_EVAL_RUN_LIMITS` with them; imports/tests follow.

## Change 5: Delete the dead `EvalRunConfig` type

`lib/eval/runTypes.ts:73`. Zero constructors, zero consumers (verified by grep — the only mentions are the owner's two review comments pointing at the overlap). A fossil from a pre-#726 refactor. Delete outright; this resolves a third of the "three similar types" complaint by itself.

## Change 6: Name the raw-vs-loaded boundary in the remaining option types

The legitimate distinction the two surviving types encode, which their names do not teach: `EvalRunCliOptions` is *raw flag values* (strings, unresolved paths, a graders-module path); `EvalRunLoadedInputsOptions` is *after loading* (parsed `Input[]`, instantiated `BaseGrader[]`) — the programmatic surface the optimizer calls. Under the three-layer frame these become the level-2 suite options (raw and loaded forms) with names that say so. Exact names decided at implementation; the test is that a reader can tell from the name which side of loading they are on.

## Change 7: Closure walk readability (`lib/analysis/closure.ts`)

Two review questions, two small fixes:

- `ParsedSourceFile` carries `source` and `program` because the optimizer's target discovery shares this walk (`source` for content hashes/writeback safety, `program` for finding `optimize`-marked declarations); seeding uses only `absoluteFile`. Say this on the type — today the second consumer is invisible.
- The adjacent-duplicate filter (`index === 0 || file !== allFiles[index - 1]`) is "dedupe a sorted list" (duplicates arise when two `.agency` files import the same TS helper, or two TS entries share transitive files). Extract as a named `uniqueSorted()` helper with that one-line comment.

## Change 8: Small placements and docs from the run.ts review

- `DEFAULT_EVAL_RUN_LIMITS` → a constants home (`lib/constants.ts` or the extracted `subprocess.ts`), keeping its "pipe through AgencyConfig.eval.limits" TODO.
- The `seed` override on the suite runner exists for exactly one caller — the optimizer, which must pin seeding to its discovery-time closure walk (same baseDir/file list its mutations were computed against; also avoids N re-walks). Document that on the option, or rename it so the single purpose is visible.
- `Input.node` doc comment: spell out the two-level default (input's `node` → the `--agent file:node` target → `main`).
- `validateInputSelection`: owner simplified in working tree (neither-flag case now falls through to "inputs"); fold in, but note the neither case then fails later with a worse error — decide whether "provide --inputs or --goal" should still be raised when both are absent.

## Later items (appended as review continues)

- **Location decided (owner, 2026-07-30): the Level-1 files live in `lib/eval/run/`**, not `lib/cli/eval/run/` as originally sketched — `runAgent` is a library primitive the suite, grading, and optimizer compose over; `lib/cli/eval/run.ts` stays the thin command. (Plan-review finding: the cli/ location created a two-way cli↔eval dependency.)
- **The stdlib's second run pipeline is named Level-2 debt.** `lib/stdlib/agencyEval.ts` `_prepareInput`/`_finalizeInput` re-implement prepare + extract for Agency callers (a third copy of the extract step). Level 2 absorbs it onto `run/extract.ts` — and only then does the Agency `Input` gain a working `files` field (adding the field now would advertise seeding the stdlib path does not perform).

- **`AgentRun` is two arms, not three (owner, iteration 2): the `no-record` arm is deleted.** A clean exit that left no statelog (or an extractor that wrote no record file) is an `error` — a completed run always records a statelog, so its absence is a failure, and giving one failure mode its own status arm would invite an arm per failure mode. This changes suite behavior: such runs now count in `errorCount`, where before the refactor they counted ok. Two suite tests that stubbed a no-op extractor were updated to write a minimal record.
- **`"passed"` outcome confirmed consistent (owner, iteration 2), REFINED by PR #734 review:** interrupt handlers use approve / reject / propagate / pass, but the extractor was mapping "no resolution event recorded" to `"passed"` — an affirmative claim the data does not support, and a silent format break for records already on disk saying `"unresolved"`. Now both exist: `"passed"` only when a resolution event says so; `"unresolved"` when nothing did. Old records parse into the type again.
- **Iteration 2 (owner review comments, 2026-07-30), all applied:** `runAgent` restructured as a private `AgentRunner` class (methods `run`/`seedWorkdir`/`execute`/`extractRecord`/`fail`; the exported `runAgent()` function stays as the entry point); the `ExtractResult` union and `withFixtures` helper deleted; `defaultEvalRecordExtractor` + `optimizeEvalRecordExtractor` merged into `makeEvalRecordExtractor({ warnMissingValue })`; `evalInterruptDecision` unexported (its contract test deleted — the `satisfies IpcDecisionMessage` return type now pins the shape at compile time); `InterruptEntry.outcome` `"unresolved"` renamed to `"passed"`; `NormalizedEvent` variants named (`NormalizedLlmEvent` / `NormalizedToolStartEvent` / `NormalizedToolEndEvent`).
- **EvalRunLoadedInputsOptions ↔ RunAgentOptions overlap (owner, iteration 2):** the suite options duplicate the per-run fields because every suite forwards them verbatim to each `runAgent` call. The Level-2 `evaluate()` redesign should carry a `RunAgentOptions` subset explicitly instead of re-declaring fields. Doc comment added in `run.ts` naming this.
- **NormalizedEvent coverage question (owner, iteration 2, open):** should normalization cover more event types than llm/tool_start/tool_end (interrupts, thread lifecycle, errors are aggregated separately today)? Needs a decision on whether `events` is "the LLM/tool timeline" or "the whole trace, normalized".
- **Legacy-trace tolerance (open):** the field-presence degrade path in extraction exists only for pre-#726 statelogs. Given the no-backward-compatibility stance, it could be deleted once old saved runs stop mattering.

- **Disk-first iteration EXECUTED (2026-07-30, uncommitted on `adit/eval-refactor`)** per `/Users/adityabhargava/agency-lang/docs/superpowers/plans/2026-07-30-eval-grading-disk-first.md` (v2 + owner's run/grade separation): `AgentRun` slimmed to `output`-no-`record` with `salvageRecord()`; grading-side type renamed `LoadedRun` (both public surfaces; type-only import guard in `public.test.ts`); `gradeRun(runDir, ctx)` only — union/`toEntries`/`readInputSpec` deleted, tolerance moved into `readEvalRun` (corrupt per-input file degrades with a warning, corrupt `summary.json` fails naming the file, duplicate-id warning); errored-scores-zero pinned by a spy-grader test; **`evalRunLoadedInputs` no longer knows graders exist** — `graders` option deleted, `evalRun` composes resolve → validate → run → `recordGrading`, the once-duplicated scoring block is now `gradeSuite()` (`lib/eval/grading/gradeSuite.ts`), `resolveGraders` moved to `lib/cli/eval/graders.ts`; `docs/dev/eval-grading.md` + CLAUDE.md entry. NOTE for review: the old "misconfigured grader rejected before any agent runs" integration test became a direct `validateGraders` unit assertion — the fail-fast *ordering* now lives in `evalRun` and is not integration-tested (doing so would need a compiled grading-module fixture).

- **Iteration A EXECUTED (2026-07-30, uncommitted on `adit/eval-refactor`)** per `/Users/adityabhargava/agency-lang/docs/superpowers/plans/2026-07-30-eval-suite-layer.md` (v2). The three-level structure is done: `runSuite` (`lib/eval/run/runSuite.ts`, with `RunSuiteOptions`/`PerRunOptions` — Change 6), `gradeSuite`, `judgeSuite` all take run directories; `lib/cli/eval/run.ts` and `grade.ts` are pure command files; `recordGrading` lives in `lib/eval/grading/recordGrading.ts` and takes a runDir (no in-memory mutation); `lib/agentTarget.ts` holds `parseTarget`+`resolveEvalRunTarget`; the optimizer's `runInput` seam returns a run directory and grading goes through `gradeRun` (its `gradeInput` import, the exported `gradeInput`, and the synthesized `Entry` shape are gone); `judgeSuite` lost its `inputs` parameter (specs read from each run's `input.json`; union + `coerceRun` deleted); extractor `input` field + `verbose` + eval `quietCompile` deleted; `fakeRun` builds full run directories and takes the input spec. **User-visible:** `agency eval judge <dirA> <dirB>` no longer takes `--inputs`/`--goal`; Agency `evalJudgeSuite` lost its inputs argument (`make` + `make doc` run). Retired queue items: 1–5 and trivia 11. The review's predicted JSON-round-trip tripwire fired in greedyReflective's expected-answer test and was fixed by threading real specs through `fakeRun`.

- **Stdlib `evalRun` REMOVED, not absorbed (owner decision, 2026-07-30; executed uncommitted on `adit/eval-stdlib-removal`).** The Agency-side run pipeline (`_initEvalRun`/`_prepareInput`/`_finalizeInput`/`_finishEvalRun`/`_formatEvalRunFailure`, the Agency `evalRun` def and its three types, `recordInputSuccess`/`recordInputRunFailure` in runArtifacts, one execution test) predated workdir seeding, counted no-statelog runs as success, and carried no provenance — outdated on three counts, deleted whole. `evalExtract`/`evalJudge`/`evalJudgeSuite` stay (thin delegates to current core). A future Agency binding should wrap `runSuite`. This supersedes the old "Iteration B: absorb the stdlib pipeline" plan; the Agency `Input.files` idea goes with it until that binding exists. `make` + `make doc` run.
- **NOTE: the #734 squash-merge did NOT include the review-round fixes** — they ride as uncommitted changes on `adit/eval-stdlib-removal` alongside this removal (unresolved/passed split, judge no-goal verdict, optimizer suite-of-one guard, fakeRun cleanup, integration test + CI step, recordGrading error naming, scratch-file/.gitignore reverts).

*(next items land here)*

## Deferred / raised but not adopted

- Restructuring `EvalRunResult` to separate execution from grading (e.g. `{ execution: { inputs, okCount, errorCount }, grading? }`) and/or dropping the derivable `okCount`/`errorCount`. Raised during review of `runTypes.ts`; not yet decided.
- The empty-suite silent success: a suite that loads zero inputs currently "succeeds" with objective 0 instead of erroring ("no inputs loaded from `<source>`"). Surfaced by the stale-dist debugging session; a small guard, not yet decided.

## Testing (once the list is frozen)

One pass at implementation time: every deleted surface loses its tests, every rename updates fixtures, and the existing suites (`lib/eval`, `lib/cli/eval`, `lib/optimize`) prove nothing else depended on the removed pieces. Change 1 additionally wants one new test: an input spec containing `working_dir` produces the explicit "use files" error (if that recommendation is adopted).
