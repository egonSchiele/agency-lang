# Importing Harbor jobs as Agency run folders

Linear: ADI-367 (this design) and ADI-372 (building it). ADI-370 adds two fields this relies on. ADI-375 uses this to import the results we already have.

## Why

Most of our benchmark results come from Harbor (SWE-bench Verified, Terminal-Bench) and sit in `~/bench-agency/jobs`. Statelog only accepts Agency run folders. We decided to keep Agency's format and convert Harbor results into it, so every result can be compared in one place: by benchmark, agent, model and reasoning level, with cost, runtime and tokens.

## Goals

- One command converts the Harbor trials it's given into Agency run folders that `agency runs list` reads and `agency eval upload` sends to statelog.
- A converted run can't be told apart from one written by `agency eval run`.
- Running it again changes nothing.

## Non-goals

- **Deciding which attempts belong to a suite run (owner's decision).** One suite run is often spread over several jobs, with reruns of attempts that failed for infrastructure reasons. The command does not try to work out which attempt a rerun replaces. Whoever imports picks the trials by hand and passes them in; for old results that's ADI-375. The command only *reports* when tests end up with different numbers of attempts.
- Deciding which old jobs to trust, for example the web-search-contaminated Agency runs before `fw-agency-minimal-path`, or `jobs-discarded/`. That's also ADI-375.
- Other agents (Pi, OpenCode, mini, gold), and the July Terminal-Bench jobs whose adapter saved only a text transcript. ADI-378.

## Anti-goals

- A second writer of the run folder format. Everything goes through `lib/runDirectory/mutations.ts`.
- Counting infrastructure failures against a model.

## What exists today

A Harbor job folder holds `config.json` and one folder per trial, named `<task>__<random suffix>`. A trial holds:

- `result.json`: `task_name` (e.g. `swe-bench/astropy__astropy-12907`), `source` (e.g. `swe-bench-verified`), `verifier_result.rewards` (`{reward: 1.0}`, or null), `exception_info` (`{exception_type, exception_message}`, or null), and `started_at`. `agent_result` (tokens, cost) is always null for Agency trials.
- `agent/statelog.jsonl`, the Agency trace, when the agent started. It carries the model, agent name, cost and per-call token `usage`.

**When the agent never started there's no trace.** For example, all 25 trace-less trials in `full-agency-6e9db1438-flash-high` are `NonZeroAgentExitCodeError` from the firewall setup script. Other trials with no reward are `CancelledError`, `DaytonaError`, `VerifierTimeoutError`, `RewardFileNotFoundError` (the verifier didn't write its result) and network errors.

**Agency scores every run that didn't end `ok` as 0** today (`lib/runDirectory/list.ts:184`), whatever its score rows say. That would count infrastructure failures against a model, and score a timeout that passed the verifier as 0.

Reasoning level is recorded nowhere. The adapter reads `AGENCY_EFFORT` from the host's environment, and it shows only in job names like `flash-high`.

## Approaches

1. **A TypeScript command in agency-lang** that writes through `recordCompletedRun` and `recordGradingPass`. **Chosen.**
2. **A Python script beside `adapter.py`** that writes `annotations.jsonl` itself. Rejected: it would re-implement annotation ids, schema checks, locking and layout.
3. **Python calling `agency runs add`.** Rejected: `runs add` files runs under `<group>/<traceId>/`, not `<test>/<trial>/`, and can't mint `run` or `score` rows.

The command once had a built-in rule for choosing which attempts to keep. It was replaced by picking trials by hand (see Non-goals), because the real jobs mix continuations, reruns and reruns that failed again, and no rule fit them simply.

## Design

### Command

```
agency eval import-harbor [<job folder>...] [--trials <file>] --out <dir> [--batch <name>] [--reasoning <level>]
```

- **Hidden** from `agency eval --help` (`{ hidden: true }`, like `remote` and `review`), because it's an internal benchmarking tool. It's documented in `docs/dev/` only.
- **Input:** job folders, a `--trials` file, or both.
  - A job folder means all of its trials, ordered by `started_at`, then trial folder name.
  - A `--trials` file lists one trial folder path per line, in the order they should be numbered. Blank lines and `#` comments are ignored.
- **Everything in one call becomes one batch.** With exactly one job folder and no `--trials`, the batch is the job's folder name. Otherwise `--batch` is required.
- Output goes to `<out>/<batch>/<test>/<trial>/`, always with the trial folder, the layout `findRunDirectories` already walks. Uploading is then `agency eval upload <out>/<batch>`.

**Examples:**
- `k1-agency-minimal` on its own is one job folder: batch `k1-agency-minimal`, trial 1 for each test.
- `k1`…`k5` as five job folders with `--batch k-agency-minimal`: each test gets trials 1–5 in job order.
- `flash-high` plus its reruns uses `--trials flash-high.txt --batch flash-high`. The file lists the 500 trial folders chosen by hand: the main job's attempts, except the ones replaced by a rerun in `-rest2` or `-fixup`.

