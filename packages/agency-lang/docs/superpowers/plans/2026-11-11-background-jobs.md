# Background jobs: implementation plan

**Goal:** `agency agent` can start a shell command, keep working while it runs, read its output, and stop it.

**Spec:** `docs/superpowers/specs/2026-11-11-background-jobs.md`. Read it first. This plan says how to build what the spec decides, and does not repeat the reasons.

**How to work through it:** one session, top to bottom. The tasks are ordered so each one builds on the one before. Make all the changes, then run one build and one test run, as "How to test" says at the end. One PR.

Paths are relative to `packages/agency-lang`. Work in the worktree `worktree-background-jobs`, on the branch `adit/background-jobs`.

## Background: the code this builds on

Read this section before the tasks. Each paragraph names the file to open.

**The host starts processes.** `lib/host/host.ts` defines `HostSubprocess`, with `run` and `start`. `start` returns a `RunningProcess`, which has `kill` and `wait`. The Node implementation is `startChild` in `lib/host/node/nodeSubprocess.ts`. It collects standard output and standard error into two `collector` objects, each with a `text()` function. Today `text()` is called only when the child closes.

**The host's stop is stronger than `kill`.** Inside `startChild`, `stop` sends `SIGTERM` to the process group, sends `SIGKILL` two seconds later, and releases the output pipes if a stray process holds them. `stop` runs for three reasons: the time limit in `RunOptions.timeoutMs`, the abort signal in `RunOptions.signal`, and the output cap in `RunOptions.maxOutputBytes`. The `kill` on the handle only sends one signal. So a job is stopped by aborting a signal the job owns, and never by calling `kill`.

**A stdlib helper reads the run it was called under.** `docs/dev/stdlib/adding-a-module-to-the-agency-stdlib.md` shows the pattern: a TypeScript function in `lib/stdlib/` calls `currentRun()` on its first line and uses `run.ctx` and `run.stack`. `lib/stdlib/spill.ts` and `stdlib/spill.agency` are a small, complete example of a module built this way.

**The run's context holds state that is not saved.** `RuntimeContext` in `lib/runtime/state/context.ts` has the lock tables as fields (`locks`, `lockOwners`, `lockWaiters`, `lockReleasers`). The constructor sets them, and `createExecutionContext` sets them again on each new execution context. `cleanup()` runs when a run ends.

**`safeBash` approves, then runs.** In `stdlib/safeBash.agency`, `safeBash` calls `planFor`, returns early on a refusal, calls `raiseAll`, and then matches on the plan's execution kind to run it. `raiseOne` holds one raise site per effect. `runBash` calls `_bash`, and its comment explains why that is safe only behind `raiseAll`.

**The REPL owns the terminal.** `_runLineRepl` in `lib/stdlib/cli.ts` holds the readline interface. It waits for a line, starts the spinner, reports `working` to Herdr, calls `onSubmit`, reports `idle`, and loops.

**The main agent adds an expiring message each turn.** `mainAgent` in `lib/agents/agency-agent/brains/coordinator/coordinator.agency` calls `addGlobalInstructions()`, which is in `lib/agents/agency-agent/lib/globalInstructions.agency`. It calls `systemMessage(text, label: ..., expires: "llmCall")`.

**The coder knows when it is a one-shot run.** `lib/agents/agency-agent/brains/coordinator/subagents/code.agency` has `_oneShot` and `setCodeOneShot`. `coordinatorInit` sets it from `context.interactive`.

## Rules that apply to every task

- Use types, not interfaces. Use objects, not maps. Use arrays, not sets. No dynamic imports.
- No mutable state in a TypeScript module variable. The job table is a value on the run's context.
- Do not run `agency fmt` on `stdlib/safeBash.agency`, `stdlib/agents/lib/toolkits.agency`, or any other `.agency` file that already exists. Format only the `.agency` files this plan adds.
- Format the TypeScript files you touch with prettier, by name.
- Check every doc and comment you write against `docs/dev/contributing/anti-patterns.md` and the writing tips before the PR.
- Never edit `CHANGELOG.md`.

## What a reviewer should look at hardest

These are the cases most likely to go wrong for a person using the feature. Each has a test in the task named.

1. **A rejected approval starts nothing.** If `startJob` could start the process before every question is answered, the approval would be decoration. Task 5 has the test, and it must fail when the start is moved above `raiseAll`.
2. **Escape during a wait leaves the job running.** The wait listens on the run's abort signal. The job must not. Task 2.
3. **The coder's budget trips while its job runs.** The guard aborts the run's signal. The job belongs to the session and keeps running. The trip must also reach the `std::guard` handlers, as a trip between statements does, so a handler is never skipped and the coder keeps its draft. Task 5 has the two tests, `guardTripDuringWaitAsksTheHandler` and `guardTripDuringWaitCanBeApproved`.
4. **An id the table does not know.** After a pause, a restart, or a typo, `jobOutput` and `stopJob` return a failure and never throw. Task 4.
5. **A run that ends with jobs still running.** `cleanup()` stops them all, and no process is left behind. Task 3.
6. **A working directory that does not exist.** `startJob` returns the same failure `safeBash` gives, and no job appears in the list. Task 5.

