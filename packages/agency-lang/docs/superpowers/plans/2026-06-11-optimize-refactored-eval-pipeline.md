# Optimize Refactored Eval Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `agency eval optimize <file>[:<node>]` compose shared eval run, eval judge suite, and declaration-target patching instead of owning its own judging pipeline.

**Command surface decision:** We are **not** adding a new top-level `agency optimize` command and we are **not** keeping the legacy top-level `agency optimize` command as an alias. The only supported entrypoint is `agency eval optimize`. Having two names for the same command is unnecessarily confusing. Any reference in this plan to a top-level `agency optimize` is a historical artifact from an earlier draft and should be ignored — the legacy top-level command is removed in the declaration-modifier-v2 plan (Task 8), and this plan must not re-add it.

**Architecture:** Treat optimize as source mutation orchestration only: discover declaration targets, run a baseline eval suite, iterate mutator patch plans, evaluate candidates with `evalRunLoadedTasks()`, judge champion-vs-candidate with `judgeSuite()`, accept only `winner === "B"`, write optimize artifacts, and optionally write back the champion file set.

**Tech Stack:** TypeScript, Commander CLI, Vitest, `lib/eval/loadTasks.ts`, `lib/cli/eval/run.ts`, `lib/eval/judge/suite.ts`, `lib/optimize/targets.ts`, `lib/optimize/patch.ts`, `lib/optimize/artifacts.ts`.

---

## Source spec

Spec: `docs/superpowers/specs/2026-06-11-optimize-eval-pipeline-design.md`

Prerequisites:

- `docs/superpowers/plans/2026-06-11-eval-core-primitives.md`
- `docs/superpowers/plans/2026-06-11-eval-goals-tasks-judge-suite.md`
- `docs/superpowers/plans/2026-06-11-optimize-declaration-modifier-v2.md`

## File structure

### Modify

- `scripts/agency.ts`
  - The only optimize entrypoint is `agency eval optimize <file>[:<node>]`.
  - Replace required `--agent` option with positional `<agent>` argument.
  - Do **not** add a top-level `agency optimize` command. The legacy top-level command is deleted in the declaration-modifier-v2 plan (Task 8).
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
  - Accept only when `suiteVerdict.winner === "B"`.
- `lib/optimize/loop.test.ts`
  - Tests for task reuse, A/B side mapping, acceptance rule, candidate failures, judge failures, and summary counts.
- `lib/optimize/artifacts.ts`
  - Ensure layout has `runs/optimize/<run-id>/iter-N/agent/`, `eval-run/`, `verdict.json`, `champion/agent/`, and `summary.json`.
- `lib/optimize/artifacts.test.ts`
  - Layout and collision tests.
- `docs/site/cli/eval.md`
  - Document eval optimize alias.
- `docs/site/cli/optimize.md`
  - Document primary top-level optimize command and declaration modifier examples.

## Implementation notes

- `--goal` desugars once at startup to `task_id: "task-1"`; reuse the same task array for baseline, candidates, and judge calls.
- If selected node requires args and `--goal` creates no args, fail before baseline run with the exact helpful message from the spec.
- Optimize run directory collision matches eval run: throw and stop; no overwrite/resume.
- Champion is side A; candidate is side B. `judgeSuite()` owns position-bias swapping internally.
- Do not keep optimize-specific `judgeSamples`, `acceptThreshold`, `buildOptimizeVerdict`, or sampling code after migration unless compatibility tests require temporary wrappers.
- Candidate eval task failures should be visible to `judgeSuite()` through missing/failed task statuses. Reject unless suite winner is B.

---

### Task 1: Update `agency eval optimize` CLI surface (positional `<agent>`, judge flags)

**Files:**
- Modify: `scripts/agency.ts`
- Modify: `lib/cli/eval/optimize.ts`
- Modify: `lib/cli/eval/optimize.test.ts`

**Prerequisite:** The legacy top-level `agency optimize` command and `lib/cli/optimize.ts` are deleted in the declaration-modifier-v2 plan (Task 8). Do not re-add them here. The only optimize entrypoint after this work is `agency eval optimize`.

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

### Task 3: Compose optimize loop with eval run and judge suite

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

Call `evalRunLoadedTasks({ agent: materializedEntryFile, tasks, tasksSource: "optimize:tasks", runsDir: iterEvalRunDir, runId: "eval-run", continueOnError: true, config })` or the artifact convention chosen in the declaration modifier plan. Ensure output ends up under `iter-N/eval-run/`.

Before implementing, verify the exact export name in `lib/cli/eval/run.ts` — if only `evalRun()` exists today, either extract a tasks-already-loaded entrypoint as a small refactor here, or call `evalRun()` with the loaded tasks injected via the existing `deps`. Do not silently invent a function name that the prerequisite plan never created.

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

### Task 4: Align optimize artifacts with refactored pipeline

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
runs/optimize/<run-id>/iter-0/eval-run/
runs/optimize/<run-id>/iter-1/agent/
runs/optimize/<run-id>/iter-1/mutation.json
runs/optimize/<run-id>/iter-1/mutation.md
runs/optimize/<run-id>/iter-1/diff.patch
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

### Task 5: Handle optimize error policy

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

### Task 6: Update docs and remove obsolete optimize judging knobs

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

### Task 7: Keep `stdlib/agency/eval.agency` `optimize()` wrapper in sync with the refactored pipeline

Whenever the CLI surface changes, the stdlib must expose the same functionality so users can build Agency agents that call the optimizer. The declaration-modifier-v2 plan (Task 9) makes the stdlib `optimize()` wrapper adopt the new target-discovery model. **This task layers on the pipeline changes** (judge-suite acceptance, removal of optimize-specific sampling/verdict knobs, judge flag standardization).

**Files:**
- Modify: `stdlib/agency/eval.agency` — `optimize()` parameters
- Modify: `lib/stdlib/agencyEval.ts` (the `_optimize` binding)
- Modify: `lib/stdlib/agencyEval.test.ts`
- Modify: `docs/site/stdlib/agency/eval.md` (regenerated via `agency doc`)

- [ ] **Step 1: Match parameter set to the new CLI**

Remove `acceptThreshold` (now `suiteVerdict.winner === "B"` only — no thresholding at the optimize layer) and `judgeSamples` if it has been renamed (`--samples`). Add equivalents for `--confidence-threshold`, `--margin-threshold` if surfaced by `judgeSuite()`. Keep parameter names aligned with the eval-judge stdlib wrapper so users see consistent vocabulary.

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
  lib/optimize/patch.test.ts \
  lib/optimize/artifacts.test.ts \
  lib/optimize/loop.test.ts \
  lib/eval/loadTasks.test.ts \
  lib/eval/judge/suite.test.ts \
  lib/cli/eval/run.test.ts \
  > /tmp/optimize-refactored-eval-pipeline-final.log 2>&1
```

- [ ] If any stdlib files were changed, run `make` because repo guidance requires it for stdlib changes.
- [ ] Do not run the full agency test suite locally.
