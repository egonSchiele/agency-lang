# Jobs: one interface for work that runs apart from its starter

Written 2026-11-19. The first slice is built
(`docs/superpowers/plans/2026-11-19-jobs-1-outlive-the-turn.md`), and the
sections below say where it differs from the first draft. The rest is a
design. The section "Not checked yet" lists what the design assumes and
nobody has tried.

## The goal

A job is work that keeps going while the thing that started it does
something else, or after it has gone. These are all jobs:

- A script that downloads large models overnight and retries on failure.
- A check on a CI run that merges the pull request when CI passes.
- An agent that edits another agent, runs it against an eval suite, reads
  the results, and edits again.
- Several sub-agents that each do one part of a review.
- An agent on a rented cloud machine that is woken for a task and then
  put back to sleep.
- A task BMO runs every Wednesday.

These differ in where they run, whether they can ask a question, and
whether their state can be saved. So Agency does not define what a job
is. It defines **an interface a thing implements to be a job**, and
builds its tooling (listing, stopping, showing output, and later
schedules and waking) on that interface.

## The problem that started this

Today a background job is a shell command that belongs to the run that
started it (`lib/runtime/jobs/jobTable.ts`, `docs/dev/stdlib/jobs.md`).
The runtime stops a run's jobs when the run ends or pauses to hand an
interrupt to its caller.

`agency agent` is one run that rarely pauses, so its jobs live across
turns. Once the terminal moves onto the shared session core
(`docs/superpowers/plans/2026-11-19-shared-session-core-3-terminal.md`,
Part D), the session pauses after every turn and at every approval. A job
would die at the end of the turn that started it. Part D waits on this
spec's first slice.

## What exists today

Four things already have the same verbs under different names.

| Thing | Start | Status and list | Stop | Interrupts | Saved state |
| --- | --- | --- | --- | --- | --- |
| `startJob`, a shell command (`std::jobs`) | yes | `jobOutput`, `/jobs` | `stopJob` | asked before it starts | none |
| `spawn`, an Agency file as its own process (`std::agency`) | yes | `agency attach` listing, an output file | `kill <pid>` | held, answered with `agency attach` | an optional checkpoint |
| A BMO job | a chat tool | a database row | cancel | BMO's approvals pane | pause and checkpoints |
| A Perry session | the engine | the engine's list | cancel | an approval dialog | a saved run |

The first two are in this repo and become the first two kinds.

## The design in one page

Three pieces of data and two layers of code.

**The description** says what to run. It is plain data, built before the
job starts.

**The handle** says which running job. It is plain data, returned by
`start`. It is saved with the session, so a pause cannot lose it.

**The kind** is the code that knows how to start, stop, and read one
sort of job. A kind is an Agency file that exports one function for each
function in the interface. A description names its kind's file, so there
is no list of kinds to register, and an agent can write a kind and use
it in the same session.

```agency
import { shellJob, start, status, output, stop } from "std::jobs"

const download = shellJob("./fetch-models.sh", label: "Model downloads")
const handle = start(download)?   // the same call for every kind
status(handle)
output(handle)
stop(handle)
```

The shell kind is the only kind built so far, and `shellJob` is exported
from `std::jobs` itself. An `agencyJob` in `std::jobs/kinds` is a later
slice.

**The lower layer** runs something apart from its starter on this
platform and keeps a record of it. It is part of the host. On Node it is
a detached process with a folder on disk.