---

## Task 1: the host reports output so far

**Files:**
- Modify: `lib/host/host.ts`
- Modify: `lib/host/node/nodeSubprocess.ts`
- Modify: `lib/host/memoryHost.ts`
- Test: `lib/host/node/nodeSubprocess.test.ts`

**Change.** `RunningProcess` gains one function:

```ts
export type RunningProcess = {
  kill(signal?: "SIGTERM" | "SIGKILL"): void;
  wait(): Promise<RunResult>;
  /** The output collected so far. */
  output(): { stdout: string; stderr: string };
};
```

- [ ] In `startChild`, return the two collectors' `text` functions beside `child`, `ended`, and `kill`. In `nodeSubprocess.start`, build `output` from them.
- [ ] `memoryHost` passes `start` through to the fake subprocess a test gives it. Check that the type still lines up, and update any fake in the tests that builds a `RunningProcess` by hand. `grep -rn "wait: " lib --include=*.test.ts` finds them.
- [ ] The browser host refuses subprocesses, so it needs no change.
- [ ] Test, in `nodeSubprocess.test.ts`, with a script the test controls. The clock must not decide when the script moves on, or the test fails on a loaded CI runner:

  ```
  printf 'A\n'; while [ ! -f go ]; do sleep 0.05; done; printf 'B\n'
  ```

  Run it in a temporary folder. Poll `output().stdout` until it contains `A`, with a deadline of a few seconds. Check it does not contain `B`. Create the file `go`. After `wait()`, the output is `"A\nB\n"`.

**Later tasks use:** `host.subprocess.start(command, options)` and `output()`.

---

## Task 2: the job table

**Files:**
- Create: `lib/runtime/jobs/jobTable.ts`
- Create: `lib/runtime/jobs/progressText.ts`
- Test: `lib/runtime/jobs/jobTable.test.ts`
- Test: `lib/runtime/jobs/progressText.test.ts`

The table is plain data plus functions that take it. It knows nothing about Agency, approvals, or the terminal. It takes the host as an argument, so a test can run it against the Node host with a real bash.

### `progressText.ts`

```ts
/** What a terminal would show: on each line, the text after the last
 *  carriage return. A `\r\n` line ending is a line ending, not an overwrite. */
export function collapseCarriageReturns(text: string): string;
```

- [ ] Tests: `"10%\r50%\r100%\n"` becomes `"100%\n"`. `"a\r\nb\r\n"` becomes `"a\nb\n"`. Text with no carriage return is unchanged. `"10%\r"` with nothing after the carriage return becomes `"10%"`, so a bar that has just been cleared still shows its last state.

### `jobTable.ts`

The limits are the spec's numbers, as named constants in this file:

```ts
export const MAX_RUNNING_JOBS = 8;
export const MAX_FINISHED_JOBS = 20;
export const JOB_OUTPUT_CAP_BYTES = 10 * 1024 * 1024;
```

The types:

```ts
export type JobState = "running" | "ended" | "stopped" | "timedOut";

export type JobSummary = {
  id: string;            // "job-1", "job-2", ...
  command: string;       // the command as the caller wrote it
  state: JobState;
  exitCode: number | null;
  startedAt: number;     // milliseconds, from the host's clock
  endedAt: number | null;
  /** The job has ended and no read has returned its final state yet. */
  unread: boolean;
};

export type JobReport = JobSummary & {
  stdout: string;        // new since the last read, carriage returns collapsed
  stderr: string;
  note: string;
};

export type JobStart = {
  command: string;       // the text that runs
  label: string;         // the text the summary shows as `command`
  cwd: string;
  maxMs: number;
};

export type JobTable = { /* the jobs, the next id, the end listeners */ };
```

The functions:

```ts
export function newJobTable(): JobTable;

/** Starts the command. When MAX_RUNNING_JOBS are already running, rejects
 *  with an Error whose message says so and lists them. */
export function addJob(table: JobTable, host: Host, start: JobStart): Promise<JobSummary>;

/** The job's state in words: "running", "exit 0", "stopped", "timed out".
 *  The one place a state becomes text. */
export function describeJobState(job: JobSummary): string;

/** The job's state and its output since the last read, or null for an
 *  unknown id. Moves the read position. */
export function readJob(table: JobTable, id: string): JobReport | null;

/** Resolves when the job has ended, when `waitMs` has passed, or when
 *  `signal` aborts, whichever is first. Never rejects, and never stops
 *  the job. Resolves at once for an unknown id or a finished job. */
export function waitForJob(
  table: JobTable,
  id: string,
  waitMs: number,
  signal: AbortSignal,
): Promise<void>;

/** Stops the job and resolves when it has ended. False for an unknown id.
 *  Does not read the job: the caller reads it if it wants the report. */
export function endJob(table: JobTable, id: string): Promise<boolean>;

/** Stops every running job. Does not wait. */
export function endAllJobs(table: JobTable): void;

export function listJobs(table: JobTable): JobSummary[];

/** Calls `listener` once for each job that ends from now on. Returns a
 *  function that removes the listener. */
export function onJobEnd(table: JobTable, listener: (job: JobSummary) => void): () => void;
```

