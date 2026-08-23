# Tracking the agency agent's eval performance over time

Date: 2026-08-22. Status: design, revised after review (v2).

Review: `2026-08-22-eval-tracking-pipeline-design-review.md` (same directory).
Every finding there is addressed in this revision; the "Changes in v2"
section at the end lists them.

## Why

We now have evals that run against the agency agent (`evals/agency-agent`,
three tests today) and a run directory format that holds everything a run
produced. What we do not have is any way to see how the agent's performance
moves over time. Every eval run lands in a directory under `runs/` on one
machine and is forgotten.

The goal of this work is a pipeline where a suite run ends up in statelog (the
web app at `/Users/adityabhargava/statelog`, which already stores agent traces
for people who deploy agents there), and statelog shows score, cost, and time
per batch, per test, and per agent, over time. Once that exists, three things
become possible that are not possible today:

- A weekly CI job that runs the suite against the agent on `main` and records
  the result, so a regression shows up as a dip on a chart instead of never.
- Comparing two "brains" of the agency agent (the directories under
  `lib/agents/agency-agent/brains/`) on the same suite, which is how we intend
  to decide which way to take the agent.
- Later, statelog running and grading eval suites itself, for any user's
  agent, on a schedule or whenever the agent changes. Nothing in this design
  builds that, but everything in it is what that would need: the data a
  hosted runner would produce is exactly the data this pipeline uploads.

The pipeline does not try to make the agent pass every test. It records.

## Terms

- **Test**: one directory under a suite, with a `test.json` and the files the
  agent is given. `evals/agency-agent/fib` is one.
- **Suite**: a directory of tests. `evals/agency-agent` is one.
- **Run**: one test executed once by the agent. A run has one trace (one
  `statelog.jsonl`, one trace id) and one run directory.
- **Trial**: when a test is executed more than once in the same invocation,
  each execution is a trial. Today every test has exactly one trial.
- **Batch**: one invocation of `eval run` over a suite. A batch holds
  `tests × trials` runs. On disk it is the group directory `eval run` writes
  (`runs/2026-08-22-191537-1M1cHC/`), whose name is the batch id.
- **Run directory**: the on-disk shape described in `docs/dev/run-directory.md`.
  The parts this design touches are `statelog.jsonl` (the trace) and
  `annotations.jsonl` (the verdicts).
