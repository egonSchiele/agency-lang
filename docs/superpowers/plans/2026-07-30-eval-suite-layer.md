# Iteration A: the suite layer

**Plan v2** — incorporates `/Users/adityabhargava/agency-lang/docs/superpowers/plans/2026-07-30-eval-suite-layer-REVIEW.md` (all points adopted, including full judge symmetry).

**Mode:** pairing on branch `adit/eval-refactor`, directly in `/Users/adityabhargava/agency-lang/packages/agency-lang`. No commits, no PR — the owner reviews the working tree. Paths relative to `packages/agency-lang` unless absolute.

**Goal:** finish the three-level structure. After this iteration: `runSuite` (execution), `gradeSuite` (grading), `judgeSuite` (comparison) are three library functions with the same shape — each takes/produces run directories, and nothing else carries run data — and `lib/cli/eval/run.ts` is a command file that only parses flags and composes them. The optimizer consumes the library like everyone else, grades run directories like everyone else, and the last in-memory grading seam (`gradeInput` + the synthesized `Entry` shape) collapses.

**Naming note:** the original three-level frame called level 2 `evaluateSuite(agent, inputs, graders)` — run *and* grade in one call. The disk-first decision supersedes that: running and grading stay separate functions joined by the run directory, and only the `evalRun` command composes them. So the library function is `runSuite`, symmetric with `gradeSuite`/`judgeSuite`.

## Background: what is where today, and the seams to cut

**The suite loop lives in the CLI.** `evalRunLoadedInputs` (`lib/cli/eval/run.ts:216`) resolves the target, walks the closure once, builds provenance, loops inputs calling `runAgent`, writes the summary. It is library logic in a command file, and the optimizer reaches *up* into `cli/` for it (`lib/optimize/baseOptimizer.ts:3`).

**Target resolution chains into the CLI too.** `resolveEvalRunTarget` (`run.ts:81`) is used by the runner, the optimizer (`baseOptimizer.ts:79`), and the optimize command; it calls `parseTarget` from `lib/cli/util.ts:34` — a 12-line, dependency-free "file:node" splitter also used by `lib/cli/test.ts`.

**The twin option types (Change 6).** `EvalRunCliOptions` is raw flag strings; `EvalRunLoadedInputsOptions` is after loading (parsed `Input[]`). The names do not teach the distinction, and the loaded type re-declares `runAgent`'s per-run fields (`precomputedSeed`, `overlayFiles`, `pipeAgentOutput`, `extractor`) under slightly different names.

**Dead options (verified by grep):** `verbose` is declared on both option types and forwarded once, but nothing reads it. `quietCompile` is documented as "currently unused" and only ever passed (by the optimizer). Both are deleted, not migrated — including `EvalRunCliOptions.verbose` and the optimizer's `quietCompile: true`. **Implementer caution (from review):** there is a LIVE `quietCompile` of the same name in `lib/cli/util.ts:231/259/292` used by `runAgencyNode` and `lib/eval/grading/agencyRunner.ts:61` — delete the eval option only; a blind grep-and-delete would break the judge runner.

**The extractor's `input` field is a dead seam.** `EvalRecordExtractor` (`lib/eval/run/extract.ts:9-13`) declares `input: Input`, forcing `runAgent` to fabricate `input: { args }` (the seam leak flagged two iterations ago). Verified: no extractor implementation or test reads `input`. The field is deleted; the fabrication goes with it.

**The optimizer's grading is the last in-memory-shaped seam.** `BaseOptimizer.evaluate` (`baseOptimizer.ts:234-249`) caches an `EvalRunInputResult` per (workspace, input) and calls `gradeInput(input, result, ctx)`. `gradeInput` is exported solely for this caller, and it is why `gradeRun.ts`'s `loadedEntry` must synthesize a fake `EvalRunInputResult` (dead `statelogPath: ""`, re-derived status). Each optimizer run is already a suite of one input in its own run directory, so it can grade with `gradeRun(runDir, ctx)` and take `perInput[0]`. The test fixture `fakeRun` (`lib/optimize/testUtils.ts`) already writes a real `eval-record.json` to disk — it only needs to also write `input.json` and `summary.json` and return the run directory.