Decisions the signatures do not settle:

- **The table's functions have their own names.** `addJob` and `endJob` are not called `startJob` and `stopJob`, because the stdlib helpers and the Agency functions already use those names, and a stack trace should say which layer it is in.
- **Each job owns an `AbortController`.** `addJob` passes its signal as `RunOptions.signal`, `maxMs` as `timeoutMs`, and `JOB_OUTPUT_CAP_BYTES` as `maxOutputBytes`. `endJob` and `endAllJobs` abort it. Nothing else is ever passed as the job's signal. In particular the run's own abort signal is not, which is what keeps Escape and a guard trip from stopping a job.
- **The command is `{ kind: "shell", script: command }`**, the same shape `abortableShell` in `lib/stdlib/abortable.ts` sends.
- **The final state comes from the `RunResult`.** `timedOut` gives `"timedOut"`. `aborted` gives `"stopped"`. Anything else gives `"ended"`. When `truncated` is set, the state is `"ended"` and `note` is `"Stopped: <stream> passed the 10 MiB cap."`.
- **A start that throws rejects and adds nothing to the table.** For example, no bash on the search path.
- **A process that fails after it started still ends its job.** In the Node host most spawn failures arrive later, as the child's `error` event, which rejects the promise `wait()` returns. By then `start` has handed back a handle and the job is in the table. So the table handles a rejected `wait()` the way it handles a resolved one: the job becomes `"ended"` with `exitCode: null`, the error's message goes in `note`, it is marked `unread`, and the end listeners are called. Without this the job would stay `"running"` for the rest of the session and count against the limit.
- **`unread` is cleared by `readJob`, and by nothing else.** It is cleared when a read returns the job's final state. `endJob` does not read, so it does not clear it.
- **`label` and `command` differ** for the same reason `runBash` takes a `source`: the plan can rewrite the text.
- **The message for too many jobs is built here**, from `MAX_RUNNING_JOBS` and the running jobs' ids and commands. Callers pass it on and never rebuild it.
- **`describeJobState` is the only code that turns a state into words.** The finish line, `/jobs`, the jobs message, and the trace line all show its result. A new state is then one edit.
- **The read position is a character count per stream**, into the string `output()` returns. It never lands inside a character, because `startChild` calls `setEncoding("utf8")` on both streams, which joins a character split across two chunks before the collector sees it. Collapse carriage returns in the slice being returned, not in the stored text.
- **Dropping finished jobs.** When a job ends and more than `MAX_FINISHED_JOBS` finished jobs are in the table, drop the oldest one that is not `unread`. If every finished job is unread, drop the oldest.
- **Time comes from the host's clock**, the one `RuntimeContext.clock` returns, so a test can control it.

Tests, with the Node host and a real bash:

- [ ] A job running the marker-file script from Task 1: poll `readJob` until the output read so far contains `A`, and check `B` has not appeared. Create `go`. A read after the job ends returns the rest, ending in `"B\n"`, with state `"ended"` and exit code 0. One more read returns empty output, and `unread` is false after it.
- [ ] `waitForJob` with a 10-second wait on `sleep 0.3` resolves in under 2 seconds.
- [ ] `waitForJob` with a 300 ms wait on `sleep 30` resolves in under 2 seconds, and the job is still `"running"`.
- [ ] A job whose `wait()` rejects, built on `memoryHost` with a fake subprocess: the job's state is `"ended"`, its `note` holds the error's message, it is `unread`, the end listener was called once, and it no longer counts toward `MAX_RUNNING_JOBS`.
- [ ] After `endJob`, the job is still `unread`. After a `readJob` that follows, it is not.
- [ ] `waitForJob` on `sleep 30` with a signal aborted after 200 ms resolves in under 2 seconds, and the job is still `"running"`. This is review item 2.
- [ ] `endJob` on `sleep 30 & echo $!; wait` resolves within 4 seconds, the job's state is `"stopped"`, and the printed pid is no longer alive.
- [ ] `endAllJobs` with two running jobs: both pids are gone within 4 seconds.
- [ ] With `MAX_RUNNING_JOBS` jobs running, one more `addJob` rejects, the message names a running job's id, and the table still has `MAX_RUNNING_JOBS` jobs.
- [ ] `describeJobState` gives `"running"`, `"exit 0"`, `"exit 3"`, `"stopped"`, and `"timed out"` for the five cases.
- [ ] A job with `maxMs: 300` running `sleep 30` ends with state `"timedOut"`.
- [ ] A job that prints past a small cap ends with a `note` that names the stream. Pass the cap as an optional argument for the test.
- [ ] `readJob`, `endJob`, and `waitForJob` with the id `"job-99"` return null, false, and a resolved promise.
- [ ] `onJobEnd` is called once when a job ends, with `unread: true`.
- [ ] A job that prints `10%`, a carriage return, `50%`, a carriage return, and `100%` reads back as `100%`.

Clean up in `afterEach` with `endAllJobs`, so a failing test leaves no `sleep` behind.

**Later tasks use:** every function above.

---

## Task 3: the table lives on the run's context

**Files:**
- Modify: `lib/runtime/state/context.ts`
- Test: the existing test file for `context.ts`

