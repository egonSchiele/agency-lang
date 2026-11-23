# Importing Harbor jobs as Agency run folders

Linear: ADI-367 (this design) and ADI-372 (building it). ADI-370 adds two fields this relies on.

## Why

Most of our benchmark results come from Harbor (SWE-bench Verified, Terminal-Bench) and sit in `~/bench-agency/jobs`. Statelog only accepts Agency run folders. We decided to keep Agency's format and convert Harbor results into it, so every result can be compared in one place: by benchmark, agent, model and reasoning level, with cost, runtime and tokens.

## Goals

- One command turns Harbor job folders into Agency run folders that `agency runs list` reads and `agency eval upload` sends to statelog.
- A converted run can't be told apart from one written by `agency eval run`.
- Running it again changes nothing.

## Non-goals

- Trials with no Agency trace: other agents (Pi, OpenCode, mini, gold), and the July Terminal-Bench trials whose adapter saved only a text transcript. That's 694 of the 726 Terminal-Bench trials. Showing other agents is ADI-378.
- Deciding which old jobs to trust. The command converts what it's given. ADI-375 picks the list, which leaves out the web-search-contaminated Agency runs before `fw-agency-minimal-path` and everything in `jobs-discarded/`.

## Anti-goals

- A second writer of the run folder format. Everything goes through `lib/runDirectory/mutations.ts`.
- Counting infrastructure failures against a model.

## What exists today

A Harbor job folder holds `config.json` (agents, model, datasets) and one folder per trial, named `<task>__<random suffix>`. A trial holds:

- `result.json`: `task_name` (e.g. `swe-bench/astropy__astropy-12907`), `source` (e.g. `swe-bench-verified`), `agent_info.model_info`, `verifier_result.rewards` (`{reward: 1.0}`, or null), `exception_info` (`{exception_type, exception_message}`, or null), and per-phase timestamps. `agent_result` (tokens, cost) is always null for Agency trials.
- `verifier/reward.txt`, or `reward.json` for named rewards.
- `agent/statelog.jsonl`, the Agency trace. It carries the model, agent name, cost and per-call token `usage`.

Across the 6,602 Agency trials: 6,385 ended normally with a reward, 124 hit `AgentTimeoutError` with a reward, and about 95 have no reward (`CancelledError` 33, `DaytonaError` 29, `VerifierTimeoutError` 11, `AgentTimeoutError` 7, `RewardFileNotFoundError` 5, others 10).

Reasoning level is recorded nowhere. The adapter reads `AGENCY_EFFORT` from the host's environment, and it appears only in job names like `flash-high`.

## Approaches

1. **A TypeScript command in agency-lang** that writes through `recordCompletedRun` and `recordGradingPass`. **Chosen.**
2. **A Python script beside `adapter.py`** that writes `annotations.jsonl` itself. Rejected: it would re-implement annotation ids, schema checks, locking and layout, so converted runs could drift from `eval run` output.
3. **Python calling `agency runs add`.** Rejected: `runs add` files runs under `<group>/<traceId>/`, not `<test>/<trial>/`, and can't mint `run` or `score` rows.

## Design

### Command

```
agency eval import-harbor <job folder>... --out <dir> [--batch <name>] [--reasoning <level>]
```

Output goes to `<out>/<batch>/<test>/<trial>/`, the layout `findRunDirectories` already walks. Uploading is then `agency eval upload <out>/<batch>`. Several job folders need `--batch`.

### Batches and trials (owner's decisions)

- **By default, one job is one batch**, and the batch id is the job folder's name. Unlike `eval run`, there's no random suffix, so a re-import keeps the same id.
- **`--batch <name>` merges several jobs into one batch.** This is for attempts that were run as separate jobs, like `k1-agency-minimal`…`k5-agency-minimal`.
- **Trial numbers:** within a job, each task's trials are numbered 1…k by `started_at`. With several jobs, numbering continues across them in the order given on the command line.

### One trial becomes one run folder

| Harbor | Run folder |
|---|---|
| `agent/statelog.jsonl` | `statelog.jsonl` (`stagedStatelogFile`). Model, agent name, cost, tokens and runtime all come from the trace. That also sidesteps Harbor's wrong timings at high concurrency. |
| `task_name` minus its `<source>/` prefix | `run.test = { id }` |
| `source` | `run.benchmark` (new field, ADI-370) |
| `--reasoning` | `run.reasoning` (new field, ADI-370). Absent when the flag isn't given. |
| the job | `run.batch` and `run.trial` (above) |
| `exception_info` | `run.ended`, plus `run.error` set to `<exception_type>: <exception_message>` |
| Harbor job path and trial name | `run.flags = { harborJob, harborTrial }`, so a run can be traced back |
| `verifier_result.rewards` | one `score` row per reward (below) |

`run.suite` is null, because there's no Agency suite. The `run` row's annotator is `{ kind: "harness", id: "harbor-import@<agency version>" }`.

**How a run ended:** no exception means `ok`. `AgentTimeoutError` means `timeout`. `CancelledError` means `killed`. Any other exception means `error`.

**Scores:** each reward becomes a `score` row from `{ kind: "grader", id: "harbor-verifier:<source>" }`, named after the reward key (`reward` for `reward.txt`), with `weight: 1` and `mustPass: false`. A reward of exactly 0 or 1 is binary (`pass`); anything else is a scalar. All of a trial's rewards are one grading pass. `recordGradingPass` requires the trace to be in the folder first, so scores are written after `recordCompletedRun`.

**No reward (owner's decision, rule C).** Agency's batch accuracy skips runs with no score.
- **The agent was at fault** (`AgentTimeoutError`, `RewardFileNotFoundError`, `NonZeroAgentExitCodeError`): write one binary score of 0, so the failure counts.
- **The infrastructure was at fault** (`DaytonaError`, `CancelledError`, `VerifierTimeoutError`, `NetworkConnectionError`, and any type not listed here): write no score. The run still shows with how it ended and Harbor's message. Unknown types are named in the command's output, so the list can be extended.

### Skipping and re-running

- A trial with no `agent/statelog.jsonl` is skipped and counted in the output.
- A trial whose run folder already has its `run` row and a complete grading pass is skipped. If a run folder has the `run` row but no pass, for example because an earlier import was cut off between the two writes, only the pass is added. Re-imports are therefore safe at any point.
- The output ends with one line of counts: imported, already present, skipped with no trace, and unscored because of infrastructure, plus any unknown exception types.

### Reading Harbor's files

Harbor publishes no schema for `result.json`. The command reads only the fields in the table above, through one zod schema in one file. A trial that doesn't match is reported with the field that failed and the trial's path, and skipped. The rest of the job still converts.

### Reasoning level

- **Past jobs:** `--reasoning <level>` sets it for every trial in the import. Without the flag it's left blank.
- **Future runs:** ADI-370 records the effort in the trace itself, so new runs don't need the flag.
- If both are present, the flag wins, because it's what the owner said about that import.

## Left to the builder

- Where the command lives under `lib/cli/eval/`, and how it splits into a pure planner (trials → run drafts) and a thin writer.
- Fixtures: small copied trials for a normal pass, a timeout with a reward, an infrastructure failure, an agent-fault failure with no reward, a missing trace, and a `result.json` with a missing field.
- How progress is printed while a 500-trial job converts.

## Depends on

ADI-370 must land first: the `benchmark` and `reasoning` fields on the `run` row, `RunSummary`, and statelog.
