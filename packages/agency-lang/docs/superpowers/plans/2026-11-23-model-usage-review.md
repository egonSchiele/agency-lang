# Review: Model Usage, Benchmark and Reasoning Level plan (ADI-370)

Plan: `docs/superpowers/plans/2026-11-23-model-usage.md`
Spec: `docs/superpowers/specs/2026-11-23-model-usage-design.md`

I checked the plan's claims against the agency-lang worktree (at `fdfd008af`) and against statelog's `origin/main` (at `68f2317`). Every file the plan names exists. The design follows the spec, and the order of the two PRs is safe: `eval run` writes no new `run` row fields, and statelog's `promptCompletion` log schema is a `looseObject`, so the new `reasoningEffort` field on events is accepted by a statelog that hasn't upgraded yet.

The findings below are ordered by how much they matter. The first three would cause a failure or a broken page if built as written.

## Must fix

### 1. Task 2 breaks the runs explorer's `optimize` case

Task 2 says `benchmarkFromSuite("optimize")` returns `null`, and that `suiteFromSource` is rebuilt on top of it. The Files line lists what `suiteFromSource` keeps for itself: `null`, `""` and `"unspecified"` become `—`, `inline:…` is shown as is, plus the `@<ref>` suffix and `clip`. It doesn't list `"optimize"`.

So after the rebuild, `suiteFromSource("optimize")` gets `null` back from `benchmarkFromSuite` and shows `—`. Today it shows `optimize`, and `lib/runsExplorer/suite.test.ts:27` asserts that:

```ts
expect(suiteFromSource("optimize")).toBe("optimize");
```

The plan says that test must pass unchanged, so Step 4 will fail.

Fix: add `"optimize"` to the list of cases `suiteFromSource` handles itself, before it calls `benchmarkFromSuite`. Also add a row `"optimize"` → `null` to the Task 2 test table, because the interface promises it and no test checks it.

A smaller point in the same task: `suiteFromSource` still needs the `?ref=` part to build its `@<ref>` suffix, and `benchmarkFromSuite` throws that away. So `suiteFromSource` still has to know whether a source is a git source. The plan should say what `benchmark.ts` exports for that (for example `looksLikeGitUrl`), so the builder doesn't copy the git check back into `suite.ts`.

### 2. A trace the refresh script can't re-summarize breaks every eval page in its project

After Part B deploys, `RunSummaryRowSchema` requires the new shape: `models` as usage entries, plus `benchmark` and the four token totals. Every row stored before the deploy has the old shape, so it fails that schema until the refresh script rewrites it.

`parseRows` in `evalQueries.ts` returns a failure as soon as one row fails to parse. So one old-shape row makes the whole batch list, batch page or test endpoint fail. On the trace page, the same old row's `models` is a list of strings, and `summary.models.map(formatModelUsage)` would show `undefined` for each.

The script fixes this for every trace it can re-summarize. But Task 9 (and Review Focus 5) says a trace that fails is "logged, and the script carries on". Its old-shape row stays in `trace_summaries`, and its project's eval pages stay broken. Nothing in the plan says what happens next.

Fix: when `summarizeTrace` fails for a trace, the script deletes that trace's row from `trace_summaries` and reports it. The row is derived data. Deleting it hides that one run from the eval pages until its next log or annotation change re-summarizes it, which is far better than one stale row breaking the whole project. The test in Task 9 should then check that the failing trace's row is gone and the others were rewritten. Because this deletes rows in production, it needs the owner's yes before it goes into the plan.

### 3. Task 9's "testable part" still reads the database

`refreshAllTraceSummaries()` takes no arguments, reads every `trace_id` from `trace_summaries`, then calls `summarizeTrace` on each. The test stubs `summarizeTrace`, but the function still queries Postgres for the ids, so the test as described can't run as a plain unit test. It needs either the postgres integration setup or a second stub.

Fix: split the loop from the query. For example:

```ts
export async function refreshTraceSummaries({ traceIds, summarize }: {
  traceIds: string[];
  summarize: (args: { traceId: string }) => Promise<Result<RunSummary>>;
}): Promise<{ refreshed: number; failed: { traceId: string; error: string }[] }>
```

The script reads the ids and passes in the real `summarizeTrace`. The unit test passes three ids and a `summarize` that fails for one of them. If finding 2 is accepted, the delete is passed in the same way.

## Should fix

### 4. The spec and the plan disagree on how git sources are parsed

The spec says "Git sources are parsed with the existing `parseSource`" (`lib/eval/sources.ts`). The plan instead moves the explorer's own parser out of `lib/runsExplorer/suite.ts`. I think the plan is right: `parseSource` needs a `baseDir`, throws on an empty `?ref=`, and throws on a local path that has a `?ref=`. A summary of a stored run must never throw on a source string, so the explorer's parser fits better. Change the spec's sentence to match the plan, so the next reader doesn't "fix" the plan back to `parseSource`.