- [ ] Add a field `jobs: JobTable` beside the lock fields.
- [ ] Set it to `newJobTable()` in the constructor, next to `this.locks = {}`.
- [ ] Set it to `newJobTable()` in `createExecutionContext`, next to `execCtx.locks = {}`. Each run gets its own table.
- [ ] In `cleanup()`, call `endAllJobs(this.jobs)` before the fields are cleared. `cleanup()` aborts the context's own controller, which does not reach a job's controller, so this call is what stops the jobs.
- [ ] Test: build a context with the Node host, start `sleep 30 & echo $!; wait` in `ctx.jobs`, call `ctx.cleanup()`, and check the pid is gone within 4 seconds. This is review item 5.

Every caller of `cleanup()` cleans up a context whose run is over:

- `finalizeExecCtx` in `lib/runtime/node.ts`, when a node run returns.
- `lib/runtime/interrupts.ts`, in two places: when a resumed run returns, and when a resumed served invocation returns.
- `rewindFrom` in `lib/runtime/rewind.ts`, in the `finally` of the replay it ran on a context it created.
- `lib/debugger/overlays.ts`, on the contexts the debugger creates for its overlays.

Run `grep -rn "\.cleanup()" lib --include=*.ts` and list every caller in the dev doc, since that doc states what stops a job.

A `restore(checkpoint)` inside a program is different. `applyRestoreSignal` applies it to the same context (`lib/runtime/node.ts:542`), and `cleanup()` is not called. So an in-program restore leaves jobs running, and a debugger rewind or a resume starts with an empty table. The dev doc in Task 9 states both.

---

## Task 4: the stdlib module `std::jobs`

**Files:**
- Create: `lib/stdlib/jobs.ts`
- Create: `stdlib/jobs.agency`
- Modify: `lib/stdlib/shell.ts` (export `resolveSpawnCwd`)
- Modify: `docs/site/.vitepress/config.mts` (the stdlib sidebar)
- Test: `tests/agency/jobs.agency`, `tests/agency/jobs.test.json`

### `lib/stdlib/jobs.ts`

Each function calls `currentRun()` on its first line.

```ts
/** Starts an approved command as a job and returns its id. */
export async function _startJob(
  command: string,
  label: string,
  cwd: string,
  maxMs: number,
): Promise<string>;

/** Waits up to `waitSeconds`, then reports. Throws for an unknown id. */
export async function _jobOutput(id: string, waitSeconds: number): Promise<JobReportForAgency>;

export async function _stopJob(id: string): Promise<JobReportForAgency>;

export function _listJobs(): JobSummaryForAgency[];
```

- `_startJob` resolves the working directory with `resolveSpawnCwd`, the way `bashImpl` does, and then calls `addJob`.
- `_jobOutput` keeps `waitSeconds` between 0 and `MAX_WAIT_SECONDS`, a named constant of 600 in this file. It waits with `waitForJob`, passing `run.ctx.getAbortSignal(run.stack)`. Otherwise it calls `readJob`.
- **A guard trip during a wait returns the report and does not throw.** A time guard that trips between statements raises a `std::guard` interrupt, and a handler can approve more time or reject. A wait that throws on the abort skips that: no handler is asked, and the coder's `@guard` returns its failure without the saved draft. So when the wait was cut short by a guard trip the runner will raise, `_jobOutput` returns the job's report as it stands. The next statement boundary raises the trip, and every handler sees it. The check:

  ```ts
  const raisableTrip =
    readCause(signal.reason)?.kind === "guardTrip" && run.stack.firstRaisableTrip() !== null;
  ```

  `readCause` is in `lib/runtime/errors.ts`, and `firstRaisableTrip` is on `StateStack`. Returning early is correct here: `wait` means "return by this time at the latest", and the report at that moment is a true answer. No loop is needed.
- **Every other cancelled wait keeps the reason it was cancelled.** For Escape, a race another branch won, or a root budget, throw `leafCancel("job wait cancelled", signal)`. `leafCancel` is the function `abortableSleep` uses in `lib/stdlib/abortable.ts`. It copies the signal's cause into the error, and the cause is how the rest of the runtime tells an Escape from a guard trip. Export `leafCancel` from `abortable.ts`. Do not write `new AgencyCancelledError(...)` here: an error with no cause is read as a run killed from outside, so Escape would end the turn the wrong way and a budget trip would not reach its guard.
- `_stopJob` calls `endJob` and then `readJob`, and returns that report. The read is what clears `unread`, so a job the model stopped drops off its jobs message.
- The two `ForAgency` types are the table's types with two changes: `runningFor` replaces the two timestamps, and `status` holds the result of `describeJobState`. Format `runningFor` with `lib/utils/formatElapsed.ts`. One function in this file does the conversion, and all four helpers use it.
- The message for an unknown id is the spec's, from decision 8.
- After any `await`, call a second helper through `callPlain`, as the stdlib guide says. `pnpm run lint:structure` reports a mistake here.

### `stdlib/jobs.agency`