- **Annotation**: one row in `annotations.jsonl`. Three kinds exist: `score`
  (one grader's verdict on one run), `run` (the harness's own row: which test,
  which suite, how the run ended), and `checklist` (a person's sign-off).
  Ids are deterministic (a hash of trace id, annotator and payload), so the
  same opinion always has the same id.
- **Agent name**: the string an agent sets with `setAgentName(...)` from
  `std::statelog`. It is recorded as an `agentName` event in the trace, and
  cross-run tools group runs by it.
- **Statelog** (the app): the web app. It has projects, traces, and logs
  (one row per trace event), ingested live over HTTP by agents whose config
  names it as `log.host`. Agency-lang already has sealed clients for its API
  under `lib/cli/statelog/` (`docs/dev/statelog-clients.md`).

## What exists that this builds on

In agency-lang:

- `eval run` writes one run directory per test, with the trace and a `run`
  annotation whose payload is `{ test, suite: { source, sha? }, graders?,
  harness?, ended, flags, error? }` (`lib/runDirectory/annotations.ts`,
  `lib/eval/run/runSuite.ts`). `suite.sha` is the commit of a suite fetched
  from a git URL; it answers "which version of the suite was this", and this
  design does not change or reuse it for anything else.
- `eval grade` reads a group, grades every run, and appends `score`
  annotations. It prints one score per test.
- The runs explorer (`agency logs <paths…>`, `lib/runsExplorer/`) already
  computes a per-run summary from a run directory:
  `buildRunRowFromDirectory(snapshot, source)` in `lib/runsExplorer/rows.ts`
  returns a `RunRow` with `agent`, `score`, `gatesPassed`, `status`,
  `costUsd`, `wallMs`, `models`, and the per-test breakdown. This is the one
  definition of "what did this run score and cost", and statelog must not
  grow a second one.
- `resolveProjectTarget` (used by `agency remote deploy`, `remote spend`,
  `schedule --backend remote`) turns the `remote.serveUrl` binding in
  `agency.json` plus an API key into a statelog project target. `agency
  remote link <url>` writes the binding.
- `setAgentName` exists in `stdlib/statelog.agency`. The agency agent does
  not call it.

In statelog:

- `POST /api/logs` ingests one trace event per request, authorized against
  the project named in the body (`authorizeLogProject`). Lines carry no id;
  the server mints one per row.
- Tables: `projects`, `traces`, `logs`, `api_keys`, `usage_events` (hosted
  invocation billing), and the scheduling tables. There is no table for
  verdicts and no per-trace summary.
- The frontend is React 19 with hand-written CSS and page-level render tests
  (`src/frontend/pages/**/*.test.tsx`). No charting library.
- `package.json` depends on `agency-lang` (currently `^0.14.0`) for the
  compiler, so importing more from agency-lang's public exports is the
  established way to share code.

## Goals and non-goals

Goals:

1. A suite run can be uploaded to a statelog project with one command and
   viewed there: batch table, batch page, test page, trend chart.
2. Repeated trials per test, with mean and standard error, so a chart of a
   small suite reads as a trend and not as noise.
3. A weekly CI job that runs the agency-agent suite and uploads it.
4. Runs identify their agent (including which brain) from the trace alone.

Non-goals, decided in the brainstorm and not to be reopened in review:

- No `--tag key=value` on `eval run`. Brain comes from the agent name, the model
  from the trace, the suite commit from `suite.sha`. Nothing is
  passed on the command line to identify a run.
- No live streaming path built for evals. An agent whose config already
  streams to statelog keeps doing so; the upload command copes with that
  (see "Traces already on the server").
- No per-line dedup ids on the wire. Dedup is per trace.
- No "skip the weekly run unless the agent changed". The run is weekly,
  unconditionally. The budget is controlled by the cost cap and the trial
  count, not by change detection.
- No Docker or hosted sandbox. Tests run on the host (locally) or on the CI
  runner, which is a throwaway machine already.
- No writes to statelog's `usage_events`. That table is money statelog itself
  incurred on hosted invocations; eval cost is an observation reported by the
  uploader and goes in the trace summary only. Mixing the two would corrupt
  `agency remote spend`.
- No hosted eval runner in statelog. Noted under "Later".

## Design, part 1: agency-lang

### 1.1 `eval run --trials k`

`--trials <k>` (integer ≥ 1, default 1) runs every test k times. Each trial
is an ordinary run: its own trace id, its own run directory, its own `run`
annotation, graded on its own. The only thing trials share is the batch.

Layout. For k = 1 the layout is unchanged: `<out>/<testId>/`. For k > 1 each
trial gets `<out>/<testId>/<n>/` with n from 1. Keeping k = 1 flat means no
existing directory, script, or doc changes, and `findRunDirectories` already
walks one level of children, so a group with trial subdirectories needs the
walk to go one level deeper only when a test directory is itself not a run
directory. Concretely: `findRunDirectories` treats a directory that is not a
run directory and whose children are run directories as a group, recursively,
bounded to depth 2 (group → test → trial). Anything deeper is still an error.

Statistics. Each run records which trial it is (1.2); the statistics
themselves are never stored. Whoever reads a batch computes:

- a test's score in the batch: the mean of its trials' run scores;
- a test's standard error: the sample standard deviation of its trial scores
  divided by √k, and `null` when k = 1;
- a batch's accuracy: the mean over tests of the per-test means;
- a batch's standard error: computed over the per-trial batch means (trial
  1's mean over tests, trial 2's, …), which is what Terminal-Bench reports as
  `± x%`. Pairing runs by trial index is what makes this number meaningful:
  for two tests scoring `[1, 0]` and `[0, 1]`, matched indices give trial
  means `[0.5, 0.5]` and SE 0, while an arbitrary pairing could give `[1, 0]`
  and a nonzero SE. So the trial index is persisted on the run row, and
  `batchStatistics` refuses a batch where a test has a duplicated or missing
  trial index (it reports the test and the indices) rather than pairing rows
  by accident.

`eval grade` on a group with trials prints per test `mean ± se (k trials)`
and the batch line the same way. The formatting lives in
`lib/cli/eval/formatGrade.ts` next to the existing formatter; the arithmetic
lives in one exported function (see 1.5) so statelog prints the same numbers.

Parallelism: `-n` applies across all `tests × trials` runs, not per test.

### 1.2 The batch id and trial index on the `run` row

`RunPayload` gains two optional fields:

- `batch?: string`: the batch id, which is the group directory's basename
  (`2026-08-22-191537-1M1cHC`). `eval run` sets it on every run it launches.
- `trial?: number`: a positive integer, the trial index from 1.1. `eval run`
  sets it on every run (it is `1` when `--trials` is 1).

Both are optional in the zod schema so every run directory written before
this change still loads. Readers treat an absent batch as "this run is its
own batch" and an absent trial as trial 1. The trial index, not the
directory nesting, is what survives an upload, which is why it is on the
row.

Why a field and not the directory name: the directory name does not survive
an upload, and a run directory is meant to be movable (`cp -r`) without
losing meaning.

### 1.3 The agency agent names itself

In `lib/agents/agency-agent/agent.agency`, right after `setBrain(brain)`,
the agent calls `setAgentName("agency-agent/" + brain.name)`. Every trace
then carries an `agentName` event, and the runs explorer and statelog group
by it. Two brains are two agent names, which is how they become two lines
on the chart.

Agent names become URL path segments in statelog (2.3), so `setAgentName`
now validates its argument: letters, digits, `.`, `_`, `-` and `/`, nothing
else and no whitespace (`^[A-Za-z0-9._/-]+$`), at most 200 characters. A
bad name throws at the call site with the rule in the message; nothing is
emitted. `/` is allowed so names can be hierarchical and is percent-encoded
in URLs. Statelog applies the same rule to the `agentName` event on ingest
and to the path parameter.

### 1.4 `agency eval upload <path…>`

A new eval subcommand. It accepts any mix of run directories and groups
(through `findRunDirectories`, same as `eval grade`) and uploads each run to
the statelog project the current directory is linked to.

Target resolution: `resolveProjectTarget`, exactly as `remote deploy` uses
it. No new flags for host or key; `agency remote link` and the existing API
key handling are the way to point a checkout at a project.

What is uploaded per run, in this order:

1. **The trace**, unless it is already on the server (next section). Lines
   are read through `readTraces` (so a torn final line and byte-identical
   duplicate lines are dropped the same way every other reader drops them),
   numbered from 0 in file order after that cleanup, and posted through a
   new bulk ingest endpoint (`POST /api/projects/:id/logs/bulk`, part 2), in
   chunks of 500 events, each event carrying its number as `sequence`. One
   trace is thousands of lines; one POST per line is not workable. The
   server stores `sequence`, and that, not arrival time, is the order a
   trace is rebuilt in.

   A run whose trace file is empty (the agent died before its first event;
   `recordCompletedRun` still writes the `run` row, and `ended` says why)
   has nothing to post here, but its verdict must still count, as a zero.
   For such a run the upload creates the trace with the existing `POST
   /api/traces` (`{ id, project_id }`) so the annotations in step 2 have a
   trace to attach to.
2. **The annotations**: every row in `annotations.jsonl`, posted as one
   array to `POST /api/projects/:id/annotations`. The server upserts by the
   row's id.

The upload client is a new sealed file `lib/cli/statelog/evalUploadClient.ts`
on the `statelogRequest` core, following the conventions in
`docs/dev/statelog-clients.md`: it owns the paths and body shapes, maps
failures to plain messages, and nothing outside it knows the endpoints.

Output: one line per run (`fib/2  uploaded 640 events, 4 annotations` or
`fib/2  trace already on server (640 events), uploaded 4 annotations`), and
at the end the batch's URL on statelog. Exit code: non-zero if any run failed
to upload, after attempting all of them; a run whose trace uploaded but whose
annotations failed is reported as failed (the trace is harmless on its own,
and re-running the command finishes the job because the trace is then
"already on the server").

Idempotence: running the command twice, or after `eval grade` added new
`score` rows, uploads the annotations again and the server upserts by id, so
nothing doubles. Re-grading with a different grader produces rows with
different ids and different annotators; the fold already handles a later
pass superseding an earlier one (`docs/dev/run-directory.md`).

### Traces already on the server

An agent whose config names statelog as `log.host` streams every event as it
runs. If such an agent is evaluated and then uploaded, the trace would be
stored twice. The upload prevents that per trace: before posting lines it
asks `GET /api/projects/:id/traces/:traceId/events-count` (part 2); a
non-zero count means "already on the server" and the lines are skipped. The
upload prints both counts (server and file) when it skips, so a trace that
was streamed partially (the agent crashed mid-run) is visible as a mismatch.
The upload does not repair such a trace; that case is rare and the message
is enough to act on by hand.