I checked that the explorer's parser already gives the spec's answers for the `//subdir` form that `sources.ts` uses. For example, `github.com/acme/evals//suites/plan-easy?ref=abc123` gives `plan-easy`, because `dataBasename` splits on `/` and drops empty parts.

### 5. Task 4 should check that the run's totals still add up

After Task 4, `RunSummary.costUsd` and `RunSummary.llmCalls` still come from `computeMetrics` in `lib/eval/extract.ts`, while `models` comes from the new `modelUsageOf`. These are two pieces of code summing the same `promptCompletion` events. They agree today. If someone later changes one (for example, makes `computeMetrics` count embedding calls), they disagree silently. That is the spec's anti-goal: two fields that say the same thing and can disagree.

Fix: add one test to `list.test.ts` that builds a trace with several models and asserts that the sum of `models[].calls` equals `llmCalls`, and the sum of `models[].costUsd` equals `costUsd`. This is also what Review Focus 2 ("run totals still equal the sum of `models`") depends on, but no test in the plan checks it.

### 6. Task 1 doesn't mention the second place that logs `promptCompletion`

`lib/runtime/memory/manager.ts:307` calls `run.log?.promptCompletion(...)` for the memory manager's own LLM calls. It doesn't go through `promptRequest.ts`, so it won't pass a `reasoningEffort`. Task 1 makes the client write `null` when the field is missing, so these events will say `null`, which is right: memory calls don't set a reasoning level. The plan should say this is deliberate, so the builder doesn't think it was missed.

### 7. Part B's list of test fixtures is incomplete

Task 8 names two fixture files. Changing `models` from a list of names to usage entries also touches these statelog tests, which typecheck will flag:

- `src/backend/lib/evals/evalQueries.test.ts` (several `models: [...]`)
- `src/backend/lib/evals/traceSummary.test.ts:242, 275`
- `src/backend/postgres-integration/evalTraceSummary.test.ts:140, 223, 232`
- `src/frontend/components/evals/tables.test.tsx:32, 46, 145, 156`
- `src/frontend/lib/evalViewModels.test.ts:23`
- `src/frontend/components/projects/TracesTable.test.tsx:47`
- `src/frontend/pages/Traces/traceModel.test.ts:119, 128`

Task 6 Step 4 covers this in general terms ("existing tests ... are updated"). Listing them helps the builder size Tasks 6 to 8, and shows that the frontend fixtures will break in Task 7 before Task 8 fixes them, which Task 7 Step 4 already expects.

## Small points

- **Task 1:** `wireAccessors.ts` already has a `nonEmptyString` helper. `reasoningEffortOf` should use it.
- **Task 1 and Task 3:** `wireAccessors.ts` already has `reasoningOf`, which returns the model's reasoning *text*. `reasoningEffortOf` and `ModelUsage.reasoning` hold the requested *level*. A one-line doc comment on `ModelUsage.reasoning` ("the requested reasoning level, such as `high`; not the reasoning text") keeps the two apart.
- **Task 9 docs:** statelog's `docs/dev/eval-tracking.md` names agency-lang 0.44.2 in two places: line 6 and line 134. The plan only mentions line 134.
- **Task 6:** consider adding `reasoningEffort: z.string().nullable().optional()` to `LogPromptCompletionSchema` in statelog's `src/common/apiTypes/logEvents.ts`. It isn't needed (the schema is loose), but that file documents the event fields statelog knows about.
- **Part A done:** the plan gives the `CHANGELOG.md` line for the release. Say explicitly that the builder puts that line in the PR description for the owner and doesn't edit `CHANGELOG.md` itself.

## What I checked and found right

- `clientConfig.reasoningEffort` is the right value to log. `prompt.ts` builds `clientConfig` from agency.json defaults, the branch's `llm` defaults and the call's own options, so a level set at any of those places is recorded. `withLocalDefaults` keeps `reasoningEffort` on the config for local models too.
- `tokensIn`, `tokensCached`, `tokensCacheWrite`, `tokensOut`, `cost` and `modelOf` all exist in `wireAccessors.ts`, and each returns 0 or `""` when the field is missing, so Review Focus 1 (no usage, no cost) works with no extra code.
- `summarizeEvalRun`, which statelog calls, goes through `summarizeOne`, so the Task 4 change reaches statelog. Statelog passes `source: "statelog:<traceId>"`, which is the record's source and not the suite source, so it doesn't affect `benchmark`.
- Keeping `batchUsage` separate from `batchStatistics` is right: statelog's `evaluateBatch` already handles batches that `batchStatisticsByBatch` refuses, and `sharedBatchFields` is the one place both paths share, which is where the plan puts `batchUsage`.
- Statelog backend scripts are built with `pnpm run build` and run as `node dist/backend/scripts/<name>.js`, as Task 9 Step 4 says.
