# Review: start a program in its own process (plan)

Plan: `docs/superpowers/plans/2026-11-15-start-a-program-in-its-own-process.md`
Spec: `docs/superpowers/specs/2026-11-15-start-a-program-in-its-own-process.md`
Date: 2026-11-15

I checked the plan's claims against the code in this worktree (`adit/own-process`, at afeba234f). Most of the background section is accurate. Four problems should be fixed before the build starts, and about a dozen smaller ones can be fixed during it. The last section lists the claims I checked and found correct, so they do not need checking again.

## Fix before the build

### 1. The first PR ships the automatic rejection the owner ruled out

The plan splits the work so that after the first PR, "a question the spawned program cannot settle is rejected, as `agency run` does today." The owner settled the opposite: a started process must never approve or reject on its own. If the first PR merges and the second is delayed or changed in review, `main` has a `spawn` that rejects questions automatically.

There is a second cost. Case 6 of task 6 is written for the rejecting behaviour, and task 13 rewrites it. The test is written twice.

Recommendation: reverse the order of the two PRs.

- **First PR: held questions and `agency attach`** (tasks 8 to 12). None of these tasks needs `spawn`. A person can test them with `agency run --wait-for-response` under `tmux`, and the spawn tests in task 13 can start the program with that flag directly. The record field `outputFile` is optional, so attach works without it.
- **Second PR: `spawn`** (tasks 1 to 7), with `_spawn` passing `--wait-for-response` from its first commit.

Neither PR then contradicts a settled decision. If the owner prefers the current order, the plan should say that the first PR stays open until the second is approved, and that the two merge together.

### 2. A spawned program inherits its parent's trace id and config overrides

`withRootCarriers` (`lib/cli/childEnv.ts`) clears the policy, budget, resume and entry-node variables. It does not clear `AGENCY_TRACE_ID` or `AGENCY_CONFIG_OVERRIDES` (`lib/config/config.ts:1058`, `:1065`). `runChildOverrides` in `lib/cli/commands.ts` keeps inherited overrides on purpose, for the eval harness.

`_spawn` runs the command with the calling program's environment. So when the caller runs under `--capture-workdir`, under an eval harness, or with a trace id set:

- The spawned program reads the same `AGENCY_TRACE_ID` (`lib/runtime/node.ts:419`), so two runs share one trace id.
- The spawned program inherits the caller's `log.logFile` override, so its events are written into the caller's statelog file, possibly after the caller has finished.
- Task 10 names the held checkpoint file after the trace id, so a caller and the program it started could write to the same file under `~/.agency/held/`.

The spec says the new process "shares no globals, threads, or job table with the caller" and reads its own `agency.json`. Task 5 should build the child's environment from the host's variables with `AGENCY_TRACE_ID`, `AGENCY_CONFIG_OVERRIDES`, and the `AGENCY_IPC*` variables removed, and `lib/stdlib/spawn.test.ts` should check that they are absent. `RunOptions.env` (`lib/host/host.ts:281`) replaces the whole environment, so `_spawn` has to build the full list anyway to set `AGENCY_SPAWN_DEPTH`.

### 3. The seed conversation is left on disk, and nothing tells the approver

Choice 3 keeps `messages.json` under `~/.agency/spawned/<id>/` and never deletes it. The `std::spawn` payload shows `messageCount` and the output path. It does not show this file. A conversation can hold anything the user typed or a tool read. The owner's rule is that Agency never writes a file the user does not know about.

There is a related bug in task 3. The plan says "a command-line run calls `runNode` once," so the seed is read once. `runNode` is the public entry that every exported node wrapper calls (`lib/runtime/node.ts:581`), and the comment on `registerAttach` says it is "called by `runNode` for every node run." A TypeScript helper that starts an Agency node in the same process would seed that node's thread a second time.

One change fixes both problems. `readSeedMessages` reads the file, deletes it, and remembers on `process` that the seed was used. The seed is then applied once per process, and the file lives only from the start until the program's first node. If the owner would rather keep the file, put its path in the payload and in `ProcessInfo`, as the output path is.

