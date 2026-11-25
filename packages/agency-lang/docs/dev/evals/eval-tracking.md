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

`batchUsage` (same file) sums a batch's token totals and per-model usage
entries over its runs, and gives its benchmark: the runs' shared value, or
the distinct values sorted and joined with ", " when they differ. It is a
separate function because it applies to any batch, including one whose trial
grid `batchStatistics` refuses. Statelog still shows those batches, and it
reads their usage from `batchUsage` instead of summing anything itself.

## One summary derivation, including silent runs

`summarizeRunDirectory(snapshot)` and `summarizeEvalRun(input)` share one
private derivation in `lib/runDirectory/list.ts`, `summarizeDigest`: every
event-derived field comes from the trace's digest (`digestTrace` in
`traceDigest.ts`, see "Results-only uploads"), combined with the
annotations. The rules:

- A run with no events still summarizes: zero cost, calls, duration, and
  models; its identity, outcome, batch, trial, and suite come from the
  `run` row. A directory with neither a trace nor a run row is not a run.
- `status`: `ok` when the harness saw a clean finish. `killed` when it cut
  the run short after the agent left a record, meaning events or usage the
  harness reported. A cut is a timeout, cost cap, or signal. `failed` for every other harness outcome, including a silent run.
  `trace` when there is no harness row at all, which means an ad-hoc
  directory. The `RunStatus` type also declares `partial`, but `statusOf`
  never returns it.
- `endedAt`: the last event's timestamp, else the `run` row's `createdAt`.
  An imported run's row is written at import time, so the trace's own time
  comes first.
- A run with no events takes its usage and times from the `run` row's
  `reported` field when there is one. An importer fills it for an agent
  that writes no trace, such as Pi.
- `latestScore` is the weighted mean of the scores on record; `score` is
  what the run counts as in a mean: the effective score when the run ended
  `ok`, null when it ended `void` (so accuracy leaves it out), and
  otherwise the effective score or 0 if ungraded. Grading writes no score
  row for a run that did not finish, so without this field a batch mean
  would quietly skip its crashes.
- `agency eval grade` doesn't follow this rule for `void` runs: it
  counts every run it can't grade as 0. On an imported Harbor batch with one
  pass, one fail and one void run, `runs list` gives 0.5 and
  `eval grade` gives 0.33. Imported batches aren't graded today, so the two
  are left to differ.

`summarizeEvalRun` takes canonical rows (`traceId`, the trace's events in
order, its annotation rows) and checks every row belongs to that trace.
That is the boundary statelog uses: hand over the stored rows, get the
summary back. Statelog must not reconstruct a `RunDirectorySnapshot`, fold
annotations itself, or repeat any score, status, cost, or timestamp
arithmetic; none of those internals are exported.

## `agency eval upload`

`evalUpload(targets, target)` in `lib/cli/eval/upload.ts`, registered as
`agency eval upload <paths…>`. It uploads to the project in `agency.json`
only (`log.host`, `log.projectId`; key from `$STATELOG_API_KEY`); there are
no host, project, or key flags on purpose.

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

4. Split the events with `requestChunks` (in `evalUploadClient.ts`): at most
   `EVENTS_PER_REQUEST` (500) events and `MAX_REQUEST_BYTES` (5 MiB,
   statelog's body limit, measured on the exact body) per request. This
   happens before any post, so a run with an event too big for a request of
   its own is refused whole instead of leaving a trace that can't be
   finished. Post each chunk to
   `POST /api/projects/:slug/logs/bulk`, each with its 0-based `sequence`
   (its position in the file). Then post every annotation row to
   `POST /api/projects/:slug/annotations`, which upserts by the row's
   deterministic id.

Events always go before annotations, and a refused plan posts neither: an
annotation summarizes a trace, and the server must never hold a score for
a trace it cannot complete. A failure on one directory is reported and the
next one still uploads. Running the command twice is safe: events skip,
annotations upsert.

Runs upload through a bounded pool, and each one prints its line as it
finishes (`reportProgress` in `EvalUploadOptions`). The result names
the statelog batch page (`/projects/evals/batch?id=<slug>&batch=<batch>`)
only when every uploaded run shares one batch id; statelog keys the page
by project and batch alone.

The client, `lib/cli/statelog/evalUploadClient.ts`, is the seventh sealed
statelog client (`docs/dev/hosting/statelog-clients.md`).

## Results-only uploads

`agency eval upload --results-only` sends each run's **trace digest**
(`PUT /api/projects/:slug/traces/:traceId/digest`) and its annotations, and
no events. For SWE-bench runs that is about 2 KB per run instead of about
3.7 MB. Statelog summarizes from the digest plus the annotations, so its
eval pages show the same numbers; the trace itself can't be viewed.

- **The digest** (`TraceDigest` in `lib/runDirectory/traceDigest.ts`) is
  the event half of `RunSummary`: input, agent name, start and last-event
  times, duration, call counts, event count, code hash, the trace's own
  ending, and per-model usage. Reasoning stays null where the trace
  recorded none; `withFallbackReasoning` applies the run row's level when
  the digest meets the annotations. Every summary goes through the digest,
  so a digest and its events can't disagree (`traceDigest.test.ts` checks
  both ways on every fixture).
