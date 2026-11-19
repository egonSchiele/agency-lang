# Jobs 1: a job outlives the turn that started it

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shell job is a separate process with a record on disk, started and read through `std::jobs`, so that a pause, the end of a turn, or quitting the app cannot stop it.

**Architecture:** Each job is run by a small detached process, the *runner*, which starts the command through the host, copies its output to files, and writes the job's record in `~/.agency/jobs/<id>/`. Everything else (status, output, stop, list) is reading and writing files in that folder, so any program on the machine can do it. A run keeps a list of the jobs it holds, with its own read positions, on its context, saved in every checkpoint the way `spawnCount` is.

**Tech Stack:** TypeScript (runtime, host, CLI), Agency (`stdlib/`, the agent), vitest, the `agency test` runners.

**Spec:** `docs/superpowers/specs/2026-11-19-jobs-interface-design.md`

**Review:** `2026-11-19-jobs-1-outlive-the-turn-review.md`, beside this file. Every problem it lists is answered here. "Review N" below names its numbered problems.

**Linear:** milestone "3. A job outlives the turn that started it": ADI-335, ADI-337, ADI-336, ADI-341. Closes ADI-307.

## What gets built, by pull request

| PR | Tasks | Tickets | After it merges |
| --- | --- | --- | --- |
| 1 | 1 to 4 | ADI-335, ADI-337 | `start`, `status`, `output`, `stop` in `std::jobs` work on detached jobs. The agent still uses the old job table. |
| 2 | 5 | ADI-336 | `agency jobs` lists, stops, and cleans up. |
| 3 | 6 to 8 | ADI-341 | The agent's tools use the new jobs. The run's job table is deleted. The session core offers the job tools. |

This plan, its review, and the spec ride with PR 1.

## Where this plan differs from the spec

The spec was written before the code was read. These points are decided here, and the spec is edited to match in Task 4.

1. **A runner process owns each job.** Nothing but a parent can learn a child's exit code, and the starter may be gone when the job ends. So the starter launches a runner, and the runner is the job's parent.
2. **A stop is a file, not a signal.** The runner looks for a file named `stop`. A signal is sent in one case only: the runner has died and its command is still running (see "When the runner dies").
3. **The host gains functions, not a part.** The spec calls the lower layer "a new part of the host". What is built is four functions on the subprocess part, and the job folder's logic as shared code that takes a host.
4. **Two output files,** `stdout.log` and `stderr.log`, because a job report keeps the two streams apart today.
5. **`shellJob` is exported from `std::jobs`,** not from `std::jobs/kinds`. There is one kind in this plan.
6. **`whenStarterPauses: "stop"` is not built.** Nothing uses it yet. `JobDescription` does not have the field in this plan.
7. **A handle is an id, a kind, a label, and a start time.** `where`, the `unreachable` state, and an interrupt for stopping a job the run does not hold all wait for the first job that can be somewhere else (milestone 4). Nothing in this plan can produce one.
8. **After a rewind the run still holds its running jobs.** The spec says the handle list after a rewind is the checkpoint's. Here a restore keeps every job the run already holds and adds the checkpoint's, as a restore does not lower `spawnCount`. A job is real work outside the run, and a list that forgot it would leave it running with nothing to stop it.

## What changes for a program that is not the agent

`startJob` is a public function of `std::safeBash`, and this plan changes what it does for every caller.

- **A job keeps running after the program ends.** Today a job stops when the run that started it ends. After PR 3 it keeps running until it exits, reaches `maxMinutes` (60 by default, 720 at most), or is stopped. A script that calls `startJob("npm run dev")` and returns exits at once and leaves the server up. This is a breaking change to a documented function, and the owner accepted it on 2026-11-19.
- **`startJob` is refused inside a `run()` subprocess,** with "startJob cannot be called inside a run() subprocess." `spawn` refuses there for the same reason (`stdlib/agency.agency:551`): code in a `run()` child is sandboxed, and a process that outlives the child is a way out. Today such a job dies with the child. After this plan it would run for up to an hour with nobody holding it. This covers `learn`, `runFunction`, and any tool that runs in a child. Decided here, since it follows the rule `spawn` already has. It is the one thing in this plan the owner has not seen.
- **A job's output stays on disk** in `~/.agency/jobs/` until `agency jobs clean`, including anything secret a command printed. Today it lives in memory and goes away with the run.

`CHANGELOG.md` is not edited by this plan. The text for it goes in PR 3's description, for the owner to use at release.

## When the runner dies

`host.subprocess.start` puts every command in its own process group (`nodeSubprocess.ts:162`). So a runner killed with `SIGKILL`, or lost in some other way, leaves its command running, with nothing enforcing its time limit or its output cap and nothing collecting its output (Review 1).

The rule: **a job with no runner is stopped.** The record names the command's process group and the time that process started. When `jobStatus` or `requestStop` finds the runner gone:

1. If the command's process is alive and its start time matches the record, the group is stopped through the host: `SIGTERM`, then `SIGKILL` two seconds later, as the host stops any command.
2. The record is written as `ended`, with the note `The job's runner died, so its command was stopped.`
3. When the start time cannot be read (no `ps`, as in a slim container or on Windows), nothing is signalled, and the note is `The job's runner died. Its command may still be running as process <pid>.`

The start-time check is what makes a signal safe after a reboot, when the system may have given the pid to another process. It is `liveStartTime` in `lib/cli/attach.ts:110`, which `agency attach` uses for the same purpose, moved behind the host in Task 1. The same check closes the reused-pid hole for the runner itself.

## Global Constraints

