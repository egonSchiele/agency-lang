# Harbor import: name the agent, import Pi, keep real run times

Date: 2026-11-25. Status: design, revised after architecture review (`2026-11-25-harbor-other-agents-design-review.md`) and plan review (`../plans/2026-11-25-harbor-other-agents-review.md`). Covers ADI-378 and the agent-name gap. ADI-374, the comparison pages, is out of scope.

## Problem

Statelog can't answer "which agent did better" for the SWE-bench batches, for three reasons.

1. **Runs have no agent name.** Statelog takes a batch's agent from the trace's own `agentName` event. Harbor runs never emit one, so the Agent column is blank. Harbor's `result.json` does name the agent family, as `agent_info.name`: `agency-agent` or `pi`. It doesn't say which Agency build ran.
2. **Pi trials can't be imported.** The importer treats a trial with no Agency trace as void, and Pi never writes one. Each Pi trial's `result.json` still has everything statelog shows: the score, tokens, cost and timings.
3. **Imported runs show the import time as their end time.** The six batches in production all "ended" on 2026-11-24, when I imported them, though they ran on 2026-11-11 to 2026-11-14. The summary takes `endedAt` from the run row's `createdAt`, which for an import is the import time. The trend chart plots batches by end time, so it stacks all six on one day.

## Decided

- **The agent name comes from a flag.** `agency eval import-harbor --agent <name>` sets it for every run in the import. Without the flag, each run takes `agent_info.name` from its own `result.json`. Choosing names stays manual, like choosing trials.
- **Pi's cost is the cost Pi reported.** Both agents price tokens the same way, which I checked on one trial each:
  - Pi reported $0.00317472. Its tokens at Z.AI's Flash prices come to $0.00317472.
  - Agency's trace logged $0.002124. Its tokens at the same prices come to $0.002124.

  So the reported costs compare directly, and nothing needs recomputing.
- **A run's end time comes from its trace.** The summary uses the trace's last event time when there is one, and the run row's time otherwise.

## What the owner runs, once both PRs ship

```
# 1. Refresh every stored summary, so older runs pick up the new end times.
node dist/backend/scripts/refresh-trace-summaries.js

# 2. Re-import each Agency batch with an agent name into a fresh folder,
#    then upload results-only.
agency eval import-harbor --trials flash-high.txt --batch flash-high-6e9db1438 \
  --reasoning high --agent agency-main --out runs-named
agency eval upload --results-only runs-named/flash-high-6e9db1438

# 3. Import and upload the Pi runs.
agency eval import-harbor jobs/k1-pi jobs/k2-pi jobs/k3-pi jobs/k4-pi jobs/k5-pi \
  --batch k-pi --reasoning high --agent pi-1.5.2 --out runs-named
agency eval upload --results-only runs-named/k-pi
```

The re-import must go into a fresh folder. An import refuses to rename the agent of a run folder that already exists, and the ADI-375 folders have runs without names.

Re-uploading statelog's copy needs no delete first. The new run rows are newer than the rows uploaded on 2026-11-24, so they become each trace's current run row, and the agent names appear.

One side effect is expected. The re-import writes a new grading pass, so each re-uploaded Agency run has two passes in statelog. Both give the same score, so accuracy doesn't change.

Proposed agent names. The owner picks the final ones.

| Batch | Agent name |
|---|---|
| `flash-high-6e9db1438` | `agency-main` |
| `matchpi2-4418c5301` | `agency-matchpi` |
| `full2-control-4418c5301` | `agency-matchpi` (the same build as round 2) |
| `full2-fixes-4418c5301` | `agency-fixes` |
| `full2-notrim-4418c5301` | `agency-fixes` (the same build, with the trim off) |
| `k-agency-minimal` | `agency-minimal` |
| `k-pi` (new) | `pi-1.5.2` |
| `pi-flash-high` (new, from `full-pi152-flash-high` and its reruns) | `pi-1.5.2` |