A bulk upload that fails partway (network drop after chunk 3 of 7) leaves a
trace with a non-zero count, which the next upload would skip. To make a
retry finish the job instead, the count endpoint also returns the highest
stored `sequence`, and the upload resumes from the chunk after it when the
count is lower than the file's; it skips only when the count equals the
file's event count.

### 1.5 Public exports for statelog

Statelog must show the same score and cost as the CLI, so it imports the
arithmetic rather than reimplementing it. agency-lang's package exports gain
a `./eval` entry (`dist/lib/eval/public.js`, extending the existing
`lib/eval/public.ts`) exposing:

- `summarizeRun(snapshot: RunDirectorySnapshot): RunSummary`: the existing
  `buildRunRowFromDirectory` behind a name that does not mention the
  explorer, returning agent name, score, gates passed, status, cost, wall
  time, models, LLM call count, tool call count, started and ended times,
  batch, trial, and test id. `RunRow` keeps its explorer-specific fields (`key`,
  `source`, `backfilled`) as a wrapper around `RunSummary`.
- `batchStatistics(runs: RunSummary[]): BatchStatistics`: the per-test and
  batch-level mean and standard error from 1.1.
- `readRunDirectory`, `readTraces`, `foldAnnotations`, `annotationId`, the
  annotation zod schema, and the annotation types, which statelog needs to
  rebuild a snapshot from rows it stored and to verify ids (2.3).
- `AGENT_NAME_PATTERN`, the rule from 1.3, so statelog validates names the
  same way.

"Effort" (the reasoning-effort setting) is not part of the summary. The
`promptCompletion` event does not record it today
(`lib/runtime/prompt.ts:520`), and it is a per-call option that can differ
within one run, so there is no single run-level value to show. Adding it to
the event and showing the set of observed efforts is a later change.

Statelog's server runs on Node and already imports agency-lang, so this is a
version bump there, not a new dependency.

### 1.6 `suite.sha` for local suites