- Use types, not interfaces. Use objects, not maps. Use arrays, not sets. No dynamic imports.
- No mutable state in a TypeScript module variable. Process-wide state goes through `processSlot` in `lib/runtime/processSlot.ts`, with a comment that says why it is per process.
- Name every number: a poll interval, a limit, and a timeout each get a named constant.
- Every platform call goes through the host (`run.ctx.host`, or `currentHost()`), never through `fs`, `child_process`, or `process` directly. The exceptions are `lib/host/node/` and `lib/cli/`.
- The job folder is `~/.agency/jobs/<id>/` under `agencyHomeDir(host)` (`lib/runtime/agencyHome.ts`), made with `host.files.privateDir` (mode `0700`).
- A job id is `job-` and six hex digits, and matches `^job-[0-9a-f]{6}$`. An id that does not match is never used as a path (Review 5).
- At most 8 jobs a run holds may be running or starting at once (`MAX_RUNNING_JOBS`). A job's output is capped at 10 MiB a stream (`JOB_OUTPUT_CAP_BYTES`).
- `startJob`, `jobOutput`, `stopJob`, and `listJobs` keep their names, parameters, and the shape of `JobReport` and `JobSummary`.
- Nothing deletes a job's folder except `agency jobs clean`.
- A test stops every job it starts before it returns, and gives each a short `maxMinutes`. Both test runners delete the case's temporary `AGENCY_HOME` when the case ends, and a job that outlives the case would write into a folder that is gone.
- Commands: `pnpm run typecheck`, never `pnpm tsc --noEmit`. `pnpm run fmt:ts` on the TypeScript files a PR changes, by name, before each commit. `agency test` runs pass `--check-capabilities`, as CI does. Run the tests for the changed files and let CI run the rest.
- Shell commands in this repo need Claude Code's sandbox off. `make` takes about 10 seconds and must run before any `agency test` and before any spawn test. Never `git add` a folder. Restore `tests/agency-js/llm-provider-defaults/log.jsonl` before a commit.

## Review Focus

0. **A job started inside a branch.** Each branch of a `fork`, and each parallel tool call, gets its own copy of a module's globals (`docs/site/guide/state-isolation.md`). The held list must not be a global, or a job the model starts in a parallel tool call is forgotten when the branch ends. Covered in Task 4.
1. **The runner dies without writing an ending** (`kill -9`, a reboot). The job must read `ended`, and its command must be stopped or the note must name the process that may still run. Covered in Task 3.
2. **Two readers of one job.** A run's read of a job's output must not move what `agency jobs` or another run sees. Covered in Tasks 3 and 5.
3. **A session resumed in a new process.** Its held jobs come back from the checkpoint, and `jobOutput` carries on from the saved position. Covered in Task 4.
4. **A program that starts a job and returns.** It exits at once: nothing in the standard library may hold the process open for a job. Covered in Task 7.
5. **Two parallel starts at the limit.** With seven jobs running, two starts at once must not both succeed. Covered in Task 4.

---

## File structure

| File | Responsibility |
| --- | --- |
| `lib/host/host.ts`, `lib/host/node/nodeSubprocess.ts`, `lib/host/memoryHost.ts`, `lib/host/browserHost.ts` | Four functions on the subprocess part, and `pid` on a running process. |
| `lib/runtime/jobs/jobRecord.ts` (new) | The record's schema, the id check, the file names, and reading and writing a record. No process code. |
| `lib/runtime/jobs/jobRunner.ts` (new) | What the runner does: run the command, copy output, watch for `stop`, write the ending. Takes a host, so tests drive it. |
| `lib/runtime/jobs/detachedJobs.ts` (new) | What a starter or reader calls: `launchJob`, `jobStatus`, `jobOutputSince`, `requestStop`, `listJobRecords`, `removeEndedJobs`. |
| `lib/runtime/jobs/jobEndWatcher.ts` (new, Task 6) | Polls a list of jobs and calls a listener when one ends. Started and stopped by the terminal. |
| `lib/runtime/state/context.ts`, `checkpointStore.ts`, `schemas.ts` | `heldJobs` on the run's context, saved and restored beside `spawnCount`. `startingJobs`, not saved. |
| `lib/stdlib/jobs.ts` | The helpers Agency calls. |
| `stdlib/jobs.agency` | The interface: `shellJob`, `start`, `status`, `output`, `stop`, and the tool functions. |
| `stdlib/safeBash.agency` | `JobHandle`, `startShellJob` (the one approved path to a launch), and `startJob` on top of it. |
| `lib/cli/jobs.ts` (new), `scripts/agency.ts` | `agency jobs`, and the hidden `agency job-runner` command. |

---

## PR 1: the lower layer and `std::jobs`

### Task 1: What the host needs to know about processes

**Files:**
- Modify: `lib/host/host.ts` (`HostSubprocess`, `RunningProcess`), `lib/host/node/nodeSubprocess.ts`, `lib/host/memoryHost.ts`, `lib/host/browserHost.ts`, `lib/cli/attach.ts`
- Modify, because they implement the type: the fakes at `lib/runtime/jobs/jobTable.test.ts:239` and `:275`, `lib/stdlib/spawn.test.ts:59`, and `lib/stdlib/__tests__/fakeSubprocess.ts`
- Test: `lib/host/node/nodeSubprocess.detached.spawn.test.ts` (new)

**Interfaces:**
- Produces, on `HostSubprocess`:

```ts
/** Starts the command in its own process group with its three standard
 *  streams ignored. This process does not wait for it. */
startDetached(command: Command, options?: { cwd?: string; env?: Record<string, string> }): Promise<{ pid: number }>;
processState(pid: number): "alive" | "gone" | "unknown";
/** When the process started, in milliseconds, or null when it cannot be
 *  read: the process is gone, or the platform has no `ps -o lstart`. */
processStartedAt(pid: number): number | null;
/** SIGTERM to the process group `pid` leads, then SIGKILL after the
 *  host's usual two seconds. Resolves when the group is gone. */
stopGroup(pid: number): Promise<void>;
```

- Produces, on `RunningProcess`: `pid: number`, the child's pid, which is also its process group.

