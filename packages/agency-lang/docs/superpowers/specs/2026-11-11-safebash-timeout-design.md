# A time limit for safeBash, bash, and exec, and a kill that stops the whole command

## The problem

`safeBash` has no time limit. It calls `_bash(command, cwd, 0, "", {})` (`stdlib/safeBash.agency`), and a timeout of `0` means none. The `bash` and `exec` tools take a `timeout`, and it also defaults to none. A command that hangs, or a test suite that takes much longer than expected, holds the agent until something else stops it.

Two runs of the SWE-bench pilot show what that costs:

- On `django-11299`, one Django test command hung for 63 minutes, until the benchmark's 50-minute agent timeout killed the trial. The coder's own 15-minute time budget did not stop it.
- On `sympy-13615`, in the run on 2026-11-11, the coder spent its last minutes in three commands that ran sympy's whole test suite. They took 161, 325, and 325 seconds, and the coder's 15-minute budget ran out during the last one. The fix was already on disk, so the task passed. The run still took 28 minutes, against 11 the run before.

Most commands are short. Across the three Agency runs on GLM 5.3 Flash (30 trials), the coder made 409 `safeBash` and `exec` calls:

| | Time |
|---|---|
| Median | 0.9 s |
| 90th percentile | 9.8 s |
| 99th percentile | 104 s |
| Calls over 120 s | 3, all of them the sympy full-suite runs |

The longest calls that did useful work were pytest's own test runs on `pytest-10356`, at 85 to 107 seconds.

## Why killing the command does not stop it today

The Node host starts a shell command with `spawn(bash, ["-c", script])` (`lib/host/node/nodeSubprocess.ts`). Its `kill` calls `child.kill(SIGTERM)`, which signals only that one bash process. The run ends on the child's `close` event, and Node fires `close` only after every process holding the child's output pipe has closed it.

Take `cd tests && python runtests.py admin_views`. Bash starts Python, and Python inherits bash's output pipe. If bash is killed and Python keeps running, the pipe stays open, `close` never fires, and the call does not return. The same happens with test workers, servers, or anything else the command starts.

A script that kills a command after 1 second shows the gap, and that a group kill closes it:

| Command | Kill | Call returns after |
|---|---|---|
| `sleep 6` | bash only | 1.0 s |
| `sleep 6; echo done` | bash only | 6.0 s |
| `sleep 6 & wait` | bash only | 6.0 s |
| `sleep 6; echo done` | process group | 1.0 s |
| `sleep 6 & wait` | process group | 1.0 s |

The first row works only because bash replaces itself with a lone command.

## Guards use the same kill

Agency's `guard` can limit the time of a block, and a guard trip does stop a running command. It was the first thing considered: wrap the body of `safeBash` in a time guard. It does not solve this, for two reasons.

A guard has no kill of its own. A time guard's timer aborts an `AbortSignal` (`lib/runtime/guard.ts`). `bashImpl` passes that signal to the host (`lib/stdlib/shell.ts`), and the host's abort listener calls the same `kill` described above. So a guard around `safeBash` would hang on the same commands. This is the likely reason the coder's 15-minute budget, which is a guard, did not stop the command on `django-11299`.

A guard is also the wrong shape for the limit. A command aborted by its signal rejects with a cancel, and its output is dropped (`runCancellable` in `lib/stdlib/abortable.ts`). A command stopped by the host's own `timeoutMs` returns its output so far (`spawnResultOf`, same file). The model needs that output to see which test hung.

So the limit is the host's `timeoutMs`, and the kill is fixed in the host, where guards, cancels, and time limits all reach it.

## What other agents do

**Pi** (1.5.0). Its `bash` tool takes an optional `timeout` in seconds, described as "optional, no default timeout". When the time runs out, Pi kills the whole process tree (`killProcessTree` in `dist/utils/shell.js`) and returns an error. In the 2026-11-10 run on GLM 5.3 Flash, the model set a timeout on 230 of 292 `bash` calls. The values it picked most were 60, 10, 300, 15, 30, and 600 seconds, up to 3,600.

**Crush** (`internal/agent/tools/bash.go`). It never kills a command for running long. After 60 seconds, a command moves to a background job, and the tool returns a shell ID. The model can change the delay with `auto_background_after`, start a command in the background with `run_in_background`, read its output with `job_output`, and stop it with `job_kill`.

## The change

The host makes two promises about a command it stops: everything the command started is signalled, and the call returns. Steps 3 to 5 are those promises. They apply to every way a command is stopped: a time limit, the run's abort signal (a guard trip, a cancel, or a race that another branch won), and the cap on output.

### 1. A default limit of 120 seconds

`safeBash`, `bash`, and `exec` stop a command after 120 seconds unless the call asks for more. That covers the 99th percentile above with room, and every long command that did useful work. For `bash` and `exec`, a `timeout` of `0` still means no limit.

### 2. A `timeout` parameter on `safeBash`, in seconds

```
safeBash(command: "python tests/runtests.py", timeout: 600)
```

The model can raise the limit for a command it expects to be slow. Pi's numbers show models use such a parameter when it is offered. It is in seconds, the unit Pi and Crush use, and the one a model is most likely to guess.

`bash` and `exec` keep their `timeout` in milliseconds. Changing the unit would change the meaning of a number existing programs pass.

The `std::bash` and `std::exec` questions `safeBash` raises carry the limit in their `timeout` field, in milliseconds, so the payload states how the line will run.

### 3. Signal the whole process group

