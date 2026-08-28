# Eval tracking: trials, batches, and uploading runs to statelog

This is the agency-lang half of "track how the agency agent scores over
time". The whole pipeline is: run a suite several times (`eval run
--trials`), grade it (`eval grade`), upload the run directories to statelog
(`eval upload`), and let statelog draw the trend from the uploaded rows.
Statelog's side (storage, endpoints, pages) and the weekly CI job are later
pull requests; this note records what they can rely on.

## Terms

- **Run directory**: one folder per run, `statelog.jsonl` plus
  `annotations.jsonl` (`docs/dev/evals/run-directory.md`). Still the only thing
  grading reads and the only thing upload sends.
- **Batch**: one invocation of `eval run` over a suite. Its id is the group
  directory's name plus a unique suffix (`nightly-Xy12Zk9q`), minted once
  per invocation, so two groups that share a name (`team-a/nightly`,
  `team-b/nightly`) never merge when graded or uploaded together. Every run
  the invocation writes carries it.
- **Trial**: one repetition of one test inside a batch, numbered from 1.
- **Silent run**: a run that died before writing a single event. The
  harness still records its `run` row, so the failure is evidence, not a
  gap.
- **Summary** (`RunSummary`): one row of derived facts about one run:
  test, agent, batch, trial, status, timestamps, cost, calls, models, score.

## What `eval run --trials k` writes

Every harness `run` row now carries `batch` and `trial`
(1-based). `flags.trials` records how many were asked for. With one trial
the layout is unchanged, `<out>/<testId>/`; with more it is
`<out>/<testId>/<trial>/`, so a test's repetitions sit together and the old
flat groups keep working. Jobs are scheduled trial-major (`a/1, b/1, a/2,
b/2`): an interrupted suite leaves behind complete trials, which is what
the statistics need. Running `--trials` into a group that already holds a
flat single-trial run for a test is an error for that test: trial
directories beneath an existing run would be invisible to discovery, which
takes the parent as the run.

`findRunDirectories` looks at most two levels down a group and never enters
`.staging`. The trial count is validated in `runSuite` itself (a finite
positive integer), not only by the CLI flag parser, because `runSuite` is
also an API.

## Batch statistics: a complete grid, paired by trial

`lib/eval/batchStatistics.ts` is pure and is never stored; it is recomputed
from summaries wherever they live. `batchStatisticsByBatch` splits
summaries by batch id (a run without one is a batch of its own), and
`batchStatistics` computes one batch:

- per test: mean score over its scored trials, sample standard deviation
  over the square root of the count (null below two scored trials), mean
  cost and duration;
- per batch: accuracy (mean over every scored run) and a standard error
  over the **per-trial batch means**, pairing trial 1 of every test as one
  sample, trial 2 as the next, and so on. This is why the trial index must
  be durable: for scores `[1, 0]` and `[0, 1]`, pairing by index gives
  trial means `[0.5, 0.5]` and SE 0; any other pairing gives something
  else.

It refuses what would make that pairing a lie: runs from different batches,
duplicate or gapped trial indices within a test, and an uneven grid (one
test with three trials, another with two). A batch is whole or it is not
reported.

`eval grade` prints one block per batch that ran more than one trial
(`fib  score 0.667 ± 0.333 (3 trials, $1.20 each)`, then `accuracy … over N
tests × k trials, $total`). Several selected batches are grouped by their
batch id and headed `batch <id>`, never merged.

## One summary derivation, including silent runs

`summarizeRunDirectory(snapshot)` and `summarizeEvalRun(input)` share one
private derivation in `lib/runDirectory/list.ts`. The rules:

- A run with no events still summarizes: zero cost, calls, duration, and
  models; its identity, outcome, batch, trial, and suite come from the
  `run` row. A directory with neither a trace nor a run row is not a run.
- `status`: `ok` when the harness saw a clean finish. `killed` when it cut
  the run short after events existed, meaning a timeout, cost cap, or
  signal. `failed` for every other harness outcome, including a silent run.
  `trace` when there is no harness row at all, which means an ad-hoc
  directory. The `RunStatus` type also declares `partial`, but `statusOf`
  never returns it.
- `endedAt`: the `run` row's `createdAt`, else the last event's timestamp.
- `latestScore` is the weighted mean of the scores on record; `score` is
  what the run counts as in a mean, by grading's own rule (`gradeRun.ts`:
  a run that did not finish scores zero). Grading writes no score row for
  such a run, so without this field a batch mean would quietly skip its
  crashes.

`summarizeEvalRun` takes canonical rows (`traceId`, the trace's events in
order, its annotation rows) and checks every row belongs to that trace.
That is the boundary statelog uses: hand over the stored rows, get the
summary back. Statelog must not reconstruct a `RunDirectorySnapshot`, fold
annotations itself, or repeat any score, status, cost, or timestamp
arithmetic; none of those internals are exported.

## `agency eval upload`

`evalUpload(targets, target)` in `lib/cli/eval/upload.ts`, registered as
`agency eval upload <paths…>`. It uploads to the linked project only
(`agency remote link`, key from `$STATELOG_API_KEY`); there are no host,
project, or key flags on purpose.

Runs upload concurrently (they are independent traces); within one run, in
order:

1. Read the directory once and summarize it. The trace id comes from the
   trace, or from the sole `run` row for a silent run.
2. Ask the server what it holds: `GET
   /api/projects/:slug/traces/:traceId/upload-state`, one of
   `missing`, `empty`, `live` (rows streamed while the agent ran, no
   sequence), `bulk-prefix` (every row sequenced, exactly
   `0..nextSequence-1`), or `invalid` (mixed, duplicated, or gapped). The
   **server** proves the state; the client only parses it, and rejects a
   `bulk-prefix` whose `eventCount` and `nextSequence` disagree.
3. Decide with the pure `eventPlan(state, fileEvents)`:

   | server says | file has | plan |
   |---|---|---|
   | missing | 0 events | create the trace by posting `events: []` |
   | missing / empty | events | upload all |
   | empty | 0 events | skip |
   | live, same count | | skip |
   | live, other count | | refuse (a live trace cannot be completed by upload) |
   | bulk-prefix, same count | | skip |
   | bulk-prefix, fewer | | resume at `nextSequence` |
   | bulk-prefix, more | | refuse |
   | invalid | | refuse, with the server's reason |

4. Post events in chunks of `EVENTS_PER_REQUEST` (500) to
   `POST /api/projects/:slug/logs/bulk`, each with its 0-based `sequence`
   (its position in the file). Then post every annotation row to
   `POST /api/projects/:slug/annotations`, which upserts by the row's
   deterministic id.

Events always go before annotations, and a refused plan posts neither: an
annotation summarizes a trace, and the server must never hold a score for
a trace it cannot complete. A failure on one directory is reported and the
next one still uploads. Running the command twice is safe: events skip,
annotations upsert.

The result names the statelog batch page only when every uploaded run
shares one batch id and one agent name, and that name passes
`agentNameProblem`. An older trace may carry a name from before validation;
`..` would be folded out of the URL, so no link is better than a wrong one.

The client, `lib/cli/statelog/evalUploadClient.ts`, is the seventh sealed
statelog client (`docs/dev/hosting/statelog-clients.md`).

## Agent names are URL segments

`setAgentName` (`std::statelog`) names the agent a trace belongs to, and
statelog puts that name in a path: `/evals/agents/<name>/batches/<batch>`.
So the rule in `lib/statelog/agentName.ts` is: letters, digits, `.`, `_`,
`-`, and `/` between segments; at most 200 characters; no empty, `.`, or
`..` segment (a URL parser folds those away even when percent-encoded). An
invalid name throws at the call site, inside or outside an Agency frame.
The agency agent names itself `agency-agent/<brain>`
(`lib/agents/agency-agent/lib/agentName.agency`) right after it picks its
brain, so runs group per brain.

## What `agency-lang/eval` exports for statelog

`summarizeEvalRun` with `EvalRunInput`, `RunSummary`, `RunStatus`;
`batchStatistics`, `batchStatisticsByBatch` and their types;
`AnnotationSchema`, `annotationId` and the annotation types;
`EventEnvelope`; `agentNameProblem`, `AGENT_NAME_PATTERN`,
`AGENT_NAME_MAX_LENGTH`. They all live in `lib/eval/public.ts`, alongside
the unchanged grader-authoring exports.
`lib/eval/public.test.ts` also checks that the run directory reader, the
trace parser, and the annotation fold are not exported.

## What the statelog pull request must provide

- `logs.sequence` (nullable) with a unique `(trace_id, sequence)`; bulk
  ingest stores the sequence, live ingest leaves it null. Trace
  reconstruction orders by sequence.
- `POST /api/projects/:slug/logs/bulk` accepting `{ traceId, events:
  [{ sequence, event }] }`, creating the trace when it does not exist, and
  accepting `events: []` (that is how a silent run's trace is created,
  because `POST /api/traces` is session-only).
- `GET /api/projects/:slug/traces/:traceId/upload-state` returning the
  discriminated state above, proven from the stored rows.
- `POST /api/projects/:slug/annotations` recomputing `annotationId` from
  the row before writing and refusing an existing id whose project or
  trace differs.
- A per-trace summary computed by calling `summarizeEvalRun` on the stored
  rows (after a bulk upload's annotations land, and after a live trace's
  end event), stored for filtering and charts.

## Where this deviates from the spec

- The spec described the upload-state endpoint as `{ count, maxSequence }`.
  That cannot tell a partly live-streamed trace from a resumable bulk
  prefix, so it became the discriminated state above.
- The spec said the summary "only gains batch and trial". It also gained
  `status`, `endedAt`, `eventCount`, `suiteSource`/`suiteSha`, and `score`,
  and silent runs, because statelog needs those and must not derive them
  itself.

## The weekly CI run

`.github/workflows/agent-evals.yml` runs `evals/agency-agent` with three
trials every Sunday (03:00 UTC), grades it, and uploads it to the linked
statelog project. `workflow_dispatch` takes `trials` and `suite` overrides for
a cheaper smoke run (it still calls the paid agent, grades, and uploads). It
needs the `OPENAI_API_KEY`, `STATELOG_API_KEY`, and `STATELOG_PROJECT_URL`
secrets (the last is a serve URL, as `remote link --url` takes).

Cost: `eval.limits.maxBatchCostUsd` in `agency.json` caps the whole batch —
once finished runs have spent that much, no further test starts — and
`maxCostUsd` caps each run on its own, so the worst case is the batch cap plus
`--parallel` per-run caps (see `docs/site/cli/eval.md`). Grading judges are
outside both. The caps apply to local runs of the suite too; set them from the
batch table's real costs. A batch cut short by the cap uploads as incomplete.

Scores never fail the job: `eval grade` exits 2 when a must-pass gate failed,
and the workflow treats that as a warning and uploads anyway; any other
non-zero exit (grading broke) fails the job. The run directory is kept as a
workflow artifact for 14 days, so a batch whose upload failed can be uploaded
by hand. `lib/cli/eval/workflowFlags.test.ts` checks every flag the workflow
passes against the CLI's registered options.
