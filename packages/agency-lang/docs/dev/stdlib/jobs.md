# Background jobs

A background job is a shell command that keeps running while the program
does other work, and after the program has ended.

```agency
startJob("./run-comparison.sh")      // "Started job-3fa9c1. ..." at once
jobOutput("job-3fa9c1")              // what it printed so far, and "running"
jobOutput("job-3fa9c1", wait: 300)   // returns when it ends, or after five minutes
stopJob("job-3fa9c1")                // stops it and everything it started
```

The same jobs through handles, for Agency code:

```agency
const job = start(shellJob("./run-comparison.sh", label: "comparison"))?
output(job)
stop(job)
```

Each read returns only the output this run has not read before. When the
job has ended, the report has its exit code.

## Where the code lives

| File | What |
| --- | --- |
| `lib/runtime/jobs/jobRecord.ts` | The record's schema, the id check, the file names, and reading and changing a record. |
| `lib/runtime/jobs/jobRunner.ts` | What the runner process does: run the command, copy its output, watch for `stop`, write the ending. |
| `lib/runtime/jobs/detachedJobs.ts` | What a starter or a reader calls: launch, status, read output, stop, list, clean up. |
| `lib/runtime/jobs/heldJobs.ts` | The list of jobs a run holds, and how a checkpoint's list is merged in. |
| `lib/runtime/jobs/jobEndWatcher.ts` | The watch the REPL runs to print a line when a job ends. |
| `lib/runtime/jobs/progressText.ts` | Keeps a progress bar's last state: the text after the last carriage return on each line. |
| `lib/stdlib/jobs.ts` | The helpers the Agency side calls, each reading the run. |
| `stdlib/jobs.agency` | `std::jobs`: `shellJob`, `start`, `status`, `output`, `stop`, and the tools `jobOutput`, `stopJob`, `listJobs`. |
| `stdlib/safeBash.agency` | `JobHandle`, `startShellJob`, and `startJob`, beside `safeBash`, because all go through `approvedPlan`. |
| `lib/cli/jobs.ts` | `agency jobs`, `agency jobs stop <id>`, and `agency jobs clean`. |
| `lib/stdlib/cliJobLine.ts` | The line the REPL prints when a job ends. |

## The folder

Each job has a folder, `<agency home>/jobs/<id>/`, which is
`~/.agency/jobs/<id>/` unless `AGENCY_HOME` says otherwise. It holds:

- `record.json`: the command, its label and folder, its time limit, its
  state, how it ended, and the pid and start time of the runner and of
  the command.
- `stdout.log` and `stderr.log`: everything the command printed.
- `stop`: present when someone asked the job to stop.

The jobs folder and each job's folder are made with `privateDir`, mode
`0700`, and checked on every read as well as on the first write. Whoever
can write a job's folder can stop the job and forge its record.

A job's output stays on disk after the job ends, secrets and all, until
`agency jobs clean` removes the folder. Nothing else removes one.

**An id is checked before it is a path.** An id is `job-` and six hex
digits. `jobDir` throws for any other text, so an id from a command line
or a checkpoint, such as `../../x`, never becomes a path.

**A folder is never reused.** `launchJob` makes the folder with
`privateDir(..., { mustBeNew: true })` and picks another id when the
folder exists. Folders stay until someone cleans them, so after a few
thousand jobs a new id would otherwise match an old one, and the new job
would write into the old job's files and obey its `stop` file.

**A record is replaced whole.** Every write goes to a sibling file that is
renamed over the record, so a reader never sees half a record. The node
host checks, after it opens a file, that the path still names the file it
opened. A read that lands on a rename fails that check, so `readRecord`
and `changeRecord` try again (`RECORD_READ_ATTEMPTS`). Only a missing
record reads as null: a record that cannot be read throws, so a failed
read is never taken for a job that does not exist.

## The runner

A process of its own owns each job: the runner, which is the hidden CLI
command `agency job-runner <dir>`. Only a parent can learn how its child
ended, and the program that started the job may be gone by then, so the
runner is the command's parent. It is found the way `spawn` finds the CLI,
through `agencyCliPath()`, which falls back to the package's `dist/` under
vitest. A test that starts a real runner needs a build first.