### 4. A `fork` resets the start count

Choice 4 keeps the count in an Agency global. `docs/dev/runtime/globalstore.md:155-177` says each `fork`, `parallel` and `race` branch gets a clone of the globals, and a branch's writes are thrown away when the branches join unless `shared: true` is given. The plan says "each branch can start 500." The problem is larger than that. A loop that runs a one-branch `fork` around each `spawn` never raises the parent's count, so it can start processes without limit.

```agency
while (true) {
  fork([1]) as x {
    spawn("./scripts", "report.agency") with approve
  }
}
```

Spec decision 3 says "One run may call `spawn` successfully at most 500 times." The plan does not meet that. Keep the count beside the run's spend instead. `docs/dev/runtime/cost-is-state.md` describes a figure that is saved in every checkpoint, restored on every restore, and covers the whole run across forks. The start count needs the same three properties. If the owner accepts a count per branch, the spec's sentence should change to match the code.

## Fix during the build

### 5. `_checkPolicy` is already a stdlib helper with a different job

Task 5 writes `try _checkPolicy(policy)?` and says "`_checkPolicy` stands for a TypeScript helper that throws `validatePolicy`'s error." `lib/stdlib/policy.ts` already exports `_checkPolicy(policy, interrupt)`, which matches an interrupt against a policy. An implementer who imports it by that name gets the wrong function. Use `_validatePolicy`, which the same file exports (line 16) and which returns `{ success, error }`:

```agency
const valid = _validatePolicy(policy)
if (!valid.success) {
  return failure("Invalid policy: ${valid.error}")
}
```

### 6. The host already has a private-folder function

Task 5 moves the body of `ensureSessionsDir` into a new `lib/runtime/privateDir.ts`. `host.files.privateDir` already does this job (`lib/host/host.ts:146-152`): it makes a folder with mode `0700`, or checks that an existing one is a real folder owned by the user with no access for anyone else. `_spawn` and `saveHeldCheckpoint` both have a host. Use it, drop the new file, and leave `registry.ts` alone. This may also keep `lib/stdlib/spawn.ts` out of `FS_IMPORTERS`.

### 7. Decide in task 4 whether `resume` takes `--detach`

Task 4 puts `--detach` and `--output-file` on `run` only. Task 13 then moves them to `addRunAndRecordingOptions`, because the resume test needs them. `addRunAndRecordingOptions` is used by both `run` (`scripts/agency.ts:652`) and `resume` (`:687`). Put the flags there in task 4 and write the resume path once.

### 8. Put `--` before the program's arguments

`docs/dev/cli/cli-arguments.md`, rule 1: everything after the filename belongs to the program, and `agency` prints a warning unless a `--` follows the filename. `_spawn` builds the command line, so it should always write `<dir>/<filename>:<node> -- <args...>`. Update the expected command in the task 5 unit test.

### 9. Refuse a symlink at the output path

Task 4 opens the output file with `fs.openSync(path, "a", 0o600)`. When `spawn` is given its own `output` path, a symlink there is followed. The repo rule is to refuse symlinks. Open with `O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW`. The mode `0600` only applies when the file is created, so the dev doc should say that an existing file keeps its mode.

### 10. Two test cases need more detail

- **Case 1 of task 6** checks that `~/.agency/spawned/` holds no folder after a rejected start. Other cases in the same file spawn programs into the same throwaway `AGENCY_HOME`, so the result depends on the order the cases run in. Have the handler record `intr.data.output`, reject, and then check that the folder holding that path does not exist.
- **Waiting on a marker file from Agency.** The plan says every test waits on a file and never sleeps. It does not say how an Agency test waits. Agency has no wait-for-file function, and a loop with no pause spins the CPU. Name the mechanism before the build, for example a small TypeScript helper in `tests/agency/spawn/` that checks for the file on an interval until a deadline. The alternative is to move the cases that wait into `lib/cli/detach.spawn.test.ts`, where vitest can do it.
- **Case 8** (`readsThread.agency`) offers two designs and leaves the choice to the implementer. Pick one now. Check `docs/misc/TESTING.md` for whether the Agency test runner mocks `llm()`.

