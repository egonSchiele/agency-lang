# Model Usage, Benchmark and Reasoning Level Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every eval run summary carries its benchmark and a per-(model, reasoning level) usage breakdown with token totals. Statelog stores them and returns them from its eval endpoints (ADI-370).

**Architecture:** Two parts, two PRs, with a release in between.

- **Part A (agency-lang):**
  - the runtime logs `reasoningEffort` on each LLM call;
  - a small `modelUsage.ts` sums `promptCompletion` events into `ModelUsage[]`;
  - a small `benchmark.ts` derives the benchmark from the suite source, shared with the runs explorer's suite column;
  - `RunSummary` replaces `models` with the usage list and gains `benchmark` and token totals;
  - `batchUsage` sums usage over a batch.
- **Part B (statelog):**
  - bump to the new release;
  - a migration adds columns;
  - the summary writer, DTOs and pages follow;
  - a one-off script re-summarizes stored traces.

**Tech Stack:** TypeScript, zod 4, vitest (agency-lang); Kysely, Postgres, React, vitest (statelog).

**Spec:** `packages/agency-lang/docs/superpowers/specs/2026-11-23-model-usage-design.md`

## Global Constraints

- `RunSummary.models` is **replaced** by `ModelUsage[]`. No second list of model names on `RunSummary`.
- `ModelUsage = { name: string; reasoning: string | null; calls: number; inputTokens: number; cachedInputTokens: number; cacheCreationInputTokens: number; outputTokens: number; costUsd: number }`. Token field names match `TokenUsage` (`lib/statelogClient.ts`). One entry per (name, reasoning) pair, sorted by name, then reasoning, with `null` before any string.
- **Reasoning rule:** the call's `reasoningEffort`, else the `run` row's `reasoning`, else `null`.
- **Benchmark rule:** the `run` row's `benchmark`, else the name derived from `suite.source` (spec's table), else `null`.
- `eval run` writes no new `run` row fields. Only the Harbor import (ADI-372 part 2) will write `benchmark` and `reasoning`.
- One suite-name parser: `benchmarkFromSuite` (Task 2). The runs explorer's `suiteFromSource` builds on it.
- `reasoningEffort` is logged on `promptCompletion` only, not on `promptStart`.
- Statelog never sums or derives usage, tokens or benchmarks. It stores `RunSummary` and calls `batchUsage`.
- **Part B starts only after Part A is released.** Locally, point statelog at the Part A build to develop. Its PR must pin the published version.
- **agency-lang:** absolute imports with `@/`. Run `pnpm run typecheck` and `pnpm run fmt:ts:check` before each commit. Run `make` once in a fresh worktree.
- **statelog:**
  - absolute `@/` imports with `.js` suffixes;
  - `Result` instead of throwing;
  - `type`, not `interface`;
  - objects, not `Map`;
  - named parameters for more than two arguments;
  - green gate per its workflow: `pnpm run lint`, `pnpm run build-backend`, typecheck, `make test`.

## Review Focus

1. **A `promptCompletion` with no `usage` or no `cost`** (a cut-off call, an older trace) still counts as one call, with zeros. Test in Task 3.
2. **A `promptCompletion` with an empty model string** is counted under the name `unknown`, so run totals still equal the sum of `models`. Test in Task 3.
3. **A suite source with a trailing slash, or a git source with `?ref=` and no subdir**, gives the folder name or the repo name, never `""` or a `?ref` fragment. Test in Task 2.
4. **A batch where some runs have a benchmark and some don't** gives only the non-null values. It never gives `"null"` or a leading ", ". Test in Task 5.
5. **The refresh script on a trace whose events no longer summarize** logs that trace and carries on, then prints how many traces succeeded and how many failed. Test in Task 9.

---

## Part A: agency-lang (one PR)

### Task 1: Log `reasoningEffort` on each LLM call

**Files:**
- Modify: `lib/statelogClient.ts` (`promptCompletion` ~:638)
- Modify: `lib/runtime/promptEvents.ts` (`emitPromptCompletion`)
- Modify: `lib/runtime/promptRequest.ts` (~:253, pass `clientConfig` to `emitPromptCompletion`)
- Modify: `lib/statelog/wireAccessors.ts` (add `reasoningEffortOf`)
- Test: `lib/statelogClient.test.ts`, `lib/statelog/wireAccessors.test.ts`, `lib/runtime/prompt.reasoningEffort.test.ts` (new; set up like `prompt.toolRounds.test.ts`, spying on `ctx.statelogClient.promptCompletion`)

