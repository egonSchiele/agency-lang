# Review: Jobs 1, a job outlives the turn that started it

Plan: `docs/superpowers/plans/2026-11-19-jobs-1-outlive-the-turn.md`
Reviewed against the code in the `jobs-interface` worktree on 2026-11-19.

## Verdict

The design fits the code. A runner process that owns the command, a folder of
plain files, a stop file in place of signals, and a held list on the run's
context saved beside `spawnCount` all match how `spawn`, `agency attach`, and
the job table work today. The split into three PRs is sound, and the
spec deviations are explained.

Most of the plan's references check out. `processState` is at
`lib/runDirectory/lock.ts:169`. `writeText` writes through a sibling file.
`spawnCount` sits at `context.ts:150` and is adopted at `context.ts:917`. The
job table's `endingOf`, `describeBytes`, `JobStart`, and `ReadPositions` exist
as described. The context is shared by every branch, as the `spawnCount`
comment says.

Nine problems should be fixed in the plan before anyone builds it. Four of
them break the plan's own promises: a dead runner leaves the command running,
a program that starts a job cannot exit, two parallel starts pass the limit,
and old job ids collide. The rest are smaller.

## Problems to fix before building

### 1. A runner that dies leaves its command running, and nothing can stop it

`nodeSubprocess.start` puts every command in its own process group
(`lib/host/node/nodeSubprocess.ts:162` and `:169`, `detached: OWN_GROUP`).
So when the runner is killed with `SIGKILL`, the command keeps running. Under
the plan, three things go wrong:

- `jobStatus` sees the runner gone and writes `ended`. The command is still
  running.