On Linux and macOS, the host starts each child as the leader of a new process group, with Node's `detached: true`. The group's ID is the child's PID, and `process.kill(-pid, signal)` signals every process in the group. Python, pytest, and pytest's workers stay in bash's group unless they leave it on purpose.

On Windows, the kill runs `taskkill /F /T /PID <pid>`, where `/T` covers the whole tree.

### 4. `SIGTERM`, then `SIGKILL` after 2 seconds

The stop sends `SIGTERM` to the group first, so a test runner can print its summary and remove its temporary folders. After 2 seconds it sends `SIGSTOP` and then `SIGKILL` to the group. The stop comes first because a kill reaches the group one process at a time, and a shell running `a; b` could start `b` while `a` is being killed.

The `SIGKILL` is sent even when the command has already returned. A process that ignored `SIGTERM` and holds no output pipe is still in the group.

### 5. The call returns even when a process escapes

A process that calls `setsid()` leaves the group, and the kill does not reach it. If it still holds the output pipe, `close` never fires. So once a stopped child has exited, the host reads its pipes for half a second more and then destroys them. The call returns with the output read so far.

Without this step, the group kill would fix the common cases and leave the call able to hang on any command that starts a daemon.

### 6. Ctrl+C and exit kill the groups too

The terminal sends Ctrl+C to its foreground process group. A command in its own group is no longer in that group, so Ctrl+C stops reaching it. Today it reaches the command only because the command shares the terminal's group.

So the host keeps a list of the children it started that have not closed. When the Agency process exits, an `exit` handler kills every group on the list. While the list is not empty, the host also listens for `SIGINT`, `SIGTERM`, and `SIGHUP`. If nothing else handles the signal, it kills the groups and ends the process with the same signal. If something else does, such as the terminal UI, that handler decides, and the `exit` handler is the backstop.

### 7. A timeout is a failure with the output so far

A `safeBash` command that runs out of time returns a failure in the shape a nonzero exit gives, with two more fields:

```
{
  "command": "python tests/runtests.py",
  "exitCode": 1,
  "stderr": "...",
  "stdout": "...",
  "timedOut": true,
  "note": "Stopped at the time limit of 120 seconds. stdout and stderr hold the output so far. Run a narrower command (one test file, or one test), or pass a larger timeout."
}
```

The output so far matters most for a test run: the model can see which tests ran and which one hung. The agent's tool trace shows the call as "timed out".

`bash` and `exec` already return exit code 1 with "Process timed out" at the end of stderr, and keep doing so.

## No cap at the time left in the budget

An earlier draft capped a command's limit at the time left in the run's budget. That needs no code. The budget is a time guard, and a guard trip aborts the signal the running command listens on. Once the kill works, the coder's 15-minute budget stops the command itself, and the guard answers its own trip with the draft the coder saved.

## What this does not cover

- **A process that leaves the group keeps running.** Step 5 makes the call return, and the process lives on: a daemon, an explicit `setsid` setup, or `docker run`. Catching those needs Linux cgroups, or a subreaper process that adopts orphans. The sandbox the agent runs in is the backstop for those.
- **Background jobs.** Crush's design lets the model keep working while a command runs. It needs two more tools (`job_output`, `job_kill`), and the model has to remember to come back for the result. The coder's tool list was cut in #1445 to save context, so this is left for later. A command that ends normally is not stopped, so `server > log 2>&1 &` leaves the server running. Without the redirect, the server holds the output pipe, and the call waits until the time limit stops it.
- **A program that asks on the terminal.** `detached: true` also gives the child a new session with no terminal. A program that opens `/dev/tty` for a password, such as `sudo`, now fails at once where it used to prompt.
- **Other tools that start programs.** The git tools keep their own 30-second limit. Other callers of the host's `run` get the group kill, but no new default limit.

## Decisions on the earlier open questions

1. **120 seconds is the default.** It fits the SWE-bench data. A project with a slow build needs the model to pass `timeout` more often.
2. **`exec` and `bash` stay in milliseconds.** See step 2.
3. **The kill waits 2 seconds between `SIGTERM` and `SIGKILL`.** Pi sends `SIGKILL` at once. The wait lets pytest clean up. It costs nothing when the command honors `SIGTERM`, because the call returns as soon as the pipes close.

## How to test

One build and one test run cover the change.

- **Unit tests for the stop,** in `lib/host/node/nodeSubprocess.test.ts`, with the Node host and a real bash:
  - `sleep 30 & echo $!; wait` with a 200 ms limit returns within 1.5 seconds, and the `sleep` process is gone afterwards.
  - `sleep 30; echo done` with an aborted signal returns within 1.5 seconds and prints nothing.
  - A script that ignores `SIGTERM` returns after the 2-second grace period.
  - A Perl process that calls `setsid()` and holds the pipe does not keep the call from returning, and is still alive afterwards.
  - Killing the tracked children, as the exit handler does, stops a running command.
- **The trace line,** in `lib/stdlib/agentToolTrace.test.ts`: a failure with `timedOut` shows "timed out".
- **`safeBash`,** in `tests/agency/safeBash.agency`: a line that prints, sleeps 20 seconds, and prints again, run with `timeout: 1`, returns a failure that holds the first output, does not hold the second, and names the limit. The handler rejects any question whose `timeout` is not 1000.
- **The benchmark.** Rerun the pilot with the new tarball. Check that no `safeBash` call runs past its limit, and compare pass rate and time with `jobs/fw-agency-trim-flash-high`.