**Interfaces:**
- Produces:
  - `promptCompletion` accepts `reasoningEffort?: string | null` and posts it, normalized to `null` when absent.
  - `emitPromptCompletion` takes `reasoningEffort: string | null`.
  - `export function reasoningEffortOf(ev: EventEnvelope): string | null`, which returns `ev.data.reasoningEffort` when it's a non-empty string, else `null`.

- [ ] **Step 1: Write the failing tests:**
  - `statelogClient.test.ts`:
    - `"promptCompletion posts reasoningEffort"`: `reasoningEffort: "high"` appears in the posted payload.
    - `"reasoningEffort is null when absent"`.
  - `prompt.reasoningEffort.test.ts`:
    - `"a call with reasoningEffort logs it on its completion"`: run a prompt whose client config has `reasoningEffort: "high"`, and assert the spy received `reasoningEffort: "high"`.
    - `"a call without one logs null"`.
  - `wireAccessors.test.ts`: `reasoningEffortOf` returns `"low"` for `data.reasoningEffort: "low"`, and `null` for a missing field, `null`, or `""`.
- [ ] **Step 2: Run** `pnpm exec vitest run lib/statelogClient.test.ts lib/runtime/prompt.reasoningEffort.test.ts lib/statelog/wireAccessors.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** `promptRequest.ts` passes `clientConfig.reasoningEffort ?? null` to `emitPromptCompletion`.
- [ ] **Step 4: Run** the same command, plus `pnpm exec vitest run lib/runtime lib/logsViewer` and `pnpm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `Log each LLM call's reasoningEffort`.

### Task 2: One suite-name parser for benchmark and the explorer

**Files:**
- Create: `lib/runDirectory/benchmark.ts` (the shared part moved out of `lib/runsExplorer/suite.ts`: `looksLikeGitUrl`, the repo-name step of `gitSuite`, and `dataBasename`)
- Modify: `lib/runsExplorer/suite.ts` (`suiteFromSource` calls `benchmarkFromSuite`, and keeps its own handling of `null`/`""`/`"unspecified"` → `—`, `inline:…` shown as is, the `@<ref>` suffix, and `clip`)
- Test: `lib/runDirectory/benchmark.test.ts` (new), `lib/runsExplorer/suite.test.ts` (existing, must still pass unchanged)

**Interfaces:**
- Produces: `export function benchmarkFromSuite(source: string | null | undefined): string | null`. It returns `null` for `null`, `undefined`, `""`, `"unspecified"`, `"optimize"` and any `inline:` source. It never returns a `?ref` fragment.

- [ ] **Step 1: Write the failing test** `"derives the benchmark from the suite source"`, with `it.each` over the spec's table plus Review Focus 3:

  | input | expected |
  |---|---|
  | `"/home/me/evals/plan-easy"` | `"plan-easy"` |
  | `"/home/me/evals/plan-easy/"` | `"plan-easy"` |
  | `"/home/me/evals/plan-easy.json"` | `"plan-easy"` |
  | `"github.com/acme/evals//suites/plan-easy?ref=abc123"` | `"plan-easy"` |
  | `"github.com/acme/plan-suites?ref=abc123"` | `"plan-suites"` |
  | `"https://github.com/acme/plan-suites.git"` | `"plan-suites"` |
  | `"inline:--input"` | `null` |
  | `"unspecified"` | `null` |
  | `null` | `null` |
