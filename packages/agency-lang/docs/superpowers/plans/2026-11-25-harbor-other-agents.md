# Implementation plan: Harbor agent names, Pi import, real end times

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harbor imports carry an agent name, Pi trials import with their reported usage, and every run's end time comes from its trace.

**Architecture:** The run row gains an optional `reported` field, made of `TraceDigest` fields. `summarizeDigest` overlays it on a digest that has no events, and takes `endedAt` from the trace before the run row. The Harbor importer reads `agent_info`, `agent_result` and `agent_execution` from `result.json`, and writes `flags.agent` and `reported`. Statelog moves to the new agency-lang and shows `displayAgent` as a batch's agent.

**Tech Stack:** TypeScript, zod 4, vitest; agency-lang CLI (commander); statelog (Kysely, Express, Postgres integration tests).

**Spec:** `packages/agency-lang/docs/superpowers/specs/2026-11-25-harbor-other-agents-design.md` (review: `...-design-review.md`, same folder). Plan review: `2026-11-25-harbor-other-agents-review.md`, beside this plan; its findings are applied.

## Global Constraints

- The new run-row field is `reported?: Pick<TraceDigest, "models" | "startedAtMs" | "durationMs" | "lastEventAt">`. Its zod schema reuses `TraceDigestSchema`'s fields. No new near-duplicate usage type.
- Fresh input is `n_input_tokens - n_cache_tokens`. Cached input is `n_cache_tokens`. Cache-creation tokens are 0.
- Pi's `ModelUsage` entry has `calls: 0` and `reasoning: null`. The run row's `reasoning` fills the level through the existing `withFallbackReasoning`.
- `reported` is used only when the digest's `eventCount` is 0.
- `endedAt` is `digest.lastEventAt ?? runRow?.createdAt ?? null`, after the overlay.
- "The agent left a record" is `eventCount > 0 || models.length > 0`, read after the overlay. It decides "killed" against "failed", and whether `runs list` counts a run as one that wrote no trace.
- Timestamps written by the importer go through `new Date(x).toISOString()`.
- `--agent` wins over `agent_info.name`. Without either, `flags.agent` is absent.
- The agency-lang PR does not bump the package version; the owner publishes.
- Prose in docs and PR bodies follows `~/statelog/docs/dev/general-writing-tips.md`.
- agency-lang tests run from `packages/agency-lang` with `pnpm exec vitest run <path>`. Statelog unit tests need `SECRETS_ENCRYPTION_KEY=$(openssl rand -base64 32)`. Statelog integration tests use the local Postgres command in Task 6.

## Review Focus

1. **Re-importing into an existing batch folder with a different `--agent`.** Today `finishExisting` returns "present" and keeps the old row, so the new name would be silently dropped. Expected: the import fails for that run and says to delete the batch folder. Test in Task 3.
2. **A Pi trial whose `result.json` lacks `agent_execution`.** Expected: `reported` falls back to the trial's own `started_at` and `finished_at`, and the trial still imports. Test in Task 2.
3. **An Agency trial whose `agent_result` has null token counts.** Expected: `reported` is null, and the trial imports exactly as today. Test in Task 2.
4. **One import holding trials from two agents, without `--agent`.** Expected: each run keeps its own trial's name. Statelog then shows the batch's agent as blank, which is correct for a mixed batch. Test in Task 3.
5. **A results-only upload of a Pi run to statelog.** The CLI sends an all-zero digest. Expected: statelog's summary shows Pi's tokens, cost and duration from the run row. Test in Task 6.

---

### Task 1: `reported` on the run row, the summary overlay, trace-first end times, and the record rule

**Files:**
- Modify: `lib/runDirectory/annotations.ts` (`RunPayload`, `RunAnnotationSchema`)
- Modify: `lib/runDirectory/list.ts` (`summarizeDigest`, `statusOf`, `buildRunsListing`)
- Modify: `lib/runsExplorer/rows.ts:116` (the "killed" check)
- Modify: `lib/eval/public.ts` (export `displayAgent`)
- Test: `lib/runDirectory/list.test.ts`, `lib/runDirectory/annotations.test.ts`, `lib/runsExplorer/rows.test.ts`, `lib/eval/public.test.ts`

**Interfaces:**
- Produces: `export type RunReported = Pick<TraceDigest, "models" | "startedAtMs" | "durationMs" | "lastEventAt">` in `annotations.ts`; `RunPayload.reported?: RunReported`.
- Produces: `displayAgent(summary: RunSummary): string | null` exported from `agency-lang/eval`.

- [ ] **Step 1: Write the failing tests**

