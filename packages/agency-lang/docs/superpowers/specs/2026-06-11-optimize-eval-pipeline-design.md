# Optimize on the Refactored Eval Pipeline Design

**Date:** 2026-06-11
**Status:** Draft

## Summary

Refactor `optimize` so it composes the shared eval primitives instead of owning its own judging pipeline.

`optimize` should be the command that mutates agent source. It should use:

- task/goal loading from the eval task model,
- `eval run` core to evaluate baseline and candidates,
- `eval judge` suite aggregation to compare champion vs candidate,
- declaration-target discovery and patching from the optimize declaration modifier design.

The easy-start command should be:

```bash
agency eval optimize foo.agency --goal "Make the agent return the capital of France with no extra words."
```

Advanced users can provide a task suite:

```bash
agency eval optimize foo.agency --tasks tasks.json
```

## Relationship to other specs

This spec depends on:

- `2026-06-11-eval-core-primitives-design.md`
- `2026-06-11-eval-goals-and-judge-suite-design.md`
- `2026-06-10-optimize-declaration-modifier-design.md`
- `2026-06-11-declarative-optimize-mutator-design.md`

The declaration modifier spec owns optimize target syntax and target discovery. This spec owns how optimize presents goals/tasks and composes run/judge primitives, including pipeline artifact layout and writeback timing.

The declarative mutator spec owns source mutation operation schemas, preview/apply behavior, diffs, and target-specific replacement validation. This pipeline spec consumes that API; it should not define a second patching mechanism.

## Command surface

### Easy-start CLI

Provide an eval-namespaced command:

```bash
agency eval optimize <file>[:<node>] --goal <text> [options]
```

This is a convenience surface for first-time users. It defaults to calling `main()` with no args unless a node is supplied in `<file>:<node>`.

If the selected node requires args and none were provided, fail with a helpful message:

```text
Node main requires arguments, but --goal creates a no-argument task.
Use --tasks tasks.json to provide args for this agent.
```

### Advanced CLI

Support task suites:

```bash
agency eval optimize <file>[:<node>] --tasks <file|dir> [options]
```

Task files use `goal`, not `rubric`.

There is no top-level `agency optimize` alias. Keeping one spelling avoids unnecessary command-surface ambiguity.

### Options

Keep optimize-specific options small:

- `--iterations <n>` — candidate iterations.
- `--runs-dir <path>` — optimize run root.
- `--run-id <id>` — run id.
- `--no-writeback` — do not write champion source back.
- `--mutator-model <model>` — model for mutation.

Judge options should mirror `eval judge`, because optimize uses judge:

- `--judge-samples <n>` or a renamed `--samples <n>` if judge standardizes on that flag.
- `--confidence-threshold <n>`.
- `--margin-threshold <n>`.

Do not add optimize-only judging behavior.

## Task and goal handling

`--goal` desugars to one task:

```ts
[
  {
    task_id: "task-1",
    goal: cliGoal,
    args: {},
  },
]
```

The inline `--goal` task ID is deterministic and matches eval run/judge: `task-1`.

`--tasks` loads a suite of `EvalTask` objects:

```ts
type EvalTask = {
  task_id: string;
  goal: string;
  args: Record<string, unknown>;
  node?: string;
  working_dir?: string;
};
```

For single-goal optimize:

```text
mutator goal = task goal = judge goal
```

For suite optimize:

```text
mutator sees suite goals
judge evaluates each task against its task.goal
judgeSuite aggregates task verdicts
```

The mutator prompt should include the suite goals in deterministic task ID order. It should not receive judge-only artifacts such as hidden verdict thresholds except as iteration history.

The task suite is constructed once at optimize startup and reused for baseline runs, every candidate run, and every judge-suite call. Do not regenerate task IDs per iteration.

## Optimize loop composition

The loop is:

```text
discover optimize targets
run baseline task suite
champion := baseline

for each iteration:
  build declarative mutation operations
  preview/apply operations to candidate file set
  run candidate task suite
  judgeSuite(championRun, candidateRun, tasks, policy)
  if suiteVerdict.winner == "B": champion := candidate
  else: keep champion

write champion artifacts
optional writeback
```

Champion is always side A and candidate is always side B when calling judge. The judge suite API owns any A/B order swapping for multi-sample bias control and maps winners back to A/B.

## Artifacts

Optimize artifacts should remain under an optimize run directory, but per-iteration evaluation should use the same run artifacts as `eval run` and verdict artifacts as `eval judge`.

Suggested layout:

```text
runs/optimize/<run-id>/
  config.json
  targets.json
  iter-0/
    agent/
    eval-run/
    summary.json
  iter-1/
    agent/
    mutation.json
    mutation.md
    diff.patch
    eval-run/
    verdict.json
  champion/
    agent/
    championIter
  summary.json
```

`verdict.json` is a `SuiteVerdict` from eval judge with side labels interpreted as:

- A = current champion
- B = candidate

The optimize summary records accepted/rejected counts and links to each iteration's eval run and verdict artifacts.

## Acceptance rule

Optimize does not implement its own aggregation. It accepts a candidate only when judge suite says B wins:

```ts
if (suiteVerdict.winner === "B") acceptCandidate();
else rejectCandidate();
```

All thresholding, confidence handling, sample aggregation, and tie behavior belongs to eval judge.

## Run directory collision

Optimize run directory collision should match eval run: if `runs/optimize/<run-id>` exists, throw and stop.

No silent overwrite. No automatic cleanup. `--overwrite` and `--resume` are future features.

## Mutator responsibilities

The mutator changes source. Run and judge do not.

For declaration-modifier optimize, the mutator receives:

- overall optimize intent derived from the single goal or suite goals,
- current optimize targets and values,
- recent iteration history including judge suite verdict summaries.

It returns a target-level mutation proposal. Source application remains declarative as described in the declarative mutator design:

```text
mutator changes
  → buildOptimizeMutationPlan()
  → sourceMutator.preview()
  → sourceMutator.apply()
```

This keeps source mutation separate from evaluation and judging.

## Error handling

- No optimize targets: fail before baseline run.
- Invalid optimize target value: fail before baseline run.
- Baseline eval run fails completely: fail command.
- Candidate eval run has task failures: judge suite handles missing/failed task records according to eval judge failure semantics; optimize records the verdict and likely rejects unless B wins.
- Judge suite failure: record iteration `error.txt`, reject candidate, continue if the failure is per-iteration rather than a configuration error.
- Writeback hash mismatch: write all artifacts, then fail writeback without modifying any source files.

## Non-goals

- Optimize-specific judge sampling or aggregation.
- Clean-worktree/sandbox isolation.
- General AST editing beyond declarative optimize mutation operations.
- Non-string optimize domains.
- Exported or nested optimize declarations unless the declaration modifier spec changes.

## Testing

- `agency eval optimize foo.agency --goal ...` creates a one-task suite and runs baseline/candidate.
- `agency eval optimize foo.agency --tasks tasks.json` uses task goals in judge suite.
- Optimize calls judge suite with A = champion, B = candidate.
- Multi-sample judge behavior is tested in eval judge tests, not optimize tests, except for verifying options are passed through.
- Candidate acceptance depends only on `suiteVerdict.winner === "B"`.
- Optimize run directory collision throws.
- No top-level `agency optimize` command is registered.