The full Pi run needs a hand-picked trials file, like `flash-high`. It uses the same rerun rule: keep the main trial unless it would be void, else take the first rerun that isn't.

## Changes in agency-lang

### Read more of `result.json`

`readHarborTrial` (`lib/eval/harbor/readTrials.ts`) also reads:

- `agent_info.name`, the default agent name;
- `agent_info.model_info.name`, such as `z-ai/glm-5.3-flash`;
- `agent_result`: `n_input_tokens`, `n_cache_tokens`, `n_output_tokens` and `cost_usd`;
- `agent_execution.started_at` and `finished_at`.

Every field is optional in the schema. Older jobs may lack some, and an Agency trial reports null tokens.

`n_input_tokens` includes the cached tokens. Fresh input is `n_input_tokens - n_cache_tokens`. The cost check above relies on that split.

Harbor writes timestamps with microseconds, such as `2026-11-13T23:34:26.015034Z`. The importer passes them through `new Date(...).toISOString()`, so they match trace timestamps like `2026-11-13T23:36:29.379Z`.

### Store what the harness reported

The run row gets one new optional field, `reported`. It reuses the digest's own fields:

```ts
reported?: Pick<TraceDigest, "models" | "startedAtMs" | "durationMs" | "lastEventAt">;
```

The importer fills it only when `agent_result` has token counts, so Pi trials get it and Agency trials don't. `models` holds one `ModelUsage` entry: Pi's model, the run's reasoning level, its tokens and cost, and `calls: 0`, because Pi doesn't report a call count. The times come from `agent_execution`.

`summarizeDigest` (`lib/runDirectory/list.ts`) overlays `reported` on the digest when the digest has no events. The rest of the function stays the same. An Agency trial keeps using its trace, so one run never shows two different costs.

The zod schema reuses `ModelUsageSchema` and the matching `TraceDigestSchema` fields. `RunAnnotationSchema` is strict, and statelog validates annotations with it, so statelog must move to the new agency-lang version before any Pi upload.

### Name the agent

Every Agency trace names itself: `agency-agent/coordinator` for the five full runs and `agency-agent/minimal` for the `k` runs. Those names don't tell builds apart, and a trace's own name beats a run row's label. So, by the owner's choice on 2026-11-25, `--agent` sets a new optional `agentName` on the run row, which beats the trace's own name. It follows the same rules as `setAgentName`, and the importer refuses a bad name before writing anything.

Each run also keeps Harbor's agent family, `agent_info.name`, as its `flags.agent` label. That field already exists: `agentLabelOf` reads it, and `displayAgent` shows it when nothing else names the run. Pi imported without `--agent` shows as `pi`.

`displayAgent` moves into the public `agency-lang/eval` exports, so statelog shows the same name `runs list` does.

### Count Pi trials as real runs

`isVoid` (`lib/eval/harbor/planImport.ts`) treats "no trace" as "the agent never ran". The new rule is that the agent never ran when the trial has neither a trace nor reported tokens. Everything after that check stays the same. In `k1-pi`, 499 of 500 trials report tokens. Two are void: one whose verifier timed out, and `django__django-11734`, which timed out with no tokens and an empty Pi log. That second one looks like a trial that hung before the agent started, the same pattern as three Agency trials ADI-375 treated as void and replaced with reruns.

The same idea decides two things in the run summary. Today both require events:

- A run cut short by a timeout, cost cap or kill counts as "killed" only when it has events. Otherwise it counts as "failed". A Pi run never has events, so its timeouts would count as failures while Agency's count as kills.
- `runs list` counts a run without events as one that "wrote no trace". It would say that of every Pi run.

Both now ask whether the agent left a record: events, or reported usage. After the overlay, a Pi run has a model entry, so the check is `eventCount > 0 || models.length > 0`. The run explorer reads `summary.status` instead of repeating the rule.

### Take end times from the trace

