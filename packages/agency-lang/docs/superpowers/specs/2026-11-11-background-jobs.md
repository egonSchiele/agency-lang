# Background jobs: start a shell command and keep working

The wider set of ideas this belongs to is in `docs/superpowers/ideas/2026-11-11-background-shells-and-subagents.md`. This spec covers shell commands only. Subagents are not part of it.

Paths are relative to `packages/agency-lang`.

## The problem

A user asks `agency agent` to run the Agency versus Pi comparison. The script starts containers and takes about forty minutes.

The agent has two ways to run it today, and neither works.

```
safeBash(command: "./run-comparison.sh")
```

This call is stopped after 120 seconds, the default limit from #1448.

```
safeBash(command: "./run-comparison.sh", timeout: 3600)
```

This call runs to the end. The agent is inside one tool call for forty minutes. It cannot answer the user, look at the output so far, or notice that the first container failed in minute two.

What the user wants is what a person does: start the script in another shell, keep working, and look at it now and then.

## How shell commands run today

This section describes the code the change builds on.

**`safeBash` plans a command before it runs it.** `safeBash` in `stdlib/safeBash.agency` parses the command and calls `planFor`. The plan has two parts. The first is a list of effects, which are the questions to raise, such as `std::bash` or `std::write`. The second is an execution, which says how the approved command runs. Simple commands such as `cat` or `grep` run as stdlib tools inside the process. Everything else has the execution kind `bash` and runs under a real bash.

**Every question is raised before anything runs.** `raiseAll` raises each effect in the plan. If a handler or the user rejects one, `safeBash` returns that rejection and runs nothing. `runBash` then calls `_bash`, the function that runs a command without raising. A comment in `runBash` says this is correct only because the single path into it goes through `raiseAll`, and it says not to add a caller that skips `raiseAll`.

**The host runs the command.** `_bash` reaches `HostSubprocess.run` in `lib/host/host.ts`. `run` starts the child, collects its output, and resolves when the child ends. The host has a second function, `start`, which returns as soon as the child is running:

```ts
export type RunningProcess = {
  kill(signal?: "SIGTERM" | "SIGKILL"): void;
  wait(): Promise<RunResult>;
};
```

`start` has one caller today, `record` in `lib/stdlib/speech.ts`. A `RunningProcess` cannot report the output so far. The output is available only from `wait`, after the child ends.

**A stop reaches everything the command started.** Each child is the leader of its own process group (`lib/host/node/processGroups.ts`). A stop sends `SIGTERM` to the group, and `SIGKILL` two seconds later. The host keeps a list of children that have not closed, and the process's exit kills every group on the list.

**Long output is saved for later.** `keepOutput` from `std::spill` returns short output as it is. For long output it saves the whole text in the run's globals and returns a preview with a name. The model reads the rest with `readSpill` or `grepSpill`. `docs/dev/stdlib/spill.md` has the details.

**The timeout spec left this feature for later.** `docs/superpowers/specs/2026-11-11-safebash-timeout-design.md` says of background jobs: "It needs two more tools, and the model has to remember to come back for the result. The coder's tool list was cut in #1445 to save context, so this is left for later." This spec has to answer both points.

## What other agents do

**Crush.** The bash tool takes `run_in_background`. Two more tools manage a job: `job_output`, which takes `wait=true`, and `job_kill`. A command that runs longer than a minute moves to the background on its own. The tool description tells the model not to call `job_output` right after starting a job.

**Pi.** Pi has no background jobs.

## The change in one example

```
startJob(command: "./run-comparison.sh")
```

returns at once:

```
Started job-1. It keeps running while you work. Do not call jobOutput
right away: a job that just started has printed nothing. Call
jobOutput("job-1") when you need its result, or pass wait to block
until it ends.
```

Later:

```
jobOutput(id: "job-1", wait: 300)
```

returns after five minutes, or sooner if the script ends:

```
{
  "id": "job-1",
  "state": "running",
  "runningFor": "6m 12s",
  "stdout": "container 1 ready\ncontainer 2 ready\n...",
  "stderr": ""
}
```

Each call returns only the output the model has not been given yet. When the script ends, the same call reports `"state": "ended"` and the exit code.

```
stopJob(id: "job-1")
```

stops the script and everything it started.

## Decisions

### 1. Starting a job is its own function, `startJob`

```
export def startJob(
  command: string,
  cwd: string = "",
  maxMinutes: number = 60,
): Result<string> raises <std::bash, std::exec, ...>
```

The `raises` list is the same as `safeBash`'s.