`launchJob` writes the record, starts the runner with
`host.subprocess.startDetached`, and waits up to `START_WAIT_MS` for the
runner to write its pid. The runner:

1. Runs nothing when the record no longer says `running`, a `stop` file is
   there, or another runner has already written its pid.
2. Writes its pid and start time, starts the command through the host, and
   writes the command's pid and start time.
3. Every quarter second, appends what the command printed to the two
   files, and aborts the command when a `stop` file appears. The host then
   sends `SIGTERM` to the command's process group, and `SIGKILL` two
   seconds later.
4. When the command ends, appends the last output and writes the ending:
   `ended` with the exit code, `stopped`, `timedOut` at the job's limit, or
   `ended` with a note naming the stream that passed 10 MiB.

When the runner does not start in time, `launchJob` writes the `stop` file
first and an `ended` record second, then fails. A runner that starts late
finds both and runs nothing, so a start the model was told had failed
never runs.

The record is written by the starter once, by the runner when it starts,
and by the runner at the ending. There is no heartbeat, so a runner that is
alive but stuck reads as `running` until the job's time limit.

## When the runner dies

The host starts every command in its own process group. A runner killed
with `SIGKILL`, or lost to a reboot, leaves its command running, with
nothing enforcing its limits and nothing collecting its output. So a job
with no runner is stopped.

Every reader applies the rule: `jobStatus`, `requestStop`, a listing, and
the REPL's watch. When a record says `running` and its runner is gone:

1. If the command's process is alive and its start time matches the
   record, its group is stopped through `host.subprocess.stopGroup`, and
   the note is `The job's runner died, so its command was stopped.`
2. If the start time cannot be read (no usable `ps`), nothing is signalled,
   and the note names the pid that may still be running.
3. The record is written as `ended`, but only if it still says `running`.
   A runner that wrote its real ending and exited a moment before keeps its
   exit code.

A runner is gone when its pid names no process, or names one whose start
time differs from the record's by more than two seconds: after a reboot
the system may have given the pid to another process. The start-time
check is `processStartedAt`, which `agency attach` uses for the same
purpose (`lib/host/node/processStartTime.ts`). A pid whose state cannot be
read is taken as alive.

A record that says `running` with no runner pid is a launch in progress,
until it is older than two launch waits. Then the starter died while it
waited, and a reader ends the job the way `launchJob` would have.

## The jobs a run holds

A run keeps the jobs it started on its context, `heldJobs`: each job's
handle, how many characters of each stream this run has read, and whether
a read has returned the job's ending. Reads move only this run's
positions, never anything on disk, so `agency jobs` or another session can
read the same job without moving this run's place.

The list is on the context, not in an Agency global, because each branch
of a `fork`, and each parallel tool call, gets its own copy of a module's
globals. A job started in a parallel tool call would be forgotten when its
branch ended. The context is one for every branch of a run.

The list is saved in every checkpoint, beside `spawnCount`, and in
`checkpointSchema`, which drops any key it does not list. A resume in
another process gets the list back, and `jobOutput` carries on from the
saved positions. On a restore, `adoptHeldJobs` keeps every job the run
already holds and adds the checkpoint's, as a restore never lowers
`spawnCount`: a job is real work outside the run, and a list that forgot
it would leave it running with nothing to stop it. An entry whose id is
not a job id is dropped, since a checkpoint is a file a person can edit.

The list never shrinks. A long session's list grows with every job, and so
does `listJobs()`.

At most `MAX_RUNNING_JOBS` (8) of the held jobs may be running or starting
at once. `_launchJob` counts the running ones, which needs reads, then
checks the count plus `startingJobs` and raises `startingJobs` with no
`await` between the two, so of two parallel starts at seven running,
exactly one passes.

## Approvals

`startJob` raises exactly what `safeBash` raises for the same command. Both
go through `approvedPlan`, which plans the command, returns a refusal, and
raises every effect of the plan. `startShellJob` is the one path to a
launch: it starts the job only after `approvedPlan` returns success.
`_launchJob` runs a command with no interrupt of its own, as `_bash` does
in `runBash`, and it is safe for the same reason. Do not add a caller that
skips `approvedPlan`.