`summarizeDigest` sets `endedAt: runRow?.createdAt ?? digest.lastEventAt` today. It becomes `digest.lastEventAt ?? runRow?.createdAt`.

- Imported Agency runs get their real end times.
- Pi runs get theirs from `reported.lastEventAt`.
- A run that never started has no events, so it keeps the run row's time.
- For a normal `eval run`, the harness writes the run row seconds after the last event, so its end time barely moves.

The old order came in with eval tracking's first PR (#890), with no stated reason.

### Check Pi's durations

The `full2` jobs ran 15 trials at a time each, three jobs together, and Harbor's agent times for them were wrong. The `k` jobs ran 25 at a time each, with several jobs together. Before importing, I'll compare `agent_execution` with the first and last timestamps in `agent/pi.txt`, on 20 trials from `k1-pi` and 5 from `full-pi152-flash-high`. If they disagree by more than a few seconds, I'll stop and ask the owner.

**Result (2026-11-25):** Harbor's agent time ran 7 to 24 seconds longer than `pi.txt`, 13 seconds on average. Agency trials show the same gap against their traces, 12.5 seconds on average. So Harbor's time is the agent's own time plus harness work. Agency's durations come from its trace, so the owner chose to take Pi's times from `pi.txt` too: the earliest and latest timestamps in it. Harbor's `agent_execution` is the fallback when the log has fewer than two timestamps.

## Changes in statelog

1. **Move to the new agency-lang version.**
2. **Show the agent name for imported runs.** `groupAgentName` (`src/backend/lib/evals/evalQueries.ts`) uses `displayAgent(summary)` instead of `summary.agentName`. The index's Agent column and agent filter then work for Harbor batches.
3. **Test the re-upload.** The end-to-end suite gains a case: a results-only trace receives a second upload with a newer run row, and its summary follows the newer row.

## Not in this change

- **The comparison pages** (ADI-374).
- **Other agents' trials,** such as OpenCode and mini-SWE-agent. They import the same way if their `result.json` reports tokens. I haven't checked that they do.
- **A "no trace" label in the runs table.** A Pi run's trace page already says that no events were uploaded.
- **Pi's call count and tool calls.** They show as 0. Counting them means parsing Pi's own log format.
- **A per-batch agent field in statelog.** It would name the six batches without a re-upload, but it would be a second source for the agent name.

## Documentation

- agency-lang `docs/dev/evals/eval-tracking.md`:
  - a few lines in the Harbor import section on `--agent`, `reported` and the void rule;
  - the `endedAt` bullet updated.
- statelog `docs/dev/eval-tracking.md`: one line on `displayAgent`.
- Nothing in the user guide, because `import-harbor` is a hidden command.

## Testing

- **agency-lang unit tests:**
  - `readHarborTrial` with a Pi `result.json` fixture, and with an Agency one;
  - `isVoid` for a Pi trial with tokens and no trace, and for an Agency trial with neither;
  - `summarizeDigest` uses `reported` only when there are no events;
  - `endedAt` prefers the trace and falls back to the run row;
  - a Pi run that timed out counts as "killed", and isn't counted as one that wrote no trace;
  - `--agent` wins over `agent_info.name`.
- **statelog:**
  - `groupAgentName` with label-only runs;
  - the re-upload end-to-end case above.
- **Real data, before uploading to production:**
  - import `k1-pi` and compare `runs list` with Pi's own pass count;
  - re-import `flash-high` and check its end time;
  - upload both to a local statelog twice, then check the batch pages.

## Order of work

1. agency-lang PR, then a release.
2. statelog PR: the version bump, `displayAgent` and the end-to-end case.
3. Data, run by the owner with me:
   - refresh the summaries;
   - re-import and upload the six Agency batches with names;
   - import and upload the two Pi batches.

   Results-only uploads take about 7 minutes per 500 runs in production, so the 8,000 runs take about two hours.