- [ ] **Step 1: Write the failing test.**
  - `startDetached` a `program` command, `node -e "setTimeout(() => {}, 30000)"`. The pid is a number, `processState(pid)` is `alive`, and `processStartedAt(pid)` is within 5 seconds of now.
  - `stopGroup(pid)` resolves, and then `processState(pid)` is `gone` and `processStartedAt(pid)` is null.
  - A pid that never existed (`2 ** 30`) is `gone`.
  - `const running = await start(...)` a shell command that starts a child of its own (`sleep 30 & wait`). `stopGroup(running.pid)` leaves neither alive. Pass the started child's pid, never Node's own `process.pid`, which would stop the test runner.
- [ ] **Step 2: Run it.** `make && pnpm vitest run lib/host/node/nodeSubprocess.detached.spawn.test.ts`. Expected: FAIL, `startDetached is not a function`.
- [ ] **Step 3: Implement.**
  - `startDetached`: `spawn` with `detached: true`, `stdio: "ignore"`, `shell: false`, then `unref()`. A `shell` command goes through the bash lookup and environment cleaning `start` uses.
  - `processState` calls the function of that name in `lib/runDirectory/lock.ts:169`. Do not write a second liveness check.
  - `processStartedAt`: move `liveStartTime` and `parseStartTime` from `lib/cli/attach.ts` to `lib/host/node/`, and have `attach.ts` import them from there. `agency attach` must behave as before.
  - `stopGroup` uses `killGroup`, which `nodeSubprocess.ts` already has.
  - `memoryHost`: all four come from the `subprocess` the test passed, and refuse when none was passed. `browserHost` and the four fakes: refuse, or return the fake's own values.
- [ ] **Step 4: Run it,** and `pnpm vitest run lib/cli/attach lib/stdlib/spawn.test.ts lib/runtime/jobs`. Expected: PASS for all.
- [ ] **Step 5: Commit.** `pnpm run fmt:ts` on the changed files, then `host: start, find, and stop a process that outlives this one`.

### Task 2: The record and the runner

**Files:**
- Create: `lib/runtime/jobs/jobRecord.ts`, `lib/runtime/jobs/jobRunner.ts`
- Modify: `scripts/agency.ts` (a hidden command)
- Test: `lib/runtime/jobs/jobRecord.test.ts` (new), `lib/runtime/jobs/jobRunner.test.ts` (new)

**Interfaces:**
- Consumes: `host.subprocess.start` (as `addJob` in `jobTable.ts` calls it today), Task 1's `pid` and `processStartedAt`, `host.files`, `host.clock`.
- Produces, in `jobRecord.ts`:

```ts
export const RECORD_FILE = "record.json";
export const STDOUT_FILE = "stdout.log";
export const STDERR_FILE = "stderr.log";
export const STOP_FILE = "stop";
export const JOB_ID = /^job-[0-9a-f]{6}$/;

// A zod schema with `.strict()`, as `AttachRecordSchema` is in
// lib/debugger/attach/registry.ts: the record is read back from disk.
export const JobRecordSchema = z.object({ ... }).strict();
export type JobRecord = {
  version: 1;
  id: string;
  kind: "shell";
  /** The text the summary shows. */
  label: string;
  /** The text that runs. */
  command: string;
  /** Always absolute. */
  cwd: string;
  maxMs: number;
  state: JobState;            // the existing type, moved here from jobTable.ts
  exitCode: number | null;
  note: string;
  startedAt: number;
  endedAt: number | null;
  /** Null until the runner has started. */
  runnerPid: number | null;
  runnerStartedAt: number | null;
  /** The command's pid, which is its process group. Null until it starts. */
  commandPid: number | null;
  commandStartedAt: number | null;
};

export function isJobId(text: string): boolean;
export function jobsDir(host: Host): string;                 // <agency home>/jobs
/** Throws for an id that is not a job id, so no caller can build a path
 *  from text that came from a command line or a checkpoint. */
export function jobDir(host: Host, id: string): string;
export function readRecord(host: Host, dir: string): Promise<JobRecord | null>;
export function writeRecord(host: Host, dir: string, record: JobRecord): Promise<void>;
/** Reads the record, applies `change`, and writes the result, with
 *  nothing able to run in between. `change` returns null to leave the
 *  record as it is. Built on `host.files.updateText`. */
export function changeRecord(host: Host, dir: string, change: (current: JobRecord) => JobRecord | null): Promise<JobRecord | null>;
```

- Produces, in `jobRunner.ts`: `runJob(host: Host, dir: string, pollMs?: number): Promise<void>`. It resolves when the job's ending is written, or at once when there is nothing to run.
- Produces, in `scripts/agency.ts`: `agency job-runner <dir>`, hidden from help. It builds a `nodeHost()` and awaits `runJob(host, dir)`.

`writeRecord` is `host.files.writeText`, which already writes a sibling file and renames it over the target (`overwriteViaSibling` in `nodeFiles.ts`), so a reader never sees half a record. `readRecord` returns null for a missing file and for text the schema refuses.

The runner is a command of the `agency` CLI and not a file of its own, so that it is found the way `spawn` finds the CLI: `agencyCliPath()` in `lib/agencyCliPath.ts`, which falls back to the package's `dist/` under vitest.

What `runJob` does, in order:

1. Reads the record. **When the `stop` file exists, or the state is not `running`, it runs nothing and returns** (Review 6). A starter that gave up on a slow runner has written both.
2. Writes `runnerPid` and `runnerStartedAt` with `changeRecord`, which leaves the record alone if its state is no longer `running`. If it was left alone, returns.
3. Starts the command with `host.subprocess.start({ kind: "shell", script: record.command }, { cwd: record.cwd, timeoutMs: record.maxMs, signal, maxOutputBytes: JOB_OUTPUT_CAP_BYTES })`. These are the options `addJob` passes today. Writes `commandPid` and `commandStartedAt`.
4. Every `pollMs` (default 250): appends what `output()` has gained on each stream to its file, with `host.files.openForAppend`; aborts `signal` when the `stop` file exists.
5. When `wait()` settles: appends the last output, and writes the ending. The ending comes from the `RunResult` exactly as `endingOf` in `jobTable.ts` decides it today. Move `endingOf`, `describeBytes`, `JobState`, `JobStart`, and `ReadPositions` into `jobRecord.ts` and have `jobTable.ts` import them. A rejected `wait()` is `ended` with the error's message as the note.