- **Plan:** the pure `digestPlan(state)` puts the digest when the server
  says `missing` or `empty` (a results-only trace reads as `empty`, so a
  rerun just puts it again), and refuses `live`, `bulk-prefix` and
  `invalid`. Statelog refuses the mixed cases too, in both directions,
  with a failure envelope the client reports as a failed run.
- **Versioning.** A stored digest can't be recomputed, because its events
  were never uploaded. So `TraceDigestSchema` only grows: new fields are
  optional, a non-additive change bumps `version`, and every past version
  must still parse and summarize (the frozen
  `fixtures/traceDigest-v1.json` checks this; never edit it). The schema is
  `.strict()`, so a statelog older than the uploading CLI refuses a field
  it doesn't know rather than dropping it. Statelog must run an
  agency-lang at least as new as the CLI that uploads to it.

Design: `docs/superpowers/specs/2026-11-24-results-only-upload-design.md`.

## Importing Harbor jobs

`agency eval import-harbor` (hidden from `--help`) converts Harbor trials into run folders that `runs list` reads and `eval upload` sends. The code is in `lib/eval/harbor/`: a reader, a pure planner, and a writer that goes through `recordCompletedRun` and `recordGradingPass`. Design: `docs/superpowers/specs/2026-11-23-harbor-import-design.md`.

```
agency eval import-harbor [<job folder>...] [--trials <file>] --out <dir> [--batch <name>] [--reasoning <level>] [--agent <name>]
```

- **Input:** job folders (every trial, by `started_at`), a `--trials` file (one trial folder per line, in order), or both. The command never picks or drops trials: choosing which reruns replace which attempts is done by hand, in the `--trials` file.
- **One call is one batch.** With one job folder and no `--trials`, the batch is the folder's name; otherwise `--batch` is required. Each test's trials are numbered 1, 2, 3… in input order. Uneven trial counts are reported, because batch statistics then give no accuracy.
- **Examples:**
  - `k1-agency-minimal` alone is batch `k1-agency-minimal`, trial 1 per test;
  - `k1`…`k5` with `--batch k-agency-minimal` give trials 1–5;
  - `--trials flash-high.txt --batch flash-high` imports a hand-picked list.
- **Scoring:**
  - a reward is the score, even after a timeout;
  - no reward with `AgentTimeoutError` or `NonZeroAgentExitCodeError` (and a trace or reported tokens) scores 0;
  - anything else with no reward, and every trial with neither a trace nor reported tokens, ends `void` with no score. A void trial with no trace is a silent run with an empty `statelog.jsonl`.
- **Agents that write no trace,** such as Pi, report their tokens and cost in `result.json`. The importer stores them, with the agent's start and finish times, as the run row's `reported` field. Fresh input is `n_input_tokens - n_cache_tokens`. Pi's times come from its own log, `agent/pi.txt`, because Harbor's agent time adds about 12 seconds of harness work that an Agency trace leaves out. Pi stamps a message when it starts, so the log misses a long final message or a hang until the timeout. When Harbor's time is more than a minute longer than the log's, the importer uses Harbor's.
- **Agent name:** `--agent` sets the run row's `agentName`, which beats the trace's own name. Agency traces name themselves by brain (`agency-agent/coordinator`), which doesn't tell builds apart. Each run also keeps `agent_info.name` from its `result.json`, such as `pi`, as its `flags.agent` label.
- **Re-running is safe:** a folder holding the same Harbor trial (`flags.harborJob`/`harborTrial`) under the same agent name is left alone or only gets its scores. A folder holding a different trial, or the same trial under another agent name, fails. Only planned folders are checked, so re-importing a smaller selection needs `<out>/<batch>` deleted first.