The alternative is a `background` parameter on `safeBash`, which is what Crush does. It was set aside for two reasons.

- **The time limit means different things.** `safeBash` stops a command after `timeout` seconds, 120 by default. A job is meant to run for a long time, so a default of 120 seconds is wrong for it. A model that passed `background: true` and forgot `timeout` would have its job stopped two minutes in. A parameter cannot tell a default of 120 from a 120 the caller wrote.
- **The return value means different things.** `safeBash` returns the command's output. A job start returns a job id. One docstring would have to explain both.

`startJob` costs one more tool than the parameter would. Decision 6 says which agents carry it.

### 2. `startJob` raises the same questions as `safeBash`

`startJob` lives in `stdlib/safeBash.agency`. It calls `planFor` and `raiseAll`, exactly as `safeBash` does, and only then starts the job. It is the second caller of the internals that run a command without raising, so it has to keep the rule in `runBash`'s comment: nothing starts unless `raiseAll` raised every effect in the plan and returned success.

A handler or policy that rejects `std::bash` for a command rejects it as a job too. The rejection comes back unchanged, with its `rejected` flag, as it does from `safeBash`.

The payload of the question is the one `safeBash` raises. Its `timeout` field holds the job's limit in milliseconds. The question's text says "in the background", so a person at the approval prompt can tell the two apart:

```
Are you sure you want to run this shell command in the background?
```

An "always approve" answer for a command applies to that command in the foreground and in the background. The rule pins `command` and `cwd` (`@always(command, cwd)` on `std::bash`), and those are the same in both. This seems right: the command does the same thing either way. It is called out here because it is a consequence for approvals that a reviewer should see.

### 3. Only a plan that runs under bash becomes a job

A plan whose execution kind is `bash` starts a job. Any other plan runs in the foreground, the way `safeBash` runs it, and `startJob` returns its result with one line in front:

```
This command ran in the foreground, because it finishes at once.
```

The other kinds are file reads, writes, `echo`, `grep`, chains of those, and the `agency` command line. All but the last finish in well under a second. Running them in the foreground keeps one code path for them.

`agency test` can take minutes, and under this rule it would not become a job. That is accepted for now. The coder runs it through `safeBash` with a larger `timeout` today.

### 4. Reading and waiting are one function, `jobOutput`

```
export def jobOutput(id: string, wait: number = 0): Result<JobReport>
```

`wait` is a number of seconds. With `0`, the call returns at once. With more, the call returns when the job ends or when the time is up, whichever comes first. `wait` is capped at 600 seconds, so a model that waits still looks at the output every ten minutes.

A separate wait function would be one more tool. Crush joins the two the same way.

The report:

```
type JobReport = {
  id: string;
  command: string;
  state: "running" | "ended" | "stopped" | "timedOut";
  status: string;
  exitCode: number | null;
  runningFor: string;
  stdout: string;
  stderr: string;
  note: string
}
```

- `note` is empty unless there is something the numbers do not say, such as "Stopped: stdout passed the 10 MiB cap."

- `stdout` and `stderr` hold what the job has printed since the last `jobOutput` call for this job. Each goes through `keepOutput`, so a long piece is saved and previewed like any other command output.
- Progress bars are reduced to their last state. A download prints its progress bar by sending a carriage return and writing over the same line, thousands of times. On pipes that arrives as one very long line. `jobOutput` keeps only the text after the last carriage return on each line, which is what a terminal would be showing.
- `status` is the state in words: `running`, `exit 0`, `stopped`, or `timed out`. One function writes it, and the jobs message, the finish line, `/jobs`, and the tool trace all show the same text.
- `exitCode` is `null` while the job runs, and when a signal ended it.
- `timedOut` means the job reached `maxMinutes`.
- A process that fails after it started, for example a command the system could not run, ends its job as `ended` with no exit code and the error in `note`. It never stays `running`.

Waiting does not hold the job. Escape during a wait cancels the wait, and the job keeps running. This matches Crush, where a subagent keeps running when the user interrupts the parent's turn.

A guard trip, such as the coder's time budget, also ends the wait and not the job. In that case `jobOutput` returns the report as it stands and does not throw. The trip is then raised as a `std::guard` interrupt at the next statement, the way a trip between statements is, so every handler is asked and the coder keeps its saved draft. A wait that threw on the trip would skip the handlers.

### 5. `stopJob` and `listJobs`

```
export def stopJob(id: string): Result<JobReport>
export def listJobs(): JobSummary[]
```