- [ ] **Step 1: Write the failing tests.** In `jobRecord.test.ts`: `jobDir` throws for `../../etc`, for `job-xyz`, and for an empty string, and returns a path under `jobsDir` for `job-3fa9c1`; `readRecord` is null for text with an extra key; `changeRecord` with a `change` that returns null writes nothing.

  In `jobRunner.test.ts`, with `memoryHost`, `FakeClock`, and a scripted subprocess from `lib/stdlib/__tests__/fakeSubprocess.ts`:
  - `copies output to the two files as it arrives`: the process prints `a` then `b` on stdout; after two polls `stdout.log` holds `ab` and `stderr.log` is empty.
  - `writes the ending when the command exits`: exit code 3 gives `state: "ended"`, `exitCode: 3`, `endedAt` set.
  - `writes the runner's and the command's pid and start time before the first poll`.
  - `a stop file stops the job`: writing `stop` gives `state: "stopped"`.
  - `a stop file found before the start runs nothing`, and `a record that already reads ended runs nothing` (Review 6). In both, the scripted subprocess records that `start` was never called.
  - `a timeout reads timedOut`, and `output past the cap reads ended with a note naming the stream`.
  - `a command that cannot start reads ended with the error as its note`.
- [ ] **Step 2: Run them.** `pnpm vitest run lib/runtime/jobs/jobRecord.test.ts lib/runtime/jobs/jobRunner.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `jobRecord.ts`, `jobRunner.ts`, and the hidden command. The command catches nothing: a runner that throws is a process that is gone, which Task 3 reads as an ending.
- [ ] **Step 4: Run them.** Expected: PASS. Also `pnpm vitest run lib/runtime/jobs/jobTable.test.ts`. Expected: PASS, since the moved names only moved.
- [ ] **Step 5: Commit.** `pnpm run fmt:ts` on the changed files, then `jobs: the record and the runner`.

### Task 3: Launch, read, stop, and list

**Files:**
- Create: `lib/runtime/jobs/detachedJobs.ts`
- Modify: `lib/host/host.ts`, `lib/host/node/nodeFiles.ts`, `lib/host/memoryHost.ts` (`privateDir` takes an option)
- Test: `lib/runtime/jobs/detachedJobs.test.ts` (new), `lib/runtime/jobs/detachedJobs.spawn.test.ts` (new)

**Interfaces:**
- Consumes: Task 1's four functions; Task 2's record functions.
- Produces, on `HostFiles`: `privateDir(root, target, options?: { mustBeNew?: boolean })`. With `mustBeNew`, an existing folder throws an error whose `code` is `EEXIST`. Without it, `privateDir` behaves as it does today.
- Produces:

```ts
export const START_WAIT_MS = 5000;
export const STOP_WAIT_MS = 5000;
export const RUNNER_DIED_STOPPED = "The job's runner died, so its command was stopped.";

export type JobOutput = { stdout: string; stderr: string; positions: ReadPositions };

/** Makes a new folder under a new id, writes the first record, starts the
 *  runner, and resolves once the runner has written its pid. When it has
 *  not within START_WAIT_MS: writes the stop file, then a record that
 *  reads `ended`, and rejects. `start.cwd` must be absolute. */
export function launchJob(host: Host, start: JobStart): Promise<JobRecord>;
/** The record, with a dead runner handled by the rule under "When the
 *  runner dies". Null for no folder. */
export function jobStatus(host: Host, id: string): Promise<JobRecord | null>;
/** Output after `from` on each stream, carriage returns collapsed, and
 *  the positions to pass next time. Moves nothing on disk. */
export function jobOutputSince(host: Host, id: string, from: ReadPositions): Promise<JobOutput>;
/** Writes the stop file and resolves with the record once the job is no
 *  longer running, or after STOP_WAIT_MS. Null for no folder. */