```agency
export type JobReport = {
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

export type JobSummary = {
  id: string;
  command: string;
  state: "running" | "ended" | "stopped" | "timedOut";
  status: string;
  exitCode: number | null;
  runningFor: string;
  unread: boolean
}

export def jobOutput(id: string, wait: number = 0): Result<JobReport>

export def stopJob(id: string): Result<JobReport>

export def listJobs(): JobSummary[]
```

- `jobOutput` and `stopJob` wrap the helper in `try`, so an unknown id is a failure. They pass `stdout` and `stderr` through `keepOutput` from `std::spill`, with the job's command as the source.
- Write a module doc comment and a docstring for each function. The docstrings are what the model reads. `jobOutput`'s says three things: it returns only output not returned before, `wait` is in seconds and blocks until the job ends or the time is up, and a wait can be cancelled without stopping the job. A docstring does not name another function, because an agent may carry one tool without the other.
- `stopJob` is tagged `@capabilities(subprocess)`, since it signals processes. `jobOutput` and `listJobs` have no tag. The capability check cannot see into the TypeScript helpers, so these tags are a statement of intent, and this is the intent.
- Add `std::jobs` to the stdlib sidebar in `docs/site/.vitepress/config.mts`, in alphabetical order. Do not write the page by hand. `make` generates it.
- None of the three raises an interrupt. Say why in the module doc comment, in the words of the spec's decision 10.

`startJob` is added in Task 5, because it has to live in `safeBash.agency`. This task's tests reach a job through it, so write them after Task 5.

---

## Task 5: `startJob`

**Files:**
- Modify: `stdlib/safeBash.agency`
- Modify: `stdlib/agents/lib/toolkits.agency`
- Test: `tests/agency/jobs.agency`, `tests/agency/jobs.test.json`

This task touches the code that decides whether a command is approved. Make the smallest change that lets two functions share it, and do not copy it.

### Share the approval between `safeBash` and `startJob`

Today the body of `safeBash` does four things in order: plan, refuse, raise, run. `startJob` needs the first three unchanged.

- [ ] Move the first three into one function, and call it from `safeBash`:

  ```agency
  def approvedPlan(command: string, dir: string, timeoutMs: number, jobMs: number | null): Result<Plan>
  ```

  It holds the `_debug` line, the refusal check, the `raiseAll` call, and the broad-explanation branch, exactly as they are now. It returns the plan on success. A rejection is returned as it came, with its `rejected` flag, the way `safeBash` returns it today.

  `safeBash` passes `null` for `jobMs`. `startJob` passes the job's limit.

- [ ] Inside `approvedPlan`, decide once whether this plan will run as a job, from the plan and not from the caller:

  ```agency
  const asJob = jobMs != null && exec.kind == "bash"
  ```

  When `asJob` is true, the questions say "in the background" and carry `jobMs` as their `timeout`. When it is false, they have today's text and carry `timeoutMs`. So a question always describes what will run. Today only a plan of kind `bash` raises `std::bash` or `std::exec`, so asking the caller would give the same prompts. Asking the plan keeps that true if a later plan kind raises one of those effects and runs in the foreground.

- [ ] Move the `match(exec)` that runs the plan into one function, and call it from `safeBash`:

  ```agency
  def runPlanned(exec: Execution, dir: string, command: string, timeout: number): Result<string>
  ```

- [ ] `raiseAll` and `raiseOne` take one more parameter, `background: boolean`. `approvedPlan` passes `asJob` for it. It changes the text of two questions and nothing else:

  | Effect | Text when `background` is true |
  | --- | --- |
  | `std::bash` | `Are you sure you want to run this shell command in the background?` |
  | `std::exec` | `Are you sure you want to run this command in the background?` |

  Every other effect keeps its text. No payload changes.

  Work the wording out once, at the top of `raiseOne`, as a suffix that is `" in the background"` or empty. The two arms put it into their text. Do not write an `if` in each arm.

- [ ] The existing `safeBash` tests in `tests/agency/safeBash.agency` must pass unchanged. They are the check that this refactor moved code without changing it.

### Add `startJob`

```agency
export def startJob(
  command: string,
  cwd: string = "",
  maxMinutes: number = 60,
): Result<string> raises <the same list as safeBash>
```

- [ ] Three named constants sit above it: `JOB_DEFAULT_MINUTES = 60`, `JOB_MAX_MINUTES = 720`, and `FOREGROUND_TIMEOUT_SECONDS = 120`. The signature's default uses the first.
- [ ] `maxMinutes` above `JOB_MAX_MINUTES` is treated as `JOB_MAX_MINUTES`. Zero or less is treated as `JOB_DEFAULT_MINUTES`.
- [ ] Call `approvedPlan(command, dir, FOREGROUND_TIMEOUT_SECONDS * 1000, maxMinutes * 60000)`. Return its failure unchanged.
- [ ] If the plan's execution kind is `bash`, start the job with `_startJob(text, command, dir, maxMinutes * 60000)`, wrapped in `try`. `text` is the planned text, the one `runBash` would run. On success return:

  ```
  Started job-1. It keeps running while you work. Do not call jobOutput
  right away: a job that just started has printed nothing. Call
  jobOutput("job-1") when you need its result, or pass wait to block
  until it ends.
  ```

  A failure from `_startJob` gets the prefix `runBash` puts on a failure from `_bash`, and nothing else:

  ```
  `<command>` was not run: <the failure's message>
  ```

  A `try` around a TypeScript call keeps only the error's message, so Agency code cannot tell one kind of failure from another, and does not need to. The table wrote the message for too many jobs, and `resolveSpawnCwd` wrote the one for a missing folder.

