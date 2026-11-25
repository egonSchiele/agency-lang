# Architecture review: Harbor import, agent names, Pi, run times

Reviews `2026-11-25-harbor-other-agents-design.md`. Date: 2026-11-25.

## Summary

The goal is right and most of the design is small. One part is not. The fix for end times stamps each run row with the trial's finish time. That forces a new statelog delete script, a delete step before every re-upload, and a new rule about annotation timestamps. A simpler fix gets the same result: the summary takes a run's end time from its trace when the trace has one. Then the delete script, the `now` stamping and the delete step all go away.

The second finding is smaller. The new `reported` field repeats fields that `TraceDigest` and `ModelUsage` already define. It should reuse them.

## Major features and public API

The design touches two public things.

1. **The run row format (`RunAnnotationSchema`).** Every `eval run` writes this row, and statelog validates it, so it's one of agency-lang's most used formats. The design adds an optional `reported` field that only imports fill. `benchmark` and `reasoning` set the precedent: both are optional fields "for imported runs". The schema is strict, so an older reader refuses a row with the new field. That means statelog must upgrade before the first Pi upload, as the design says. An older `agency` CLI reading a newer run folder fails the same way. That's acceptable for an additive change.
2. **`displayAgent` in `agency-lang/eval`.** This adds one export. Statelog and `runs list` should show the same agent for the same run, so tying them together is right.

Changing how `endedAt` is chosen, as recommended below, touches every run summary, not just imports. For a normal `eval run`, the harness writes the run row seconds after the last event, so the two times barely differ. The change is deliberate and it's small. Statelog's stored summaries keep their old end times until they're refreshed. The re-uploads refresh the six batches. `refresh-trace-summaries` should run once for the rest.

## Effort and impact

| Task | Effort | Impact | Verdict |
|---|---|---|---|
| `--agent` flag into `flags.agent` | small | high: no comparison works without it | keep |
| Export `displayAgent`; statelog's `groupAgentName` uses it | small | high | keep |
| Read Pi's `result.json`; `reported`; the new void rule | medium | high: Agency against Pi is the comparison the owner wants to show | keep |
| Real end times by stamping `createdAt` | small in itself | high | **replace** (next section) |
| Statelog delete script and its integration test | medium | none once the replacement lands | **drop** |
| Check Pi's durations against `pi.txt` on 20 trials | small | medium | keep the check |
| A `pi.txt` parser as the duration fallback | medium | low | **drop**. If the check fails, ask the owner. |
| Re-uploading the six Agency batches (about 70 minutes) | machine time | needed for agent names | keep |

**Documentation should stay small.** The Harbor import section of `docs/dev/evals/eval-tracking.md` needs a few lines: `--agent`, `reported`, and the new void rule. Change the `endedAt` bullet on line 96. Statelog's dev note needs one line about `displayAgent`. Nothing goes in the user guide, because `import-harbor` is a hidden command.

**Tests should stay unit-level.** No new integration test is needed once the delete script is gone. The real-data checks run by hand, not in CI.

## The 80/20 rule

### End times: read them from the trace

The design stamps each run row's `createdAt` with the trial's finish time. Because statelog and agency-lang both treat the newest run row as current, the Nov 24 rows already in production would beat the corrected ones. So the design adds a statelog script that hard-deletes a batch before each re-upload.

There's a smaller fix. `summarizeDigest` sets `endedAt: runRow?.createdAt ?? digest.lastEventAt`. Flip the order to `digest.lastEventAt ?? runRow?.createdAt`. A run's end time is then its last event's time whenever it has a trace, and the run row's time only when it has none.

- Agency imports get their real end times without stamping anything.
- Pi runs have no trace, so `reported` supplies `lastEventAt` as the agent's finish time.
- Annotation timestamps keep their meaning: when the row was written.
- A re-upload needs no delete. The new run rows are newer than the Nov 24 rows, so they win, and the agent names show up.

The rule came in with eval tracking's first PR (#890) with no stated reason. A run that never started has no events, so it falls back to the run row's time, as it does today.

This drops the delete script, its integration test, the `now` stamping, the "same ids on re-import" property and the delete step. The cost is one changed line in a widely used function, plus a summary refresh in statelog.

### Agent names: a statelog field instead of a re-import

Statelog now has `eval_batch_descriptions`. An `agent` field there would name the six batches with no re-import and no re-upload. I don't recommend it. Agency-lang treats the agent as a property of each run (`displayAgent`), and a second, per-batch source of truth in statelog would disagree with `runs list`. The re-upload costs about 70 minutes of machine time and no code.

## Reusing code

**`reported` should reuse existing types.** The design spells out `model`, three token counts, `costUsd`, `startedAt` and `durationMs`. That is one `ModelUsage` entry plus three `TraceDigest` fields under different names. Reuse them:

```ts
reported?: Pick<TraceDigest, "models" | "startedAtMs" | "durationMs" | "lastEventAt">;
```

The importer builds one `ModelUsage` entry with `calls: 0` and the run's reasoning level. `summarizeDigest` then overlays `reported` on the digest when the digest has no events. The rest of the function stays the same. The zod side reuses `ModelUsageSchema` and the matching `TraceDigestSchema` fields.

This also covers `lastEventAt`, which the end-time fix needs.

The design already reuses `flags.agent`, `--reasoning`, the trials file and the rerun rule.

## Reusing and unifying concepts

The reader learns one new idea: a run row can carry what the harness reported, for a run with no trace. Framing `reported` as "the digest fields the harness reported" connects it to `TraceDigest`, which already means "what a summary needs from a trace". The design adds no other concept once the delete script is gone.

## Tying concepts together

- **`reported` tied to `TraceDigest`.** This is the right tie. If the summary ever needs another digest field from a traceless run, the type points there. `TraceDigest` is versioned and additive-only, so the picked fields won't change under stored rows.
- **`displayAgent` shared by statelog and `runs list`.** This tie is right too, as above.
- **`endedAt` shared by every run kind.** One rule for all runs is simpler than an import-only special case.

## Risks to check during implementation

1. **Re-uploading run rows to a results-only trace.** The design depends on new run rows winning over old ones in statelog. The end-to-end suite covers a re-grade after a results-only upload, but not a new run row. Add that case, or check it once with a local statelog before uploading to production.
2. **`lastEventAt` format.** Checked: a Harbor Agency trace's last `data.timestamp` is ISO 8601 UTC, like `createdAt`, for example `2026-11-13T23:36:29.379Z`. The importer should write Pi's `lastEventAt` in the same form, by passing Harbor's microsecond timestamps through `new Date(...).toISOString()`.
3. **Pi's durations.** Run the 20-trial check before importing `k-pi`.

## Recommended changes to the design

1. Replace "Keep the real run times" with the `endedAt` flip. Drop the `now` stamping and the delete script, along with its section and test.
2. Define `reported` as `Pick<TraceDigest, "models" | "startedAtMs" | "durationMs" | "lastEventAt">`.
3. Drop the `pi.txt` duration fallback. Keep the check, and stop to ask if it fails.
4. Add `refresh-trace-summaries` to the data steps, after the statelog upgrade.
5. Add the re-upload case to the end-to-end tests.
6. Trim the docs plan to the few lines above.
