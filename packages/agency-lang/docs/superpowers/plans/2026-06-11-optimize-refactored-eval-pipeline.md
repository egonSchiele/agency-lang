# Optimize Refactored Eval Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `agency eval optimize <file>[:<node>]` compose shared eval run, eval judge suite, declaration-target discovery, and the declarative source mutator instead of owning its own judging or source-editing pipeline.

**Command surface decision:** We are **not** adding a new top-level `agency optimize` command and we are **not** keeping the legacy top-level `agency optimize` command as an alias. The only supported entrypoint is `agency eval optimize`. Having two names for the same command is unnecessarily confusing. Any reference in this plan to a top-level `agency optimize` is a historical artifact from an earlier draft and should be ignored — the legacy top-level command is removed in the declaration-modifier-v2 plan (Task 4), and this plan must not re-add it.

**Architecture:** Treat optimize as orchestration only: discover declaration targets, run a baseline eval suite, ask the LLM mutator for declarative mutation operations, preview/apply those operations through the source mutator, evaluate candidates with `evalRunLoadedTasks()`, judge champion-vs-candidate with `judgeSuite()`, accept only `winner === "B"`, write optimize artifacts, and optionally write back the champion file set.

**Tech Stack:** TypeScript, Commander CLI, Vitest, `lib/eval/loadTasks.ts`, `lib/cli/eval/run.ts`, `lib/eval/judge/suite.ts`, `lib/optimize/targets.ts`, `lib/optimize/sourceMutator.ts`, `lib/optimize/artifacts.ts`.

---

## Source spec

Spec: `docs/superpowers/specs/2026-06-11-optimize-eval-pipeline-design.md`

Prerequisites:

- `docs/superpowers/plans/2026-06-11-eval-core-primitives.md`
- `docs/superpowers/plans/2026-06-11-eval-goals-tasks-judge-suite.md`
- `docs/superpowers/plans/2026-06-11-optimize-declaration-modifier-v2.md`
- `docs/superpowers/plans/2026-06-11-declarative-optimize-mutator.md`

## File structure

### Modify

- `scripts/agency.ts`
  - The only optimize entrypoint is `agency eval optimize <file>[:<node>]`.
  - Replace required `--agent` option with positional `<agent>` argument.
  - Do **not** add a top-level `agency optimize` command. The legacy top-level command is deleted in the declaration-modifier-v2 plan (Task 4).
- `lib/cli/eval/optimize.ts`
  - Accept `--goal` or `--tasks` exactly like eval run.
  - Build one `OptimizeLoopConfig` from shared task loading, declaration discovery, and judge policy flags.
- `lib/cli/eval/optimize.test.ts`
  - CLI config tests for `--goal`, `--tasks`, judge option passthrough, and run-dir collision.
- `lib/optimize/types.ts`
  - Align loop config with eval goals and judge suite policy.
- `lib/optimize/loop.ts`
  - Use `evalRunLoadedTasks()` for every baseline/candidate run.
  - Use `judgeSuite()` with champion as A and candidate as B.
  - Convert LLM mutation proposals into declarative source mutator operations and consume preview/apply results.
  - Accept only when `suiteVerdict.winner === "B"`.
- `lib/optimize/loop.test.ts`
  - Tests for task reuse, A/B side mapping, acceptance rule, candidate failures, judge failures, and summary counts.
- `lib/optimize/history.ts`, `lib/optimize/history.test.ts`
  - Operation-based mutation history entries (no prompt text bodies).
- `lib/optimize/ast.ts`
  - Delete the legacy tag-based helpers (`findOptimizeTargets`, `getPromptValue`, `updatePrompt`) and the legacy `OptimizeTarget` type, resolving the name collision with `lib/optimize/targets.ts`. Keep `parsePromptToSegments` (interpolation validation still needs it; move it next to the validation helper if `ast.ts` ends up empty).
- `lib/optimize/artifacts.ts`
  - Ensure layout has `runs/optimize/<run-id>/iter-N/agent/`, `eval-run/`, `verdict.json`, `champion/agent/`, and `summary.json`.
- `lib/optimize/artifacts.test.ts`
  - Layout and collision tests.
- `docs/site/cli/eval.md`
  - Document `agency eval optimize` with declaration modifier examples.

## Implementation notes