- [ ] For any other execution kind, call `runPlanned(exec, dir, command, FOREGROUND_TIMEOUT_SECONDS)` and put this line in front of a success:

  ```
  This command ran in the foreground, because it finishes at once.
  ```

- [ ] Put a comment above the `_startJob` call that points at the comment in `runBash`. `_startJob` is the second place a command runs with no interrupt of its own, and it is safe for the same reason: the only path to it goes through `approvedPlan`.
- [ ] The `@capabilities` tag matches `runBash`'s plus whatever `approvedPlan` needs. `agency test --check-capabilities` reports a missing one.
- [ ] Docstring, for the model: when to use it (a command expected to run for minutes or longer, such as a download, a server, or a watch), that it returns a job id at once while the command keeps running, and that a command printing more than 10 MiB should redirect its output to a file. Do not name `jobOutput` in the docstring. The stdlib guide says a docstring must not mention other functions, and the result text above already names it at the moment the model needs it.

### `jobTools()`

- [ ] In `stdlib/agents/lib/toolkits.agency`:

  ```agency
  export def jobTools(): any[] {
    """
    Return the tools for running a shell command as a background job.
    """
    return [startJob, jobOutput, stopJob]
  }
  ```

  `shellTools()` does not change.

### Tests, in `tests/agency/jobs.agency`

No LLM calls. Each node wraps its calls in a handler.

- [ ] `rejectedStartsNothing`: a handler that rejects `std::bash` and `std::exec`. `startJob("sleep 30")` returns a failure, and `listJobs()` is empty. This is review item 1. To confirm the test can fail, move the `_startJob` call above `approvedPlan` once, see the test fail, and move it back.
- [ ] `backgroundQuestionSaysSo`: the handler records `intr.message`. For `startJob("sleep 1")` the recorded text ends with "in the background?". For `safeBash("sleep 1")` it does not.
- [ ] `startReadStop`: with an approving handler, `startJob("printf 'A%s\\n' 1; sleep 1; printf 'B%s\\n' 2")` returns text containing `job-1`. `jobOutput("job-1", wait: 10)` returns state `"ended"`, exit code 0, and standard output containing `A1` and `B2`. A second `jobOutput("job-1")` returns empty standard output. The `printf` form keeps the expected text out of the command, as `timeLimitStopsTheCommand` in `safeBash.agency` does.
- [ ] `stopEndsIt`: start `sleep 30`, call `stopJob`, and check the state is `"stopped"`. `listJobs()` then shows the job with `unread` false.
- [ ] `guardTripDuringWaitAsksTheHandler`: start `sleep 30`. Inside a 200 ms time guard, call `jobOutput(id, wait: 30)`. The handler has a `std::guard` arm that records it was called and returns `reject()`, the way `tests/agency/async/time-guard.agency` does. Assert that the handler was called, that the guarded block is a failure, and that `listJobs()` still shows the job as `"running"`. Stop the job at the end.
- [ ] `guardTripDuringWaitCanBeApproved`: the same setup, with a job that runs about one second. The handler approves the trip with more time, `approve({ maxTime: ... })`, and the block then finishes with the job's report. This case fails if the wait throws on a guard trip.
- [ ] `foregroundForInstantCommands`: `startJob("echo hi")` returns text that starts with the foreground line and contains `hi`, and `listJobs()` is empty. The handler records every question's text, and none ends with "in the background?".
- [ ] `unknownId`: `jobOutput("job-99")` and `stopJob("job-99")` are failures whose message contains "is not running in this run". This is review item 4.
- [ ] `missingFolder`: `startJob("sleep 1", cwd: "/no/such/folder")` is a failure whose message contains "was not run", and `listJobs()` is empty. This is review item 6.
- [ ] `timeLimitCarriesTheLimit`: the handler rejects unless `intr.data.timeout` is `120000` for `startJob("sleep 1", maxMinutes: 2)`.

---

## Task 6: trace lines

**Files:**
- Modify: `lib/stdlib/agentToolTrace.ts`
- Test: `lib/stdlib/agentToolTrace.test.ts`

Read `docs/dev/agents/tool-output.md` first. Every tool the agent offers needs a line in the renderer's table.

- [ ] Add three entries beside `safeBash`:

  | Tool | Line |
  | --- | --- |
  | `startJob` | `Start job` and the command. |
  | `jobOutput` | `Check job` and the id, with `waiting up to 5m` when `wait` is set. The summary shows the report's `status`. |
  | `stopJob` | `Stop job` and the id. |

- [ ] Use the table's existing helpers (`one`, `summary`, `text`). Look at how `safeBash` and `readSpill` are written and follow the nearer one.
- [ ] Tests, one per tool, in the style of the `readSpill` cases.

---

## Task 7: the REPL prints a line when a job ends

**Files:**
- Modify: `lib/stdlib/cli.ts`
- Test: the existing test file for `cli.ts`

