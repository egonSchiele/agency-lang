# Review: Harbor agent names, Pi import, real end times

Date: 2026-11-25. Reviews the plan `2026-11-25-harbor-other-agents.md` and its spec `../specs/2026-11-25-harbor-other-agents-design.md`.

The plan is sound. I checked its premises against the code and one real Pi trial, and they hold. Six findings follow, most important first. Only the first one would break the rollout.

## 1. The owner's re-import command fails for every run

The spec's step 2 re-imports `flash-high-6e9db1438` with `--out runs`. The ADI-375 import already wrote `runs/flash-high-6e9db1438`, and its run rows have no `flags.agent`. Task 3 makes `finishExisting` reject a folder whose agent differs from the new one. So all 500 runs fail with "delete the batch folder", and the same happens for the other five batches.

The check itself is right. The instructions just need to match it.

**Fix:** In the spec's owner section and in Task 7 Step 3, import into a fresh folder, such as `--out runs-named`, or delete `runs/<batch>` first. Say which one.

## 2. Pi timeouts show as "failed", and Agency timeouts show as "killed"

`statusOf` (`lib/runDirectory/list.ts:235`) returns "killed" only when `eventCount > 0`. `runsExplorer/rows.ts:116` has the same check. A Pi run never has events, so its 7 `AgentTimeoutError` runs in `k1-pi` become "failed". An Agency run that times out becomes "killed". Statelog's batch `statusCounts` will then differ by agent for the same event. Scores are not affected, because both cases score 0.

**Options:**
- Treat a run row with `reported` like a run with events in both checks. That is a small change plus one test.
- Accept it and add it to "Not in this change".

The owner should pick. I'd take the first option, because ADI-374 compares these batches side by side.

## 3. `runs list` says every Pi run "wrote no trace"

`buildRunsListing` counts each run with `eventCount === 0` as silent. `lib/cli/runDirectory/list.ts:105` then prints "500 runs wrote no trace" for `k1-pi`. The line is true, but its doc comment says it means "died before its first event", and a reader may take it that way.

**Fix:** At least add this line to Task 4 Step 2's expected output, so the implementer doesn't "fix" it on the fly. If finding 2 gets the code fix, use the same rule here.

## 4. Re-uploading adds a second grading pass to every Agency run

The re-import writes a new grading pass with new ids. The upload posts it next to the pass from 2026-11-24. Each re-imported Agency run then has two passes in statelog. The scores are equal, so accuracy doesn't change. The trace page may now say "score 1.00 (2 passes)". I did not check the statelog UI for this.

**Fix:** Add it to Task 6 Step 6's checks, and to the spec's note under "What the owner runs", as an expected side effect. Nothing needs to change in the code.

## 5. Task 6's test helper can't build the rows the plan describes

In `evalUploadEndToEnd.test.ts`, `runRow(traceId)` takes no other arguments. Both new cases need a run row with different `flags`, `createdAt` or `reported`.

**Fix:** Say that Task 6 Step 2 gives `runRow` an optional overrides argument.

## 6. A trace's own agent name hides the `--agent` name

`displayAgent` returns the trace's `agentName` before the run row's label. That works for the six batches, because their traces emit no `agentName`. But Agency traces can emit one: statelog's own end-to-end digest uses `"agency-agent/minimal"`. If a future Harbor run emits one, its `--agent` name won't show. Then every build of the agent shows the same name.

**Fix:** Add one line to the spec's "Not in this change", so the limit is written down. Don't change the order now. A label-first order would break `eval run`, whose label is a command line.

## Small notes

- **Duration check.** Task 4 Step 1 checks only `k1-pi`. `pi-flash-high` comes from `full-pi152-flash-high`, which ran 10 trials at once, so its times are probably fine. Checking 5 of its trials as well costs a minute.
- **Concurrency figure.** The spec says the `k` jobs ran 30 to 35 at once. `jobs/k1-pi/config.json` says `n_concurrent_trials: 25`. The conclusion doesn't change, but the number should match.

## What I checked and found correct

- One real trial, `k1-pi/astropy__astropy-12907__HXstdgG`, has exactly the plan's `PI_REPORTED` values: 57240 − 50944 = 6296 fresh input tokens, and 68,853 ms between the `agent_execution` times.
- `silentTraceIdOf` hashes the job and trial names, so a re-imported Pi trial keeps its trace id. A re-upload updates the same trace and doesn't duplicate it.
- `traceDigest.ts` doesn't import `annotations.ts`, so `TraceDigestSchema.pick(...)` in `annotations.ts` won't create an import cycle. The plan's fallback in Task 1 Step 3 won't be needed.
- `summarizeDigest` sets `endedAt: runRow?.createdAt ?? digest.lastEventAt` today, at `list.ts:185`, as the spec says.
- `agentLabelOf` and `displayAgent` exist, and `groupAgentName` in statelog reads `summary.agentName`, as the spec says.
- A results-only upload of a run with no events puts an all-zero digest (`digestPlan` returns "put-digest" for a "missing" trace). Task 6's Pi case tests the right path.
- Statelog stores `agent_label`, `total_cost`, `wall_ms`, `input_tokens` and `ended_at` on `trace_summaries`, so Task 6's assertions name real columns.