Unchanged. It stays the commit of a git-fetched suite. A local suite records
no sha. (Filling it from the enclosing repository was considered and
rejected: it would make the field mean "the agent's commit" in CI and "the
suite's commit" elsewhere.)

## Design, part 2: statelog

### 2.1 Schema

Two new tables, by migration.

`logs` gains one column: `sequence` (integer, null), with a unique index on
`(trace_id, sequence)` where `sequence` is not null. Bulk ingest always sets
it (1.4). Live ingest leaves it null: the live client posts one event at a
time and subagents in other processes share the trace id, so there is no
single counter to assign, and the live path keeps its current
`created_at` ordering. Reconstruction orders by `sequence` first, then
`created_at`, then `id`, so a bulk-uploaded trace is rebuilt in file order
and a live one no worse than today.

`annotations`:

| column | type | notes |
|---|---|---|
| `id` | text, primary key | the deterministic annotation id from the file, verified on write (2.3) |
| `project_id` | text, not null, fk | |
| `trace_id` | text, not null | indexed |
| `kind` | text, not null | `run`, `score`, `checklist` |
| `annotator` | text, not null | |
| `batch` | text, null | copied out of `data` for `run` rows; indexed with `project_id` |
| `data` | jsonb, not null | the full row as on disk, including `payload`, `v`, `createdAt` |
| `created_at` | timestamptz | the row's own `createdAt` |
| `uploaded_at` | timestamptz | server time |

`trace_summaries`, one row per trace, derived:

| column | type |
|---|---|
| `trace_id` | text, primary key |
| `project_id` | text, not null, indexed with `agent_name` and with `batch` |
| `agent_name` | text, null |
| `models` | text[] |
| `score` | numeric, null |
| `gates_passed` | boolean, null |
| `status` | text (`ok`, `partial`, `failed`, `killed`, `trace`) |
| `total_cost` | numeric, null |
| `wall_ms` | integer, null |
| `llm_calls` | integer |
| `tool_calls` | integer |
| `event_count` | integer |
| `started_at`, `ended_at` | timestamptz, null |
| `batch` | text, null |
| `trial` | integer, null |
| `test_id` | text, null (from the `run` row's `test.id`) |
| `suite_source`, `suite_sha` | text, null |
| `summarized_at` | timestamptz |

Every column of `trace_summaries` is a field of `RunSummary` or of the `run`
row. No batch table: a batch is the set of summaries sharing
`(project_id, batch)`, the same way a group directory on disk has no index
file.

### 2.2 `summarizeTrace(traceId)`

One server function, in `src/backend/lib/evals/summarizeTrace.ts`. It reads
the trace's log rows in reconstruction order (2.1) and its annotation rows,
rebuilds a `RunDirectorySnapshot` in memory (the stored `data` of a log row is the event; the annotation rows
are the annotation file), calls agency-lang's `summarizeRun`, and upserts
`trace_summaries`. It is called from two places:

- the annotations endpoint, after the rows are stored (this is the upload
  path: annotations arrive last, so the trace is complete by then);
- the log ingest, when the event it just stored is the trace's end event
  (this is the live path).

Both calls are the same function; there is no third way a summary is
written. A re-upload of annotations re-summarizes, which is how a re-grade
changes the score shown.

### 2.3 Endpoints

Write side, authorized like log ingest (project-scoped API key or session):

- `POST /api/projects/:id/logs/bulk`: body `{ trace_id, events: [{ sequence,
  ...envelope }] }`, each event the same envelope the single-line ingest
  takes plus its `sequence`. Inserts in one statement per request, `on
  conflict (trace_id, sequence) do nothing` so a retried chunk is harmless.
  Same format-version check as the single ingest. At most 500 events per
  request.
- `POST /api/projects/:id/annotations`: body `{ rows: Annotation[] }`,
  validated with the annotation schema (agency-lang exports it). Before
  writing, the server recomputes each row's id with agency-lang's
  `annotationId` and rejects the row if it differs: a well-formed id is not
  proof it was derived from the row, and the id is a global primary key.
  Upsert by `id`, and the conflict update never touches `project_id` or
  `trace_id`; a row whose id exists under another project or trace is
  rejected, naming the id. A row whose trace does not exist in the project
  is rejected naming the trace id (the upload creates the trace first, so
  this is a client bug, not a normal path). Calls `summarizeTrace` for each
  distinct trace id in the body after the writes.
- `GET /api/projects/:id/traces/:traceId/events`: `{ count, maxSequence }`
  (`0` and `null` for an unknown trace). The upload's skip-or-resume check.

Read side, session-authorized, for the pages:

The agent name is a path segment (percent-encoded, so
`agency-agent/coordinator` appears as `agency-agent%2Fcoordinator`), and
every read is scoped to one agent; there is no cross-agent listing beyond
the agent index.

- `GET /api/projects/:id/evals/agents`: the distinct agent names in the
  project that have at least one batch, each with its batch count and the
  newest batch's time. The Evals tab's entry point.
- `GET /api/projects/:id/evals/agents/:agent/batches?limit=&before=`: one row
  per batch: batch id, started at, models, suite source and sha, test
  count, trial count, accuracy, standard error, passed count, total cost,
  total wall time. Computed from `trace_summaries` where `agent_name` is
  `:agent`, grouped by batch.
- `GET /api/projects/:id/evals/agents/:agent/batches/:batch`: the batch's
  per-test table: test id, description (from the `run` row's stored
  `test`), per-trial score, status, cost, time, trace id; plus the batch
  aggregates.
- `GET /api/projects/:id/evals/agents/:agent/tests/:testId`: the test's
  description and tags, and its history for this agent: one point per
  batch with mean, SE, average cost, average time, and the trace ids.

The aggregate arithmetic is `batchStatistics` from agency-lang, applied to
summaries loaded by batch. SQL does the grouping and filtering; TypeScript
does the statistics, so there is one definition of them.

### 2.4 Pages

Under a project, a new "Evals" tab (`pages/projects/evals.html` and
`src/frontend/pages/Projects/Evals/`), three views, all under a chosen
agent. The tab opens on the agent list (one row per agent name with its
batch count and last run), and picking one shows:

1. **Batches**: the table from the batches endpoint, newest first. Above
   it, two charts: accuracy over time with a shaded band of ± SE, and cost
   per batch over time. A second agent can be added to the charts as a
   comparison line (a query parameter, `compare=<agent>`), which is how two
   brains are read side by side. A row links to the batch view.
2. **Batch**: aggregates at the top, then one row per test with its trial
   scores, cost, and time; each trial links to the existing trace view.
3. **Test**: description and tags, the averages, the history chart for this
   test (mean ± SE per batch), and the per-batch rows with trace links.

Charts are plain SVG components (`src/frontend/components/charts/`), no
library: two line charts with a band is small, and statelog has no chart
dependency to match.

## Design, part 3: CI

`.github/workflows/agent-evals.yml` in the agency-lang repo:

- Triggers: `schedule: cron "0 3 * * 0"` (Sundays, 03:00 UTC) and
  `workflow_dispatch` with inputs `trials` (default `3`) and `suite`
  (default `evals/agency-agent`).
- Steps: checkout (actions pinned by SHA, as the other workflows do),
  pnpm and Node setup, `pnpm install`, `make`; then in `packages/agency-lang`,
  with `RUN_DIR=runs/weekly-$(date -u +%Y-%m-%d-%H%M%S)` and
  `AGENCY="node $PWD/dist/scripts/agency.js"`:

  ```
  $AGENCY remote link "$STATELOG_PROJECT_URL"
  $AGENCY eval run \
    --agent-cmd "$AGENCY agent --policy recommended -p -- {input}" \
    --suite "$SUITE" --trials "$TRIALS" -n 2 --out "$RUN_DIR"
  $AGENCY eval grade "$RUN_DIR"
  $AGENCY eval upload "$RUN_DIR"
  ```

  These are the real flags of `agency eval run` today (`--suite`, `{input}`
  as the placeholder, `--out` so the later steps know the directory);
  `--trials` is the one addition from 1.1. `$STATELOG_PROJECT_URL` is a
  repository variable; `$SUITE` and `$TRIALS` come from the dispatch inputs
  or their defaults.
- The cost cap is not a flag: `eval run` reads `eval.limits.maxCostUsd` from
  `agency.json` (`lib/eval/run/runAgent.ts:227`). The repo's `agency.json`
  already sets `eval.limits.wallClockSec` for evals; this design adds
  `maxCostUsd: 25` beside it, so the cap is visible in one place and applies
  to a local run of the suite too.
- A unit test, `lib/cli/eval/workflowFlags.test.ts`, reads the workflow
  file, extracts the `eval run` invocation, and checks every `--flag` in it
  against the command's registered options, so renaming a flag fails the
  test before it fails the Sunday run.
- Secrets: the LLM provider key the agent uses, and `STATELOG_API_KEY`
  (project-scoped) for the upload.
- `if: always()` step at the end: upload the run directory group as a
  workflow artifact, 14-day retention, so a batch whose upload failed can be
  uploaded by hand from the download.
- `timeout-minutes: 90`. The job never fails on scores; it fails only when a
  step could not run or the upload failed.

Cost calibration, for the record: the fib test cost $2.32 for one trial on
2026-08-22. Three tests × three trials is roughly $21; the $25 cap fits
today's suite and must be raised as tests are added. The batch
table makes the real number visible, so after a few weeks the cap is set
from data.

## Part 4: testing

agency-lang:

- `--trials`: `runSuite` with k = 2 writes `<out>/<test>/1/` and `/2/`, both
  `run` rows carry the same `batch`, the trace ids differ; k = 1 keeps the
  flat layout. `findRunDirectories` on a trials group finds every trial and
  still refuses depth 3.
- `batch` and `trial` on the `run` row: the schema accepts a row without
  them; the fold exposes them when present; `trial: 0` is rejected.
- `batchStatistics`: a fixture of 2 tests × 3 trials with hand-computed
  mean and SE; k = 1 gives SE `null`; the `[1,0]`/`[0,1]` pairing example
  from 1.1 gives SE 0; a duplicated trial index and a missing one are both
  refused naming the test.
- `setAgentName`: accepts `agency-agent/coordinator`, rejects a name with a
  space, an empty name, and a 201-character name, each without emitting an
  event.
- `eval upload`: against a stubbed `statelogRequest` (stub `text()`, the rule
  from `docs/dev/statelog-clients.md`): posts events in 500-event chunks with
  sequences 0..n-1 then annotations; skips events when the server count
  equals the file count and prints both; resumes from the right chunk when
  the server count is lower; creates the trace and posts only annotations
  for an empty trace file; an annotation failure makes the run fail and the
  exit code non-zero while other runs still upload; a second run posts
  annotations only.
- `setAgentName`: an agency test that the agent's startup emits `agentName`
  with `agency-agent/<brain>` (the existing agent tests under
  `lib/agents/agency-agent/tests/` show the pattern).
- `summarizeRun`: on a fixture run directory, equals the explorer's
  `RunRow` fields for the same directory.
- `pnpm run lint:structure`, `lib/sourceIsText.test.ts`, and the package
  export test (that `agency-lang/eval` resolves) before pushing.

statelog:

- Annotations route: posting the same rows twice leaves one copy each; a
  key for another project is denied; a row for an unknown trace is rejected
  naming the trace; a row whose id does not match its content is rejected;
  a well-formed id that already exists under another project, posted with
  different data, is rejected and the original row is unchanged.
- Bulk logs route: 1,200 events in three requests arrive as 1,200 rows in
  sequence order; re-posting a chunk adds nothing; the format-version check
  applies; an `agentName` event with a space in the name is rejected.
- `summarizeTrace`: a fixture trace plus annotations produces the expected
  agent name, models, cost, counts, score; it runs on annotations arrival
  and on the end event.
- Read endpoints: a fixture of 2 agents × 2 batches × 2 tests × 2 trials
  returns the hand-computed accuracy, SE, cost under each agent's path; the
  agent index lists both with the right counts; a percent-encoded name with
  `/` resolves.
- Pages: one render test per view with fixture data, matching the existing
  `.test.tsx` pattern.

## Later (not in this design)

- **A hosted eval runner in statelog.** Users deploy an agent and a suite;
  statelog runs the suite on a schedule or when the agent changes, grades it,
  and stores the same rows this pipeline uploads. Everything in part 2 is
  what that needs; part 1's upload command is what a local run would still
  use.
- **Live streaming for eval runs**, so a batch can be watched in progress.
  Needs nothing new on the server beyond part 2.
- **Growing the suite** from three tests to ten or fifteen across categories,
  which is what makes the chart worth reading. Separate small PRs.
- **The "agent that writes agents" brain.** Once two brains exist the chart
  already splits them by agent name.

## Delivery: four pull requests, in order

1. **agency-lang** (this repo): 1.1 through 1.6, the upload client, the
   `./eval` exports, tests. Then publish a new package version, because
   statelog imports from it.
2. **statelog, API only**: the migration, `summarizeTrace`, the write and
   read endpoints, the agency-lang dependency bump, route tests. No UI.
3. **statelog, UI**: the Evals tab and its three views, the SVG charts,
   render tests.
4. **agency-lang, CI**: `agent-evals.yml`, the `maxCostUsd` config line, the
   workflow-flag test. Last, because it needs 1 through 3 deployed to mean
   anything.

## Changes in v2 (from the review)

- Trial index persisted (`trial` on the run row, `RunSummary`,
  `trace_summaries`); `batchStatistics` refuses duplicate or gapped indices.
- Bulk-ingested events carry a `sequence`; `logs.sequence` with a unique
  index; reconstruction orders by it. Live ingest unchanged (documented).
- Annotation ids are recomputed on the server; conflicts never move a row
  between projects or traces; forged-id test added.
- CI command corrected to the real flags (`--suite`, `{input}`, `--out`);
  the cost cap moved to `eval.limits.maxCostUsd` in `agency.json`; a test
  checks the workflow's flags against the CLI.
- Effort dropped (not in the `promptCompletion` event, and per-call).
- Zero-event runs: the upload creates the trace so the verdict still counts.
- Resumable bulk upload via `maxSequence`.
- Agent name in the URL path; name validated (no whitespace) at
  `setAgentName` and on ingest.
- Delivery split into four PRs.

## Decisions log

| decision | chosen | rejected | why |
|---|---|---|---|
| how results reach statelog | upload from the run directory after grading | stream live | one path, works on any run directory, re-grade friendly |
| identifying what was evaluated | agent name in the trace, model from the trace, suite sha | `--tag key=value` | no new mechanism; statelog should not know what a brain is |
| duplicate traces | skip a trace the server already has | per-line content ids with server dedup | trace ids are unique already; per-line ids change the wire for every client |
| cadence | weekly, unconditional, 3 trials | nightly; skip-unless-changed by commit | cost; change detection needed the suite sha to mean something else |
| error margin | mean ± standard error over trials | single trial | a one-trial chart of a small suite is noise |
| cost storage | `trace_summaries.total_cost` | `usage_events` | that table is statelog's own billing |
| sandboxing | host and CI runner | Docker, Daytona | CI is already throwaway; policies are the product |
| charts | hand-written SVG | a chart library | two charts; no existing dependency |
