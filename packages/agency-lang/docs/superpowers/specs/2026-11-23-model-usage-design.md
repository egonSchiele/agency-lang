# Benchmark, reasoning level and per-model usage for every eval run

Linear: ADI-370. Needed by ADI-372 (Harbor import, part 2) and ADI-374 (statelog comparison pages).

## Why

We want to compare eval results by benchmark, agent, model and reasoning level, and to see cost, runtime and tokens for each. Agency's run summary (`RunSummary`, `lib/runDirectory/list.ts`) has the agent name, a list of model names, cost and duration. It has no benchmark, no reasoning level, and no token counts. Statelog stores what that summary returns, so it can't show them either.

## Goals

- Every run summary carries its benchmark, and a breakdown of its LLM usage by model and reasoning level, with token counts and cost.
- Agency sums the same things over a batch, so statelog never has to.
- Statelog stores them, so runs can be filtered and sorted by them, and its batch and test endpoints return them.
- Harbor imports (ADI-372 part 2) can set the benchmark and the reasoning level of old jobs, whose traces don't record it.

## Non-goals

- Pages that show these fields well, and new filter parameters on statelog's endpoints. Both are ADI-374. This ticket stores the data, indexes `benchmark`, and returns the fields.
- Recording the reasoning level in old traces. Old Harbor jobs get it from the import's `--reasoning` flag (ADI-372 part 2).

## Anti-goals

- Statelog computing any of these itself, per run or per batch. It stores what Agency returns (statelog `docs/dev/eval-tracking.md`: "Never add a second summary/statistics implementation in statelog").
- Two fields that say the same thing and can disagree, such as a list of model names beside the per-model list.

## What exists today

- **Every LLM call's `promptCompletion` event** records its `model`, `usage` (`inputTokens`, `outputTokens`, `cachedInputTokens`, `cacheCreationInputTokens`, `totalTokens`) and `cost.totalCost`. `inputTokens` is fresh input only; cache reads are `cachedInputTokens`. Agency's eval record already sums input and output tokens (`lib/eval/extract.ts`, `computeMetrics`), but `RunSummary` doesn't expose them.
- **The reasoning level isn't in the trace.** `emitPromptStart` (`lib/runtime/promptEvents.ts`) records `model` and `maxTokens` from the call's `clientConfig`, but not `reasoningEffort`. The value is right there: `promptRequest.ts` has `clientConfig` when it calls both `emitPromptStart` and `emitPromptCompletion`.
- **There's no benchmark.** The `run` row has `suite: { source, sha? }`. `source` is the resolved absolute path for a local suite, the raw source string for a git suite (for example `<repo>?ref=<sha>`), and `inline:--input` for an `--input` run (`lib/cli/eval/run.ts`, `loadSuite`). `RunSummary.suiteSource` is that string.
- **Batch statistics** come from agency-lang (`lib/eval/batchStatistics.ts`, `batchStatisticsByBatch`), and statelog calls them. They have cost and duration totals, but no models or tokens.
- **Statelog checks uploaded annotations with agency-lang's `AnnotationSchema`** (`annotationsIngest.ts`). The `run` row schema is `.strict()`, so a `run` row with a field statelog's agency-lang version doesn't know is rejected.
- **`RunSummary.models`** is a sorted list of distinct model names. Readers:
  - agency-lang: `runsExplorer/rows.ts`.
  - statelog:
    - `trace_summaries.models` (already a JSON column);
    - `RunSummaryRowSchema` and the DTOs in `evalQueries.ts`;
    - the batch list and batch page;
    - the trace overview (`traceModel.ts`, `traceOverview.ts`, `TraceOverviewPane.tsx`). When a trace has no summary, `traceModel.ts` falls back to plain names from the events (`eventModels`);
    - the design-guide fixtures.

## Approaches

1. **Replace `models` with the per-model list (chosen).** `RunSummary.models` becomes a list of usage entries. Readers that showed names read `.name`. Owner's pick: it's the shape the owner sketched, and there's one field instead of two that could drift.
2. **Keep `models: string[]` and add `modelUsage`.** Fewer changes, but the model names would be stored twice. Rejected.

