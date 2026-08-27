# Writing an optimizer

An optimizer searches for better values of the `optimize`-marked declarations in an agent. `greedy` (the default), `gepa`, and `example` all extend one base class, `BaseOptimizer` (`lib/optimize/baseOptimizer.ts`), and the `--optimizer` flag selects among them through a registry. This guide shows how to write your own.

For the user-facing command (`agency optimize`), see `docs/site/cli/optimize.md`. The smallest working optimizer is `lib/optimize/optimizers/example.ts` — copy it.

## How optimizing works, end to end

Optimizing is a search over the text of your marked declarations. One iteration looks like this:

1. **Propose.** A model is shown the current target values and some feedback, and returns declarative edit operations.
2. **Preview.** Those operations are applied to the sources captured at discovery time, producing a candidate: a complete `{ relative path: source }` map. Nothing is written to your project.
3. **Evaluate.** The candidate's file map is overlaid onto a fresh copy of the project, compiled, and run once per input. Each run is graded, giving a `Scorecard`.
4. **Compare.** The candidate's objective is compared against the champion's. Better means accepted.

Every candidate is scored to a single number between 0 and 1. There is no pairwise "which of these two is better" comparison anywhere in the optimizer — that path was removed. If you want relative judging, write a grader that produces a scalar.

## The contract

An optimizer is a class that:

1. extends `BaseOptimizer`,
2. has a `readonly name`,
3. implements `optimizeTargets(source, inputs)`, and
4. is made available to `--optimizer` (registry **or** a path module — see [Registering and using it](#registering-and-using-it)).

```ts
import { BaseOptimizer } from "../baseOptimizer.js";
import type { Test } from "@/eval/grading/types.js";
import type { OptimizeTargetSet } from "../targets.js";
import type { OptimizeResult } from "../types.js";

export class MyOptimizer extends BaseOptimizer {
  readonly name = "mine";
  protected async optimizeTargets(source: OptimizeTargetSet, inputs: Test[]): Promise<OptimizeResult> {
    // ... search, return the best candidate as an OptimizeResult
  }
}
```

(In an **out-of-repo** module, import these from the package, not relative paths: `import { BaseOptimizer, type Test, type OptimizeTargetSet, type OptimizeResult } from "agency-lang/optimize"`.)

## What the base class does before you run

`BaseOptimizer.optimize(target)` runs a fixed preamble, then calls your `optimizeTargets`:

1. resolves the agent file and **discovers the `optimize` targets** (parsing the entry file and its local `.agency` imports) into an `OptimizeTargetSet`; throws if none are marked.
2. stores any held-out validation set on `this.validationInputs` (empty array if none).
3. **echoes the resolved grading setup** and **fail-fast validates** the graders with `grader.validateInput`, so a misconfigured grader aborts before any agent runs. An override set is checked against the first input. In snapshot mode each input's own grading module is loaded once and checked against its own test. Validation inputs are checked too, because champion selection grades them.

So inside `optimizeTargets` you already have a discovered `source` and the run `inputs`; your job is the search.

## The data you work with

- **`OptimizeTargetSet`** (`targets.ts`): `{ baseDir, entryFile, files, targets, typeAliases }`. `files` maps each relative path to its source and discovery-time sha256; `targets` is the list of discovered `optimize` declarations (`{ id, kind, name, value, valueKind, declaredType, … }`); `typeAliases` is the closure's type registry, used to typecheck proposed values. `fileMap(source)` returns just the `{ relpath: source }` map.
- **A candidate is a file map.** Everywhere below, `files: Record<string, string>` means a complete relpath→source map for the whole discovered closure, not a diff. `defaultPreview` produces one; you pass it to `evaluate`/`scoreFiles` and it becomes the overlay applied on top of a fresh project copy before compiling.
- **`Test`** (`@/eval/runTypes.ts`): one agent invocation. Its fields are `{ id?, description?, tags?, input?, goal?, expected?, files?, … }`. `input` is a string or a JSON object, delivered as the entry node's single positional parameter. The optimizer code calls these values `inputs`, but the type is `Test`, re-exported from `@/eval/grading/types.js`.
- **`Scorecard`** (`@/eval/grading/scorecard.ts`): the result of grading a candidate. See [Grading semantics](#grading-semantics-you-should-know).
- **`OptimizeResult`** (`lib/optimize/types.ts`): what you return — champion iteration + files, decision counts, per-iteration records, objectives, and the champion breakdown. `finishPointwise` builds it for you.

## Protected helpers

These are the building blocks every optimizer composes (`this.` on `BaseOptimizer`):

| Helper | What it does |
| --- | --- |
| `scoreFiles(source, files, inputs)` | The one you want most of the time. Allocates a fresh cache partition and grades `files` on `inputs` → `Scorecard`. |
| `fork()` | Mint a fresh `CachePartition` — a cache-partition token (`{ key }`), nothing on disk. Use it when you want to grade the *same* candidate against several input sets and share cached runs between them (GEPA does this: minibatch first, then the full set). |
| `evaluate(ws, source, files, inputs)` | Grade `files` on `inputs` inside an existing workspace `ws`. Runs are cached by `(ws.key, inputId)`, so re-evaluating a candidate you already scored on an input is free. |

A candidate that crashes the agent on an input is scored, not fatal: `runInputViaEval` notes the error through the reporter and returns the run directory, whose `run` row says the run ended in error, and `gradeRun` scores that 0 without calling any grader. A search that ends on the first bad candidate would never learn from it.
| `proposeValidMutation(propose, preview, maxAttempts?)` | Ask for a mutation and validate it, with bounded retries (3 by default). Never throws on a malformed LLM response and feeds validation diagnostics back into the next attempt. Returns `{ ok: true, preview, rationale }` or `{ ok: false, rationale, diagnostics }`. |
| `finishPointwise(source, candidates, trainChampion, attempts, startedAt)` | The shared tail. Picks the writeback champion (by validation when configured), writes it back if `config.writeback`, assembles the `OptimizeResult` with train/baseline/validation objectives and the champion breakdown, and fires `runFinished`. |
| `pickValidationChampion(source, candidates, trainChampion)` | Just the champion selection, if you need it without the rest of `finishPointwise`. |
| `requireBaselineGatesPass(scorecard)` | Throw a clear error if the baseline fails a `mustPass` gate (the program or suite is broken — don't optimize). |
| `isMaxObjective(scorecard)` | `objective() >= 1` — nothing left to improve; stop or skip the loop. |
| `buildPointwiseResult({ championIter, championFiles, attempts })` | Lower-level result assembly. `finishPointwise` calls it; you rarely need it directly. |
| `eachIteration(step)` | `for iter in 1..config.iterations`, awaiting each `step(iter)`. |
| `reporter` | A `PointwiseReporter` for progress (silent unless the CLI sets verbosity). |
| `config.graders` | The objective, as a `GraderSource`. `snapshot` (the CLI default): each input is graded by the graders its run directory stored — the suite test's own `graders.ts` and harness pairs, the goal judge for tests with neither. The grader files are read from the suite as candidate runs happen, so the same rule applies as to `eval run`: do not edit the suite while a search is running. `override` (an explicit `--graders` module): one set for every input. |
| `config` | `BaseOptimizerConfig`: `graders`, `iterations`, `seed`, `runId`, `runsDir`, `writeback`, `mutatorModel`, `verbosity`, `config` (the `AgencyConfig`). |
| `validationInputs` | Held-out inputs (empty if none). See [Validation](#validation). |
| `workspace.writeBack(source, files)` | Write a file set back to the real sources, sha-checked. `finishPointwise` already does this — only call it directly if you are not using `finishPointwise`. |

`CachePartition` (`lib/optimize/workspace.ts`) is **not** a directory. It is just `{ key: string }`, a cache-partition token. The real isolation happens per input: `evaluate` hands your `files` map to `runSuite`, which seeds the agent's import closure into `runs/<runId>/…/workdir/`, overlays those files, compiles, and runs there. You never write to disk yourself.

## The shape: score → propose → score → compare → finish

Here is the whole `example` optimizer — a single round. Real optimizers loop and search more cleverly, but they all follow this shape.

```ts
protected async optimizeTargets(source: OptimizeTargetSet, inputs: Test[]): Promise<OptimizeResult> {
  const startedAt = Date.now();
  this.reporter.runStarted({
    optimizer: this.name, runId: this.config.runId,
    targets: source.targets, inputCount: inputs.length, iterations: 1,
  });

  // 1. Score the unchanged agent.
  const baseline = await this.makeCandidate("baseline", fileMap(source), source, inputs);
  this.reporter.baselineScored({ objective: baseline.scorecard.gatedObjective() });

  // 2. Ask the built-in mutator for one new set of target values. proposeValidMutation
  //    retries on validation errors and never throws on a bad response.
  const outcome = await this.proposeValidMutation(
    (diagnostics) => proposeMutation({
      config: this.config.config, targets: source.targets, inputs,
      history: "", model: this.config.mutatorModel, diagnostics,
    }),
    (operations) => defaultPreview(source, operations),
  );

  // 3. Score the proposal (if any) and decide acceptance on the training objective.
  const candidate = outcome.ok
    ? await this.makeCandidate(1, outcome.preview.files, outcome.preview.targetSet, inputs)
    : undefined;
  const beatsBaseline = candidate !== undefined
    && candidate.scorecard.gatedObjective() > baseline.scorecard.gatedObjective();
  const trainChampion = beatsBaseline ? candidate : baseline;
  const decision = beatsBaseline ? "accepted" : "rejected";

  this.reporter.iterationDecided({
    iter: 1, total: 1, decision, objective: trainChampion.scorecard.gatedObjective(),
    ...(beatsBaseline && outcome.ok
      ? { changes: outcome.preview.changes, rationale: outcome.rationale }
      : {}),
  });

  // 4. Pick the writeback champion, write it back, build the result, report.
  const candidates = beatsBaseline ? [baseline, candidate] : [baseline];
  return this.finishPointwise(source, candidates, trainChampion, [{ iter: 1, decision }], startedAt);
}

/** Grade one candidate file set. */
private async makeCandidate(
  iter: number | "baseline", files: Record<string, string>,
  targetSet: OptimizeTargetSet, inputs: Test[],
): Promise<Candidate> {
  const scorecard = await this.scoreFiles(targetSet, files, inputs);
  return { iter, files, scorecard, targetSet };
}
```

Note the `targetSet` carried on each candidate. It reflects *that candidate's* target values (`outcome.preview.targetSet` for a mutation), so the final report can show what each variable started and ended as.

## Proposing mutations

A mutation is proposed by a model and applied to the source. There are two proposer front-ends, both returning a `MutationProposal` (`{ operations, rationale }`):

- **`proposeMutation`** (`lib/optimize/mutator.ts`) is the greedy and example proposer. It renders TARGETS, GOALS, per-input FEEDBACK, and HISTORY into `lib/agents/optimize/mutatePrompt.agency`.
- **`proposeReflective`** (`lib/optimize/gepaReflect.ts`) is GEPA's reflective proposer, backed by `lib/agents/optimize/gepaReflect.agency`. It renders TARGETS, GOALS, the minibatch's FEEDBACK, and HISTORY (validation errors from a rejected attempt).

You hand `proposeValidMutation` two callbacks:

1. **propose(diagnostics)** → call a proposer. `diagnostics` is empty on the first attempt and carries the previous attempt's validation errors on retries, so the model can self-correct.
2. **preview(operations)** → turn the proposed operations into an `OptimizeMutationPreview` (`{ files, changes, diff, diagnostics, targetSet }`). Use `defaultPreview(targetSet, operations)`. If `preview.diagnostics` is non-empty the proposal is invalid and gets retried.

`proposeValidMutation` returns `{ ok: true, preview, rationale }` once a clean preview is produced, or `{ ok: false, … }` after `maxAttempts`. Treat `ok: false` as a `validation-failed` iteration — never let it abort the run.

## Reflection feedback

To let a custom grader (or labeled `expected` outputs) steer the search, feed the proposer per-input feedback rendered from a candidate's `Scorecard`:

```ts
import { renderReflectionFeedback } from "../reflectionFeedback.js";
// ...
feedback: renderReflectionFeedback(champion.scorecard.perInput),
```

This renders, per input, the args, the **output**, the **`expected`** answer (when set), and each grader's **score + `feedback`**. `proposeMutation` accepts it as its `feedback` field; GEPA already builds it. This is what lets the optimizer learn "the output gave the area, not the capital New Delhi" without a separate `--goal`.

It also renders what **people** said about the run, when the run directory carries any: the run's `notes.md` and every checklist sign-off note ("Notes from people who reviewed this run:") and the text of every checklist question a reviewer answered no ("Checklist questions reviewers answered NO:"). Both come from `humanFeedbackFor(snapshot, traceId)` (`lib/runDirectory/humanFeedback.ts`), which also returns the questions answered yes (`checked`) for consumers that want to say what a run did right; reflection uses only `unchecked`. `gradeRun` attaches the result to each `InputGrades.humanFeedback`, so an optimizer gets it for free by grading a run directory. To make use of it, run the candidate once, write `notes.md` in its run directory (or `agency label` it), and re-grade: the next proposal sees the notes.

## Grading semantics you should know

`evaluate`/`scoreFiles` return a `Scorecard`; how it turns grades into a number matters for your accept/reject logic.

| Method | What it gives you |
| --- | --- |
| `objective()` | The raw weighted mean across inputs of each input's weighted-mean grade. A **scalar** grade contributes its value; a **binary** grade contributes `1.0`/`0.0`, so a binary-only grader yields accuracy. |
| `gatesPassed()` | True when every `mustPass` grader passed on every input. |
| `gatedObjective()` | **The number to compare candidates on**: `objective()` when gates pass, `0` otherwise. |
| `inputScores()` | Per-input objectives (a gate-failed input scores 0). GEPA's Pareto pool uses this. |
| `perInput` | The full per-input grades. Feed it to `renderReflectionFeedback`. |

Prefer `gatedObjective()` over hand-writing `s.gatesPassed() ? s.objective() : 0`. It exists so that a gate-failing candidate with a high raw score can never appear to beat a gate-passing one. (`greedy` and `gepa` still spell out the long form in their accept checks — both carry a `TODO(gated-objective)` to collapse together. New optimizers should just use `gatedObjective()`.)

`mustPass` is an orthogonal gate: it does not change how a grade contributes to the mean, it zeroes the whole input and trips `gatesPassed()`.

## Validation

`this.validationInputs` is the held-out set (empty if none). Search on `inputs`, then hand every candidate you'd consider shipping to `finishPointwise`, which selects among them by validation score:

```ts
return this.finishPointwise(source, [baseline, ...accepted], trainChampion, attempts, startedAt);
```

With no validation set it returns `trainChampion` unchanged. With one, it scores each candidate via `scoreFiles(source, files, this.validationInputs)` and picks the best, recording `result.validationObjective`.

If your optimizer deliberately ignores validation, it just won't set `validationObjective`, and the generated report notes that a validation set was provided but unused — so the behavior isn't silently dropped.

## Reporting and the result

Emit progress through `this.reporter` (the CLI renders it; tests capture it):

`runStarted` → `baselineScored` → per iteration `iterationDecided` (and `note(message)` for free-form detail like which parent GEPA sampled) → `runFinished`. The base class calls `gradingSetup` for you, and `finishPointwise` calls `runFinished` for you.

`finishPointwise` also sets `trainObjective`, `baselineObjective` (from whichever candidate has `iter === "baseline"`), `validationObjective`, and `championBreakdown` — the per-input reward-hacking lens that shows up in `report.md` and `champion/grades.json`. You do not need to set any of these yourself.

## Registering and using it

Two ways to make `--optimizer` resolve to your class:

**A. A path module (no repo changes).** Default-export a factory `(config) => Optimizer` and point `--optimizer` at the file:

```ts
// myOptimizer.ts
import { BaseOptimizer, type BaseOptimizerConfig, type Test, type OptimizeResult, type OptimizeTargetSet } from "agency-lang/optimize";

class MyOptimizer extends BaseOptimizer {
  readonly name = "mine";
  protected async optimizeTargets(source: OptimizeTargetSet, inputs: Test[]): Promise<OptimizeResult> { /* … */ }
}

export default (config: BaseOptimizerConfig) => new MyOptimizer(config);
```
```bash
agency optimize foo.agency --suite inputs.json --optimizer ./myOptimizer.ts
```

`--optimizer` treats a value with a `/` or a `.ts`/`.js`/`.mjs` extension as a path: it's loaded with esbuild + `import()` (same as a grading module), the default-exported factory is called with the run config, and the result is used **structurally** as an `Optimizer` (`{ name, optimize }`) — no `instanceof`, so it works even across realms. This is the path for users who don't fork the repo. You can also set it as `eval.optimize.optimizer` in `agency.json` (`lib/config.ts`).

**B. A built-in name (in-repo).** Register it so a bare `--optimizer <name>` resolves it:

```ts
// lib/optimize/registry.ts
registerOptimizer("mine", (config) => new MyOptimizer(config));
```

Config that only your optimizer needs rides on `BaseOptimizerConfig` and gets cast in the factory — see how `gepa` takes `minibatch`.

## Testing

`BaseOptimizer`'s constructor takes a `deps` object of seams so you can unit-test without an LLM, real subprocess runs, or file edits:

| Seam | Replaces |
| --- | --- |
| `discover` | Target discovery — return a fixed `OptimizeTargetSet` instead of parsing a file. |
| `runInput` | Running the agent — return the run DIRECTORY it wrote (one trace). Grading reads that directory like any other run directory ([run-directory.md](run-directory.md)), so it must carry a real statelog and a `run` row; `fakeRun` in `lib/optimize/testUtils.ts` builds one. |
| `reporter` | Progress output — capture emitted events. |
| `agencyRunner` | Running judge/proposer `.agency` files. |
| `cache` | The per-`(workspace, input)` run cache. |

Your own optimizer should add its own `propose` / `preview` seams the way `example`, `greedy`, and `gepa` do, so a test can hand it a fixed proposal.

See `lib/optimize/optimizers/greedyReflective.test.ts` and `baseOptimizer.test.ts` for the patterns (fake source, fake `runInput`, injected `propose`, asserting accept/reject counts and that feedback reaches the proposer).

## Checklist

- [ ] Extend `BaseOptimizer`, set `name`, implement `optimizeTargets`.
- [ ] Use `scoreFiles`/`evaluate` to grade; `proposeValidMutation` to mutate.
- [ ] Compare candidates on `gatedObjective()`, not raw `objective()`.
- [ ] End with `finishPointwise` so writeback, validation selection, objectives, and the breakdown are handled consistently.
- [ ] Emit `runStarted` / `baselineScored` / `iterationDecided` through `this.reporter`.
- [ ] Make it resolvable: a path module (`export default (config) => new …`) used via `--optimizer ./file.ts`, or `registerOptimizer(...)` in `registry.ts`.
- [ ] Add a test with injected `deps` (no live LLM).