In `list.test.ts`, using the file's existing helpers for a run folder or `summarizeEvalRun` input:

```ts
it("uses the run row's reported usage when the trace has no events", () => {
  const summary = summarizeEvalRun({ traceId: "t", events: [], source: "s",
    annotations: [runRow({ reasoning: "high", reported: PI_REPORTED })] });
  expect(summary.costUsd).toBe(0.00317472);
  expect(summary.inputTokens).toBe(6296);
  expect(summary.cachedInputTokens).toBe(50944);
  expect(summary.outputTokens).toBe(1404);
  expect(summary.durationMs).toBe(68_853);
  expect(summary.startedAt).toBe("2026-11-13T23:34:26.015Z");
  expect(summary.endedAt).toBe("2026-11-13T23:35:34.868Z");
  expect(summary.models).toEqual([expect.objectContaining({ name: "z-ai/glm-5.3-flash", reasoning: "high" })]);
});

it("ignores reported usage when the trace has events", () => {
  // the same row with a one-call trace: cost, tokens and models come from the trace
});

it("takes endedAt from the last event before the run row", () => {
  // trace whose last event is 2026-11-13T23:36:29.379Z, run row createdAt 2026-11-24T20:15:00.000Z
  expect(summary.endedAt).toBe("2026-11-13T23:36:29.379Z");
});

it("falls back to the run row's time when there are no events", () => {
  // no events, no reported: endedAt === run row createdAt
});

it("counts a timed-out run with reported usage as killed", () => {
  // no events, run row ended "timeout" with PI_REPORTED: status "killed"
});

it("still counts a timed-out run with no record as failed", () => {
  // no events, no reported, ended "timeout": status "failed"
});
```

Also in `list.test.ts`: `buildRunsListing` gives `silentRunCount` 1 for one run with no events and no `reported`, and 0 for one with `reported`.

In `rows.test.ts`: a summary with `status: "killed"` and `eventCount: 0` sets `statelogHadEvents`.

`PI_REPORTED` is `{ models: [{ name: "z-ai/glm-5.3-flash", reasoning: null, calls: 0, inputTokens: 6296, cachedInputTokens: 50944, cacheCreationInputTokens: 0, outputTokens: 1404, costUsd: 0.00317472 }], startedAtMs: Date.parse("2026-11-13T23:34:26.015Z"), durationMs: 68_853, lastEventAt: "2026-11-13T23:35:34.868Z" }`.

In `annotations.test.ts`: a run row with `reported` parses; one with an extra key inside `reported` is refused.