`stopJob` stops the job with the host's stop, waits for it to end, and returns the final report with the last output.

`listJobs` returns the id, command, state, and running time of each job. It is for programs and for the agent's `/jobs` command. The agent does not offer it to the model as a tool; decision 7 covers how the model learns what is running.

### 6. Which agents carry the tools

A new toolkit, `jobTools()` in `stdlib/agents/lib/toolkits.agency`, returns the three tools: `startJob`, `jobOutput`, and `stopJob`. `shellTools()` does not change, so no stdlib agent gains a tool by default.

In `agency agent`, two agents carry `jobTools()`, and only in an interactive session:

- **The main agent.** It holds the conversation with the user, so it is the one asked "how is the download going?". `startJob` raises its own questions, so the main agent can carry it without carrying `safeBash`.
- **The coder.** The router sends a message such as "start the build in the background" to the coder, because the coder is the agent that runs commands. A coder with no `startJob` would run the command in the foreground and hit the time limit.

**A one-shot run carries no job tools.** `agency agent -p` exits when its one turn ends, and the exit stops every job. A job started there would be killed before it could finish. Crush makes the same choice: in a headless run its commands always block.

This adds three tools to the interactive coder, whose list #1445 trimmed. That is the cost of this decision.

### 7. The harness tells the model what is running

The timeout spec's second worry was that "the model has to remember to come back for the result". Earlier sessions showed that a model does not reliably use a tool it is merely offered. So the harness, not the model's memory, carries the list of jobs.

At the start of each turn, the main agent adds one system message that expires when the turn's `llm()` call returns:

```
Background jobs:
- job-1  running  14m 02s  ./run-comparison.sh
- job-2  exit 1, output not read yet  2m 40s  pnpm test:run
```

It uses `systemMessage(msg, expires: "llmCall")`, the mechanism the agent's global instructions use (`addGlobalInstructions` in `lib/agents/agency-agent/lib/globalInstructions.agency`). The message is rebuilt for each turn and is removed before the session is saved. With no jobs, nothing is added.

A job stays on the list until it has ended and its last output has been read with `jobOutput`. So a model that forgot about a job is told about it on its next turn, and a job that ended is announced until the model looks.

A turn the router sends to the coder runs on the main thread, so the coder reads the same message.

The list is written once per turn. A job that ends while a long turn is running is not announced to the model until the next turn. The user sees it end at once (decision 12). The model can still call `jobOutput` at any point in the turn.

This does not start a turn. If the model ends its turn while a job runs, nothing happens until the user types. The idea doc covers the harness wake that would fix this. It is left out because it changes the REPL loop, and the three tools do not depend on it.

`startJob`'s result also tells the model not to call `jobOutput` right away, as Crush's does.

### 8. Jobs live on the run's context, not in a checkpoint

A running process cannot be saved. A checkpoint holds data, and a process is not data.

So the table of jobs is a field on `RuntimeContext`, beside the lock tables. `docs/dev/runtime/lock.md` describes the same choice for locks: "These fields are runtime-only. They are not serialized in checkpoints." Each execution context gets a new, empty table, as it gets new lock tables in `createExecutionContext` (`lib/runtime/state/context.ts`).

This follows the rule against mutable state in a TypeScript module variable. The table belongs to one run, and two runs in one process each have their own.

What follows from that choice:

- **Every branch of a run sees the same jobs.** A job the coder starts inside a tool call is visible to the main agent, because both run on one context.
- **A job is stopped when its run ends.** `RuntimeContext.cleanup()` stops every job in the table. `cleanup` runs when a node run returns (`lib/runtime/node.ts`), when a served invocation finishes, and after a rewind. The host's exit hook is the backstop for a process that dies.
- **A job does not survive a pause.** A run that returns an interrupt to its caller has ended for now, and `cleanup` stops its jobs. After the resume the table is empty. `jobOutput` for an id that is not in the table returns a failure the model can act on, and never an error:

  ```
  job-1 is not running in this run. It was stopped when the run paused or
  restarted. Start it again if you still need it.
  ```

  The interactive `agency agent` answers its interrupts inside a handler, so it does not pause this way during a session. A program called from TypeScript, or a served agent, does.