- `--goal` desugars once at startup to `task_id: "task-1"`; reuse the same task array for baseline, candidates, and judge calls.
- If selected node requires args and `--goal` creates no args, fail before baseline run with the exact helpful message from the spec.
- Optimize run directory collision matches eval run: throw and stop; no overwrite/resume.
- Champion is side A; candidate is side B. `judgeSuite()` owns position-bias swapping internally.
- Do not keep optimize-specific `judgeSamples`, `acceptThreshold`, `buildOptimizeVerdict`, source-patching helpers, or sampling code after migration unless compatibility tests require temporary wrappers.
- Candidate eval task failures should be visible to `judgeSuite()` through missing/failed task statuses. Reject unless suite winner is B.
- Target discovery (`discoverOptimizeTargets()`) runs once at CLI startup; the discovered `OptimizeTargetSet` rides in `OptimizeLoopConfig.target.targetSet`. After an accepted candidate, the champion adopts the `targetSet` returned by `OptimizeSourceMutator.preview()` (the mutator plan makes preview return the updated set) — never re-run disk discovery mid-loop.
- **Parse budget:** parsing can take up to a second on long files. Total parse cost at the optimize layer must be O(n) in the number of Agency files: one discovery pass at startup, plus O(files touched) per preview attempt. Anything that re-parses the whole import tree per iteration (re-discovery on acceptance, a second closure walk, parsing unchanged files) is a defect. Candidate compilation inside each eval run necessarily processes the tree; that is the compiler's cost, not this layer's, and must not be added to.
- **Keep the per-iteration workspace.** `iter-N/workspace/` remains a full working-dir copy (existing `prepareWorkspace()` exclusions) so candidates can read non-Agency resources at runtime, and task `working_dir` normalization (`normalizeOptimizeTasks`) stays. `iter-N/agent/` holds only the discovered Agency file set for inspection; the same candidate files are overlaid onto the workspace, and baseline/candidate evals always run against the workspace entry file.
- The LLM mutator contract is defined in the declarative-optimize-mutator plan (Task 5): `proposeMutation({ config, targets, tasks, history, model?, diagnostics?, callModel? })` returning `{ operations, rationale }`. The mutator does not validate; the loop owns a single retry, passing diagnostics from a rejected `OptimizeSourceMutator.preview()` back via `diagnostics`.
- Sequencing (accepted): the declarative-optimize-mutator plan executes first, and its Task 5 changes the mutator output shape before this plan migrates the loop. `agency eval optimize` is broken on main in that window; Task 3 below closes it. Do not add compatibility shims.

---

### Task 1: Update `agency eval optimize` CLI surface (positional `<agent>`, judge flags)

**Files:**
- Modify: `scripts/agency.ts`
- Modify: `lib/cli/eval/optimize.ts`
- Modify: `lib/cli/eval/optimize.test.ts`

**Prerequisite:** The legacy top-level `agency optimize` command and `lib/cli/optimize.ts` are deleted in the declaration-modifier-v2 plan (Task 4). Do not re-add them here. The only optimize entrypoint after this work is `agency eval optimize`.

- [ ] **Step 1: Write failing CLI tests**

Assert:

```bash
agency eval optimize foo.agency --goal "Return Paris"
agency eval optimize foo.agency:main --tasks tasks.json
```

both build an equivalent `OptimizeLoopConfig`. Assert `--goal` and `--tasks` are mutually exclusive and that exactly one is required. Assert judge flag passthrough (`--samples`, `--confidence-threshold`, `--margin-threshold`). Assert that no top-level `agency optimize` command is registered.

- [ ] **Step 2: Run RED**

```bash
pnpm test:run lib/cli/eval/optimize.test.ts > /tmp/optimize-pipeline-cli-red.log 2>&1
```

- [ ] **Step 3: Update `eval optimize` command registration**

In `scripts/agency.ts`, change `eval optimize` from `--agent <file>` to positional `<agent>`:

```ts
evalCmd
  .command("optimize")
  .description("Optimize marked Agency declarations against an eval goal or task suite")
  .argument("<agent>", "Agency file target: file.agency[:node]")
  .option("--goal <text>", "Goal to optimize for")
  .option("--tasks <fileOrDir>", "Eval task suite")
  .option("--iterations <n>", "Candidate iterations", parseInt)
  .option("--runs-dir <path>", "Optimize runs directory")
  .option("--run-id <id>", "Optimize run id")
  .option("--no-writeback", "Do not write the champion back to source files")
  .option("--mutator-model <model>", "Model used to propose mutations")
  .option("--samples <n>", "Judge samples per task", parseInt)
  .option("--confidence-threshold <n>", "Minimum confidence counted as a win", parseInt)
  .option("--margin-threshold <n>", "Suite win margin required", parseInt)
  .action(async (agent, opts) => evalOptimize({ ...opts, agent, config: getConfig() }));
```

Before editing, read `scripts/agency.ts` to confirm the **exact** flag names already used by `agency eval judge` (`--samples`, `--confidence-threshold`, `--margin-threshold`, or different names) and reuse them verbatim so flag names do not drift between commands.

Commander's `--no-writeback` sets `opts.writeback === false` and defaults to `true`. The CLI action and `evalOptimize()` must consume `opts.writeback`, **not** `opts.noWriteback`. Add a test.

- [ ] **Step 4: Run GREEN**

```bash
pnpm test:run lib/cli/eval/optimize.test.ts > /tmp/optimize-pipeline-cli-green.log 2>&1
```

- [ ] **Step 5: Commit**

```bash
git add scripts/agency.ts lib/cli/eval/optimize.ts lib/cli/eval/optimize.test.ts
git commit -m "optimize: positional agent arg and judge flag passthrough on eval optimize"
```

---

### Task 2: Build optimize task suite from shared eval task model

**Files:**
- Modify: `lib/cli/eval/optimize.ts`
- Modify: `lib/cli/eval/optimize.test.ts`
- Modify: `lib/optimize/types.ts`

- [ ] **Step 1: Add failing tests for `--goal` and `--tasks`**

Assertions:

```ts
expect(config.runtime.tasks).toEqual([{ task_id: "task-1", goal: "Return Paris", args: {} }]);
expect(config.runtime.tasksSource).toBe("inline:--goal");
```

For `--tasks`, assert task goals are loaded once and sorted/preserved according to `loadTasks()` behavior.

- [ ] **Step 2: Run RED**

```bash
pnpm test:run lib/cli/eval/optimize.test.ts > /tmp/optimize-pipeline-tasks-red.log 2>&1
```

- [ ] **Step 3: Implement task selection**

Reuse `validateTaskSelection()` and `taskFromGoal()` / `loadTasks()` from eval run. Remove required `opts.goal` when `--tasks` is supplied.

- [ ] **Step 4: Add no-args node validation hook**

If there is an existing typechecker/helper to inspect node parameters, use it. If not, add a small validation after parsing the entry file:

```text
Node main requires arguments, but --goal creates a no-argument task.
Use --tasks tasks.json to provide args for this agent.
```

Keep this scoped to `--goal`; task files can provide args.

- [ ] **Step 5: Run GREEN**

```bash
pnpm test:run lib/cli/eval/optimize.test.ts lib/eval/loadTasks.test.ts > /tmp/optimize-pipeline-tasks-green.log 2>&1
```

- [ ] **Step 6: Commit**

```bash
git add lib/cli/eval/optimize.ts lib/cli/eval/optimize.test.ts lib/optimize/types.ts
git commit -m "optimize: use shared eval task model"
```

---

### Task 3: Migrate the optimize loop to declaration targets and the source mutator

The loop core is still on the legacy model: `validateOptimizeTarget()` requires the `@optimize(prompt)` tag that `discoverOptimizeTargets()` now rejects, mutations are applied via the `lib/optimize/ast.ts` prompt-patching helpers, and the champion is a single source string. This task replaces that core with declaration-target discovery plus the declarative source mutator, and closes the accepted broken window opened by the mutator plan's Task 5.