Only a plan of kind `bash` becomes a job. `startJob` runs every other plan,
such as a file read, `echo`, or an `agency` line, in the foreground the way
`safeBash` runs it, with a line in front of its output saying so. `start`
refuses such a plan and runs nothing; its approvals are still asked first,
because the plan's kind is known only after `approvedPlan`.

An "always approve" rule pins `command` and `cwd` for `std::bash`, and
`command` and `subcommand` for `std::exec`. Neither pins `timeout`, so a
rule saved for a command in the foreground also approves it as a job.

`jobOutput`, `stopJob`, `listJobs`, `status`, `output`, and `stop` raise
nothing. A job exists only because its command was approved, its output is
what `safeBash` would have returned under the same approval, and stopping
it can only undo what that approval allowed. Each acts only on a job the
run holds, so a call never reaches a process the run did not start.
Stopping a job the run does not hold is a person's action, at a terminal
with `agency jobs stop`.

**A job cannot start inside a `run()` subprocess,** as `spawn` cannot. Code
in a `run()` child is sandboxed, and a job would outlive the child with
nobody holding it. `startShellJob` refuses before any approval is asked,
and `_launchJob` refuses again.

## What stops a job and what does not

A job stops when it is stopped (`stopped`), when it reaches its time limit
(`timedOut`), and when it prints more than 10 MiB on one stream (`ended`,
with a note). A command that fails after it started ends as `ended` with
the error in the note.

A pause, the end of a turn, the end of the run, and the end of the program
do not stop a job. `cleanup()` stops nothing. A program that starts a job
and returns exits at once and leaves the job running, so nothing in the
standard library may start a timer that outlives its call: the host
clock's timer keeps a process alive.

Escape and a guard trip do not stop a job either. They do end a
`jobOutput` wait:

- **Escape** throws `leafCancel(...)`, which keeps the cause, so the REPL
  still reads it as an interrupt and not a kill.
- **A time guard trip** returns from the wait without throwing, and the
  next step raises it as `std::guard`, so every handler sees it and can
  grant more time. `jobOutput` waits and reads in two statements, so a
  handler that rejects the trip leaves the output for the next read.

## `agency jobs`

`agency jobs` lists every job on the machine, newest first, with its state,
running time, and label. `agency jobs stop <id>` stops one, and refuses
text that is not a job id. `agency jobs clean` removes the folders of the
jobs that are not running. None of them runs Agency code, so they need no
run and no policy. A listing reads each job as any reader does, so it ends
a job whose runner has died, and stops its command.

## The agent

`jobTools()` returns `startJob`, `jobOutput`, and `stopJob`. In
`agency agent` the main agent and both coders carry them in the REPL and
under the session core (`sessionJobTools()` in
`lib/agents/agency-agent/lib/cliTools.agency`, passed to `agencyAgent` in
`extraTools`). A one-shot run offers none: its turn is the whole run, so a
model that started a job could never read it. `agencyAgent` itself offers
no job tools. The main agent also gets `readSpill` and `grepSpill`,
because a long read is saved and previewed and the main agent has no shell
to read its path with.

**The jobs message.** `answerTurn` in `lib/agents/agency-agent/lib/answer.agency`
calls `addJobsNote()` before each turn's `agencyAgent` call. It adds a
system message, which expires when the turn's first `llm()` call returns,
listing each job that is running or ended and unread.

**The finish line.** The REPL calls `watchHeldJobs`, which reads the run's
held jobs every second and reports each one that ends since the watch
began. The terminal starts and stops the watch; the standard library never
does, for the reason under "What stops a job". The watch reads the list on
every poll, so a job started in any branch, or one that came back from a
checkpoint, gets its line. What `_runLineRepl` does with the line depends
on what owns the terminal. During a turn it writes the line. At the plain
prompt it clears every row of the prompt, writes the line, and draws the
prompt again with what was typed. While the slash menu, `/paste`, or
`$EDITOR` owns the terminal, it holds the line and prints it when the
prompt or a turn takes the terminal back.

**`/jobs`** lists the session's jobs, and `/jobs stop <id>` stops one. See
`docs/dev/agents/user-commands.md`.

`describeJobState` is the one place a state becomes words (`running`,
`exit 0`, `stopped`, `timed out`). Everything that shows a state uses it.