**The upper layer** is the kinds. A kind whose job runs on this machine
says what to launch, and `std::jobs` launches it with the lower layer. A
kind whose job runs somewhere else (a cloud machine, BMO's database)
does the work itself and never touches the lower layer.

```
 start(description)   status(handle)   stop(handle)   ...      std::jobs
        │                    │               │
        └──────── finds the kind by name, calls its export ───────┐
                                                                  │
   shell kind        agency kind        a user's kind             │  kinds
        │                 │                   │
        └── detached process on this host ────┘   or a web request,
                                                  a database row, ...
```

### Why the description is data

`start` takes a description and nothing else. That one decision gives
four things later without a second design:

- **A schedule** is a description and a time.
- **A restart** starts the same description again.
- **An approval** shows the description, so what was approved is what
  runs. `spawn` works this way today with its `SpawnQuestion`.
- **Another machine** can be sent a description to start there.

### Why the job and the handle are separate

A job lives where it lives. The handle travels with the session.

When a session is handed from a laptop to a phone, the handle goes with
it and the job stays on the laptop. `status(handle)` on the phone answers
`unreachable`, with the name of the machine that has the job. A job on a
cloud machine answers properly from both. Nothing in the design moves a
job between devices.

## The types

What is built in the first slice is smaller than the design below:

```agency
// std::jobs
type JobDescription = { kind: "shell"; label: string; maxMinutes: number }
type ShellJob = JobDescription & { command: string; cwd: string }

// std::safeBash, re-exported by std::jobs
type JobHandle = { id: string; kind: string; label: string; startedAt: number }
```

`whenStarterPauses` is not built, because nothing needs `"stop"` yet.
`where`, `data`, and the `unreachable` state wait for the first job that
can be somewhere other than this machine. `JobHandle` lives in
`std::safeBash` because `std::jobs` imports that module, and a type in
`std::jobs` would make the two import each other. `startedAt` is
milliseconds since the Unix epoch. The full design:

```agency
/** What to run. Each kind adds its own fields. */
type JobDescription = {
  kind: AgencySource;        // the kind's file, as learn and run take one
  label: string;             // what a person sees in a list
  whenStarterPauses: "keepRunning" | "stop";   // default "keepRunning"
  maxMinutes: number | null
}

/** Which running job. Saved with the session. */
type JobHandle = {
  id: string;                // "job-" and random hex, as today
  kind: string;              // the kind's name, to show a person
  label: string;
  where: string;             // the machine or service that has the job
  startedAt: string;
  data: Record<string, any>  // what the kind needs to find the job again
}

type JobState =
  "running" | "waiting" | "paused" | "ended" | "stopped" | "timedOut" | "unreachable"

type JobStatus = {
  state: JobState;
  status: string;            // the state in words, from describeJobState
  runningFor: string;
  exitCode: number | null;
  note: string
}
```

`waiting` means the job is held on an interrupt.
`JobStatus` keeps the fields today's `JobSummary` has, so `/jobs` and the
jobs message read the same.

## The interface

A kind's file exports these. `std::jobs` has a function of the same name
for each, which finds the kind and calls its export.

### A kind's code is sandboxed, so it cannot start a process

A kind's function is called the way `learn` calls a learned function: in
a `run()` child process, with the caller's handlers and policy voting on
every interrupt it raises. That contains a kind that hangs or misbehaves,
and it is why an agent can use a kind it has just written.

Code in a `run()` child is sandboxed, and `spawn` refuses to run there,
because a started process is not sandboxed and would be a way out
(`docs/superpowers/specs/2026-11-15-start-a-program-in-its-own-process.md`,
"Inside `run()`"). The same rule holds here. **A kind never starts a
process. It says what to launch, and `std::jobs` launches it** in the
caller's process, after raising the interrupt for that launch.

So a kind is one of two shapes.

**A kind whose job is a process on this machine exports `launch`.**

| Function | Returns | What it does |
| --- | --- | --- |
| `launch(description)` | `Result<Launch>` | Says what to run. Starts nothing. |

```agency
type Launch =
  | { run: "command"; command: string; cwd: string }
  | { run: "agencyFile"; dir: string; filename: string; node: string;
      args: string[]; policy: Record<string, any>;
      maxCost: number | null; maxTime: number | null }
```

`std::jobs` then does the rest with the lower layer and no kind code:
`start`, `status`, `stop`, and `output` for a command, and those plus
the functions `spawn` and `agency attach` already give an Agency file.
This is the behaviour a local kind gets for free.

**A kind whose job runs somewhere else exports the functions itself.**

| Function | Returns | What it does |
| --- | --- | --- |
| `start(description)` | `Result<JobHandle>` | Starts the job, for example with a web request. |
| `status(handle)` | `JobStatus` | The state now. |
| `stop(handle)` | `Result<JobStatus>` | Stops the job and what it started. |

**Any kind may export `info(handle)`,** extra facts to show a person:
the command, the folder, the cost so far.

**A kind exports the rest only when it can do them.** The two columns say
what the two kinds in the standard library can do.

| Function | What it does | Shell | Agency |
| --- | --- | --- | --- |
| `output(handle)` | What the job printed since the last read. | yes | yes |
| `result(handle)` | The value the job returned. | no | yes |
| `interrupts(handle)` | The interrupts the job is held on. | no | yes |
| `respondToInterrupts(handle, responses)` | Responds to them and lets the job go on. | no | yes |
| `send(handle, message)` | Hands the job a message while it runs. | no | later |
| `pause(handle)` | Stops the job in a way `resume` can undo. | no | yes |
| `save(handle)` | The job's state as data. | no | yes |
| `resume(handle)` | Carries on a paused or saved job. | no | yes |

The two interrupt functions are the ones a TypeScript caller already
uses on a paused run, with a handle where the run's result would be.
`interrupts(handle)` returns the same interrupt values, always as a
list. `responses` has one response for each, in the same order, each
made with `approve()`, `approve(value)`, `reject()`, or
`reject(reason)`. A job is held and answered as a whole batch, as a run
is.

```agency
for (intr in interrupts(handle)) { print(intr.message) }
respondToInterrupts(handle, [approve(), reject("not on main")])
```

What a kind can do is read from what its file exports. `describe` in
`std::agency` already lists a module's exports and their signatures, so
there is no second list of abilities to keep in step. Calling a function
a kind does not export is a failure that names the kind and the function.

The whole shell kind is a few lines:

```agency
// std::jobs/kinds/shell.agency, in outline.
export type ShellJob = JobDescription & { command: string; cwd: string }

export def launch(description: ShellJob): Result<Launch> {
  return success({ run: "command", command: description.command, cwd: description.cwd })
}
```

The defaults apply only to a job `std::jobs` launched itself, so a kind
that runs elsewhere can never be handed a `stop` that stops nothing.

## Finding a kind

There is no registry. A description names its kind's file with
`AgencySource`, the type `learn`, `run`, and `runFile` take: a `std::`
module, a contained Agency file, or source text.

```agency
// shellJob and agencyJob fill this in for the two standard kinds.
// An agent that has just written runpod.agency does this:
const runpod = { kind: "file", dir: "./jobs", filename: "runpod.agency" }
const handle = start({ kind: runpod, label: "Wikipedia crawl", machine: "a100" })
```

**When a job starts, a copy of its kind's source is saved in the job's
folder.** Every later call on that job uses the copy. Three things
follow:

- Any program on the machine can list, stop, or respond to the job with
  the code that started it: `agency jobs`, Perry, a session that did not
  start it.
- Editing the kind's file does not change a job that is running. `learn`
  keeps a copy of what it learned for the same reason.
- A handle carries the job's id and no path to code. A saved session
  from another machine cannot tell this program which file to load. A
  handle whose job folder is not on this machine reports `unreachable`.

A folder of saved kinds in the agent's home, like the toolbox, is a
later addition, so that a kind an agent wrote lasts across sessions.

## The lower layer

**As built in the first slice.** The host's subprocess part gained four
functions, not a new part: `startDetached`, `processState`,
`processStartedAt`, and `stopGroup`. The job folder's logic is shared code
that takes a host (`lib/runtime/jobs/`). A small process of its own, the
runner (`agency job-runner <dir>`), owns each job, because only a parent
can learn how a child ended and the starter may be gone by then. A stop
is a file named `stop` in the job's folder, which the runner looks for. A
signal is sent in one case only: the runner has died and its command is
still running, which the record's saved start times show. The two output
streams go to two files, `stdout.log` and `stderr.log`. The first draft
follows.

A new part of the host, used through `std::detached`. On Node it is what
`spawn` already does for one case, taken out and made general:
`startDetached` in `lib/cli/detached.ts` (own process group, output
appended to a file opened with `O_NOFOLLOW`) and the per-program folder
`_spawnPaths` names.

| Function | What it does |
| --- | --- |
| `startDetached(command, options)` | Starts the command apart from this process and writes its record. |
| `detachedStatus(handle)` | Alive or not, and how it ended. |
| `readOutput(handle)` | Output since this reader's last read. |
| `stopDetached(handle)` | `SIGTERM` to the process group, then `SIGKILL`, as jobs do today. |
| `listDetached()` | Every record on this machine. |

Each job has a private folder, `~/.agency/jobs/<id>/`:

- `record.json`: the handle, the description, the state, and how it
  ended. For a process, the pid and the time the process started, so a
  pid the system has reused is not taken for the job.
- `kind.agency`: the copy of the kind's source.
- `output.log`: both output streams.
- `inbox/` and `outbox/`: messages, when a later slice adds them.

The record is on disk so that any program on the machine can list the
jobs. A job started in `agency agent` shows in Perry, because both read
the same folder. A list reads records and runs no kind's code, so it
needs no run and no policy. A kind that runs elsewhere has a folder too,
with the last state its `status` reported.

Nothing deletes a job's folder. `agency jobs clean` removes the folders
of ended jobs when a person asks. A record whose process is gone, after
a reboot for example, reads as `ended` with a note.

| Host | What it runs | Outlives its starter |
| --- | --- | --- |
| `nodeHost` | a detached process | yes |
| `memoryHost` | a scripted fake, for tests | as the test says |
| `browserHost` | refuses in the first version; a worker later | no |

The layer says what it can promise, so a kind can refuse or warn. A
worker dies when the page closes, so a browser can never promise that a
job outlives the page.

An app changes this layer the way Perry already changes the working
folder: by building a host with one part replaced.

## Interrupts, checkpoints, and pauses

- **A handle is saved in a checkpoint. A job is not.** After a resume in
  the same process, another process, or another machine, the session
  still has its handles.
- **A pause does not stop a job.** In the first slice every job keeps
  running; the `stop` choice is not built.
- **A job cannot start inside a `run()` subprocess,** as `spawn` cannot.
  The child is sandboxed, and a job would outlive it with nobody holding
  it.
- **A rewind does not undo a start.** The job is real work outside the
  run. After a rewind the run keeps every job it held and adds the
  checkpoint's, as a restore does not lower `spawnCount`. A list that
  forgot a job would leave it running with nothing to stop it.
- **Every start raises an interrupt, and a policy rule can answer it.**
  `std::jobs` raises it for a launch on this machine: for a command,
  exactly what `safeBash` raises for that command, through
  `approvedPlan`, as `startJob` does today; for an Agency file,
  `std::spawn`. A kind that runs elsewhere raises its own, such as
  `std::fetch`. There is no separate rule for a start that repeats: a
  schedule or a restart raises again, and its policy answers.
- **At most 8 jobs a session started may run at once,** as today.
- **Each kind says when it can raise an interrupt.** A shell command
  cannot raise one, so every interrupt is raised before it starts. An
  Agency program can raise one while it runs, and it is held until
  someone responds, as a spawned program is now.
- **A session acts freely on handles it holds,** because each exists
  only through an approved start. Listing or stopping jobs the session
  does not hold a handle for is a person's action (`agency jobs`, the
  job list in an app). From Agency code it raises an interrupt.