How each new value is found was decided by the owner as follows.

- **Reasoning level when calls differ:** one usage entry per (model, reasoning level) pair, not one entry per model with a list of levels. Tokens and cost stay separate per level, so "what did Opus at `high` cost?" is a filter.
- **Benchmark for Agency's own suites:** the suite folder's name, with no flag and no config file. If a name ever comes out wrong, a flag can be added later.

## Design

### 1. Runtime: record the reasoning level on each call

`emitPromptCompletion` gains `reasoningEffort`, from `clientConfig.reasoningEffort`, or `null` when the call didn't set one (the provider's default). It's logged on the `promptCompletion` event beside `model` and `usage`, so one event holds everything a usage entry needs. `promptStart` doesn't get it: nothing reads it there.

A call that turns on thinking through `thinking: { enabled, budgetTokens }` without a `reasoningEffort` records `null`. (My call: the ticket is about effort levels, and a budget isn't one.)

### 2. The `run` row: optional `benchmark` and `reasoning`

`RunPayload` and `RunAnnotationSchema` (`lib/runDirectory/annotations.ts`) gain two optional strings. Nothing in this ticket writes them. The Harbor import (ADI-372 part 2) is the first writer:

- `benchmark`: from `result.json`'s `source`.
- `reasoning`: from `--reasoning`, for traces that don't record a level.

`eval run` writes neither (see the benchmark rule below), so its `run` rows don't change. A new CLI's uploads therefore keep working against a statelog that hasn't upgraded yet. Only Harbor imports carry the new fields, and they're uploaded after statelog upgrades.

### 3. The run summary

```ts
export type ModelUsage = {
  name: string;
  /** The call's reasoningEffort, else the run row's `reasoning`, else null
   *  (the provider's default). */
  reasoning: string | null;
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  costUsd: number;
};
```

`RunSummary` changes:

- `models: ModelUsage[]`: one entry per (name, reasoning) pair, summed over the run's `promptCompletion` events. Sorted by name, then reasoning, so snapshots are stable. Example:

  ```ts
  models: [
    { name: "claude-opus-5-5", reasoning: "high", calls: 12, inputTokens: 3200, cachedInputTokens: 41000, cacheCreationInputTokens: 0, outputTokens: 420, costUsd: 0.61 },
    { name: "claude-opus-5-5", reasoning: "low",  calls: 3,  inputTokens: 800,  cachedInputTokens: 9000,  cacheCreationInputTokens: 0, outputTokens: 80,  costUsd: 0.09 },
    { name: "jev",             reasoning: null,   calls: 5,  inputTokens: 3000, cachedInputTokens: 0,     cacheCreationInputTokens: 0, outputTokens: 50,  costUsd: 0.01 },
  ]
  ```
- New `benchmark: string | null` (rule below).
- New run totals `inputTokens`, `cachedInputTokens`, `cacheCreationInputTokens` and `outputTokens`: the sums over `models`. `costUsd` already exists.

**The benchmark rule:** the `run` row's `benchmark` when it has one (Harbor imports). Otherwise the summary works it out from `suite.source`:

| `suite.source` | `benchmark` |
|---|---|
| `/home/me/evals/plan-easy` (local folder) | `plan-easy` |
| `/home/me/evals/plan-easy.json` (local file) | `plan-easy` (extension dropped) |
| a git source with a subfolder (`<repo>/evals/plan-easy?ref=…`) | `plan-easy` (the subfolder's last part, never the `?ref` part) |
| a git source with no subfolder | the repo's name |
| `inline:--input`, or no suite | `null` |

(My call to work it out in the summary rather than have `eval run` write it. It's the owner's folder-name rule, kept in one place. Runs already stored get a benchmark when they're summarized again. And `eval run`'s `run` rows stay unchanged, so there's no window where uploads are rejected. Git sources are parsed with the existing `parseSource`.)

**One parser for suite names.** The runs explorer already turns `suite.source` into a short name for its "suite" column (`lib/runsExplorer/suite.ts`, `suiteFromSource`). The shared part (the folder or file name without its data extension, or the repo name for a git source) moves into one function that the summary uses for `benchmark`. The explorer keeps its display extras on top of it: the `@<ref>` suffix, clipping, `—` for unknown, and showing `inline:…` as is. So the explorer and statelog always agree on a run's name.

**The reasoning rule:** a call's own `reasoningEffort` wins. When the call recorded none, the `run` row's `reasoning` fills it in. Old Harbor traces record none, so `--reasoning high` gives every entry `reasoning: "high"`. When neither says, it's `null`.

**Token fields** mean what the trace's `usage` means, with the same names as agency-lang's other token breakdowns (`TokenUsage` in `statelogClient.ts`, `TokenBreakdown` in `spendTypes.ts`): `inputTokens` is fresh input, `cachedInputTokens` is cache reads, `cacheCreationInputTokens` is cache writes.

**Readers in agency-lang:** the runs explorer's per-test and per-run model lists use `.name`, deduplicated.

### 4. Batch usage

A new agency-lang function, `batchUsage(runs: RunSummary[])` (exported beside `batchStatisticsByBatch`), returns a batch's:

- `benchmark: string | null`: the runs' shared value. When they differ, it's the distinct non-null values, sorted and joined with ", ". It's null when no run has one.
- `inputTokens`, `cachedInputTokens`, `cacheCreationInputTokens` and `outputTokens`: summed over the runs;
- `models: ModelUsage[]`: the runs' entries summed per (name, reasoning), in the same order as a run's.

It's a separate function rather than new `BatchStatistics` fields, because `batchStatistics` refuses a batch whose trial grid is incomplete, and statelog still shows those batches. (My call, following the anti-goal: statelog reads these instead of summing anything itself.)

### 5. Statelog

- **Dependency:** move to the agency-lang release with this change (it also brings `void`, from ADI-372 part 1).
- **Migration:** add to `trace_summaries`:
  - `benchmark text` (nullable, indexed);
  - `input_tokens`, `cached_input_tokens`, `cache_creation_input_tokens` and `output_tokens` (bigint, not null, default 0).

  `models` stays a JSON column and now holds the usage entries.
- **`toTraceSummaryRow`** writes the new columns. **`RunSummaryRowSchema`** gains `ModelUsage` and the new fields.
- **Endpoints**, with no new query parameters (ADI-374):
  - **Test endpoint:** each run returns `benchmark`, the four token totals, and `models` (usage entries).
  - **Batch list and batch page:** each batch returns `benchmark`, the token totals and `models` from agency-lang's `batchUsage`.
- **Pages:** where a page lists model names today, it lists each entry's name, with its level when there is one (`claude-opus-5-5 (high)`). The trace page's fallback for traces with no summary keeps listing plain names from the events. The design-guide fixtures move to the new shape. Anything more is ADI-374.
- **Existing rows:** summaries already stored have the old `models` shape and no tokens or benchmark. A one-off script re-runs the existing summary refresh for every trace in `trace_summaries`. Run it once after deploying. (My call: this is cheaper than making the schema accept both shapes, and the prototype has few rows.)

## Left to the builder

- Where `ModelUsage` summing lives. Probably beside `computeMetrics` in `lib/eval/extract.ts`, so the eval record and the summary share it.
- Test fixtures for:
  - a run using two models;
  - one model at two levels;
  - a call with no level plus a `run` row `reasoning`;
  - each row of the benchmark table;
  - a batch whose runs have different benchmarks.

## Order

1. An agency-lang PR, then a release.
2. A statelog PR on that release, then deploy, then run the refresh script.

Because `eval run`'s `run` rows don't change, nothing breaks between steps 1 and 2.

## Depends on

- ADI-372 part 2 builds on the `benchmark` and `reasoning` run-row fields, and is the first to write them.
