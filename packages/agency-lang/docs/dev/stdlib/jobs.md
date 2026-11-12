# Background jobs

A background job is a shell command that keeps running while the program
does other work.

```agency
startJob("./run-comparison.sh")      // "Started job-3fa9c1. ..." at once
jobOutput("job-3fa9c1")              // what it printed so far, and "running"
jobOutput("job-3fa9c1", wait: 300)   // returns when it ends, or after five minutes
stopJob("job-3fa9c1")                // stops it and everything it started
```

Each `jobOutput` returns only the output not returned before. When the job
has ended, the report has its exit code.

## Where the code lives

| File | What |
| --- | --- |
| `lib/runtime/jobs/jobTable.ts` | The table: start, read, wait, stop, close, list, the limits, and the end listeners. |
| `lib/runtime/jobs/progressText.ts` | Keeps a progress bar's last state: the text after the last carriage return on each line. |
| `lib/runtime/state/context.ts` | `RuntimeContext.jobs`, a new table for each execution context, closed by `cleanup()`. |
| `lib/stdlib/jobs.ts` | The helpers the Agency side calls, each reading the run. |
| `stdlib/jobs.agency` | `std::jobs`: `jobOutput`, `stopJob`, `listJobs`, and the `JobReport` and `JobSummary` types. |
| `stdlib/safeBash.agency` | `startJob`, beside `safeBash`, because both go through `approvedPlan`. |
| `lib/stdlib/cliJobLine.ts` | The line the REPL prints when a job ends. |

A job is started with the host's `start`, and `output()` on the handle is
what it has printed so far. Each job owns an `AbortController`, and its
signal is the only one passed to the child. Aborting it makes the host send
`SIGTERM` to the whole process group, and `SIGKILL` two seconds later.

Ids are `job-` and six random hex digits. A new table cannot continue an
old count, because the table is not saved, and a counter would hand a
resumed session an id its conversation already used for another command.

## Approvals

`startJob` raises exactly what `safeBash` raises for the same command. Both
call `approvedPlan`, which plans the command, returns a refusal, and raises
every effect of the plan. Both signatures name the effect set
`SafeBashEffects`. `startJob` starts the job only after `approvedPlan`
returns success. `_startJob` runs a command with no interrupt of its own,
as `_bash` does in `runBash`, and it is safe for the same reason: the only
path to it runs through `approvedPlan`. Do not add a caller that skips it.

Only a plan of kind `bash` becomes a job. Every other plan, such as a file
read, `echo`, or an `agency` line, runs in the foreground the way `safeBash`
runs it, with a line in front of its output saying so. `approvedPlan`
decides from the plan whether the command runs as a job. When it does, the
`std::bash` and `std::exec` questions say "in the background" and carry the
job's limit as their `timeout`.

An "always approve" rule pins `command` and `cwd` for `std::bash`, and
`command` and `subcommand` for `std::exec`. Neither pins `timeout`, so a
rule saved for a command in the foreground also approves it as a job.

`jobOutput`, `stopJob`, and `listJobs` raise nothing. A job exists only
because its command was approved, its output is what `safeBash` would have
returned under the same approval, and stopping it can only undo what that
approval allowed. An id names a job in the run's own table, so a call never
reaches a process the run did not start.

## Checkpoints and pauses

The table is not saved in a checkpoint. `cleanup()` closes it, which stops
every job and every start still in progress, and refuses any later start.
Every caller of `cleanup()` runs it on a context whose run is over:

- `finalizeExecCtx` in `lib/runtime/node.ts`, when a node run returns.
- `lib/runtime/interrupts.ts`, when a resumed run or a resumed served
  invocation returns.
- `rewindFrom` in `lib/runtime/rewind.ts`, after its replay.
- `lib/debugger/overlays.ts`, on the contexts the debugger makes.

So a job stops when its run ends, and when the run pauses to hand an
interrupt to its caller. After a resume, a rewind, or a restart the table is
empty. A `restore(checkpoint)` inside a program is applied to the same
context (`applyRestoreSignal` in `lib/runtime/node.ts`), so its jobs keep
running. The interactive `agency agent` answers its interrupts in a
handler, so it does not pause during a session.

Every branch of a run shares the run's table. A program started with
`run()` from `std::agency` has its own context and its own table.

## What stops a job and what does not

A job stops when `stopJob` is called (`stopped`), when it reaches
`maxMinutes` (`timedOut`), when it prints more than 10 MiB on one stream
(`ended`, with a `note` naming the stream), and when its run ends or
pauses. A process that fails after it started ends its job as `ended` with
the error in `note`, so it never stays `running`.

Escape and a guard trip do not stop a job, because a job never listens on
the run's signal. They do end a `jobOutput` wait:

- **Escape** throws `leafCancel(...)`, which keeps the cause, so the REPL
  still reads it as an interrupt and not a kill.
- **A time guard trip** returns from the wait without throwing, and the
  next step raises it as `std::guard`, so every handler sees it and can
  grant more time. `jobOutput` waits and reads in two statements, so a
  handler that rejects the trip leaves the output for the next read.

## Limits and memory

At most `MAX_RUNNING_JOBS` (8) run at once, and the table keeps
`MAX_FINISHED_JOBS` (20) finished jobs, dropping the oldest one whose
output was read first. Once a read returns a finished job's last output,
the job lets go of its output, so finished jobs hold no text that was
already read.

## The agent

`jobTools()` returns `startJob`, `jobOutput`, and `stopJob`. In
`agency agent` the main agent and both coders carry them in an interactive
session only (`sessionJobTools()` in `subagents/code.agency`): a one-shot
run exits when its turn ends, which would stop its jobs. The main agent
also gets `readSpill` and `grepSpill`, because a long read is saved and
previewed, and the coders already have both.

**The jobs message.** `mainAgent` calls `addJobsNote()` each turn. It adds
a system message, which expires when the turn's `llm()` call returns,
listing each job that is running or ended and unread. The routed coder and
the coder called as a tool run on the main thread and read it too.

**The finish line.** `_runLineRepl` prints a line when a job ends. What it
does depends on what owns the terminal. During a turn it writes the line.
At the plain prompt it clears every row of the prompt, writes the line,
and draws the prompt again with what was typed. While the slash menu,
`/paste`, or `$EDITOR` owns the terminal, it holds the line and prints it
when the prompt or a turn takes the terminal back.

**`/jobs`** lists the jobs, and `/jobs stop <id>` stops one. See
`docs/dev/agents/user-commands.md`.

`describeJobState` is the one place a state becomes words (`running`,
`exit 0`, `stopped`, `timed out`). Everything that shows a state uses it,
through the `status` field.