- [ ] **Step 2: Run** `pnpm exec vitest run lib/runDirectory/benchmark.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Move the shared code into `benchmark.ts`, and rebuild `suiteFromSource` on it.**
- [ ] **Step 4: Run** `pnpm exec vitest run lib/runDirectory/benchmark.test.ts lib/runsExplorer` and `pnpm run typecheck`. Expected: PASS, with `suite.test.ts` unchanged.
- [ ] **Step 5: Commit** with the message `One suite-name parser for the benchmark and the runs explorer`.

### Task 3: Sum a run's LLM usage by model and reasoning level

**Files:**
- Create: `lib/runDirectory/modelUsage.ts`
- Test: `lib/runDirectory/modelUsage.test.ts`

**Interfaces:**
- Consumes: `modelOf`, `tokensIn`, `tokensCached`, `tokensCacheWrite`, `tokensOut`, `cost` and `reasoningEffortOf` (Task 1) from `lib/statelog/wireAccessors.ts`.
- Produces:
  ```ts
  export type ModelUsage = { name: string; reasoning: string | null; calls: number;
    inputTokens: number; cachedInputTokens: number; cacheCreationInputTokens: number;
    outputTokens: number; costUsd: number };
  export function modelUsageOf({ events, fallbackReasoning }: {
    events: readonly EventEnvelope[]; fallbackReasoning: string | null }): ModelUsage[];
  export function sumModelUsage(lists: readonly ModelUsage[][]): ModelUsage[];
  ```
  Only `promptCompletion` events count. Both functions return entries sorted by name, then reasoning (`null` first).

- [ ] **Step 1: Write the failing tests** (events built with `statelogLine` from `lib/runDirectory/testFixtures.ts`):
  - `"one entry per model and level, summed"`:
    - two `opus` calls at `high`, one `opus` call at `low`, and one `jev` call with no level;
    - this gives three entries, with `calls` 2, 1 and 1, and the sums of all four token fields and cost.
  - `"a call with no level takes the fallback"`: `fallbackReasoning: "high"` turns the `jev` entry's `reasoning` into `"high"`.
  - `"a call with no usage or cost counts as a call with zeros"` (Review Focus 1).
  - `"an empty model name is counted as unknown"` (Review Focus 2).
  - `"only promptCompletion events count"`: `promptStart` and `toolCall` events are ignored.
  - `sumModelUsage`: two runs' lists with an overlapping (`opus`, `high`) pair give one summed entry, and the rest pass through, in sorted order.
- [ ] **Step 2: Run** `pnpm exec vitest run lib/runDirectory/modelUsage.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement both.** Key the running sums by `JSON.stringify([name, reasoning])` in a plain object.
- [ ] **Step 4: Run it again, then `pnpm run typecheck`.** Expected: PASS.
- [ ] **Step 5: Commit** with the message `Sum a run's LLM usage by model and reasoning level`.

### Task 4: Put benchmark and usage on the run summary

**Files:**
- Modify: `lib/runDirectory/annotations.ts` (`RunPayload` and `RunAnnotationSchema`: optional `benchmark` and `reasoning`, both `z.string().min(1).optional()`)
- Modify: `lib/runDirectory/list.ts` (`RunSummary`, `summarizeOne`)
- Modify: `lib/runsExplorer/rows.ts:111` (`models: namesOf(summary.models)`, distinct names in order)
- Modify: `lib/eval/public.ts` (export `type ModelUsage`)
- Modify: `docs/dev/evals/run-directory.md` (the `run` row's two optional fields; `RunSummary`'s `models`, `benchmark` and token totals, one sentence each)
- Test: `lib/runDirectory/annotations.test.ts`, `lib/runDirectory/list.test.ts`, `lib/runsExplorer/rows.test.ts`

**Interfaces:**
- Consumes: `benchmarkFromSuite` (Task 2), and `modelUsageOf` and `ModelUsage` (Task 3).
- Produces:
  - `RunSummary.models: ModelUsage[]`;
  - `RunSummary.benchmark: string | null`;
  - `RunSummary.inputTokens`, `cachedInputTokens`, `cacheCreationInputTokens` and `outputTokens: number` (sums over `models`).

- [ ] **Step 1: Write the failing tests:**
  - `annotations.test.ts`: `"a run row may carry benchmark and reasoning"` (a row with both parses), and `"an empty benchmark is refused"`.
  - `list.test.ts`:
    - `"models is the run's usage by model and level, with token totals"`: a trace with two models gives the expected `models`, and `inputTokens` equals their sum.
    - `"benchmark comes from the suite source"`: a run row with `suite: { source: "/x/evals/plan-easy" }` gives `"plan-easy"`.
    - `"the run row's benchmark wins over the suite source"`.
    - `"the run row's reasoning fills calls with no level"`.
    - `"an --input run has no benchmark"`.
  - `rows.test.ts`: an existing assertion on `models` keeps passing with names, and two entries for one model at two levels give that name once.
- [ ] **Step 2: Run** `pnpm exec vitest run lib/runDirectory lib/runsExplorer`. Expected: the new tests FAIL, and so do existing tests that build `RunSummary` with `models: string[]`. Update those fixtures to `[]` or entries.
- [ ] **Step 3: Implement.** `summarizeOne` calls `modelUsageOf({ events, fallbackReasoning: runRow?.reasoning ?? null })` and `benchmarkFromSuite`. Other summary fields are unchanged.
- [ ] **Step 4: Run** `pnpm exec vitest run lib/runDirectory lib/runsExplorer lib/eval lib/cli/eval`, and `pnpm run typecheck`. Expected: PASS.
- [ ] **Step 5: Update `run-directory.md`, then commit** with the message `Run summary: per-model usage, token totals and benchmark`.

