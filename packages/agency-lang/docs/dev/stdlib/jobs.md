# Background jobs

A background job is a shell command that keeps running while the program
does other work.

```agency
import { startJob } from "std::safeBash"
import { jobOutput, stopJob } from "std::jobs"

startJob("./run-comparison.sh")         // "Started job-1. ..." at once
jobOutput("job-1")                      // what it printed so far, and "running"
jobOutput("job-1", wait: 300)           // returns when it ends, or after five minutes
stopJob("job-1")                        // stops it and everything it started
```

Each `jobOutput` returns only the output not returned before. When the job
has ended, the report has its exit code.

## Where the code lives

| File | What |
| --- | --- |
| `lib/runtime/jobs/jobTable.ts` | The table: start, read, wait, stop, list, the limits, and the end listeners. Plain data and functions that take it. |
| `lib/runtime/jobs/progressText.ts` | Keeps the last state of a progress bar: the text after the last carriage return on each line. |
| `lib/runtime/state/context.ts` | `RuntimeContext.jobs`, a new table for each execution context, and the stop in `cleanup()`. |
| `lib/stdlib/jobs.ts` | `_startJob`, `_jobOutput`, `_stopJob`, `_listJobs`: the helpers the Agency side calls, each reading the run. |
| `stdlib/jobs.agency` | `std::jobs`: `jobOutput`, `stopJob`, `listJobs`, and the `JobReport` and `JobSummary` types. |
| `stdlib/safeBash.agency` | `startJob`, beside `safeBash`, because both go through `approvedPlan`. |
| `lib/host/host.ts` | `output()` on `RunningProcess`: the output collected so far. |

A job is started with the host's `start`. Each job owns an
`AbortController`, and its signal is the only one passed to the child.
`endJob` and `endAllJobs` abort it, and the host's stop then sends
`SIGTERM` to the whole process group and `SIGKILL` two seconds later.
`jobOutput` reads `output()` and keeps, per stream, how many characters it
has already returned.

## Approvals

`startJob` raises exactly what `safeBash` raises for the same command. Both
call `approvedPlan`, which plans the command, returns a refusal, and raises
every effect of the plan. `startJob` starts the job only after
`approvedPlan` returns success. `_startJob` runs a command with no
interrupt of its own, as `_bash` does in `runBash`, and it is safe for the
same reason: the only path to it runs through `approvedPlan`. Do not add a
caller that skips it.

Only a plan of kind `bash` becomes a job. Every other plan, such as a file
read, `echo`, or an `agency` line, runs in the foreground the way `safeBash`
runs it, and `startJob` puts a line in front of its output saying so.
`approvedPlan` decides from the plan whether the command will run as a job.
When it will, the `std::bash` and `std::exec` questions say "in the
background" and carry the job's limit as their `timeout`. So a question
always describes what will run.

An "always approve" rule for `std::bash` pins `command` and `cwd`, and
`std::exec` pins `command` and `subcommand`. Neither pins `timeout`, so a
rule saved for a command in the foreground also approves it as a job.

`jobOutput`, `stopJob`, and `listJobs` raise nothing. A job exists only
because its command was approved. Its output is what `safeBash` would have
returned under the same approval, and stopping it can only undo what that
approval allowed. An id names a job in the run's own table, so a call can
never reach a process the run did not start. A policy that wants no jobs
rejects `std::bash` and `std::exec`.

## Checkpoints and pauses

The table is a field on `RuntimeContext`, beside the lock tables, and is
not saved in a checkpoint: a running process is not data.
`createExecutionContext` gives each run a new, empty table.

`cleanup()` stops every job in the table. These callers run it, each on a
context whose run is over:

- `finalizeExecCtx` in `lib/runtime/node.ts`, when a node run returns.
- `lib/runtime/interrupts.ts`, when a resumed run returns, and when a
  resumed served invocation returns.
- `rewindFrom` in `lib/runtime/rewind.ts`, after the replay it ran.
- `lib/debugger/overlays.ts`, on the contexts the debugger makes for its
  overlays.

So a job stops when its run ends, and when the run pauses to hand an
interrupt to its caller. After a resume, a debugger rewind, or a restart,
the table is empty, and `jobOutput` or `stopJob` for an old id returns a
failure that says the job is not running in this run.

A `restore(checkpoint)` inside a program is different. It is applied to
the same context (`applyRestoreSignal` in `lib/runtime/node.ts`), so the
jobs keep running, and the conversation may no longer mention them.