## Messages between processes

Not in the first slices. The shape is set now so the folder and the
interface leave room for it.

Each job has an inbox and an outbox. `send(handle, message)` writes to
the inbox. The job writes to the outbox when it has something for its
starter: an interrupt, a notice that it finished, or a plain message.
Approvals, waking the agent, and agents talking to each other are then
all reads and writes on the two. The outbox is on disk because the
starter may be gone when the job writes to it.

`agency attach` already responds to a running program's held interrupts
over its debug socket (`docs/dev/runtime/spawn.md`). `interrupts` and
`respondToInterrupts` for the agency kind are built on that.

## What changes for the agent

The model keeps the tools it has: `startJob`, `jobOutput`, and `stopJob`,
with the same names and the same reports. Underneath they call the shell
kind. `/jobs` and the jobs message (`jobsNote.agency`) read handles the
session holds.

The session core calls `setJobToolsOn(false)` today. It turns them on
once the shell kind exists, and Part D of the terminal plan can go
ahead.

`spawn` stays as it is. `std::jobs` calls it for an `agencyFile` launch,
with the output file inside the job's folder, and a `ProcessInfo` is
what the handle carries in `data`.

## Out of scope

- **Waking the agent when a job ends.** Agreed as needed and agreed as
  later. It reads the outbox.