- `requestStop` on an ended job returns at once and writes no stop file
  (Task 3's own test says so). Neither `stop`, `stopJob`, nor
  `agency jobs stop` can reach the command.
- `maxMs` was enforced by the runner, so the command now has no time limit.

Task 3's second spawn test kills the runner and then asserts `ended`. That
test passes and leaks a `sleep 30` every time it runs. The first spawn test
asserts that "no process named in the record is alive", but the record names
only the runner, so it cannot check the command.

The plan needs a decision here. One way: the runner writes the command's
process group id into the record once the command starts. `RunningProcess`
has no `pid` today (`lib/host/host.ts:319`), so the host would have to give
one. When `jobStatus` finds the runner gone and the group alive, it reports
the job as running with a note, and a stop signals the group through the
host. Review Focus 1 should then say "the command is stopped or still
stoppable", and the test should assert that the command's group is gone after
a stop.

### 2. A program that starts a job cannot exit until the job ends

Task 6 adds a process-wide watcher that polls with a timer. The host clock's
timer is a plain `setTimeout` with no `unref` (`lib/runtime/clock.ts:21`), so
an active timer keeps Node alive. The plan has `_launchJob` and
`_heldSummaries` call `watchJob`. Both run in every program, not only in the
terminal.

So after PR 3, a script that calls `startJob("npm run dev")` and returns does
not exit. It waits until the job ends or reaches `maxMinutes`, which is 60
minutes by default. This contradicts the plan's section "What changes for a
program that is not the agent", which says the script returns and leaves the
server up. The sentence "it never keeps a process alive" in Task 6 is true
only when no job is watched.

The fix is for the terminal to do the watching. `cli.ts` already owns the
line printer, so it should call `watchJob` for the jobs it learns about from
`listJobs` at each turn, and the stdlib helpers should call nothing. If the
watcher must stay in the stdlib, it needs a timer that does not hold the
process open, and the host clock has no such timer today. Add a test: a
compiled program that starts `sleep 30` and returns exits within a few
seconds.

### 3. Two parallel starts can pass the eight-job limit

Today `addJob` counts starts in progress toward the limit
(`table.starting`, `lib/runtime/jobs/jobTable.ts:98`), because the agent runs
tool calls in parallel. The plan's `_launchJob` checks the count of running
held jobs, then awaits `launchJob`, which can take up to `START_WAIT_MS`
(5 seconds). Only after that does it push the job onto `heldJobs`. Two
parallel tool calls both pass the check, and the run ends up with nine.

Keep a count of starts in progress on the context. It does not need to be
saved in the checkpoint, the same as `table.starting` today. Add a case to
Task 4's limit test that starts the ninth and tenth jobs in parallel.

### 4. Old job ids get reused, and a new job writes into an old job's folder

Ids are six hex digits, about 16.7 million values. Today an id only has to be
unique within one run's table. Under this plan, folders stay until
`agency jobs clean`. By the birthday bound, after about 5,000 jobs that were
never cleaned, the chance that some new id matches an old one is about 50
percent.

`privateDir` does not refuse an existing folder. It ignores `EEXIST`
(`lib/host/node/nodeFiles.ts:765-772`). So `launchJob` would overwrite the
old record and append to the old job's output files, and the old job's
`stop` file, if one is still there, would stop the new job at once.

`launchJob` should make the job's folder only when it is new, and pick
another id when it is not. The global constraint can keep the six digits.

### 5. A job id is used as a path without being checked

`jobDir(host, id)` joins the id onto the jobs folder. Two inputs to it come
from outside the program:

- `agency jobs stop <id>` takes the id from the command line.
- `heldJobs` comes back from a checkpoint, which a person can edit (see
  "The checkpoint is the program" in the package `CLAUDE.md`).

An id such as `../../some/folder` makes `requestStop` write a `stop` file
there, and makes `readRecord` and `jobOutputSince` read files there. Every
later call uses that folder as its root, so the host's containment check does
not help. `jobDir` should refuse any id that does not match
`job-[0-9a-f]{6}`, and `adoptHeldJobs` should drop entries that fail the same
check.

### 6. The runner can start a job its starter already reported as failed

`launchJob` waits up to 5 seconds for the runner to write its pid. After that
it rejects and writes a record that reads `ended`. A runner on a loaded
machine can start at 5.1 seconds. Task 2 says the runner reads the record and
writes it back with `runnerPid` set. It never checks the state, so it would
overwrite `ended` and run the command. The model was told the start failed,
so it starts the command again, and now two copies run.

On a timeout, the starter should write the `stop` file before it writes
`ended`. The runner should check for `stop`, and for a state other than
`running`, before it starts the command. Add a case to Task 2's tests: a
runner that finds a `stop` file before it starts runs nothing.

### 7. `jobStatus` can overwrite a real ending with "the process is gone"

`jobStatus` reads a record that says `running`, then calls `processState`.
Suppose the runner writes its real ending and exits between those two steps.
`jobStatus` sees `gone` and writes back `ended`, `exitCode: null`, with the
"stopped by a restart" note. The real exit code is lost. A job that exited
with code 0 reads as if it died in a reboot.

Before writing, `jobStatus` should read the record again, and write only if
it still says `running`.

### 8. `std::jobs` and `std::safeBash` would import each other

`start` in `std::jobs` calls `startShellJob` in `std::safeBash`. And
`startShellJob` returns `ShellStart`, which names `JobHandle`, a type the
plan exports from `stdlib/jobs.agency`. So each module imports the other.

`docs/dev/compiler/init-topsort.md` ("Import cycles between files") says a
cycle fails at load with "Cannot access ... before initialization", even when
it is made only of type imports. It also says `findImportCycle` skips `std::`
modules, so the compiler will not report the cycle. It will show up as a load
failure.

Define `JobHandle` in `std::safeBash`, which `std::jobs` already has to import
for `SafeBashEffects`, and re-export it from `std::jobs`. Or move it to a
small module that both import.

### 9. The checkpoint schema is missing from the file list

`spawnCount` is also declared in `checkpointSchema`
(`lib/runtime/state/schemas.ts:122`). That schema is a plain `z.object`, so
zod drops any key it does not list. A checkpoint parsed through it, as
`pausedCheckpointSchema` does, would lose `heldJobs` without an error. Task 4
should list `schemas.ts` with the other two files. The `jobs-resume` test
would catch this, but only after the time spent looking for it.

## Questions for the owner

### A job started inside a `run()` subprocess

`spawn` refuses inside a `run()` subprocess (`stdlib/agency.agency:551`).
`startJob` does not. Today such a job stops when the child's run ends,
because the child's job table closes. After PR 3 it keeps running for up to
60 minutes, and nobody holds it. The child's context is gone, and the parent
never got a handle. Only `agency jobs` can find it.

This happens in `learn` and `runFunction` calls, and in any tool that runs in
a child process. The options are to refuse `startJob` in a `run()` child, as
`spawn` does, or to stop a child's held jobs when the child ends. The plan
should pick one, and its section on callers other than the agent should
mention it.

### The changelog entry

Task 7 Step 5 adds a changelog entry. The standing rule is that `CHANGELOG.md`
is edited only when the owner asks, and it is normally written at release
time. If the owner asked for this entry when accepting the breaking change,
keep the step. If not, put the text in PR 3's description instead.

## Smaller problems

- **The runner's file is not where `moduleDir` points under vitest.** Task 3
  finds `runnerMain.js` through `host.system.moduleDir(import.meta.url)`.
  Under vitest that is `lib/runtime/jobs/`, which holds only `runnerMain.ts`.
  `spawn` avoids this with `agencyCliPath()`, which falls back to the
  package's `dist/` (`lib/agencyCliPath.ts:15-18`). Use the same lookup, and
  say in Task 3 that its spawn test needs `pnpm run build` first.
- **An empty `cwd` runs in the wrong folder.** `resolveSpawnCwd` returns `""`
  for an empty `cwd` (`lib/stdlib/shell.ts:77`). Today the host then runs the
  command in its own working folder, which a host built with
  `nodeHost({ cwd })` sets (`subprocessIn`, `lib/host/node/nodeHost.ts:303`).
  The runner builds a plain `nodeHost()` and knows nothing of that folder.
  `_launchJob` should write `host.system.cwd()` into the record when `cwd` is
  empty, so the record's `cwd` is always absolute.
- **The pid-reuse check is available.** Task 3 makes this conditional on
  whether `agency attach` has a callable check. It does: `liveStartTime(pid)`
  at `lib/cli/attach.ts:110` returns the process's start time. It calls `ps`
  through `execFileSync` directly, so it would have to move behind the host
  to be used here. Decide now whether to move it and add `runnerStartedAt` to
  the record, or to accept the hole. Do not leave the decision to the
  implementer.
- **A spec deviation is missing from the list.** The spec says that after a
  rewind, the session's handle list is the checkpoint's. `adoptHeldJobs`
  keeps the union. The union is the better choice, for the reason Task 4
  gives, but it should be point 8 under "Where this plan differs from the
  spec".
- **Task 8 contradicts Task 2.** Task 8's list of topics for the dev doc
  includes "the heartbeat rule". Task 2 says there is no heartbeat.
- **Listing a job can write to it.** Task 5's test says a list changes no
  record or file. If `agency jobs` applies the dead-runner rule through
  `jobStatus`, the list writes `ended` back. Either the listing applies the
  rule without writing, or the test excludes that case. Say which.
- **PR 1's fork test reads the wrong list.** Task 4's fourth case checks
  `listJobs()` after the fork. Until Task 7, `listJobs()` reads the old
  table, so the new jobs are not in it. Call `status` on both handles
  instead. `status` fails for a handle the run does not hold, so two
  successes show both are held.
- **The resume test's last check is vague.** "The job's folder shows it ran
  the whole time" should name the check. For example: `runnerPid` is the
  same before and after the resume, and `endedAt` is later than the resume.
- **Existing tests break, and they are not in Task 7.**
  `tests/agency/jobs.agency` expects "This run has no jobs" (line 186), which
  Task 7 changes to "This session has no jobs." Several of its nodes start
  `sleep 30`, and any node that fails before its `stopJob` call relies on the
  run's end to stop the job. After PR 3 the job outlives the test case, and
  its runner writes into the temporary `AGENCY_HOME` that the test runner
  deletes when the case ends. Add this file to Task 7. Make every node stop
  its jobs, and give each job a short `maxMinutes`. Also check
  `tests/agency/safeBashSavedOutput.agency` and
  `lib/agents/agency-agent/tests/jobsSlash.agency`.
- **Some `HostSubprocess` implementations are missing from Task 1.** The
  fakes in `lib/runtime/jobs/jobTable.test.ts:239` and `:275`,
  `lib/stdlib/spawn.test.ts:59`, and `lib/stdlib/__tests__/fakeSubprocess.ts`
  implement the type. They need the two new functions, or the functions must
  be optional on the type.
- **The held list never shrinks.** `MAX_FINISHED_JOBS` is deleted, so a long
  session's `heldJobs` grows with every job, in every checkpoint and in every
  `listJobs()` reply. That is probably fine for now. The dev doc should say
  so.
- **Output stays on disk.** Today a job's output lives in memory and goes
  away with the run. Under this plan it stays in `~/.agency/jobs/` until
  `agency jobs clean`, including anything secret that a command printed. The
  rewritten `docs/dev/stdlib/jobs.md` should say this.
- **Some commands go against the repo's rules.**
  - Task 7 runs `pnpm tsc --noEmit`. Use `pnpm run typecheck`.
  - Task 8 runs `make && pnpm test:run`, the whole vitest suite. Run the
    tests for the changed files and let CI run the rest.
  - No task runs `pnpm run fmt:ts`. Run it on the TypeScript files each PR
    changes, by name. CI fails without it.
  - Local `agency test` runs should pass `--check-capabilities`, as CI does.

## Answers to "Not checked while writing this plan"

1. **Whether a test's children share the program's context.** Each test case
   runs one program in one child process. Every test in this plan starts and
   reads its jobs in that same program, so they share the run's context. The
   question would matter only for a job started in one case and read in
   another, and no test does that.
2. **How tests set `AGENCY_HOME`.** Both runners already do it. Agency tests
   get a temporary folder per case (`lib/cli/util.ts:391-399`), and so do
   agency-js tests (`lib/cli/test.ts:1363-1366`). Both delete the folder when
   the case ends. That is why a test must stop its jobs before it returns.
   Vitest tests do not get one, so they set it themselves: through
   `memoryHost` settings, or through `process.env` for the spawn test.
3. **Whether the test sandbox lets a detached process outlive it.** The
   runtime has no operating-system sandbox. There is no `sandbox-exec` or
   `bwrap` anywhere in `lib/`. The only sandbox is Claude Code's own, which
   the global constraints already turn off, and CI has none.