## Agent names are labels

A run's agent can come from three places. They rank in this order:

1. the `run` row's `agentName`, which an importer's `--agent` sets;
2. the trace's own `agentName` event, from `setAgentName`;
3. the `run` row's `flags.agent` label: an agent file, a command line, or
   Harbor's agent family.

The summary folds the first two into `RunSummary.agentName`. Two functions
then add the label. `displayAgent` (`lib/runDirectory/list.ts`), which
`runs list` and statelog use, shows the label as it is. `resolveAgentName`
(`lib/runsExplorer/identity.ts`), which the runs explorer uses, shortens it
to its file name or command.

`setAgentName` (`std::statelog`) names the agent a trace belongs to.
Statelog treats the name as a filterable label on a batch, not a URL key:
its evals pages are keyed by project and batch, and a batch shows an agent
only when every run shows the same one by `displayAgent`. The rule in `lib/statelog/agentName.ts` —
letters, digits, `.`, `_`, `-`, and `/` between segments; at most 200
characters; no empty, `.`, or `..` segment — keeps a name one clean token
that stays intact wherever a URL carries it. An invalid name throws at
the call site, inside or outside an Agency frame. The agency agent names itself `agency-agent/<brain>`
(`lib/agents/agency-agent/lib/agentName.agency`) right after it picks its
brain, so runs group per brain.

## What `agency-lang/eval` exports for statelog

`summarizeEvalRun` with `EvalRunInput`, `RunSummary`, `RunStatus`, `ModelUsage`;
`displayAgent`, the name a listing shows for a run's agent;
`batchStatistics`, `batchStatisticsByBatch`, `batchUsage` and their types;
`AnnotationSchema`, `annotationId` and the annotation types;
`TraceDigestSchema` and `TraceDigest`;
`EventEnvelope`; `agentNameProblem`, `AGENT_NAME_PATTERN`,
`AGENT_NAME_MAX_LENGTH`. They all live in `lib/eval/public.ts`, alongside
the unchanged grader-authoring exports.
`lib/eval/public.test.ts` also checks that the run directory reader, the
trace parser, the annotation fold, and `digestTrace` are not exported.

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
a cheaper smoke run (it still calls the paid agent, grades, and uploads).

The agent runs the way the suite's README says: inside the eval Docker image
via `run-in-docker.sh`, with `--policy approve-all`, because the tests write
and run code. That gives the agent a shell and the network, so the workflow
bounds what a misbehaving or prompt-injected run can reach: the container
sees only the LLM key and the run directory; every secret is set on the one
step that needs it, never job-wide; and the LLM key is a dedicated
`AGENT_EVALS_OPENAI_API_KEY` with its own spend limit, so a leak costs at
most that limit until it is rotated. Secrets: `AGENT_EVALS_OPENAI_API_KEY`
and `STATELOG_API_KEY`; the host and project come from `agency.json`
(`log.host`, `log.projectId`). The run
directory becomes a workflow artifact only when the upload failed, because it
holds every trace and artifacts on a public repo are public.

Cost: `eval.limits.maxBatchCostUsd` in `agency.json` caps the whole batch —
once finished runs have spent that much, no further test starts — and
`maxCostUsd` caps each run on its own, so the worst case is the batch cap plus
`--parallel` per-run caps (see `docs/site/cli/eval.md`). Grading judges are
outside both. The caps apply to local runs of the suite too; set them from the
batch table's real costs. A batch cut short by the cap has an uneven trial
grid: `eval grade` reports it as having no statistics (never throws), and
statelog shows it as incomplete.

Scores never fail the job: `eval run` exits 2 when some tests errored and
`eval grade` exits 2 when a must-pass gate failed; the workflow treats both as
warnings and carries on to the upload. Any other non-zero exit (could not run,
grading broke) fails the job. `lib/cli/eval/workflowFlags.test.ts` checks
every flag the workflow passes against the CLI's registered options.