export function requestStop(host: Host, id: string): Promise<JobRecord | null>;
export function listJobRecords(host: Host): Promise<JobRecord[]>;      // newest first
/** Deletes the folder of every job that is not running. Returns their ids. */
export function removeEndedJobs(host: Host): Promise<string[]>;
```

Rules the signatures do not say:

- **An id is never reused** (Review 4). `launchJob` picks an id and makes its folder with `privateDir(..., { mustBeNew: true })`. On `EEXIST` it picks another id. Folders stay until `agency jobs clean`, so after a few thousand jobs a six-digit id would otherwise match an old one, and the new job would write into the old job's folder and obey its `stop` file.
- **The runner is started** as `{ kind: "program", program: process.execPath, args: [agencyCliPath(), "job-runner", dir] }`. Take `process.execPath` the way `lib/stdlib/spawn.ts` does.
- **A slow runner cannot start a job that was reported as failed** (Review 6). On the timeout `launchJob` writes `stop` first and `ended` second. Task 2's runner checks both before it starts anything.
- **`jobStatus` never overwrites a real ending** (Review 7). When it finds a record that says `running` and a runner that is `gone`, it applies the dead-runner rule and writes the result with `changeRecord`, whose `change` returns null unless the record still says `running`. A runner that wrote its ending and exited a moment earlier keeps its exit code.
- **A runner is `gone`** when `processState(runnerPid)` is `gone`, or when `processStartedAt(runnerPid)` is a number that differs from `runnerStartedAt` by more than two seconds (the pid was reused). `unknown` stays `running`.
- **`requestStop` on a job whose runner is gone** applies the same rule, so the command is stopped. It writes no stop file for a job that has ended.
- **The jobs folder is opened with `privateDir` on every read** as well as on the first write, as `ensureSessionsDir` checks its folder before every use. Whoever can write a job's folder can stop the job and forge its record.
- **Positions count characters** of the file's text, as `ReadPositions` does today. `jobOutputSince` reads the whole file and slices. A read from a byte position, which `lib/cli/outputFollower.ts` does for `agency attach`, is the thing to reuse when this needs to be faster. It is not in this plan.

- [ ] **Step 1: Write the failing tests.** In `detachedJobs.test.ts`, on `memoryHost` with a `startDetached` that records its call and writes a pid into the record:
  - `launchJob writes a running record and starts the runner with the folder as its argument`.
  - `launchJob picks another id when the first one's folder exists`, with a `random` that returns the same bytes twice and then new ones.
  - `launchJob that times out writes the stop file and a record that reads ended, and rejects`.
  - `jobStatus reads a running record whose runner is gone as ended, and stops the command's group`: the fake records a `stopGroup(commandPid)` call, and the note is `RUNNER_DIED_STOPPED`.
  - `jobStatus does not signal when the command's start time does not match`, and the note names the pid.
  - `a runner whose state is unknown stays running`.
  - `jobStatus keeps a real ending`: the fake's `processState` writes `ended`, `exitCode: 0` into the record just before it answers `gone`; the result has `exitCode: 0` and no note (Review 7).
  - `jobOutputSince returns only text after the positions, and returns new positions`; called twice with the same `from` it returns the same text (Review Focus 2).
  - `requestStop on an ended job returns its record at once and writes no stop file`.
  - `jobStatus, jobOutputSince, and requestStop throw for an id that is not a job id` (Review 5).
  - `listJobRecords skips a folder with no readable record`, and `removeEndedJobs leaves running jobs`.

  In `detachedJobs.spawn.test.ts`, on a real `nodeHost` with `AGENCY_HOME` set to a temp folder through `process.env`:
  - Launch `echo one; sleep 30`, read `one`, stop it. Assert `state: "stopped"`, and that `processState` of both `runnerPid` and `commandPid` is `gone`.
  - Launch `sleep 30`, kill the runner with `SIGKILL`, call `jobStatus`. Assert `ended` with `RUNNER_DIED_STOPPED`, and that `processState(commandPid)` is `gone` (Review Focus 1). This test must leave no `sleep` behind.
- [ ] **Step 2: Run them.** `make && pnpm vitest run lib/runtime/jobs/detachedJobs`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `detachedJobs.ts` and the `privateDir` option.
- [ ] **Step 4: Run them,** and `pnpm vitest run lib/host/files.shared.test.ts` for the option. Expected: PASS.
- [ ] **Step 5: Commit.** `pnpm run fmt:ts` on the changed files, then `jobs: launch, read, stop, and list detached jobs`.

### Task 4: `std::jobs`: descriptions, handles, and the shell kind

**Files:**
- Modify: `lib/runtime/state/context.ts`, `lib/runtime/state/checkpointStore.ts`, `lib/runtime/state/schemas.ts`, `stdlib/jobs.agency`, `stdlib/safeBash.agency`, `lib/stdlib/jobs.ts`, `docs/superpowers/specs/2026-11-19-jobs-interface-design.md`
- Test: `tests/agency-js/jobs-interface/` (new), `tests/agency-js/jobs-resume/` (new), `lib/runtime/state/heldJobs.test.ts` (new)