### Trial numbers

Each test's trials are numbered 1, 2, 3… in input order. Job folders come in argument order, then the `--trials` lines.

The command doesn't check that the selection makes sense. It does report when tests have different numbers of trials, for example `5 trials: 498 tests; 4 trials: 2 tests (astropy-13033, django-10097)`, because Agency's batch statistics then give the batch no accuracy.

### How a trial is scored (owner's decision: rule C)

- **No trace (the agent never started):** an infrastructure failure. `ended: "infrastructure"`, no score.
- **A reward:** that's the score, even after a timeout.
- **A trace, no reward, and an agent-fault exception** (`AgentTimeoutError`, `NonZeroAgentExitCodeError`): one binary score of 0.
- **A trace, no reward, and anything else** (`DaytonaError`, `CancelledError`, `VerifierTimeoutError`, `RewardFileNotFoundError`, `NetworkConnectionError`, or an unknown type): an infrastructure failure. `ended: "infrastructure"`, no score. Unknown types are named in the output.

### One trial becomes one run folder

| Harbor | Run folder |
|---|---|
| `agent/statelog.jsonl` | `statelog.jsonl` (`stagedStatelogFile`). Model, agent name, cost, tokens and runtime all come from it. |
| no trace | a silent run: a `run` row only. Its `traceId` is `harbor-` + the first 24 hex characters of sha256 of `<job folder name>/<trial name>`, so it's the same on every import. |
| `task_name` minus its `<source>/` prefix | `run.test = { id }`. An id containing `/` or `..` is refused. |
| `source` | `run.benchmark` (new field, ADI-370) |
| `--reasoning` | `run.reasoning` (new field, ADI-370). Absent when the flag isn't given. |
| the batch, and the trial's number | `run.batch`, `run.trial` |
| how it ended | `run.ended`: `infrastructure` (above), otherwise `ok` (no exception), `timeout` (`AgentTimeoutError`), `killed` (`CancelledError` with a reward), or `error`. Plus `run.error` as `<exception_type>: <exception_message>`. |
| job folder name and trial name | `run.flags = { harborJob, harborTrial }`. Names, not paths, so a run's id doesn't depend on where the job lives and no local paths reach statelog. |
| `verifier_result.rewards` | one `score` row per reward |

`run.suite` is null, because there's no Agency suite. The `run` row's annotator is `{ kind: "harness", id: "harbor-import@<agency version>" }`.

**Scores:** each reward becomes a `score` row from `{ kind: "grader", id: "harbor-verifier:<source>" }`, named after the reward key, with `weight: 1` and `mustPass: false`. A reward of exactly 0 or 1 is binary; anything else is a scalar. All of a trial's rewards are one grading pass, written after `recordCompletedRun`. A silent run can't have score rows, because `recordGradingPass` needs the trace. That's fine, because silent runs are infrastructure failures.

### Change to Agency's run summary

`RunOutcome` gains `"infrastructure"`. In `summarizeRunDirectory`:

```ts
score: ended === "ok" ? effectiveScore
     : ended === "infrastructure" ? null
     : (effectiveScore ?? 0),
```

So a run that didn't end `ok` keeps the score it was given, an ungraded one is still 0, and an infrastructure failure is left out of accuracy. `eval run` is unaffected, because `gradeRun.ts:349` only grades `ok` runs and never writes `infrastructure`. Statelog validates uploaded annotations against agency-lang's schema, so it needs the agency-lang release with this change before imported runs are uploaded.

### Re-running

- A run folder that already has its `run` row is checked against the plan.
  - If its `flags.harborJob` and `flags.harborTrial` differ from the planned trial, that's a failure naming both. That happens when the input changed order, or a trial was added or removed.
  - If they match and it has a complete grading pass (`effectiveAnnotations[traceId].gradingPasses > 0`), or needs no scores, it's left alone.
  - If they match but the pass is missing (an earlier import was cut off between the two writes), only the pass is added.
- The output ends with one counts line (imported, already present, scored, infrastructure, failed), the uneven-trials report, and any unknown exception types. A failure, or a trial with a missing or broken `result.json`, sets exit code 1.

### Reading Harbor's files

Harbor publishes no schema for `result.json`. The command reads only the fields above, through one zod schema in one file. A trial that doesn't match is reported with the field that failed and the trial's path, and skipped.

### Reasoning level

- **Past jobs:** `--reasoning <level>` sets it for every trial in the import. Without the flag it's left blank.
- **Future runs:** ADI-370 records the effort in the trace itself.
- If both are present, the flag wins.

## Left to the builder

- How the code under `lib/eval/harbor/` splits into a reader, a pure planner and a writer.
- Fixtures: small copied trials for each case above.
- How progress is printed while a 500-trial job converts.

## Depends on

- ADI-370: the `benchmark` and `reasoning` fields on the `run` row, `RunSummary`, and statelog.
- Statelog moving to the agency-lang release that adds `"infrastructure"`, before any imported run is uploaded.
