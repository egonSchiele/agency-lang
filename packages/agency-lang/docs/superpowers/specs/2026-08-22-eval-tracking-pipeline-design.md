# Tracking the agency agent's eval performance over time

Date: 2026-08-22. Status: design, awaiting review.

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

- No `--tag key=value` on `eval run`. Brain comes from the agent name, model
  and effort from the trace, the suite commit from `suite.sha`. Nothing is
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

Statistics. Nothing about trials is stored. Whoever reads a batch computes:

- a test's score in the batch: the mean of its trials' run scores;
- a test's standard error: the sample standard deviation of its trial scores
  divided by √k, and `null` when k = 1;
- a batch's accuracy: the mean over tests of the per-test means;
- a batch's standard error: computed over the per-test means of each trial
  index (trial 1's mean over tests, trial 2's, …), which is what Terminal-Bench
  reports as `± x%`.

`eval grade` on a group with trials prints per test `mean ± se (k trials)`
and the batch line the same way. The formatting lives in
`lib/cli/eval/formatGrade.ts` next to the existing formatter; the arithmetic
lives in one exported function (see 1.5) so statelog prints the same numbers.

Parallelism: `-n` applies across all `tests × trials` runs, not per test.

### 1.2 The batch id on the `run` row

`RunPayload` gains `batch?: string`: the batch id, which is the group
directory's basename (`2026-08-22-191537-1M1cHC`). `eval run` sets it on
every run it launches. The field is optional in the zod schema so every run
directory written before this change still loads; readers treat an absent
batch as "this run is its own batch".

Why a field and not the directory name: the directory name does not survive
an upload, and a run directory is meant to be movable (`cp -r`) without
losing meaning.

### 1.3 The agency agent names itself

In `lib/agents/agency-agent/agent.agency`, right after `setBrain(brain)`,
the agent calls `setAgentName("agency-agent/" + brain.name)`. That is the
whole change. Every trace then carries an `agentName` event, and the runs
explorer and statelog group by it. Two brains are two agent names, which is
how they become two lines on the chart.

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
   duplicate lines are dropped the same way every other reader drops them)
   and posted through a new bulk ingest endpoint (`POST
   /api/projects/:id/logs/bulk`, part 2), in chunks of 500 lines. One trace
   is thousands of lines; one POST per line is not workable.
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

### 1.5 Public exports for statelog

Statelog must show the same score and cost as the CLI, so it imports the
arithmetic rather than reimplementing it. agency-lang's package exports gain
a `./eval` entry (`dist/lib/eval/public.js`, extending the existing
`lib/eval/public.ts`) exposing:

- `summarizeRun(snapshot: RunDirectorySnapshot): RunSummary`: the existing
  `buildRunRowFromDirectory` behind a name that does not mention the
  explorer, returning agent name, score, gates passed, status, cost, wall
  time, models, effort, LLM call count, tool call count, started and ended
  times, and the batch. `RunRow` keeps its explorer-specific fields (`key`,
  `source`, `backfilled`) as a wrapper around `RunSummary`.
- `batchStatistics(runs: RunSummary[]): BatchStatistics`: the per-test and
  batch-level mean and standard error from 1.1.
- `readRunDirectory`, `readTraces`, `foldAnnotations`, and the annotation
  types, which statelog needs to rebuild a snapshot from rows it stored.

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

`annotations`:

| column | type | notes |
|---|---|---|
| `id` | text, primary key | the deterministic annotation id from the file |
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
| `effort` | text, null |
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
| `test_id` | text, null (from the `run` row's `test.id`) |
| `suite_source`, `suite_sha` | text, null |
| `summarized_at` | timestamptz |

Every column of `trace_summaries` is a field of `RunSummary` or of the `run`
row. No batch table: a batch is the set of summaries sharing
`(project_id, batch)`, the same way a group directory on disk has no index
file.

### 2.2 `summarizeTrace(traceId)`

One server function, in `src/backend/lib/evals/summarizeTrace.ts`. It reads
the trace's log rows and annotation rows, rebuilds a `RunDirectorySnapshot`
in memory (the stored `data` of a log row is the event; the annotation rows
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

- `POST /api/projects/:id/logs/bulk`: body `{ trace_id, events: [...] }`,
  each event the same envelope the single-line ingest takes. Inserts in one
  statement per request. Same format-version check as the single ingest.
- `POST /api/projects/:id/annotations`: body `{ rows: Annotation[] }`,
  validated with the annotation schema (agency-lang exports it). Upsert by
  `id`. A row whose trace does not exist in the project is rejected with a
  message naming the trace id; the upload posts the trace first, so this is
  a client bug, not a normal path. Calls `summarizeTrace` for each distinct
  trace id in the body.
- `GET /api/projects/:id/traces/:traceId/events-count`: `{ count }`, 0 for
  an unknown trace.

Read side, session-authorized, for the pages:

- `GET /api/projects/:id/evals/batches?agent=&limit=&before=`: one row per
  batch: batch id, started at, agent name(s), models, effort, suite source
  and sha, test count, trial count, accuracy, standard error, passed count,
  total cost, total wall time. Computed from `trace_summaries` grouped by
  batch. `agent` filters on `agent_name`.
- `GET /api/projects/:id/evals/batches/:batch`: the batch's per-test table:
  test id, description (from the `run` row's stored `test`), per-trial
  score, status, cost, time, trace id; plus the batch aggregates.
- `GET /api/projects/:id/evals/tests/:testId?agent=`: the test's
  description and tags, and its history: one point per batch with mean, SE,
  average cost, average time, and the trace ids.

The aggregate arithmetic is `batchStatistics` from agency-lang, applied to
summaries loaded by batch. SQL does the grouping and filtering; TypeScript
does the statistics, so there is one definition of them.

### 2.4 Pages

Under a project, a new "Evals" tab (`pages/projects/evals.html` and
`src/frontend/pages/Projects/Evals/`), three views:

1. **Batches**: the table from the batches endpoint, newest first, with a
   filter by agent name. Above it, two charts: accuracy over time (one line
   per agent name, a shaded band of ± SE around each), and cost per batch
   over time. A row links to the batch view.
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
  pnpm and Node setup, `pnpm install`, `make`; then in `packages/agency-lang`:
  `agency remote link $STATELOG_PROJECT_URL` (repository variable), then
  `agency eval run --inputs <suite> --trials <trials> -n 2 --max-cost 25
  --agent-cmd "node $PWD/dist/scripts/agency.js agent --policy recommended
  -p -- {task}"`, then `agency eval grade <runDir>`, then `agency eval upload
  <runDir>`.
- Secrets: the LLM provider key the agent uses, and `STATELOG_API_KEY`
  (project-scoped) for the upload.
- `if: always()` step at the end: upload the run directory group as a
  workflow artifact, 14-day retention, so a batch whose upload failed can be
  uploaded by hand from the download.
- `timeout-minutes: 90`. The job never fails on scores; it fails only when a
  step could not run or the upload failed.

Cost calibration, for the record: the fib test cost $2.32 for one trial on
2026-08-22. Three tests × three trials is roughly $21; the `--max-cost 25`
cap fits today's suite and must be raised as tests are added. The batch
table makes the real number visible, so after a few weeks the cap is set
from data.

## Part 4: testing

agency-lang:

- `--trials`: `runSuite` with k = 2 writes `<out>/<test>/1/` and `/2/`, both
  `run` rows carry the same `batch`, the trace ids differ; k = 1 keeps the
  flat layout. `findRunDirectories` on a trials group finds every trial and
  still refuses depth 3.
- `batch` on the `run` row: the schema accepts a row without it; the fold
  exposes it when present.
- `batchStatistics`: a fixture of 2 tests × 3 trials with hand-computed
  mean and SE; k = 1 gives SE `null`.
- `eval upload`: against a stubbed `statelogRequest` (stub `text()`, the rule
  from `docs/dev/statelog-clients.md`): posts bulk lines in 500-line chunks
  then annotations; skips lines when the count is non-zero and prints both
  counts; an annotation failure makes the run fail and the exit code
  non-zero while other runs still upload; a second run posts annotations
  only.
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
  naming the trace.
- Bulk logs route: 1,200 events arrive as 1,200 rows; the format-version
  check applies.
- `summarizeTrace`: a fixture trace plus annotations produces the expected
  agent name, models, cost, counts, score; it runs on annotations arrival
  and on the end event.
- Read endpoints: a fixture of 2 batches × 2 tests × 2 trials returns the
  hand-computed accuracy, SE, cost; the agent filter excludes the other
  agent's batch.
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

## Decisions log

| decision | chosen | rejected | why |
|---|---|---|---|
| how results reach statelog | upload from the run directory after grading | stream live | one path, works on any run directory, re-grade friendly |
| identifying what was evaluated | agent name in the trace, model and effort from the trace, suite sha | `--tag key=value` | no new mechanism; statelog should not know what a brain is |
| duplicate traces | skip a trace the server already has | per-line content ids with server dedup | trace ids are unique already; per-line ids change the wire for every client |
| cadence | weekly, unconditional, 3 trials | nightly; skip-unless-changed by commit | cost; change detection needed the suite sha to mean something else |
| error margin | mean ± standard error over trials | single trial | a one-trial chart of a small suite is noise |
| cost storage | `trace_summaries.total_cost` | `usage_events` | that table is statelog's own billing |
| sandboxing | host and CI runner | Docker, Daytona | CI is already throwaway; policies are the product |
| charts | hand-written SVG | a chart library | two charts; no existing dependency |