- **A `restore()` inside a program leaves jobs running.** `restore(checkpoint)` is applied to the same context (`applyRestoreSignal`, called from `lib/runtime/node.ts`), so the table is untouched. The conversation goes back, and the model may no longer know about a job it started after that checkpoint. The list in decision 7 tells it on its next turn.
- **A debugger rewind starts with no jobs.** `rewindFrom` in `lib/runtime/rewind.ts` replays on a new context, and the earlier run's context was cleaned up when that run returned.
- **A child process has its own jobs.** A program started with `run()` from `std::agency` has its own context and its own table. Its jobs stop when the child ends or pauses.
- **Resuming a saved agent session starts with no jobs.** The process that ran them has exited.

### 9. Output is kept in memory, with a cap

The host already collects a child's output into two strings, one per stream. The table reads them through one new function on the handle:

```ts
export type RunningProcess = {
  kill(signal?: "SIGTERM" | "SIGKILL"): void;
  wait(): Promise<RunResult>;
  /** The output collected so far. */
  output(): { stdout: string; stderr: string };
};
```

The table remembers, per job and per stream, how many characters `jobOutput` has already returned.

A job is started with `maxOutputBytes` of 10 MiB per stream. The host stops a child that prints more than its cap, which is the behaviour `run` has today. The final report then says which stream reached the cap. A command that prints more than that should redirect its output to a file, and the docstring says so.

The cap exists because memory has to be bounded. Keeping only the newest output would be kinder to a chatty server, and it is a change to the host's collector that can come later.

Output is not written to a log file. The idea doc lists that under the UI ideas, for `tail -f` from another tab.

### 10. No effect for reading or stopping

`jobOutput`, `stopJob`, and `listJobs` raise nothing.

The reasoning is the one `std::spill` uses for its readers. A job exists only because its command was approved. Its output is what `safeBash` would have returned for the same approval. Stopping it can only undo what the approval allowed. The ids come from the run's own table, so a call can never reach a process the run did not start.

A policy that wants to keep a model from using jobs rejects `std::bash` and `std::exec`, which keeps any job from starting.

### 11. Limits

- **Eight jobs at once.** A ninth `startJob` returns a failure that lists the running jobs. The number is a guess, and Crush has a setting for the same thing.
- **`maxMinutes` defaults to 60 and is capped at 720.** A job that reaches its limit is stopped, and its state is `timedOut`.
- **Twenty finished jobs are kept.** Past that, the oldest finished job whose output has been read is dropped.

### 12. The REPL prints a line when a job ends

```
job-1 finished after 41m 08s (exit 0): ./run-comparison.sh
```

The user should not have to ask whether a job has finished.

A line printed while the user is typing at the prompt lands in the middle of their text. So the REPL prints the line itself. `_runLineRepl` in `lib/stdlib/cli.ts` owns the readline interface. When a job ends, it does one of two things:

- **A turn is running.** It writes the line to standard output. The spinner's footer already redraws below any such write.
- **The prompt is idle.** It clears the prompt line, writes the line, and asks readline to draw the prompt again with whatever the user had typed.

This lives in the stdlib REPL, not in `agency agent`, so any program built on `repl()` that starts jobs gets the line.

A program with no REPL prints nothing. It reads job state with `jobOutput` or `listJobs`.

## The `/jobs` command

`/jobs` prints the table for the user:

```
job-1  running   14m 02s  ./run-comparison.sh
job-2  exit 1     2m 40s  pnpm test:run
```

`/jobs stop job-1` stops a job. The user typed it, so no approval is asked, the same as for `!command` (`lib/agents/agency-agent/lib/slashCommands/shell.agency`). The finish line from decision 12 reports the stop, so the command prints nothing more. The model is told with a note on the user's next message, the way it is told about a `!command`, so it does not go on believing the job is running.

There is no footer. The idea doc explains why that needs a prototype first.

## Where the code goes

| File | What |
| --- | --- |
| `lib/host/host.ts` | `output()` on `RunningProcess`. |
| `lib/host/node/nodeSubprocess.ts`, `lib/host/memoryHost.ts` | `start` returns a handle with `output()`. |
| `lib/runtime/jobs/jobTable.ts` | The table: add, read new output, wait, stop, stop all, list, and the limits. It takes a host and a clock, so tests can drive it. |
| `lib/runtime/state/context.ts` | The `jobs` field, a new table per execution context, and the call in `cleanup()` that stops every job. |
| `lib/stdlib/jobs.ts` | The functions the Agency side calls, each taking the run. |
| `stdlib/jobs.agency` | `std::jobs`: `jobOutput`, `stopJob`, `listJobs`, and the two types. |
| `stdlib/safeBash.agency` | `startJob`. |
| `stdlib/agents/lib/toolkits.agency` | `jobTools()`. |
| `lib/stdlib/agentToolTrace.ts` | One trace line per tool (`docs/dev/agents/tool-output.md`). |
| `lib/stdlib/cli.ts` | The line the REPL prints when a job ends. |
| `lib/agents/agency-agent/lib/slashCommands/jobs.agency` | `/jobs`. |
| `lib/agents/agency-agent/lib/jobsNote.agency` | The jobs message at the start of each turn. |
| `lib/agents/agency-agent/brains/coordinator/` | `jobTools()` on the main agent and the coder, in an interactive session. |
| `docs/dev/stdlib/jobs.md` | The dev doc, with one line for it in `CLAUDE.md`. |

