# Writing an optimizer

An optimizer searches for better values of the `optimize`-marked declarations in an agent. `greedy` (the default), `gepa`, and `example` all extend one base class — `BaseOptimizer` (`lib/optimize/baseOptimizer.ts`) — and are selected by the `--optimizer` flag via a registry. This guide shows how to write your own.

For the user-facing command, see `docs/site/cli/optimize.md`. The smallest working optimizer is `lib/optimize/optimizers/example.ts` — copy it.

## The contract

An optimizer is a class that:

1. extends `BaseOptimizer`,
2. has a `readonly name`,
3. implements `optimizeTargets(source, inputs)`, and
4. is made available to `--optimizer` (registry **or** a path module — see [Registering and using it](#registering-and-using-it)).

```ts
import { BaseOptimizer } from "../baseOptimizer.js";
import type { Input } from "../grading/types.js";
import type { OptimizeTargetSet } from "../targets.js";
import type { OptimizeResult } from "../types.js";

export class MyOptimizer extends BaseOptimizer {
  readonly name = "mine";
  protected async optimizeTargets(source: OptimizeTargetSet, inputs: Input[]): Promise<OptimizeResult> {
    // ... search, return the best candidate as an OptimizeResult
  }
}
```

(In an **out-of-repo** module, import these from the package, not relative paths: `import { BaseOptimizer, type Input, type OptimizeTargetSet, type OptimizeResult } from "agency-lang/optimize"`.)

## What the base class does before you run

`BaseOptimizer.optimize(target)` runs a fixed preamble, then calls your `optimizeTargets`:

1. resolves the agent file and **discovers the `optimize` targets** (parsing the entry file and its local `.agency` imports) into an `OptimizeTargetSet`; throws if none are marked.
2. stores any held-out validation set on `this.validationInputs` (empty array if none).
3. **echoes the resolved grading setup** and **fail-fast validates** each grader against the first input (`grader.validateInput`), so a misconfigured grader aborts before any agent runs.

So inside `optimizeTargets` you already have a discovered `source` and the run `inputs`; your job is the search.

## The data you work with

- **`OptimizeTargetSet`** (`targets.ts`): `{ baseDir, entryFile, files, targets }`. `files` maps each relative path to its source; `targets` is the list of discovered `optimize` declarations (`{ id, kind, name, value, … }`). `fileMap(source)` returns the current `{ relpath: source }` map.
- **`Input`** (`@/eval/runTypes.ts`): one agent invocation — `{ id?, args, node?, goal?, expected?, metadata? }`.
- **`Scorecard`** (`grading/scorecard.ts`): the result of grading a candidate. `objective()` (0..1, weighted mean across inputs), `gatesPassed()` (all `mustPass` gates held), `inputScores()`, and `perInput` (per-input grades, used for reflection feedback).
- **`OptimizeResult`** (`types.ts`): what you return — champion iteration + files, decision counts, per-iteration records, objectives, and the champion breakdown. Build it with `buildPointwiseResult` (below).

## Protected helpers

These are the building blocks every optimizer composes (`this.` on `BaseOptimizer`):

| Helper | What it does |
| --- | --- |
| `fork(dir)` | Copy a directory into a fresh isolated `Workspace`. Fork from `source.baseDir` for a clean candidate, or from another workspace's `.dir` to build on it. |
| `workspace.applyFiles(ws, files)` | Write a candidate's `{ relpath: source }` into a forked workspace. |
| `evaluate(ws, entryFile, inputs)` | Run the agent once per input (cached) and grade each → `Scorecard`. |
| `scoreFiles(source, files, inputs)` | The common shortcut: `fork(source.baseDir)` + `applyFiles` + `evaluate`. Use it for fresh candidates and for validation scoring. |
| `proposeValidMutation(propose, preview, maxAttempts?)` | Ask for a mutation and validate it, with bounded retries. Never throws on a malformed LLM response and feeds validation diagnostics back into the next attempt. Returns `{ ok: true, preview, rationale }` or `{ ok: false, rationale, diagnostics }`. |
| `requireBaselineGatesPass(scorecard)` | Throw a clear error if the baseline fails a `mustPass` gate (the program/suite is broken — don't optimize). |
| `isMaxObjective(scorecard)` | `objective() >= 1` — nothing left to improve; stop/skip. |
| `buildPointwiseResult({ championIter, championFiles, attempts })` | Package the `OptimizeResult` (decision counts derived from `attempts`). |
| `reporter` | A `PointwiseReporter` for progress (silent unless the CLI sets verbosity). |
| `config` | `BaseOptimizerConfig`: `graders`, `iterations`, `seed`, `runId`, `writeback`, `mutatorModel`, `config` (the `AgencyConfig`), … |
| `validationInputs` | Held-out inputs (empty if none). See [Validation](#validation). |

## The shape: fork → apply → evaluate → compare → report → return

Here is the entire `example` optimizer — a single round. Real optimizers loop and search more cleverly, but they all follow this shape.

```ts
protected async optimizeTargets(source: OptimizeTargetSet, inputs: Input[]): Promise<OptimizeResult> {
  const startedAt = Date.now();
  this.reporter.runStarted({ optimizer: this.name, runId: this.config.runId, targets: source.targets, inputCount: inputs.length, iterations: 1 });

  // 1. Score the unchanged agent.
  const baseline = await this.score(source, fileMap(source), inputs);
  this.reporter.baselineScored({ objective: baseline });

  // 2. Ask the mutator for one new set of target values.
  //    proposeValidMutation retries on validation errors and never throws on a bad response.
  const outcome = await this.proposeValidMutation(
    (diagnostics) => proposeMutation({ config: this.config.config, targets: source.targets, inputs, history: "", model: this.config.mutatorModel, diagnostics }),
    (operations) => defaultPreview(source, operations),
  );

  // 3. If valid, score it and keep it only if it beats the baseline.
  if (outcome.ok) {
    const candidate = await this.score(source, outcome.preview.files, inputs);
    if (candidate > baseline) {
      if (this.config.writeback) this.workspace.writeBack(source, outcome.preview.files);
      this.reporter.iterationDecided({ iter: 1, total: 1, decision: "accepted", objective: candidate, changes: outcome.preview.changes, rationale: outcome.rationale });
      return this.result(source, 1, outcome.preview.files, "accepted", startedAt);
    }
  }
  // 4. Otherwise keep the original.
  this.reporter.iterationDecided({ iter: 1, total: 1, decision: "rejected", objective: baseline });
  return this.result(source, "baseline", fileMap(source), "rejected", startedAt);
}

/** Fork + apply + grade; gate-aware objective (0 if a gate fails). */
private async score(source: OptimizeTargetSet, files: Record<string, string>, inputs: Input[]): Promise<number> {
  const sc = await this.scoreFiles(source, files, inputs);
  return sc.gatesPassed() ? sc.objective() : 0;
}
```

## Proposing mutations

A mutation is proposed by a model and applied to the source. There are two proposer front-ends, both returning a `MutationProposal` (`{ operations, rationale }`):

- **`proposeMutation`** (`mutator.ts`) — the greedy/example proposer. Renders TARGETS, GOALS, per-input FEEDBACK, and HISTORY into `mutatePrompt.agency`.
- **`proposeReflective`** (`gepaReflect.ts`) — GEPA's reflective proposer (`gepaReflect.agency`).

You hand `proposeValidMutation` two callbacks:

1. **propose(diagnostics)** → call a proposer. `diagnostics` is empty on the first attempt and carries the previous attempt's validation errors on retries, so the model can self-correct.
2. **preview(operations)** → turn the proposed operations into an `OptimizeMutationPreview` (`{ files, changes, diff, diagnostics, targetSet }`). Use `defaultPreview(source, operations)`. If `preview.diagnostics` is non-empty the proposal is invalid and gets retried.

`proposeValidMutation` returns `{ ok: true, preview, rationale }` once a clean preview is produced, or `{ ok: false, … }` after `maxAttempts`. Treat `ok: false` as a `validation-failed` iteration — never let it abort the run.

## Reflection feedback

To let a custom grader (or labeled `expected` outputs) steer the search, feed the proposer per-input feedback rendered from a candidate's `Scorecard`:

```ts
import { renderReflectionFeedback } from "../reflectionFeedback.js";
// ...
feedback: renderReflectionFeedback(champion.scorecard.perInput),
```

This renders, per input, the args, the **output**, the **`expected`** answer (when set), and each grader's **score + `feedback`**. `proposeMutation` accepts it as its `feedback` field; GEPA already builds it. This is what lets the optimizer learn "the output gave the area, not the capital New Delhi" without a separate `--goal`.

## Grading semantics you should know

`evaluate`/`scoreFiles` return a `Scorecard`; how it turns grades into a number matters for your accept/reject logic:

- `objective()` is the weighted mean across inputs of each input's weighted-mean grade. A **scalar** grade contributes its value; a **binary** grade contributes `1.0`/`0.0`. So a binary-only grader yields accuracy.
- `mustPass` is an orthogonal gate: a failed `mustPass` grader makes that input score 0 and `gatesPassed()` false. Most optimizers treat "gates pass AND objective improved" as acceptance (see greedy's `beats`).

## Validation

`this.validationInputs` is the held-out set (empty if none). Search on `inputs`, then pick the writeback champion by validation with the shared helper:

```ts
const { champion, validationObjective } = await this.pickValidationChampion(source, candidates, trainChampion);
```

`pickValidationChampion` (on `BaseOptimizer`) takes your candidate list (e.g. `[baseline, ...accepted]`) and the train champion; with a validation set it scores each candidate via `scoreFiles(source, files, this.validationInputs)` and returns the best, else returns the train champion. All three built-ins (`greedy`, `gepa`, `example`) use it. If your optimizer deliberately ignores validation it just won't set `result.validationObjective`, and the report notes that a validation set was provided but unused — so the behavior isn't silently dropped.

Record both numbers on the result for the report:

```ts
result.trainObjective = champion.scorecard.objective();
if (validationObjective !== undefined) result.validationObjective = validationObjective;
```

## Reporting and the result

Emit progress through `this.reporter` (the CLI renders it; tests capture it):

`runStarted` → `baselineScored` → per iteration `iterationDecided` (and `note` for free-form detail) → `runFinished`. The base class already calls `gradingSetup` for you.

Build the result with `buildPointwiseResult({ championIter, championFiles, attempts })`. To surface the reward-hacking lens in `report.md` / `champion/grades.json`, attach the champion's breakdown:

```ts
import { breakdown } from "../gradeBreakdown.js";
result.championBreakdown = breakdown(champion.scorecard);
```

`writeback` is honored by you: `this.workspace.writeBack(source, championFiles)` writes the champion back to the real source files (it verifies each file is unchanged-on-disk by hash and aborts on a mismatch). Only do this when `this.config.writeback` is true and the champion isn't the baseline.

## Registering and using it

Two ways to make `--optimizer` resolve to your class:

**A. A path module (no repo changes).** Default-export a factory `(config) => Optimizer` and point `--optimizer` at the file:

```ts
// myOptimizer.ts
import { BaseOptimizer, type BaseOptimizerConfig, type Input, type OptimizeResult, type OptimizeTargetSet } from "agency-lang/optimize";

class MyOptimizer extends BaseOptimizer {
  readonly name = "mine";
  protected async optimizeTargets(source: OptimizeTargetSet, inputs: Input[]): Promise<OptimizeResult> { /* … */ }
}

export default (config: BaseOptimizerConfig) => new MyOptimizer(config);
```
```bash
agency optimize foo.agency --inputs inputs.json --optimizer ./myOptimizer.ts
```

`--optimizer` treats a value with a `/` or a `.ts`/`.js`/`.mjs` extension as a path: it's loaded with esbuild + `import()` (same as a grading module), the default-exported factory is called with the run config, and the result is used **structurally** as an `Optimizer` (`{ name, optimize }`) — no `instanceof`, so it works even across realms. This is the path for users who don't fork the repo. Can also be set as `eval.optimize.optimizer` in `agency.json`.

**B. A built-in name (in-repo).** Register it so a bare `--optimizer <name>` resolves it:

```ts
// lib/optimize/registry.ts
registerOptimizer("mine", (config) => new MyOptimizer(config));
```

## Testing

`BaseOptimizer`'s constructor takes a `deps` object of seams so you can unit-test without an LLM, real subprocess runs, or file edits:

- `discover` — return a fixed `OptimizeTargetSet` instead of parsing a file.
- `runInput` — return canned `{ output, recordPath }` instead of running the agent.
- `reporter` — capture emitted events.
- your own `propose` / `preview` (as `example`/`greedy`/`gepa` do) — return fixed proposals.

See `lib/optimize/optimizers/greedyReflective.test.ts` and `baseOptimizer.test.ts` for the patterns (fake source, fake `runInput`, injected `propose`, asserting accept/reject counts and that feedback reaches the proposer).

## Checklist

- [ ] Extend `BaseOptimizer`, set `name`, implement `optimizeTargets`.
- [ ] Use `scoreFiles`/`evaluate` to grade; `proposeValidMutation` to mutate.
- [ ] Honor `this.config.writeback` and `this.validationInputs` (or `note` that you ignore validation).
- [ ] Emit reporter events and `buildPointwiseResult` (+ `championBreakdown`).
- [ ] Make it resolvable: a path module (`export default (config) => new …`) used via `--optimizer ./file.ts`, or `registerOptimizer(...)` in `registry.ts`.
- [ ] Add a test with injected `deps` (no live LLM).