In `public.test.ts`: `displayAgent` is exported.

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm exec vitest run lib/runDirectory/list.test.ts lib/runDirectory/annotations.test.ts lib/eval/public.test.ts`
Expected: the new cases fail (unknown key `reported`; `endedAt` is the run row's time; `displayAgent` missing).

- [ ] **Step 3: Implement**

- `annotations.ts`: add `RunReported` and `reported?: RunReported` with a one-line doc comment ("what the harness reported, for a run whose agent wrote no trace"). Add `reported: TraceDigestSchema.pick({ models: true, startedAtMs: true, durationMs: true, lastEventAt: true }).optional()` to `RunAnnotationSchema`. `traceDigest.ts` doesn't import `annotations.ts`, so there's no cycle.
- `list.ts` `summarizeDigest`: before anything reads `digest`, replace it with `{ ...digest, ...runRow.reported }` when `digest.eventCount === 0` and `runRow?.reported` exists. Change `endedAt` to `digest.lastEventAt ?? runRow?.createdAt ?? null`.
- `list.ts`: add a private `leftRecord({ eventCount, models }: Pick<TraceDigest, "eventCount" | "models">): boolean`. `statusOf` takes the overlaid digest instead of `eventCount` and uses `leftRecord` in place of `eventCount > 0`. `buildRunsListing` counts a run as silent when `!leftRecord(summary) && summary.status !== "trace"`. Update the `silentRunCount` doc comment to "the agent left no record: no events and no reported usage".
- `rows.ts`: replace `summary.eventCount > 0 && CUT_SHORT_ENDINGS.includes(summary.ended)` with `summary.status === "killed"`; drop the import of `CUT_SHORT_ENDINGS` if nothing else uses it.
- `public.ts`: export `displayAgent` from `../runDirectory/list.js`.

- [ ] **Step 4: Run the tests and the whole run-directory suite**

Run: `pnpm exec vitest run lib/runDirectory lib/runsExplorer lib/eval/public.test.ts`
Expected: PASS. Existing tests that pinned `endedAt` to the run row's time with events present need their expected value changed to the last event's time; change only those.

- [ ] **Step 5: Commit**

```bash
git add lib/runDirectory/annotations.ts lib/runDirectory/list.ts lib/runsExplorer/rows.ts lib/eval/public.ts lib/runDirectory/*.test.ts lib/runsExplorer/rows.test.ts lib/eval/public.test.ts
git commit -m "Run rows can carry reported usage; end times come from the trace"
```

### Task 2: Read the agent and its usage from Harbor's `result.json`

**Files:**
- Modify: `lib/eval/harbor/readTrials.ts` (`HarborResultSchema`, `HarborTrial`, `trialOf`)
- Modify: `lib/eval/harbor/testFixtures.ts` (`FakeHarborTrial`, `writeHarborTrial`)
- Test: `lib/eval/harbor/readTrials.test.ts`

**Interfaces:**
- Consumes: `RunReported` from Task 1.
- Produces: `HarborTrial.agentName: string | null` (`agent_info.name`) and `HarborTrial.reported: RunReported | null`.

- [ ] **Step 1: Write the failing tests**

Extend `FakeHarborTrial` with optional `agentInfo?: { name: string; model: string }`, `agentResult?: { input: number | null; cache: number | null; output: number | null; cost: number | null }`, `agentExecution?: { startedAt: string; finishedAt: string }` and `finishedAt?: string`, written in Harbor's field names (`agent_info.model_info.name`, `n_input_tokens`, `n_cache_tokens`, `n_output_tokens`, `cost_usd`, `agent_execution.started_at`).

```ts
it("reads a Pi trial's agent and reported usage", () => {
  // agentInfo { name: "pi", model: "z-ai/glm-5.3-flash" },
  // agentResult { input: 57240, cache: 50944, output: 1404, cost: 0.00317472 },
  // agentExecution { startedAt: "2026-11-13T23:34:26.015034Z", finishedAt: "2026-11-13T23:35:34.868438Z" }
  expect(trial.agentName).toBe("pi");
  expect(trial.reported).toEqual(PI_REPORTED); // the Task 1 value
});

it("reports nothing for an Agency trial with null token counts", () => {
  // agentInfo { name: "agency-agent", ... }, agentResult all null
  expect(trial.agentName).toBe("agency-agent");
  expect(trial.reported).toBeNull();
});

it("falls back to the trial's own times without agent_execution", () => {
  // tokens present, no agentExecution; startedAt "2026-11-13T23:33:54.260502Z", finishedAt "2026-11-13T23:36:35.714892Z"
  expect(trial.reported?.startedAtMs).toBe(Date.parse("2026-11-13T23:33:54.260Z"));
  expect(trial.reported?.lastEventAt).toBe("2026-11-13T23:36:35.714Z");
});

it("reads an old result.json with none of these fields", () => {
  expect(trial.agentName).toBeNull();
  expect(trial.reported).toBeNull();
});
```

`cost_usd: null` with tokens present gives `costUsd: 0`.

- [ ] **Step 2: Run and confirm they fail**

Run: `pnpm exec vitest run lib/eval/harbor/readTrials.test.ts`
Expected: FAIL (`agentName` and `reported` undefined).

- [ ] **Step 3: Implement in `readTrials.ts`**

Add optional, nullable `agent_info`, `agent_result`, `agent_execution` and `finished_at` to `HarborResultSchema` (`z.looseObject`, like the existing fields). Add a private `reportedOf(result: HarborResult): RunReported | null`: null unless `n_input_tokens` and `n_output_tokens` are numbers; times from `agent_execution`, else `started_at`/`finished_at`, each through `toISOString()`; `durationMs` is finished minus started.

- [ ] **Step 4: Run the Harbor tests**

Run: `pnpm exec vitest run lib/eval/harbor`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/eval/harbor/readTrials.ts lib/eval/harbor/testFixtures.ts lib/eval/harbor/readTrials.test.ts
git commit -m "Harbor import: read the agent and its reported usage"
```

### Task 3: Name the agent, keep Pi trials, and `--agent`

**Files:**
- Modify: `lib/eval/harbor/planImport.ts` (`isVoid`, `planHarborImport`, `payloadOf`)
- Modify: `lib/eval/harbor/importHarbor.ts` (`importHarbor`, `finishExisting`)
- Modify: `scripts/agency.ts:1377` (the `import-harbor` command)
- Modify: `docs/dev/evals/eval-tracking.md` (the Harbor import section and the `endedAt` bullet at line 96)
- Test: `lib/eval/harbor/planImport.test.ts`, `lib/eval/harbor/importHarbor.test.ts`

**Interfaces:**
- Consumes: `HarborTrial.agentName` and `HarborTrial.reported` from Task 2.
- Produces: `planHarborImport({ trials, batch, reasoning?, agent? })` and `importHarbor({ ..., agent? })`; CLI `--agent <name>`.

- [ ] **Step 1: Write the failing tests**

`planImport.test.ts`:
- a trial with no trace and `reported` set is not void; with a reward of 1 it scores a pass and its payload has `reported`;
- a trial with no trace, `reported` set, `AgentTimeoutError` and no reward scores 0;
- a trial with neither trace nor `reported` is still void;
- `flags.agent` is the `agent` argument when given, else the trial's `agentName`, else absent;
- two trials with `agentName` "pi" and "agency-agent", no `agent` argument: each payload keeps its own name.

`importHarbor.test.ts`:
- a Pi trial imports into a folder with an empty `statelog.jsonl` and a run row holding `reported`;
- re-importing the same trial into the same folder with a different `agent` fails that run with a message containing "delete the batch folder".

- [ ] **Step 2: Run and confirm they fail**

Run: `pnpm exec vitest run lib/eval/harbor`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `isVoid`: void when `statelogPath === null && reported === null`; the rest unchanged.
- `planHarborImport` and `payloadOf` take `agent?: string`; set `flags.agent` to `agent ?? trial.agentName` when that isn't null; set `payload.reported` when `trial.reported` isn't null.
- `importHarbor` takes `agent?: string` and passes it on.
- `finishExisting`: after the Harbor-trial check, throw when `existing.row.flags.agent !== run.payload.flags.agent`: `` `${dir} was imported with agent ${old}; this import names ${new}. Delete the batch folder and import again.` ``
- `scripts/agency.ts`: `.option("--agent <name>", "Agent name for every run; defaults to each trial's agent_info.name")`, passed through.
- Docs: three or four sentences in the Harbor import section on `--agent`, `reported` and the void rule; the `endedAt` bullet becomes "the last event's timestamp, else the `run` row's `createdAt`".

- [ ] **Step 4: Run the tests and the build**

Run: `pnpm exec vitest run lib/eval lib/runDirectory && pnpm exec tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add lib/eval/harbor scripts/agency.ts docs/dev/evals/eval-tracking.md
git commit -m "Harbor import: --agent, and Pi trials import with their reported usage"
```

### Task 4: Check with real data, then open the agency-lang PR

No code. Run from `~/bench-agency`, with the worktree's CLI built (`make build && make compile-agency` in `packages/agency-lang`). `AGENCY` below is `node ~/agency-lang/.worktrees/harbor-other-agents/packages/agency-lang/dist/scripts/agency.js`.

- [ ] **Step 1: Check Pi's durations.** For 20 trials of `jobs/k1-pi` and 5 of `jobs/full-pi152-flash-high`, compare `agent_execution` (finished minus started) with the span between the first and last `timestamp` in `agent/pi.txt`. Expected: within a few seconds. If not, stop and ask the owner.
- [ ] **Step 2: Import `k1-pi`.** `$AGENCY eval import-harbor jobs/k1-pi --reasoning high --agent pi-1.5.2 --out $SCRATCH`. Expected: 500 imported, 1 void, 0 failed. `$AGENCY runs list $SCRATCH/k1-pi` shows agent `pi-1.5.2`, nonzero cost and tokens, 7 runs as killed, "1 run wrote no trace" for the void one, and a pass count equal to the number of `reward.txt` files containing `1` in `jobs/k1-pi`.
- [ ] **Step 3: Re-import `flash-high`** from the ADI-375 trials list (rebuild it with the rerun rule in `bench-agency-harbor-data` memory). Expected: `runs list` shows end times on 2026-11-11 to 2026-11-12 and agent `agency-main`.
- [ ] **Step 4: Open the PR.** Body: what changed, the real-data results above, and that statelog needs the new version before any Pi upload.

### Task 5: (owner) Publish agency-lang

The owner merges and publishes. Wait for the version number.

### Task 6: Statelog — new agency-lang, `displayAgent`, end-to-end cases

Work in a statelog worktree at `~/statelog/.worktrees/harbor-agent-names`.

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml` (agency-lang to the new version)
- Modify: `src/backend/lib/evals/evalQueries.ts` (`groupAgentName`)
- Modify: `docs/dev/eval-tracking.md` (one line: a batch's agent is `displayAgent`, the trace's name or else the harness label)
- Test: `src/backend/lib/evals/evalQueries.test.ts`, `src/backend/postgres-integration/evalUploadEndToEnd.test.ts`

**Interfaces:**
- Consumes: `displayAgent` and `RunReported` from agency-lang (Task 1), via `agency-lang/eval`.

- [ ] **Step 1: Bump agency-lang** to the published version with `pnpm add agency-lang@^<version>`; run `pnpm exec tsc -p src/backend/tsconfig.json --noEmit`.
- [ ] **Step 2: Write the failing tests**

`evalQueries.test.ts`: a batch whose runs have `agentName: null` and `agentLabel: "pi-1.5.2"` lists with `agentName: "pi-1.5.2"`; a batch whose runs carry two different labels lists with `agentName: null`.

`evalUploadEndToEnd.test.ts`, in "results-only uploads". First give `runRow` an optional second argument, `overrides: Partial<Parameters<typeof annotationId>[0]> & { createdAt?: string } = {}`, spread into the draft, with `createdAt` replacing the helper's fixed time.
- **"a newer run row replaces the older one's agent"**: `putDigest("ro-4")`, post `runRow("ro-4")`, then post the same row with `flags: { agent: "pi-1.5.2" }` and `createdAt: "2026-08-24T00:00:00.000Z"`. Expected: `summaryRow("ro-4").agent_label` is `"pi-1.5.2"`.
- **"summarizes a Pi run from its reported usage"**: `putDigest("ro-5", { digest: { ...digest, eventCount: 0, models: [], durationMs: 0, startedAtMs: null, lastEventAt: null, llmCalls: 0, toolCalls: 0, input: null, agentName: null } })`, then post a run row with `reported` equal to Task 1's `PI_REPORTED`. Expected: `total_cost` is 0.00317472, `wall_ms` is 68853, `input_tokens` is "6296", and `ended_at` equals 2026-11-13T23:35:34.868Z.

- [ ] **Step 3: Run and confirm they fail**

Run: `SECRETS_ENCRYPTION_KEY=$(openssl rand -base64 32) pnpm exec vitest run src/backend/lib/evals/evalQueries.test.ts`, then `env DB_HOST=localhost DB_PORT=5432 DB_USER=postgres DB_PASSWORD=ci DB_DATABASE=statelog_test DB_SSL=false CI=true STATELOG_INTEGRATION_TESTS=true SECRETS_ENCRYPTION_KEY=$(openssl rand -base64 32) pnpm run test:integration`
Expected: the unit case fails (agent is null). The two integration cases may already pass once the version is bumped; that's fine, they pin the behavior.

- [ ] **Step 4: Implement** `groupAgentName` with `displayAgent(summary)` in place of `summary.agentName`. Add the dev-note line.
- [ ] **Step 5: Run the full unit suite, the integration suite and `pnpm run build`.** Expected: all pass.
- [ ] **Step 6: Local check with real data.** Start a local statelog. Recreate production's state first: import `flash-high-6e9db1438` with the published CLI from before this change (`npx -p agency-lang@0.45.3 agency eval import-harbor ...`), as ADI-375 did, so its runs have no names. Upload it, then the named re-import of the same batch from Task 4 Step 3, then `$SCRATCH/k1-pi`, all with `--results-only`. Expected:
  - the batch list shows the agent names, Pi's cost and tokens, and flash-high's real end date;
  - flash-high's accuracy and cost are the same after the named upload;
  - a flash-high run's trace page shows two grading passes with the same score, which is the expected side effect.
- [ ] **Step 7: Commit and open the PR.** The PR body says the deploy needs no migration, and that `refresh-trace-summaries` should run once after deploying.

### Task 7: (with the owner) Production data

Needs: Task 6 deployed, a temporary project key in `STATELOG_API_KEY`, and a scratch folder whose `agency.json` points at production (see `statelog-production` memory).

- [ ] **Step 1: The owner runs `refresh-trace-summaries`** against production. Expected: `refreshed: N, failed: 0`.
- [ ] **Step 2: Pick the full Pi run's trials.** Apply the rerun rule to `full-pi152-flash-high`, `-rest`, `-rest2` and `-fixup`. Write `pi-flash-high.txt`. Show the owner the counts before importing.
- [ ] **Step 3: Re-import and upload the six Agency batches** with the agent names the owner confirms (spec table). Use the same trials lists and `--batch` names as ADI-375, and import into a fresh `--out` folder: an import refuses to rename the agent of an existing run folder.
- [ ] **Step 4: Import and upload `k-pi` and `pi-flash-high`.**
- [ ] **Step 5: Verify.** The production batch list shows eight SWE-bench batches, each with its agent name and real end date. Each Agency batch's accuracy and cost are unchanged from before. `pi-flash-high`'s accuracy is near the 73% in `FIXES-2026-11-13.md`.