`startJob` is in `safeBash.agency` and not in `jobs.agency` because it has to call `raiseAll`, which is not exported, and must stay beside the comment that governs it.

The dev doc states how jobs interact with interrupts, checkpoints, branches, and child processes. Decisions 2, 8, and 10 are that text.

## What this does not cover

- **Waking the agent.** Nothing starts a turn when a job ends.
- **A command that asks on the terminal.** A job has no terminal, as no shell command has since #1448. `sudo` fails at once.
- **Sending input to a job.** Standard input is closed when the job starts.
- **A process that leaves its group.** A daemon the job starts can outlive a stop, as it can with `safeBash`.
- **Moving a running `safeBash` call to the background.** Crush does this after a minute. #1448 chose to stop a long command instead, and this spec does not reopen that.
- **Windows.** The stop uses `taskkill` there and is untested, as it is for `safeBash`.
- **Subagents as jobs.** See the idea doc.

## Open questions

1. **Three tools or two.** Decision 1 argues for `startJob` as its own tool. If the tool count matters more than the two reasons given, the fallback is `safeBash(background: true)`, with the rule that a background command's default limit is 60 minutes.
2. **Three more tools on the interactive coder.** Decision 6. The alternative is to give the tools to the main agent only and keep the router from sending a background request to the coder. That means changing the router's question, which was measured and should not be reworded without measuring again.
3. **The output cap.** Decision 9 stops a job that prints more than 10 MiB on one stream. Is stopping acceptable for a first version, or should the collector keep the newest output from the start?
4. **"Always approve" covers both modes.** Decision 2. Should a rule for a foreground command also approve it as a job?

## How to test

One build and one test run cover the change.

- **The table,** in `lib/runtime/jobs/jobTable.test.ts`, with the Node host and a real bash:
  - A job that prints a line, waits for the test to create a marker file, and prints a second line: the first read returns the first line, and a read after the job ends returns only the second. The test, not the clock, decides when the job moves on.
  - `wait` returns early when the job ends, and returns at its limit when the job does not.
  - An aborted signal ends a wait and leaves the job running.
  - A stop ends a `sleep 30 & wait` job within four seconds, and the `sleep` process is gone afterwards.
  - Stopping every job ends them all. This is what `cleanup` calls.
  - A job whose process fails after it started ends with the error in its `note`.
  - A ninth job is refused. A job past its time limit reports `timedOut`.
  - A job that prints past the cap is stopped and names the stream.
- **`cleanup` stops jobs,** in the context's test file: a context with a running job, after `cleanup()`, has no live process.
- **`startJob`,** in `tests/agency/jobs.agency`, run with `--check-capabilities`:
  - A handler that rejects `std::bash` leaves `listJobs()` empty and returns the rejection with its `rejected` flag. This is the test that the approval cannot be skipped, and it fails if `startJob` starts the job before `raiseAll`.
  - An approved job is listed, `jobOutput` with `wait` returns its output and exit code, and a second `jobOutput` returns no output.
  - `startJob(command: "echo hi")` runs in the foreground and returns the output with the foreground line.
  - `jobOutput` for an unknown id returns the failure in decision 8.
  - A time guard that trips during a `jobOutput` wait asks the `std::guard` handler. Rejecting fails the guarded block and leaves the job running. Approving more time lets the block finish.
  - A job that prints `10%`, a carriage return, `50%`, a carriage return, and `100%` reads back as `100%`.
- **The trace lines,** in `lib/stdlib/agentToolTrace.test.ts`.
- **The tool lists,** in the coordinator's `toolWiring` test: an interactive session offers the three tools to the main agent and the coder, and a one-shot session offers them to neither.
- **By hand.** In `agency agent`, ask for a two-minute script to be started in the background, ask how it is going, and run `/jobs`. Type half a line at the prompt and wait for the job to end: the finish line should appear above the prompt with the typed text intact. Quit while a job runs and check that the script's processes are gone.