**Interfaces:**
- Consumes: everything Task 3 produces.
- Produces, in `lib/stdlib/jobs.ts` (beside today's helpers, which stay until Task 7):

```ts
/** Starts the job and adds it to the run's held jobs. Refuses inside a
 *  `run()` subprocess. Refuses when the held jobs that are running, plus
 *  the starts in progress, are MAX_RUNNING_JOBS, with today's message. */
export function _launchJob(command: string, label: string, cwd: string, maxMs: number): Promise<JobHandle>;
/** One summary for each job the run holds. */
export function _heldSummaries(): Promise<JobSummaryForAgency[]>;
/** The job's state and its output since this run's last read. Moves the
 *  run's read position. Throws for an id the run does not hold. */
export function _readHeldJob(id: string): Promise<JobReportForAgency>;
export function _stopHeldJob(id: string): Promise<JobReportForAgency>;
export function _waitForJobEnd(id: string, waitSeconds: number): Promise<void>;
```

`JobSummaryForAgency` and `JobReportForAgency` are the types this file has today, built by `forAgency` from a record in place of a table entry. No new status type. `_waitForJobEnd` polls `jobStatus` every 250 ms and keeps today's rules for a wait: at most `MAX_WAIT_SECONDS`, a guard trip returns, any other cancel throws `leafCancel`. Its timer lives only for the length of the wait.

**None of these helpers starts a timer that outlives its call** (Review 2). A program that starts a job and returns must exit. Watching for a job's ending is the terminal's work, in Task 6.

`_launchJob` writes `host.system.cwd()` as the record's `cwd` when it is given an empty one. Today the host fills that in when it starts the command, and a host built with `nodeHost({ cwd })` has its own folder. The runner builds a plain `nodeHost()` and would use the wrong one.

- Produces, on the run's context:

```ts
// lib/runtime/state/context.ts, beside spawnCount (line 150)
export type JobHandle = { id: string; kind: string; label: string; startedAt: number };
export type HeldJob = {
  handle: JobHandle;
  read: ReadPositions;   // what this run has read of each stream
  finalRead: boolean;    // a read has returned the job's ending
};
heldJobs: HeldJob[];
/** Starts that passed the limit check and have not finished. Not saved,
 *  as `table.starting` is not today. */
startingJobs: number;
```

The held list is on the context, not in an Agency global, for one reason: **each branch gets its own copy of a module's globals.** The agent runs parallel tool calls as branches, so a job started in one would be forgotten when the branch ended. The context is one for every branch of a run, which is why today's job table is there.

`heldJobs` is saved and restored exactly as `spawnCount` is. That is three files: the field on the checkpoint (`checkpointStore.ts` lines 183, 208, 316, 792, 849), the field in `checkpointSchema` (`schemas.ts:122`), and `adoptHeldJobs` on restore beside `adoptSpawnCount` (`context.ts:917`). The schema is a plain `z.object`, so a key it does not list is dropped without an error (Review 9).

`adoptHeldJobs` keeps every job the context already holds and adds the checkpoint's. It drops any entry whose id is not a job id: a checkpoint is a file a person can edit (Review 5).

`_launchJob` adds one to `startingJobs` before it awaits `launchJob` and takes it away in a `finally`, so two parallel starts cannot both pass the limit (Review 3).

- Produces, in `stdlib/safeBash.agency`:

```agency
export type JobHandle = { id: string; kind: string; label: string; startedAt: number }

type ShellStart =
  | { ran: "job"; handle: JobHandle }
  | { ran: "foreground"; output: string }

export def startShellJob(
  command: string,
  label: string,
  cwd: string = "",
  maxMinutes: number = 60,
): Result<ShellStart> raises <SafeBashEffects>
```

`JobHandle` is defined here, and `std::jobs` re-exports it. `std::jobs` has to import `std::safeBash` for `startShellJob` and `SafeBashEffects`. If `JobHandle` lived in `std::jobs`, each module would import the other, and a cycle of `std::` modules fails at load with "Cannot access ... before initialization" without the compiler reporting it (`docs/dev/compiler/init-topsort.md`, Review 8).

`startShellJob` is today's `startJob` body with one change: it calls `_launchJob` in place of `_startJob`. `startJob` is not changed in this task.

- Produces, in `stdlib/jobs.agency`:

```agency
export { JobHandle } from "std::safeBash"
export type JobDescription = { kind: "shell"; label: string; maxMinutes: number }
export type ShellJob = JobDescription & { command: string; cwd: string }

export def shellJob(command: string, label: string = "", cwd: string = "", maxMinutes: number = 60): ShellJob
export def start(description: ShellJob): Result<JobHandle> raises <SafeBashEffects>
export def status(handle: JobHandle): Result<JobSummary>
export def output(handle: JobHandle): Result<JobReport>
export def stop(handle: JobHandle): Result<JobReport>
```

`JobSummary` and `JobReport` are the two types the module exports today.

Rules the signatures do not say:

- `start` returns a failure when the command's plan is not a bash command ("This command runs in the foreground, so it cannot be a job."), and runs nothing.
- A handle the run does not hold is a failure for all three. Acting on another run's job waits for milestone 4.
- None of the three raises an interrupt, for the reasons in the module's doc comment today.

- [ ] **Step 1: Write the failing tests.** `lib/runtime/state/heldJobs.test.ts`: a checkpoint written from a context with two held jobs and parsed back through `pausedCheckpointSchema` still has both; `adoptHeldJobs` keeps a job the context holds that the checkpoint lacks; it drops an entry whose id is `../../x`.

  `tests/agency-js/jobs-interface/`, one node each, every job with `maxMinutes: 1`:
  - Start `shellJob("echo one; sleep 30")` under `with approve`, read `output` until it has `one`, check `status` is `running`, `stop`, and return the final state. Expected: `stopped`.
  - Start `shellJob("cat README.md")`. Expected: the foreground failure.
  - Start seven `sleep 30` jobs, then the eighth and ninth in two branches of one `fork`. Expected: exactly one of the two fails with the limit message (Review Focus 5). Stop them all.
  - Start one job in each of two `fork` branches and return the two handles from the branches. After the fork, call `status` on both. Expected: two successes, which shows the run holds both (Review Focus 0). `status` fails for a handle the run does not hold. Do not use `listJobs()` here: until Task 7 it reads the old table.
  - Call `startShellJob` inside a `run()` subprocess. Expected: the refusal.

  `tests/agency-js/jobs-resume/`: a program starts a job that prints `one`, sleeps 2 seconds, prints `two`, and sleeps 20; reads `one`; raises an interrupt nobody handles; and after the resume waits, reads again, and stops the job. The test resumes with `respondToInterrupts` and expects: the second read is exactly `two`; the record's `runnerPid` is the same before and after the resume; and the record read just before the resume says `running` (Review Focus 3). Model the file layout on `tests/agency-js/learned-tools-resume`.
- [ ] **Step 2: Run them.** `make`, then `pnpm vitest run lib/runtime/state/heldJobs.test.ts`, `pnpm run agency test js tests/agency-js/jobs-interface --check-capabilities`, and the same for `jobs-resume`. Expected: FAIL, `start` is not exported from `std::jobs`.
- [ ] **Step 3: Implement** the held list on the context, in the checkpoint, and in the schema; the TypeScript helpers; `JobHandle` and `startShellJob`; and the interface functions.
- [ ] **Step 4: Run them.** Expected: PASS for all three. Also `pnpm vitest run lib/runtime/state`, since the checkpoint's shape changed. Expected: PASS.
- [ ] **Step 5: Edit the spec** so it says what was built: the eight points under "Where this plan differs from the spec", in the sections "The types", "The lower layer", "Interrupts, checkpoints, and pauses", and the code sample at the top.
- [ ] **Step 6: Commit.** `pnpm run fmt:ts` on the changed files, then `std::jobs: descriptions, handles, and the shell kind`. Open PR 1 with this plan, its review, and the spec in it.

---

## PR 2: `agency jobs`

### Task 5: List, stop, and clean up from a terminal

**Files:**
- Create: `lib/cli/jobs.ts`
- Modify: `scripts/agency.ts` (beside the `attach` command, near line 2185)
- Test: `lib/cli/jobs.test.ts` (new)

**Interfaces:**
- Consumes: `listJobRecords`, `jobStatus`, `requestStop`, `removeEndedJobs`, `isJobId`.
- Produces:
  - `jobsListing(records: JobRecord[], now: number): string`, a pure function. One row a job, with four columns: id, `describeJobState`, running time, and label. There is no machine column, because every folder here is a job on this machine. `No jobs.` for an empty list.
  - `agency jobs`, `agency jobs stop <id>`, `agency jobs clean`.

`agency jobs stop` of text that is not a job id, or of an id with no folder, prints `There is no job <id>.` and exits with `EXIT_CODE_USAGE_ERROR`. It never builds a path from the text (Review 5). `agency jobs clean` prints how many folders it removed.

A listing reads each job through `jobStatus`. So it moves no read position and changes no file of a job that is running or has ended, with one exception: a job whose runner has died is ended, and its command stopped, by whichever reader finds it first. That is the rule under "When the runner dies", and a listing is a reader.

- [ ] **Step 1: Write the failing tests.** `jobsListing` for no jobs, for one running and one ended job in newest-first order, and for a job whose label is long (the row is not wrapped or cut). On `memoryHost`: a list of one running and one ended job changes no file in either folder (Review Focus 2); a list that includes a job whose runner is gone writes that job's ending; `stop` of `../../x` and of an unknown id both report "There is no job"; `clean` removes ended folders and leaves running ones.
- [ ] **Step 2: Run them.** `pnpm vitest run lib/cli/jobs.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `lib/cli/jobs.ts` and register the command.
- [ ] **Step 4: Run them.** Expected: PASS. Then by hand: `AGENCY_HOME=$(mktemp -d) node dist/scripts/agency.js jobs` prints `No jobs.`
- [ ] **Step 5: Commit.** `pnpm run fmt:ts` on the changed files, then `agency jobs: list, stop, and clean up jobs`. Open PR 2.

---

## PR 3: the agent moves over

### Task 6: A line when a job ends, without the job table

**Files:**
- Create: `lib/runtime/jobs/jobEndWatcher.ts`
- Modify: `lib/stdlib/cliJobLine.ts`, `lib/stdlib/cli.ts` (line 1487)
- Test: `lib/runtime/jobs/jobEndWatcher.test.ts` (new)

**Interfaces:**
- Produces:

```ts
export const WATCH_POLL_MS = 1000;
/** Every WATCH_POLL_MS, reads the state of each job `held()` returns and
 *  calls `ended` once for each job that has ended since the watch began.
 *  A job that had already ended when it was first seen is not reported.
 *  Returns a function that stops the watch and clears its timer. */
export function watchHeldJobs(args: {
  host: Host;
  held: () => HeldJob[];
  ended: (job: JobRecord) => void;
}): () => void;
```

**The terminal does the watching, and the standard library does none** (Review 2). The host clock's timer is a plain `setTimeout` with no `unref` (`lib/runtime/clock.ts:21`), so a watcher started by `_launchJob` would keep every program that starts a job alive until the job ended. The REPL is the only thing that prints the line, and it is alive anyway.

`cli.ts` line 1487 becomes a `watchHeldJobs` call with `held: () => replCtx.heldJobs` and `ended: jobLines.jobEnded`, and the function it returns is called where `stopWatchingJobs` is called today. Because the watch reads the context's list on every poll, a job started in any branch is seen, and so is a job that came back from a checkpoint.

`jobEndedLine` in `cliJobLine.ts` takes a `JobRecord`. The watcher keeps what it has seen in a local variable of the `watchHeldJobs` call, so there is no process-wide state.

- [ ] **Step 1: Write the failing tests,** with `memoryHost` and `FakeClock`: a held job that ends calls `ended` once with its record; a job added to the list after the watch began is reported when it ends; a job that had ended before it was first seen is not reported; an `ended` that throws does not stop the watch; after the returned function is called, no timer is pending.
- [ ] **Step 2: Run them.** `pnpm vitest run lib/runtime/jobs/jobEndWatcher.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them,** and `pnpm vitest run lib/stdlib/cliJobLine`. Expected: PASS.
- [ ] **Step 5: Commit.** `pnpm run fmt:ts` on the changed files, then `jobs: a finish line that needs no job table`.

### Task 7: The tools use the new jobs, and the job table is deleted

**Files:**
- Modify: `stdlib/safeBash.agency` (`startJob`), `stdlib/jobs.agency` (`jobOutput`, `stopJob`, `listJobs`, the module's doc comment), `lib/stdlib/jobs.ts`, `lib/runtime/state/context.ts` (lines 35, 144 to 146, 410, 581, 867)
- Modify, because they depend on a run's end stopping its jobs: `tests/agency/jobs.agency`, `tests/agency/safeBashSavedOutput.agency`, `lib/agents/agency-agent/tests/jobsSlash.agency`, `lib/agents/agency-agent/tests/jobsNote.agency`
- Delete: `lib/runtime/jobs/jobTable.ts`, `lib/runtime/jobs/jobTable.test.ts`
- Test: `tests/agency-js/jobs-outlive-pause/` (new), `tests/agency-js/jobs-program-exits/` (new)

**Interfaces:**
- Consumes: `startShellJob` and the Task 4 helpers.
- Produces: the same four functions with the same signatures and report shapes.
  - `startJob` is `startShellJob` with today's two messages: `startedMessage(id)` for a job, and `FOREGROUND_LINE` and the output for a foreground run.
  - `jobOutput(id, wait)` waits with `_waitForJobEnd`, then `_readHeldJob`. `unread` is "ended and `finalRead` is false".
  - `stopJob(id)` is `_stopHeldJob`.
  - `listJobs()` is `_heldSummaries`.
  - `status`, `output`, and `stop` from Task 4 share these bodies, taking a handle in place of an id.
  - An id the run does not hold fails with: `There is no job <id> in this session. Its jobs are <ids>.` (or `This session has no jobs.`). The sentence about a job being stopped by a pause is removed, because it is no longer true.

Move `MAX_RUNNING_JOBS`, `JOB_OUTPUT_CAP_BYTES`, `describeJobState`, and `JobSummary` into `jobRecord.ts` before deleting `jobTable.ts`. `MAX_FINISHED_JOBS` is deleted with the table: nothing drops a finished job any more, so a long session's held list grows with every job. Task 8's doc says so.

**The existing tests.** `tests/agency/jobs.agency` expects "This run has no jobs" (line 186), which becomes "This session has no jobs." Several of its nodes start `sleep 30` and rely on the run's end to stop a job when a check fails before the `stopJob` call. After this task that job outlives the case and its runner writes into a temporary `AGENCY_HOME` the test runner has deleted. In all four test files: every node stops every job it starts, on every path, and every job gets `maxMinutes: 1`.

- [ ] **Step 1: Write the failing tests.**

  `tests/agency-js/jobs-outlive-pause/`: a program calls `startJob("sleep 30", maxMinutes: 1)`, then raises an interrupt nobody handles, so the run returns to its caller. The test asserts the job's record reads `running` after `main` returned, resumes, and has the program call `stopJob` and return its state. Expected: `stopped`. This is ADI-307.

  `tests/agency-js/jobs-program-exits/`: the test starts a compiled program as a child process. The program calls `startJob("sleep 30", maxMinutes: 1)` and returns the job's id. Expected: the child exits within 5 seconds, and the job's record still reads `running` (Review Focus 4). The test then stops the job with `requestStop`.
- [ ] **Step 2: Run them.** `make`, then `pnpm run agency test js tests/agency-js/jobs-outlive-pause --check-capabilities`. Expected: FAIL, the record does not exist, because `startJob` still uses the table.
- [ ] **Step 3: Implement** the four functions, remove `RuntimeContext.jobs` and the `closeJobTable` call in `cleanup()`, delete the table, and fix the four test files.
- [ ] **Step 4: Run** the two new tests, then `pnpm run agency test tests/agency/jobs.agency --check-capabilities`, the same for `tests/agency/safeBashSavedOutput.agency`, `lib/agents/agency-agent/tests/jobsNote.agency`, and `lib/agents/agency-agent/tests/jobsSlash.agency`, then `pnpm run agency test js tests/agency-js/jobs-interface --check-capabilities`, and `pnpm run typecheck`. Expected: PASS for all, with no reference to `jobTable` left (`grep -rn jobTable lib stdlib` prints nothing). After the runs, `ps` shows no `sleep 30` left behind.
- [ ] **Step 5: Say what changed for every caller.** Rewrite the doc comment at the top of `stdlib/jobs.agency` (its paragraph "Jobs belong to the run that started them" is no longer true) and the docstring of `startJob`, then regenerate the stdlib docs. Do not edit `CHANGELOG.md`. Put this in PR 3's description, under a heading "Breaking changes": a job started with `startJob` now keeps running after the program that started it ends, until it exits, reaches `maxMinutes`, or is stopped with `stopJob` or `agency jobs stop`; `startJob` is refused inside a `run()` subprocess; and a job's output stays in `~/.agency/jobs/` until `agency jobs clean`.
- [ ] **Step 6: Commit.** `pnpm run fmt:ts` on the changed files, then `jobs: the agent's tools use detached jobs`.

### Task 8: The session core offers the job tools, and the docs say what is true

**Files:**
- Modify: `lib/agents/agency-agent/core.agency` (the `setJobToolsOn(false)` call and the comment above it), `lib/agents/agency-agent/lib/cliTools.agency` (the comment on `sessionJobTools`), `lib/agents/agency-agent/tests/toolWiring.agency`
- Modify: `docs/dev/stdlib/jobs.md`, `docs/dev/runtime/spawn.md` ("Time and jobs while holding"), `docs/dev/runtime/host.md` (the subprocess part), `docs/dev/agents/session-core.md`, `docs/dev/agents/user-commands.md`

`core.agency` calls `setJobToolsOn(false)`. Remove the call, so the core offers the job tools. A one-shot run still offers none: its turn is the whole run, and a model that started a job there could never read it.

`docs/dev/stdlib/jobs.md` is rewritten, not patched. Its sections "Checkpoints and pauses" and "Limits and memory" describe the table that no longer exists. The new doc covers:

- The folder and its files, and that a job's output stays on disk, secrets included, until `agency jobs clean`.
- The runner, and that it is a hidden command of the CLI.
- How a stop works, and the rule for a runner that died, with the start-time check.
- The held list on the context, its read positions, and that it never shrinks.
- That an id is checked before it is a path, and that a folder is never reused.
- The watcher, and why it is the terminal's and not the standard library's.
- What `agency jobs` does, and that a listing can end a job whose runner died.
- That `startJob` is refused in a `run()` subprocess.

- [ ] **Step 1: Change the test first.** In `toolWiring.agency`, the node that checks job tools are absent under the session core now expects them present. Run `pnpm run agency test lib/agents/agency-agent/tests/toolWiring.agency --check-capabilities`. Expected: FAIL.
- [ ] **Step 2: Remove the call** in `core.agency` and fix the comment in `cliTools.agency`.
- [ ] **Step 3: Run it.** Expected: PASS.
- [ ] **Step 4: Rewrite the docs.**
- [ ] **Step 5: Check the PR as a whole.** `pnpm run typecheck`, `pnpm run fmt:ts:check`, and `pnpm run lint`. Do not run the whole test suite: CI does.
- [ ] **Step 6: Commit.** `agent: the session core offers the job tools`. Open PR 3, and say in it that Part D of `2026-11-19-shared-session-core-3-terminal.md` is unblocked.

---

## Not in this plan

- Kinds a user wrote, the Agency kind, `interrupts` and `respondToInterrupts`: milestone 4.
- `info`, `result`, `send`, `pause`, `save`, `resume`.
- `whenStarterPauses: "stop"`.
- Jobs in a one-shot run.
- A read of a large output file from a byte position.
- A limit on jobs for the whole machine.
- Dropping finished jobs from a run's held list.
- The job-end line when the terminal runs the session through the shared driver. The watcher takes a function that returns the held list, and Part D of the terminal plan decides where that list comes from.

## Known and accepted

- **A job whose runner died on a machine with no usable `ps`** is reported as ended with a note that its command may still be running. Nothing stops it.
- **A runner that is alive but stuck** reads as `running` until its job's time limit. There is no heartbeat.