### 11. A held question that nobody can answer

A program waits forever when all of these are true: the checkpoint setting is off, and the socket cannot open. The socket cannot open on Windows, when the sessions folder is refused, or when `AGENCY_NO_ATTACH=1` is in the environment (`lib/runtime/platform.node.ts:120`). A spawned program inherits that variable from its caller. The owner ruled that the process must not answer by itself, so waiting is correct. The line task 9 writes to standard error should change in this case. It should say that nothing can answer the question, and that `kill <pid>` stops the program.

### 12. Task 8 is missing a file

`run()` in `lib/cli/commands.ts` takes `runPolicy?: { policyJson: string; interactive: boolean }`, and `RootCarriers.policy` has the same shape. Both need the new `waitForResponse` field. Add `lib/cli/commands.ts` to task 8's file list.

### 13. "Always approve" on `std::spawn`

`buildDecider` remembers an "approve always" answer for the effect for the rest of the run (`lib/runtime/interruptResolution.ts`, `remembered[interrupt.effect]`). For `std::spawn`, that answer approves every later start under any policy and any budget. A saved "always approve when" rule has the same reach, since the effect declares no `@always` tag (`docs/dev/language/effect-always-tag.md`). `std::run` declares none either. This is a question for the owner, and the review does not treat it as a hole. Should `std::spawn` declare `@always(dir, filename)`, so that "always approve when" pins the file being started? The plan should record the answer in `docs/dev/runtime/spawn.md` either way.

### 14. Smaller points

- **Several dangling calls in the seed.** `dropHandoffToolCall` (`lib/runtime/handoff.ts:91`) removes one call by its index and checks its name and id. Calling it in a loop shifts the indexes after the first removal. Work out the calls to keep in one pass, and replace or remove the message once.
- **The output cap's reach.** `capOutput` wraps `process.stdout.write` and `process.stderr.write`. A child process that inherits the program's standard output writes to the file directly, past the cap. Check whether `std::shell` children inherit it. If they do, say so in `spawn.md`.
- **The background section's line numbers.** `runSettings` is at `scripts/agency.ts:358`, not 357. The other line numbers I checked are right.

## Claims I checked and found correct

- `run()` in `lib/cli/commands.ts` has ten positional parameters, and its compiled output is written beside the source file, not to a folder that is deleted on exit. So a detached program keeps its compiled files after the command exits.
- `process.title` changes what `ps -o command=` prints on macOS, including a title longer than the original arguments. I ran it. The test in task 4 can rely on it.
- `checkedRecord` (`lib/cli/attach.ts:150`) checks a pid by its start time and not by its command line, so a new process title does not break `agency debug --attach`.
- Every interrupt in a batch carries the same checkpoint (`docs/dev/runtime/concurrent-interrupts.md:105`), so task 10 can write the first one's.
- `validateResumeBatch` exists (`lib/runtime/interrupts.ts:741`) and returns null or a reason.
- `resolveCliInterrupts` reports an unhandled interrupt and exits when no policy variable is set (`hasRunPolicyMechanism`). Task 8 is right to have `--wait-for-response` alone install an empty policy.
- The prompts read only `effect`, `message` and `data` from an interrupt (`lib/runtime/interruptPrompts.ts`), so a `HeldQuestion` can be passed to them.
- `if ... then ... else`, `try f()?`, `??`, and `name?: type` parameters are all valid Agency. Each appears in `stdlib/agency.agency` or `stdlib/date.agency`.
- `MessageThread.fromJSON` accepts a bare array, and `unansweredToolCalls` looks only at the last assistant message, as the spec wants.
- Every existing test file named in "How to test" exists.