The interactive `agency agent` answers its interrupts in a handler, so it
does not pause this way during a session.

## Branches and child processes

Every branch of a run shares the run's table. A job the coder starts in a
tool call is visible to the main agent. A program started with `run()` from
`std::agency` has its own context and its own table, and its jobs stop when
it ends or pauses.

## What stops a job and what does not

A job stops when:

- `stopJob` is called. Its state becomes `stopped`.
- It reaches its time limit, `maxMinutes`, 60 by default and at most 720.
  Its state becomes `timedOut`.
- It prints more than 10 MiB on one stream. Its state is `ended`, and its
  `note` names the stream.
- Its run ends or pauses, as above. The host's exit hook is the backstop
  for a process that dies.

A job does not stop when:

- **The user presses Escape.** Escape aborts the run's signal. A job never
  listens on that signal, only on its own. A `jobOutput` wait does listen
  on it, so the wait ends and throws `leafCancel(...)`, which keeps the
  cause and so tells an Escape from a kill.
- **A guard trips.** A time guard aborts the stack's signal, which also
  ends a wait. When the runner will raise that trip at its next step,
  `_jobOutput` returns the job's report instead of throwing. The next step
  then raises the trip as `std::guard`, so every handler sees it, as it
  sees a trip between statements, and a handler can approve more time. A
  wait that threw here would skip the handlers.

A job whose process fails after it started, such as a command the system
could not run, ends as `ended` with no exit code and the error in its
`note`. It never stays `running`, so it never counts against the limit.

## Limits

`MAX_RUNNING_JOBS` (8) jobs can run at once. A ninth `startJob` returns a
failure that lists the running jobs. The table keeps `MAX_FINISHED_JOBS`
(20) finished jobs. Past that it drops the oldest finished job whose output
was read, or the oldest finished job when every one is unread.

## The agent

`jobTools()` in `stdlib/agents/lib/toolkits.agency` returns `startJob`,
`jobOutput`, and `stopJob`. `shellTools()` does not include them.

In `agency agent`, the main agent and both coders carry them, and only in
an interactive session. `sessionJobTools()` in
`brains/coordinator/subagents/code.agency` reads the one-shot flag. A
one-shot run exits when its turn ends, and the exit would stop its jobs.

**The jobs message.** At the start of each turn, `mainAgent` calls
`addJobsNote()` (`lib/jobsNote.agency`), which adds a system message that
expires when the turn's `llm()` call returns:

```
Background jobs:
- job-1  running  14m 2s  ./run-comparison.sh
- job-2  exit 1, output not read yet  2m 40s  pnpm test:run
```

A job is listed while it runs, and after it ends until a read returns its
final state. `stopJob` reads the job, so a job the model stopped drops off.
The routed coder and the coder called as a tool run on the main thread, so
they read the message too. `coderTurn` adds none: it runs only for a turn
started with `--agent`, which is the session's first turn, before any job
exists. Nothing starts a turn when a job ends.

**The finish line.** `_runLineRepl` in `lib/stdlib/cli.ts` listens with
`onJobEnd` and prints a line such as `job-1 finished after 41m 8s (exit
0): ./run-comparison.sh`, built and printed by `lib/stdlib/cliJobLine.ts`. During a turn it writes the line, and the
spinner's footer redraws below it. At an idle prompt it clears the prompt
line, writes the line, and draws the prompt again with what was typed. A
local `turnRunning` flag, set beside the Herdr reports, tells the two
apart. The spinner cannot, because a nested prompt stops it in the middle
of a turn.

**`/jobs`** lists the jobs. `/jobs stop <id>` stops one with no approval,
like `!command`, because the user typed it. It prints nothing on success,
since the finish line reports the stop. It leaves a pending note, so the
model learns the user stopped the job.

`describeJobState` in `jobTable.ts` is the one place a state becomes words
(`running`, `exit 0`, `stopped`, `timed out`). The jobs message, the finish
line, `/jobs`, and the tool trace all show its result, through the
`status` field.

## Tests

- `lib/runtime/jobs/jobTable.test.ts`: the table against a real bash.
- `lib/runtime/state/context.test.ts`: `cleanup()` stops a job and what it
  started.
- `tests/agency/jobs.agency`: approvals, reads, stops, guard trips during a
  wait, and the foreground path.
- `lib/agents/agency-agent/brains/coordinator/tests/toolWiring.agency`:
  which sessions carry the tools.
- `lib/agents/agency-agent/tests/jobsNote.agency`: the jobs message.