- **Schedules.** A schedule is a thing that starts jobs and is not a job.
- **Sub-agents as jobs.** A sub-agent does not have to be a job. Letting
  the agent start one as a job is a later option.
- **Kinds that run elsewhere** (a cloud machine, BMO's database). The
  interface is drawn so they fit. None is built here.
- **Jobs in the browser.**
- **Moving a job between machines.**

## Slices

Each slice leaves something that works end to end. These become a
milestone in Linear once the approach is agreed.

1. **Shell jobs that outlive a turn.** The lower layer on Node, and
   today's `startJob` tools moved onto it. `/jobs` and the jobs message
   read records from disk. The run-owned job table is removed. This
   unblocks Part D of the terminal plan.
2. **The interface and kinds.** `std::jobs` with descriptions, handles,
   and `start`, `status`, `info`, `stop`, `output`. The shell kind as a
   kind's file, and a kind a user wrote, named by a description.
   `agency jobs` lists, stops, and cleans up jobs from a terminal.
3. **The agency kind.** Over `spawn`, with `result`, `interrupts`,
   `respondToInterrupts`, `pause`, `save`, and `resume`.
4. **Jobs in Perry.** The engine lists the machine's jobs and a
   session's handles.
5. **Messages.** The inbox and outbox, and `send`.
6. **Waking.** A job's ending starts a turn.
7. **Schedules.**

## Open questions

1. **A kind call from a front-end with no turn running.** A list needs
   no kind code. `info`, and `respondToInterrupts` on a kind that runs
   elsewhere, do. The proposal is a small run under the front-end's own
   policy, the one it passes to every session.
2. **Starting again after a reboot.** This needs something that is
   always running, so it is left to the schedules slice.
3. **A limit for the whole machine.** There is none. Ten sessions can
   run 80 jobs.

## Not checked yet

- Whether `learn`'s machinery can call a kind's export with the
  description checked against the kind's own type, or whether the
  description reaches the kind as untyped data.
- Whether the copy of a kind's source can be saved from what `learn`
  prepares, including the local files the kind imports.
- How much of `startDetached` is tied to `agency run` and how much is
  general.
- Whether reading output "since the last read" works with several
  readers of one file (the session, `/jobs`, Perry) without each needing
  its own saved position.
- Whether the lower layer's start is safe to offer as `std::detached` to
  any Agency code, or should be reachable only from `std::jobs`.