- [ ] Add a pure function that builds the line, and test it:

  ```ts
  /** "job-1 finished after 41m 08s (exit 0): ./run-comparison.sh" */
  export function jobEndedLine(job: JobSummary): string;
  ```

  The part in brackets is `describeJobState(job)`. The running time is `endedAt - startedAt`, formatted with `formatElapsed`. The command is printed whole, and the terminal wraps it.

- [ ] In `_runLineRepl`, after the readline interface exists, register `onJobEnd(replCtx.jobs, ...)`. Remove the listener in the `finally` that tears the REPL down.
- [ ] Add a local `turnRunning` flag to `_runLineRepl`. Set it where the loop reports `working` to Herdr, and clear it where the loop reports `idle`. Do not use `activeStopSpinner` for this: the spinner is stopped in the middle of a turn whenever a nested prompt opens, so it does not say whether a turn is running.
- [ ] The listener prints the line dimmed. How it prints depends on `turnRunning`:
  - **A turn is running:** `process.stdout.write(line + "\n")`. The bottom region redraws the spinner below it.
  - **The prompt is idle:** clear the current line with `readline.clearLine` and `readline.cursorTo`, write the line, then call `rl.prompt(true)` so readline draws the prompt and the typed text again.
- [ ] On a stream that is not a terminal, write the line plainly.

The idle case cannot be checked well in a unit test. It is in the by-hand list under "How to test". Two things to watch for there: typed text that has wrapped onto a second row, and a job that ends while the slash-command menu or the approval prompt is open. If either draws wrongly, hold the line until the prompt is next drawn, and say so in the PR.

---

## Task 8: wire it into `agency agent`

**Files:**
- Create: `lib/agents/agency-agent/lib/jobsNote.agency`
- Create: `lib/agents/agency-agent/lib/slashCommands/jobs.agency`
- Modify: `lib/agents/agency-agent/brains/coordinator/coordinator.agency`
- Modify: `lib/agents/agency-agent/brains/coordinator/subagents/code.agency`
- Modify: `lib/agents/agency-agent/lib/repl.agency`
- Modify: `lib/agents/agency-agent/lib/commandPalette.agency`
- Test: `lib/agents/agency-agent/brains/coordinator/tests/toolWiring.agency` and its `.test.json`
- Test: a new `lib/agents/agency-agent/tests/jobsNote.agency` and its `.test.json`

### The jobs message

```agency
/** The text of the jobs message, or "" when there is nothing to list. */
export def jobsNoteText(jobs: JobSummary[]): string

/** Adds the jobs message to the current thread for this llm() call. */
export def addJobsNote()
```

- [ ] `jobsNoteText` lists a job when it is running or when it is `unread`. Each row is the id, `job.status`, the running time, and the command, with `, output not read yet` after the status of an unread job. A job that has ended and been read is left out.
- [ ] `addJobsNote` calls `listJobs()` and, when the text is not empty, `systemMessage(text, label: "background-jobs", expires: "llmCall")`. Follow `addGlobalInstructions`.
- [ ] In `mainAgent`, call `addJobsNote()` on the line after `addGlobalInstructions()`. The routed coder, and the coder the main agent calls as a tool, both run on the main thread, so they read it. `coderTurn` needs no call: it runs only for a turn started with `--agent`, which is the session's first turn, before any job exists.
- [ ] Tests for `jobsNoteText`, with hand-built summaries: an empty list gives `""`. A running job is listed. An ended, unread job is listed with "output not read yet". An ended, read job is not listed.

### The tools

- [ ] `code.agency` already holds the one flag that says whether this is a one-shot run, `_oneShot`. Add one exported function beside it, and do not add a second flag anywhere:

  ```agency
  /** The job tools for this session: none in a one-shot run. */
  export def sessionJobTools(): any[]
  ```

- [ ] `code.agency`: in `runCoder`, pass `extraTools: [...extras, ...sessionJobTools()]`.
- [ ] `coordinator.agency`: add `...sessionJobTools()` to `offeredTools`. Do not add the tools to `mainAgentTools`, which is a static list built before the session knows whether it is interactive.
- [ ] `toolWiring` tests: with one-shot off, the coder's extras, the Agency coder's extras, and the main agent's offered tools each include `startJob`, `jobOutput`, and `stopJob` exactly once. With one-shot on, none of the three lists includes them. Check for duplicate names the way the file's other nodes do, since a duplicate tool name fails the `llm()` call.

The router is not changed. A message such as "start the download in the background" may be sent to the coder or kept by the main agent, and both now carry the tools.

### `/jobs`

```agency
/** `/jobs` lists the jobs. `/jobs stop <id>` stops one. */
export def jobsSlashCommand(args: string): boolean
```

- [ ] With no argument, print one row per job: id, `job.status`, running time, command. With no jobs, print `No background jobs.`
- [ ] `stop <id>` calls `stopJob`. On success it prints nothing itself, because the REPL's finish line from Task 7 already says the job stopped, and the user should not see the same job end twice. An unknown id prints the failure's message. Anything else prints a one-line usage.
- [ ] A stop by the user is told to the model. `stopJob` reads the job, so the job drops off the jobs message, and without a note the model would still believe the job is running. After a successful stop, call `addNote` from `lib/pendingNotes.agency`, the way `!command` does:

  ```
  I stopped background job job-1 myself: ./run-comparison.sh
  ```

  The note rides on the user's next message.