**Files:**
- Modify: `lib/optimize/loop.ts`
- Modify: `lib/optimize/loop.test.ts`
- Modify: `lib/optimize/types.ts`
- Modify: `lib/cli/eval/optimize.ts` (run discovery at startup, pass the target set into the loop config; delete `localAgencyFileClosure` so the import closure is parsed exactly once at startup. Fold the working-dir rule — common ancestor of the closure, unless inside cwd — into `discoverOptimizeTargets()`: walk first collecting absolute paths and parsed programs, compute `baseDir` at the end when no explicit `baseDir` option is given, then key the file map. Deriving the dir outside discovery doesn't work because discovery needs `baseDir` up front to key relative paths.)
- Modify: `lib/optimize/history.ts`, `lib/optimize/history.test.ts`
- Modify/Delete: `lib/optimize/ast.ts` (legacy helpers; see file structure notes)

- [ ] **Step 1: Write failing loop migration tests**

Inject fake `proposeMutation` and a real (or fake) `OptimizeSourceMutator`. Assert:

- the loop config carries `target.targetSet: OptimizeTargetSet` and the loop throws before the baseline run when `targetSet.targets` is empty,
- the baseline iteration materializes `targetSet.files` sources verbatim into `iter-0/agent/` and overlays them onto `iter-0/workspace/`,
- the mutator is called with the contract from the declarative-optimize-mutator plan (Task 5): `proposeMutation({ config, targets, tasks, history, diagnostics? })` returning `{ operations, rationale }`,
- proposed operations go through `OptimizeSourceMutator.preview()`; a preview with diagnostics triggers exactly one mutator retry with those diagnostics passed back; a second failure records a validation-failed iteration and continues,
- candidate previews are materialized into `iter-N/agent/` and overlaid onto `iter-N/workspace/`; evals run against the workspace entry file,
- after an accepted candidate, the champion adopts the preview's updated `targetSet` (assert no re-discovery and no re-parsing of unchanged files — e.g. with a discovery/parse spy),
- champion state is a file set (relative path → source), not a single source string.

- [ ] **Step 2: Run RED**

```bash
pnpm test:run lib/optimize/loop.test.ts > /tmp/optimize-pipeline-migrate-red.log 2>&1
```

- [ ] **Step 3: Restructure `OptimizeLoopConfig.target`**

```ts
target: {
  entryFile: string;            // relative, from targetSet.entryFile
  node: string;
  targetSet: OptimizeTargetSet; // discovered once at CLI startup
  workingDir: string;
  writeback: boolean;           // replaces writebackPath
};
```

Replace `agentSource` / `agentFilename` / `writebackPath`. Writeback writes the champion file set to the original `absoluteFile` paths from `targetSet.files`, after verifying every file's current on-disk sha256 still matches its discovery-time sha256; any mismatch aborts writeback for all files (artifacts are already written at that point).

- [ ] **Step 4: Replace the mutation path in the loop**

Delete `validateOptimizeTarget`, `promptFromSource`, `updateSourcePrompt`, `targetsFromSource`, and `programFromSource` from `loop.ts`, along with the interim `LegacyMutationProposal` type and throwing `legacyMutateUnavailable` default that closed the broken window. The per-iteration flow becomes: `proposeMutation(...)` → `OptimizeSourceMutator.preview(operations)` → (retry once on diagnostics) → materialize preview files → eval → judge. Keep the workspace copy exactly as today (`prepareWorkspace` + exclusions), overlaying preview files on top.

Materialize through a new file-set workspace writer in `lib/optimize/artifacts.ts` (with a test):

```ts
writeIterationWorkspace(iter: number, files: Record<string, string>): {
  iter: number;
  workspaceDir: string;
};
```

It prepares `iter-N/workspace/` (full working-dir copy, existing `prepareWorkspace` exclusions) and overlays `files` on top, preserving relative paths. Once the loop uses `writeIterationAgent` + `writeIterationWorkspace`, delete the single-source `writeBaseline`/`writeCandidate` writers and the `IterationArtifact` shape if nothing else consumes them.

- [ ] **Step 5: Update mutation history to operations**

History entries record `{ iter, decision, rationale, operations: [{ target, op }], lossReasons }` — no prompt text bodies. The rendered history string stays the mutator-prompt input.

- [ ] **Step 6: Run GREEN**

```bash
pnpm test:run lib/optimize/loop.test.ts lib/optimize/history.test.ts lib/optimize/sourceMutator.test.ts > /tmp/optimize-pipeline-migrate-green.log 2>&1
```

- [ ] **Step 7: Commit**

```bash
git add lib/optimize lib/cli/eval/optimize.ts
git commit -m "optimize: migrate loop to declaration targets and source mutator"
```

---

### Task 4: Compose optimize loop with eval run and judge suite

**Files:**
- Modify: `lib/optimize/loop.ts`
- Modify: `lib/optimize/loop.test.ts`
- Modify: `lib/optimize/types.ts`
- Modify/Delete: `lib/optimize/sampling.ts`
- Modify/Delete: `lib/optimize/verdict.ts`
- Modify/Delete: `lib/optimize/sampling.test.ts`
- Modify/Delete: `lib/optimize/verdict.test.ts`

- [ ] **Step 1: Write failing loop composition tests**

Inject fake `evalRun` and `judgeSuite` deps. Assert:

- baseline runs once before iterations,
- candidate runs once per iteration,
- `judgeSuite` receives `runA = champion`, `runB = candidate`, same `tasks` object/array, and configured policy,
- candidate accepted only when verdict winner is `"B"`,
- `"A"` and `"tie"` both reject,
- accepted candidate becomes next champion side A.

- [ ] **Step 2: Run RED**

```bash
pnpm test:run lib/optimize/loop.test.ts > /tmp/optimize-pipeline-loop-red.log 2>&1
```

- [ ] **Step 3: Update loop dependency shape**

In `OptimizeLoopDeps`:

```ts
judgeSuite?: (args: JudgeSuiteArgs) => Promise<SuiteVerdict>;
```

Remove `judgeTask` / optimize-specific sampling deps.

- [ ] **Step 4: Use eval run for baseline/candidates**

Call `evalRunLoadedTasks({ agent: workspaceEntryFile, tasks, tasksSource: "optimize:tasks", runsDir: iterDir, runId: "eval-run", continueOnError: true, config })`, where `workspaceEntryFile` is the entry file inside `iter-N/workspace/` (Task 3). The eval run directory is `<runsDir>/<runId>`, so passing the iter dir as `runsDir` with run id `"eval-run"` yields exactly `iter-N/eval-run/` — do not pass `iter-N/eval-run` as `runsDir` or output nests one level too deep. (`evalRunLoadedTasks()` already exists in `lib/cli/eval/run.ts` under this exact name.)

- [ ] **Step 5: Use judge suite for champion vs candidate**

Call:

```ts
const suiteVerdict = await judgeSuite({
  runA: champion.evalRun,
  runB: candidateEval,
  tasks: config.runtime.tasks,
  policy: config.judgePolicy,
});

const accepted = suiteVerdict.winner === "B";
```

- [ ] **Step 6: Remove optimize-specific verdict math**

Delete `buildOptimizeVerdict()` and optimize sampling only after loop tests use `SuiteVerdict` directly. If deletion causes too much churn, leave thin deprecated wrappers with no production callers and remove in a final cleanup task.

- [ ] **Step 7: Run GREEN**

```bash
pnpm test:run lib/optimize/loop.test.ts lib/eval/judge/suite.test.ts > /tmp/optimize-pipeline-loop-green.log 2>&1
```

- [ ] **Step 8: Commit**

```bash
git add lib/optimize/loop.ts lib/optimize/loop.test.ts lib/optimize/types.ts lib/optimize/sampling.ts lib/optimize/verdict.ts lib/optimize/*.test.ts
git commit -m "optimize: compose eval run and judge suite"
```

---

### Task 5: Align optimize artifacts with refactored pipeline

**Files:**
- Modify: `lib/optimize/artifacts.ts`
- Modify: `lib/optimize/artifacts.test.ts`
- Modify: `lib/optimize/loop.ts`

- [ ] **Step 1: Add failing layout tests**

Assert:

```text
runs/optimize/<run-id>/config.json
runs/optimize/<run-id>/targets.json
runs/optimize/<run-id>/iter-0/agent/
runs/optimize/<run-id>/iter-0/workspace/
runs/optimize/<run-id>/iter-0/eval-run/
runs/optimize/<run-id>/iter-1/agent/
runs/optimize/<run-id>/iter-1/workspace/
runs/optimize/<run-id>/iter-1/mutation.json
runs/optimize/<run-id>/iter-1/mutation.md
runs/optimize/<run-id>/iter-1/diff.txt
runs/optimize/<run-id>/iter-1/eval-run/
runs/optimize/<run-id>/iter-1/verdict.json
runs/optimize/<run-id>/champion/agent/
runs/optimize/<run-id>/champion/championIter
runs/optimize/<run-id>/summary.json
```

- [ ] **Step 2: Run RED**

```bash
pnpm test:run lib/optimize/artifacts.test.ts lib/optimize/loop.test.ts > /tmp/optimize-pipeline-artifacts-red.log 2>&1
```

- [ ] **Step 3: Write suite verdicts directly**

`iter-N/verdict.json` should be the `SuiteVerdict` from `eval judge`, with side labels documented as A=champion and B=candidate.

- [ ] **Step 4: Update summary shape**

Summary records accepted/rejected counts, champion iteration, per-iteration eval run dir, verdict path, mutation path, and decision. Do not duplicate judge aggregation math in summary beyond convenient counts copied from `SuiteVerdict`.

- [ ] **Step 5: Run GREEN**

```bash
pnpm test:run lib/optimize/artifacts.test.ts lib/optimize/loop.test.ts > /tmp/optimize-pipeline-artifacts-green.log 2>&1
```

- [ ] **Step 6: Commit**

```bash
git add lib/optimize/artifacts.ts lib/optimize/artifacts.test.ts lib/optimize/loop.ts
git commit -m "optimize: write refactored pipeline artifacts"
```

---

### Task 6: Handle optimize error policy

**Files:**
- Modify: `lib/optimize/loop.ts`
- Modify: `lib/optimize/loop.test.ts`
- Modify: `lib/cli/eval/optimize.ts`
- Modify: `lib/cli/eval/optimize.test.ts`

- [ ] **Step 1: Add failing error-policy tests**

Cover:

- no targets fails before baseline run,
- invalid target value fails before baseline run,
- baseline eval complete failure fails command,
- candidate eval task failures are passed to judge suite and reject unless B wins,
- judge suite per-iteration failure writes `error.txt`, rejects candidate, and continues,
- run directory collision throws before artifacts are written,
- writeback hash mismatch writes artifacts then fails writeback without modifying files.

- [ ] **Step 2: Run RED**

```bash
pnpm test:run lib/optimize/loop.test.ts lib/cli/eval/optimize.test.ts > /tmp/optimize-pipeline-errors-red.log 2>&1
```

- [ ] **Step 3: Implement error handling**

Reject iteration and continue only for per-iteration failures (candidate eval task failure surfaced via `judgeSuite()` result, judge suite call failure). Throw for configuration/setup errors (no targets, invalid target value, run-dir collision, baseline eval fails entirely, writeback hash/target-set mismatch).

For per-iteration failures, write an `iter-N/error.txt` artifact via the existing `OptimizeArtifacts` writer. If no helper exists today, add one in `lib/optimize/artifacts.ts` (with a test) rather than inventing a new free function. Use the helper name that fits the existing artifact API conventions — do not introduce `recordIterationError()` without first confirming the artifact writer's naming style.

- [ ] **Step 4: Run GREEN**

```bash
pnpm test:run lib/optimize/loop.test.ts lib/cli/eval/optimize.test.ts > /tmp/optimize-pipeline-errors-green.log 2>&1
```

- [ ] **Step 5: Commit**

```bash
git add lib/optimize/loop.ts lib/optimize/loop.test.ts lib/cli/eval/optimize.ts lib/cli/eval/optimize.test.ts
git commit -m "optimize: enforce pipeline error policy"
```

---

### Task 7: Update docs and remove obsolete optimize judging knobs

**Files:**
- Modify: `docs/site/cli/eval.md` (the `eval optimize` section)
- Modify: `scripts/agency.ts`
- Modify/Delete: `lib/optimize/sampling.ts`, `lib/optimize/verdict.ts`, tests if not already deleted

Do **not** create or modify `docs/site/cli/optimize.md`. There is no top-level `agency optimize` command — everything lives under `eval optimize`.

- [ ] **Step 1: Grep obsolete terms**

```bash
grep -R "acceptThreshold\|judgeSamples\|rubric\|@optimize\|tagged prompt" -n lib docs scripts stdlib > /tmp/optimize-pipeline-obsolete-grep.log 2>&1 || true
```

- [ ] **Step 2: Update public docs**

Show examples under the `eval optimize` section of `docs/site/cli/eval.md` only:

```bash
agency eval optimize foo.agency --goal "Return Paris with no extra words."
agency eval optimize foo.agency --tasks tasks.json --iterations 5 --samples 3
agency eval optimize foo.agency:main --tasks tasks.json --no-writeback
```

Document artifacts and acceptance rule `suiteVerdict.winner === "B"`. Remove any references to a top-level `agency optimize` command.

- [ ] **Step 3: Remove obsolete optimize-specific judge flags**

Use shared judge flag names: `--samples`, `--confidence-threshold`, `--margin-threshold`. If backwards compatibility is desired, keep old flags hidden/deprecated and normalize them in the CLI adapter; do not keep old names in docs.

- [ ] **Step 4: Run focused tests**

```bash
pnpm test:run lib/cli/eval/optimize.test.ts lib/optimize/loop.test.ts > /tmp/optimize-pipeline-docs-green.log 2>&1
```

- [ ] **Step 5: Commit**

```bash
git add docs/site/cli/eval.md scripts/agency.ts lib/optimize
git commit -m "docs: describe refactored optimize pipeline"
```

---

### Task 8: Keep `stdlib/agency/eval.agency` `optimize()` wrapper in sync with the refactored pipeline

Whenever the CLI surface changes, the stdlib must expose the same functionality so users can build Agency agents that call the optimizer. The declaration-modifier-v2 plan (Task 5) makes the stdlib `optimize()` wrapper adopt the new target-discovery model. **This task layers on the pipeline changes** (judge-suite acceptance, removal of optimize-specific sampling/verdict knobs, judge flag standardization).

**Files:**
- Modify: `stdlib/agency/eval.agency` — `optimize()` parameters
- Modify: `lib/stdlib/agencyEval.ts` (the `_optimize` binding)
- Modify: `lib/stdlib/agencyEval.test.ts`
- Modify: `docs/site/stdlib/agency/eval.md` (regenerated via `agency doc`)

- [ ] **Step 1: Match parameter set to the new CLI**

Remove `acceptThreshold` (now `suiteVerdict.winner === "B"` only — no thresholding at the optimize layer) and `judgeSamples` if it has been renamed (`--samples`). Add equivalents for `--confidence-threshold`, `--margin-threshold` if surfaced by `judgeSuite()`. Keep parameter names aligned with the eval-judge stdlib wrapper so users see consistent vocabulary.

Mirror the CLI's task-selection rule: exactly one of `tasks` or `goal`. `goal` desugars through the same `taskFromGoal()` path the CLI uses (`task_id: "task-1"`); passing both or neither is an error with the same message as the CLI.

- [ ] **Step 2: Update docstring with acceptance rule**

Mention explicitly that a candidate is accepted iff `judgeSuite` returns winner `B`. Update the example to use the `optimize` declaration modifier rather than the legacy `@optimize(prompt)` tag.

- [ ] **Step 3: Update `_optimize` binding**

The TS binding must call the same `optimizeLoop()` core that the CLI uses, so behavior cannot drift. No optimize-layer aggregation in the stdlib wrapper.

- [ ] **Step 4: Run tests and rebuild stdlib**

```bash
pnpm test:run lib/stdlib/agencyEval.test.ts > /tmp/optimize-pipeline-stdlib-green.log 2>&1
make
```

- [ ] **Step 5: Commit**

```bash
git add stdlib/agency/eval.agency lib/stdlib/agencyEval.ts lib/stdlib/agencyEval.test.ts docs/site/stdlib/agency/eval.md
git commit -m "optimize: stdlib optimize() matches refactored pipeline"
```

---

## Verification

- [ ] Run focused optimize pipeline tests:

```bash
pnpm test:run \
  lib/cli/eval/optimize.test.ts \
  lib/optimize/targets.test.ts \
  lib/optimize/sourceMutator.test.ts \
  lib/optimize/artifacts.test.ts \
  lib/optimize/loop.test.ts \
  lib/eval/loadTasks.test.ts \
  lib/eval/judge/suite.test.ts \
  lib/cli/eval/run.test.ts \
  > /tmp/optimize-refactored-eval-pipeline-final.log 2>&1
```

- [ ] If any stdlib files were changed, run `make` because repo guidance requires it for stdlib changes.
- [ ] Do not run the full agency test suite locally.