### Task 5: Sum usage over a batch

**Files:**
- Modify: `lib/eval/batchStatistics.ts` (add `batchUsage` and `BatchUsage`)
- Modify: `lib/eval/public.ts` (export `batchUsage` and `type BatchUsage`)
- Modify: `docs/dev/evals/eval-tracking.md` (one paragraph: `batchUsage`, and why it's separate from `batchStatistics`)
- Test: `lib/eval/batchStatistics.test.ts`

**Interfaces:**
- Consumes: `sumModelUsage` (Task 3), `RunSummary` (Task 4).
- Produces:
  ```ts
  export type BatchUsage = { benchmark: string | null; inputTokens: number;
    cachedInputTokens: number; cacheCreationInputTokens: number; outputTokens: number;
    models: ModelUsage[] };
  export function batchUsage(runs: readonly RunSummary[]): BatchUsage;
  ```

- [ ] **Step 1: Write the failing tests:**
  - `"sums tokens and models over the runs"`.
  - `"one shared benchmark"`.
  - `"different benchmarks are sorted and joined"`: `["swe-bench", "plan-easy"]` gives `"plan-easy, swe-bench"`.
  - `"null benchmarks are left out"` (Review Focus 4): `[null, "plan-easy"]` gives `"plan-easy"`, and `[null, null]` gives `null`.
  - `"works for a batch batchStatistics refuses"`: an uneven trial grid still gives totals.
- [ ] **Step 2: Run** `pnpm exec vitest run lib/eval/batchStatistics.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run** `pnpm exec vitest run lib/eval`, `pnpm run typecheck` and `pnpm run fmt:ts:check`. Expected: PASS.
- [ ] **Step 5: Write the doc paragraph, then commit** with the message `batchUsage: a batch's tokens, models and benchmark`.

**Part A done:** open the agency-lang PR. Once merged, the owner publishes a release. Its `CHANGELOG.md` entry lists under **Breaking**: "`RunSummary.models` (from `agency-lang/eval`) is now a list of usage entries, one per model and reasoning level, instead of model names." Part B pins that version.

---

## Part B: statelog (one PR, after the release)

Paths are relative to the statelog repo root. Work in a statelog worktree off `origin/main`.

### Task 6: Store the new fields

**Files:**
- Modify: `package.json` (`agency-lang` to the Part A release), then run `pnpm install`
- Create: `db/migrations/<timestamp after the newest on origin/main>_trace_summary_usage.ts`:
  - `benchmark text`;
  - `input_tokens`, `cached_input_tokens`, `cache_creation_input_tokens` and `output_tokens` (`bigint not null default 0`);
  - an index `trace_summaries_project_benchmark_idx` on `(project_id, benchmark)`;
  - a `down` that drops all of these.
- Modify: `src/backend/db/types.ts` (`TraceSummaryTable`: the five columns. The token columns are typed like `total_cost`: `ColumnType<string, number, number>`. `models` holds `ModelUsage[]`.)
- Modify: `src/backend/db/trace_summary.ts` (`toTraceSummaryRow` and the upsert's `doUpdateSet` include the five columns)
- Modify: `src/backend/lib/evals/evalQueries.ts` (`RunSummaryRowSchema`: a `ModelUsage` object schema for `models`, plus `benchmark` and the four token totals)
- Test: `src/backend/lib/evals/traceSummary.test.ts`, `src/backend/postgres-integration/evalTracking.migration.test.ts`

**Interfaces:**
- Consumes: `RunSummary` and `ModelUsage` from `agency-lang/eval`.

- [ ] **Step 1: Write the failing tests:**
  - `traceSummary.test.ts`: `"toTraceSummaryRow writes benchmark and token totals"`, from a summary with `benchmark: "swe-bench-verified"` and `inputTokens: 4000`.
  - `evalTracking.migration.test.ts`: `"trace_summaries has the usage columns, and down removes them"`.
- [ ] **Step 2: Run** `pnpm exec vitest run src/backend/lib/evals/traceSummary.test.ts`, and the integration test per `postgres-integration/` instructions. Expected: FAIL.
- [ ] **Step 3: Implement** the migration and the three backend files.
- [ ] **Step 4: Run** `pnpm run lint`, `pnpm run build-backend`, typecheck and `make test`. Expected: green. Existing tests that build `RunSummary` with string `models` are updated to entries.
- [ ] **Step 5: Commit** with the message `Store benchmark, token totals and per-model usage on trace summaries`.

### Task 7: Return the fields from the eval endpoints

**Files:**
- Modify: `src/common/apiTypes/evals.ts`:
  - add `ModelUsageDto` (same fields as `ModelUsage`);
  - `EvalRunDto` gains `benchmark`, the four token totals, and `models: ModelUsageDto[]`;
  - `EvalBatchDto` gains `benchmark`, the four token totals, and `models: ModelUsageDto[]`.
- Modify: `src/backend/lib/evals/evalQueries.ts`:
  - `toEvalRunDto` copies the run's fields;
  - `sharedBatchFields` spreads `batchUsage(summaries)` in place of the name set.
- Test: `src/backend/lib/evals/evalQueries.test.ts`

**Interfaces:**
- Consumes: `batchUsage` from `agency-lang/eval` (Task 5).

- [ ] **Step 1: Write the failing tests:**
  - `"a run DTO carries benchmark, tokens and models"`.
  - `"a batch DTO carries batchUsage's totals"`: two runs with overlapping models give summed entries.
  - `"an incomplete batch still carries its usage"`.
- [ ] **Step 2: Run** `pnpm exec vitest run src/backend/lib/evals/evalQueries.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the green gate. Expected: green, apart from frontend type errors on `models`, which Task 8 fixes. If they block the gate, do Task 8's edits in this task and note it.
- [ ] **Step 5: Commit** with the message `Eval endpoints return benchmark, tokens and per-model usage`.

### Task 8: Pages show models from the new shape

**Files:**
- Modify: `src/frontend/util.ts` (add `formatModelUsage(usage: ModelUsageDto): string`, which returns `"claude-opus-5-5 (high)"`, or just the name when `reasoning` is null)
- Modify:
  - `src/frontend/components/evals/BatchesTable.tsx:155`;
  - `src/frontend/pages/Projects/Evals/Batch.tsx:71`;
  - `src/frontend/pages/Traces/traceModel.ts:395` (`summary.models.map(formatModelUsage)`; the `eventModels(events)` fallback is unchanged).
- Modify: `src/frontend/designGuide/projectFixtures.ts` and `src/frontend/pages/Projects/Evals/testSupport.tsx` (fixtures in the new shape)
- Test: `src/frontend/pages/Projects/Evals/Batch.test.tsx`, `src/frontend/pages/Traces/traceModel.test.ts`

- [ ] **Step 1: Write the failing tests:**
  - `Batch.test.tsx`: `"the Models row lists each model with its level"` shows `claude-opus-5-5 (high), jev`.
  - `traceModel.test.ts`: `"a summarized trace lists models with their levels"`.
- [ ] **Step 2: Run** both. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the green gate. Expected: green.
- [ ] **Step 5: Commit** with the message `Pages list models with their reasoning level`.

### Task 9: Re-summarize stored traces

**Files:**
- Create: `src/backend/scripts/refresh-trace-summaries.ts`
- Create: `src/backend/lib/evals/refreshAllTraceSummaries.ts` (the testable part)
- Modify: `src/backend/scripts/README.md` (an entry: what it does, and to run it once after deploying this change)
- Modify: `docs/dev/eval-tracking.md`:
  - the `trace_summaries` column list;
  - remove "Keep this wire contract paired with … 0.44.2" or update its version;
  - one line pointing at the script.
- Test: `src/backend/lib/evals/refreshAllTraceSummaries.test.ts`

**Interfaces:**
- Consumes: `summarizeTrace({ traceId })` from `src/backend/lib/evals/traceSummary.ts`.
- Produces: `export async function refreshAllTraceSummaries(): Promise<Result<{ refreshed: number; failed: { traceId: string; error: string }[] }>>`. It reads every `trace_id` in `trace_summaries` and calls `summarizeTrace` on each in turn. The script prints the counts and each failure.

- [ ] **Step 1: Write the failing test** `"refreshes every stored trace and reports the ones that fail"` (Review Focus 5). Stub `summarizeTrace` to fail for one id, and expect `refreshed: 2` and one failure naming it.
- [ ] **Step 2: Run** it. Expected: FAIL, module not found.
- [ ] **Step 3: Implement both files and the docs.**
- [ ] **Step 4: Run** the green gate, then `pnpm run build` and `node dist/backend/scripts/refresh-trace-summaries.js` against a local database seeded with one uploaded batch. Expected: `refreshed: N, failed: 0`, and the batch page shows models with their levels.
- [ ] **Step 5: Commit** with the message `Script: re-summarize stored traces after a summary change`.

**Part B done:** open the statelog PR. After deploy, run the script once in production.