**`judgeSuite` still takes the three-shape union** (`lib/eval/judge/suite.ts:15-21`, `coerceRun` at `:139`). Verified: both production callers — the `eval judge` CLI (`lib/cli/evalJudge.ts:45`) and the stdlib binding (`lib/stdlib/agencyEval.ts:173`, `_evalJudgeSuite`) — already pass run-directory strings. Only tests exercise the other arms.

**`recordGrading` sits in `run.ts`** (from the last iteration; both of us flagged the placement). Review altitude call adopted: it is suite-level write policy, not flag parsing, so it moves DOWN into the library (`lib/eval/grading/`), not sideways into the neighbouring command file — after which `run.ts` and `grade.ts` are both purely commands. The review also caught that `recordGrading(summary, …)` mutates the in-memory summary `runSuite` returned — the one in-memory suite-data handoff left. Fix: it takes the run directory and re-reads `summary.json`, removing the mutation entirely.

## Out of scope

- Iteration B: absorbing the stdlib `_prepareInput`/`_finalizeInput` pipeline; the Agency `Input.files` field.
- The four open decisions: empty-suite guard, `EvalRunResult` restructure, legacy-trace tolerance deletion, `NormalizedEvent` coverage.
- Moving `compile` out of `@/cli/commands.js` (seed.ts's upward import) — bigger than eval.

---

### Task 1: Target resolution gets its own home

(Review correction adopted: NOT `lib/utils.ts` — that file is already a multi-concept generic bag, and an agent target is a domain concept. "How an agent target string is parsed and resolved" is one concept with three consumers, so it gets one file.)

**Files:**
- Create: `lib/agentTarget.ts` (holds both `parseTarget` and `resolveEvalRunTarget`)
- Modify: `lib/cli/util.ts` (loses `parseTarget`), `lib/cli/test.ts`, `lib/cli/eval/run.ts`, `lib/cli/eval/optimize.ts`, `lib/optimize/baseOptimizer.ts` (imports)

- [ ] **Step 1:** create `lib/agentTarget.ts` with `parseTarget` (moved verbatim from `lib/cli/util.ts:34-45`) and `resolveEvalRunTarget` (moved verbatim from `run.ts:81-94`). File doc: "How an agent target string (`path`, `path:node`, or a directory meaning `main.agency`) is parsed and resolved into the file, node, and display label." No re-export shims — sole-user ground rule.
- [ ] **Step 2:** update every importer: `lib/cli/test.ts` (`parseTarget`), `lib/cli/eval/run.ts`, `lib/cli/eval/optimize.ts`, `lib/optimize/baseOptimizer.ts` (`resolveEvalRunTarget`) → `@/agentTarget.js`.
- [ ] **Step 4:** `pnpm run typecheck`; run `lib/cli` + `lib/optimize` tests to a scratchpad log.

### Task 2: The suite loop becomes `runSuite` in the library

**Files:**
- Create: `lib/eval/run/runSuite.ts`
- Modify: `lib/cli/eval/run.ts` (loses the loop and the loaded-options type), `lib/eval/run/extract.ts` (extractor type), `lib/eval/run/runAgent.ts` (drops the fabricated `input`)
- Test: `lib/eval/run/runSuite.test.ts` (moved/adapted from the non-command tests in `run.test.ts` and `run.workdir.test.ts`)

- [ ] **Step 1: delete the extractor's dead `input` field.** `EvalRecordExtractor` becomes `({ statelogPath, outPath }) => Promise<void>`; delete the now-unused `Input` import in `extract.ts` and the `input: { args }` fabrication in `runAgent.extractRecord`. (Verified: nothing reads it.)
- [ ] **Step 2: create `runSuite.ts`.** Move `evalRunLoadedInputs` (renamed `runSuite`), `toInputResult`, and the options type. The new option shape — this IS Change 6, so the names must teach the raw-vs-loaded and suite-vs-run boundaries:

```ts
/** Per-run knobs forwarded verbatim to every runAgent call in the suite.
 *  Pick, not re-declaration: the compiler keeps this in sync with RunAgentOptions.
 *  NOTE the omission semantics shift at suite level: with `seed` omitted,
 *  runSuite computes ONE closure walk for the whole suite and passes it to
 *  every run — never one walk per input (RunAgentOptions.seed's own doc
 *  describes the single-run case). */
export type PerRunOptions = Pick<RunAgentOptions, "seed" | "overlayFiles" | "pipeOutput" | "extractor">;

/** Options for running a LOADED suite: parsed Input[], resolved values.
 *  The raw-flags side lives in the evalRun command (EvalRunCliOptions). */
export type RunSuiteOptions = {
  agent: string;                    // path or path:node
  inputs: Input[];
  runId?: string;
  runsDir?: string;
  continueOnError?: boolean;        // default true
  config?: AgencyConfig;
  /** Source provenance recorded in config.json; "unspecified" when omitted. */
  provenance?: { inputsSource: SourceProvenance; files: Record<string, SourceProvenance> };
  perRun?: PerRunOptions;
};

/** Test seam, same pattern as RunAgentDeps. */
export type RunSuiteDeps = { runner?: EvalInputRunner };

export async function runSuite(opts: RunSuiteOptions, deps: RunSuiteDeps = {}): Promise<EvalRunResult>
```

Field renames while moving: `precomputedSeed` → `perRun.seed` (the old name's story lives in the `seed` doc on `RunAgentOptions` already), `pipeAgentOutput` → `perRun.pipeOutput`, `extractor` → `perRun.extractor`. The old `overrides.extractor ?? opts.extractor` precedence dies: the extractor has exactly one home, `perRun.extractor`; `deps` carries only `runner`. `verbose` and `quietCompile` are deleted, not moved.
- [ ] **Step 3: `run.ts` keeps only the command.** Remaining exports: `EvalRunCliOptions`, `validateInputSelection`, `evalRun` (compose: resolve graders → load suite → validate → `runSuite` → `recordGrading`), plus the private `loadSuite`. `evalRun`'s second parameter gets the same treatment as `runSuite`'s: rename `overrides` → `deps`, doc it as the test seam (the CLI has no flags for either field), and map it through: `deps.runner` → `RunSuiteDeps.runner`, `deps.extractor` → `perRun.extractor`.
- [ ] **Step 4: split the tests along the same line.** The suite-mechanics tests in `run.test.ts` (loop, continueOnError, seeding, provenance, summary) and `run.workdir.test.ts` move to `lib/eval/run/runSuite.test.ts`, calling `runSuite` with `perRun.extractor` instead of the overrides bag. Command-level tests (`evalRun` flag handling, grading composition, `validateInputSelection`) stay in `run.test.ts`.
- [ ] **Step 5:** typecheck + run `lib/eval/run` and `lib/cli/eval` tests to a scratchpad log.

### Task 3: `recordGrading` moves into the grading library and stops mutating

**Files:**
- Create: `lib/eval/grading/recordGrading.ts`
- Modify: `lib/cli/eval/run.ts` (imports it), `lib/cli/eval/run.test.ts`

- [ ] **Step 1:** create `lib/eval/grading/recordGrading.ts` beside `gradeSuite.ts`:

```ts
/** Grade a finished run directory and record the verdict the standard way:
 *  the verifier directory, and a `grading` block in summary.json. Reads the
 *  summary back off disk rather than taking it in memory — the run directory
 *  is the interface, on the way in AND on the way out. */
export async function recordGrading(runDir: string, graders: BaseGrader[], config: AgencyConfig): Promise<EvalRunGrading> {
  const grading = await gradeSuite(runDir, graders, config);
  const summaryPath = path.join(runDir, "summary.json");
  const summary = JSON.parse(fs.readFileSync(summaryPath, "utf-8")) as EvalRunResult;
  summary.grading = grading;
  writeVerifierGrading(runDir, grading);
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  return grading;
}
```

`evalRun` composes: `summary.grading = await recordGrading(summary.runDir, graders, config)` — it sets the field on its own return value from the function's result; nothing mutates across the seam. Delete the old `recordGrading` from `run.ts`.
- [ ] **Step 2:** the two grading tests in `run.test.ts` switch to the new signature (`recordGrading(summary.runDir, graders, {})` and assert on the returned grading + the files). After this, the done-test from last iteration tightens: `run.ts`'s grading references are `resolveGraders`, `validateGraders`, `recordGrading` — three imported names inside `evalRun`, zero grading logic defined in the file, and `grade.ts` is purely a command too.

### Task 4: The optimizer grades run directories

**Files:**
- Modify: `lib/optimize/baseOptimizer.ts`, `lib/optimize/evalCache.ts`, `lib/optimize/testUtils.ts`, `lib/eval/grading/gradeRun.ts`
- Test: `lib/optimize/baseOptimizer.test.ts`, `evalCache.test.ts`, `baseOptimizer.workdir.test.ts`, `optimizers/*.test.ts` (mechanical follow-through)

- [ ] **Step 1: the run seam returns a run directory.** `runInputViaEval` returns `summary.runDir` (it already throws on a failed input first — keep that). The injectable `runInput` seam and `EvalCache` change value type `EvalRunInputResult` → `string` (the run directory). The cache doc keeps its collision rationale.
- [ ] **Step 2: `evaluate` grades the directory.**

```ts
const runDir = await this.cache.get(ws.key, id, () => this.runInput(ws, source, files, input, id));
const card = await gradeRun(runDir, ctx);
return card.perInput[0];
```

One suite-of-one per candidate input, graded the way every other run is graded. The input spec reaches graders via the `input.json` that `prepareInput` wrote — same disk round-trip rule.
- [ ] **Step 3: `gradeInput` goes private and `Entry` becomes honest.** With the last external caller gone, unexport `gradeInput` and delete the synthesized `EvalRunInputResult`: the internal entry shape becomes what grading actually needs — `{ input, recordPath, workdir, ungradedReason? }` — and `lookUpOutput` takes `recordPath`/`workdir` directly. Delete the "inherited from the optimizer's seam" comment: the seam moved, the excuse expires. `validateGraders` stays exported (the command uses it).
- [ ] **Step 3b: convert the `describe("gradeInput")` tests.** (Review catch — the plan's test list missed them.) `lib/eval/grading/gradeRun.test.ts:91-130` calls the exported `gradeInput` directly three times. They become `gradeRun` tests over a one-input run directory (the same conversion the in-memory `gradeRun` tests went through last iteration). They must NOT keep `gradeInput` exported "for tests" — that re-opens the seam this task closes.
- [ ] **Step 4: fixtures follow.** `fakeRun` writes `input.json` (the spec with goal/expected) and `summary.json` alongside the record it already writes, and returns the run-directory string. Optimizer tests that returned `fakeRun(...)` from `runInput` seams are unchanged beyond the type; assertions on `perInput[0].input` now read the disk-round-tripped spec (same values).
- [ ] **Step 5: update `docs/dev/writing-optimizers.md`.** (Review catch — Task 4 changes a documented seam.) The `runInput` seam row at `:245` ("return an `EvalRunInputResult` pointing at an eval record on disk…") becomes "return the run directory; grading loads it like any other run". Update the `fakeRun` sentence, and sweep the page for prose naming the cached value type on the `cache` seam row.
- [ ] **Step 6:** typecheck; run `lib/optimize` + `lib/eval/grading` tests to a scratchpad log. `baseOptimizer.workdir.test.ts`'s mock of the eval-run module switches to mocking `@/eval/run/runSuite.js` and asserting `perRun.seed`/`perRun.overlayFiles`.

Two tripwires for this task (the review named the second): (1) the objective math must not drift — any change shows as changed numbers in existing optimizer tests; (2) the input spec now reaches graders via a JSON round trip, which DROPS keys whose value is `undefined` — check once that no grader or reflection-feedback path distinguishes "`expected` absent" from "`expected: undefined`". Cost note: each candidate input's grade now re-reads `summary.json` + `input.json` besides the record — noise next to an agent subprocess, recorded here so nobody rediscovers it as a regression.

### Task 5: `judgeSuite` takes run directories — and nothing else

Review altitude call adopted in full: the original step kept `inputs: Input[]` in memory alongside the two directories, which broke the "same shape" claim. But the run directories already carry the specs — `readEvalRun` parses each `input.json` (`lib/eval/readRun.ts:27`), which is exactly how `gradeRun` gets them. So the third parameter goes.

**Files:**
- Modify: `lib/eval/judge/suite.ts`, `lib/cli/evalJudge.ts`, `lib/stdlib/agencyEval.ts`, `stdlib/agency/eval.agency`
- Test: `lib/eval/judge/suite.test.ts`, `lib/cli/evalJudge.test.ts`, `lib/stdlib/agencyEval.test.ts`

- [ ] **Step 1:** `JudgeSuiteArgs` becomes `{ runA: string; runB: string; policy; judgePair? }`. `judgeSuite` calls `readEvalRun` on each directory and iterates run A's inputs in summary order, pairing with run B by input id; the goal comes from run A's spec (`input.goal ?? ""`); an id present in only one run keeps the existing `missingDataVerdict` path. Delete `coerceRun` and the `inputs` parameter; drop the `EvalRunResult`/`ReadEvalRunResult` imports if unused.
- [ ] **Step 2: the `eval judge` CLI sheds its input flags for directory mode.** In `lib/cli/evalJudge.ts`: directory mode no longer accepts `--inputs` or `--goal` (reject both with a message saying specs come from the run directories); `--goal` remains required for files mode only. Delete `inputsFromInlineGoal`, the `loadInputs` import, and `validateInputSelection` usage — this also retires the pre-existing wart that `eval judge` loaded inputs without git-source support. **This is a user-visible CLI change; flagged for owner review.**
- [ ] **Step 3: the stdlib binding follows.** `_evalJudgeSuite` (`lib/stdlib/agencyEval.ts:173`) drops its `inputs: Input[]` parameter; the Agency wrapper in `stdlib/agency/eval.agency` drops the corresponding argument. Rebuild with `make` and regenerate docs with `make doc` — and do NOT interrupt `make doc` (an interrupted run deletes tracked files under `docs/site/stdlib/`).
- [ ] **Step 4:** convert any `suite.test.ts` cases that pass loaded objects or inline inputs to writing run directories first (same conversion `gradeRun.test.ts` went through; a test that cannot be files on disk was depending on the shortcut).
- [ ] **Step 5:** update `docs/dev/eval-grading.md`: the "Known divergence" section shrinks to a sentence saying the judge converged on 2026-07-30. Update `docs/site/cli/` judge docs for the flag change.

### Task 6: Sweep and record

- [ ] **Step 1:** straggler grep: `grep -rn "evalRunLoadedInputs\|EvalRunLoadedInputsOptions\|precomputedSeed\|pipeAgentOutput\|coerceRun\|gradeInput\|inputsFromInlineGoal" lib scripts --include="*.ts" | grep -v worktree`. Expected hits, stated rather than "zero" (review nit): `gradeInput` inside `lib/eval/grading/gradeRun.ts` only (private definition + internal call). `quietCompile` is grepped separately and EXPECTS the live hits in `lib/cli/util.ts` and `lib/eval/grading/agencyRunner.ts` — only eval-option hits are stragglers.
- [ ] **Step 2:** full sweep to a scratchpad log: `pnpm test:run lib/eval lib/cli lib/optimize lib/stdlib/agencyEval.test.ts`; typecheck; `lint:structure`.
- [ ] **Step 3:** anti-pattern audit of the diff (conditional spreads, narrating comments, near-duplicate types — the point of this iteration is that the near-duplicates are GONE: `EvalRunLoadedInputsOptions`, the fake `Entry`, `coerceRun`).
- [ ] **Step 4:** update the living spec: iteration A executed; items 1–5 + extractor seam retired; remaining queue = Iteration B + the four decisions + housekeeping.

## Self-review notes

- Queue coverage: item 1 (suite loop → library) = Tasks 1+2; item 2 (Change 6 types) = Task 2 Step 2; item 3 (optimizer) = Tasks 1+4; item 4 (`recordGrading`) = Task 3; item 5 (judge) = Task 5; trivia item 11 (extractor seam) = Task 2 Step 1.
- Deliberate API breaks (allowed, sole user): `runInput` optimizer seam returns a string; `EvalRecordExtractor` loses `input`; option renames. All internal.
- Risk to watch in Task 4: `gradeRun` on a suite-of-one must yield exactly the `InputGrades` that `gradeInput` did — the optimizer's objective math (`Scorecard` over collected `perInput`) is unchanged, so any drift shows up as changed test numbers, which is the tripwire.
- Test-count expectation: net near-zero — tests move files (Task 2) more than they change meaning.
- Review adoptions changing user-visible surface, for the owner's eyes at tree review: `eval judge` directory mode loses `--inputs`/`--goal`; the Agency-facing `judgeSuite` wrapper loses its inputs argument (requires `make` + `make doc`).