- [ ] `repl.agency`: add `"/jobs" => jobsSlashCommand("")` to the match, and a `startsWith("/jobs ")` branch beside the `/image ` one. Add `/jobs` to the help line that lists the commands.
- [ ] `commandPalette.agency`: add `"/jobs": "List background jobs, or stop one with /jobs stop <id>"`.

---

## Task 9: docs

**Files:**
- Create: `docs/dev/stdlib/jobs.md`
- Modify: `CLAUDE.md` (the one in `packages/agency-lang`)
- Modify: `docs/dev/runtime/host.md`
- Modify: `docs/dev/stdlib/safe-bash.md`
- Modify: `docs/dev/agents/user-commands.md`

A dev doc records the mechanism and the rules. It does not tell the story of how the feature was built.

- [ ] `docs/dev/stdlib/jobs.md`, with these sections:
  1. What a job is, in one example.
  2. Where the code lives: the table, the context field, the stdlib module, `startJob` in `safeBash.agency`.
  3. Approvals: `startJob` raises what `safeBash` raises, and why reading and stopping raise nothing.
  4. Checkpoints and pauses: the table is not saved, a job stops when its run ends or pauses, and what `jobOutput` returns afterwards.
  5. Branches and child processes: one table per run, shared by every branch, and a child process has its own.
  6. What stops a job and what does not: `stopJob`, the time limit, the output cap, the run ending. Not Escape, and not a guard trip.
  7. The agent: which agents carry the tools, the jobs message, the finish line, `/jobs`.
- [ ] `CLAUDE.md`: one line in the Standard library list, at most 150 characters:

  ```
  - `docs/dev/stdlib/jobs.md` — Background jobs: `startJob` and `std::jobs`, where the job table lives, and what stops a job.
  ```

- [ ] `host.md`: one sentence on `output()` where `start` is described.
- [ ] `safe-bash.md`: a short section on `startJob`, saying it shares `approvedPlan` with `safeBash`, and linking to `jobs.md`.
- [ ] `user-commands.md`: `/jobs`.
- [ ] Run `pnpm run lint:structure`. It fails when the index line is too long or the doc is missing from the index.

---

## How to test

Make every change above first. Then one build and one test run. Save each command's output to a file, so a failure can be read without running it again.

1. **Build.** `make > /tmp/jobs-make.log 2>&1`. A change to a stdlib `.agency` file needs `make`, not `pnpm run build`. `make` also regenerates the stdlib doc page for `std::jobs`.
2. **Typecheck.** `pnpm run typecheck > /tmp/jobs-typecheck.log 2>&1`.
3. **Unit tests, only the files this plan touches.** Run vitest from inside the worktree, with the file paths spelled out:

   ```
   pnpm exec vitest run \
     lib/host/node/nodeSubprocess.test.ts \
     lib/runtime/jobs \
     lib/runtime/state \
     lib/stdlib/agentToolTrace.test.ts \
     lib/stdlib/cli \
     > /tmp/jobs-vitest.log 2>&1
   ```

4. **Agency tests, only these files, with the capability check CI uses:**

   ```
   pnpm run agency test tests/agency/jobs.agency --check-capabilities > /tmp/jobs-agency.log 2>&1
   pnpm run agency test tests/agency/safeBash.agency --check-capabilities > /tmp/jobs-safebash.log 2>&1
   ```

   The second is the check that the refactor in Task 5 changed nothing.

5. **Agent tests.** Run the `toolWiring` and `jobsNote` tests with `HOME` pointed at a scratch folder, so they do not read your real agent settings.
6. **Lint.** `pnpm run lint:structure > /tmp/jobs-lint.log 2>&1`, and prettier on the TypeScript files by name.
7. **By hand, in `agency agent`:**
   - Ask it to run `for i in 1 2 3 4 5 6; do echo tick $i; sleep 20; done` in the background. It should reply at once with a job id.
   - Ask "how is that job going?", without naming the job. It should report the ticks so far. Read the trace to see which agent answered. If the router sent the turn to the coder, this also shows that the coder's tool loop, and not a side call before it, received the jobs message. An expiring message is taken by the first `llm()` call after it is added.
   - Run `/jobs`.
   - Start another job, run `/jobs stop <id>`, and check the job's end is printed once. Then ask "is that job still running?". The model should know you stopped it.
   - Type half a line and wait for the job to end. The finish line should appear above the prompt, with the typed text intact.
   - Start `sleep 600` in the background, quit the agent, and check with `pgrep -f "sleep 600"` that nothing is left.
   - Run `agency agent -p "start sleep 60 in the background"`. The agent should have no job tools, and should say it cannot or run the command in the foreground.

Do not run the full Agency test suite locally. CI runs it on the PR.

## What is not in this plan

The spec lists these under "What this does not cover": waking the agent when a job ends, sending input to a job, terminal programs such as `ncdu`, moving a running command to the background, and Windows. The idea doc has the notes on each.
