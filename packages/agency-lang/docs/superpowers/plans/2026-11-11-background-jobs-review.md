# Review: background jobs plan

Plan: `docs/superpowers/plans/2026-11-11-background-jobs.md`
Spec: `docs/superpowers/specs/2026-11-11-background-jobs.md`

# Round 2

The plan and spec were revised after round 1. I read both again in full and checked the new claims against the code on `main` at 73cdecc0c.

Every round 1 finding is addressed. One of them, finding 11, was my mistake, and the change it asked for should come out again (finding B below). The revision brings in one new issue (finding A), which needs a change to Task 4 and one test in Task 5.

## Round 1 findings, and where each one landed

| # | Finding | Where the plan handles it |
| --- | --- | --- |
| 1 | Cancel cause | Task 4, "A cancelled wait keeps the reason it was cancelled", and the test `guardEndsTheWaitNotTheJob` in Task 5 |
| 2 | A rejected `wait()` | Task 2, "A process that fails after it started still ends its job", with a `memoryHost` test |
| 3 | Timing tests | Tasks 1 and 2 use the `go` marker file |
| 4 | `unread` and `/jobs stop` | Task 2 says only `readJob` clears `unread`. `_stopJob` reads after it stops. `/jobs stop` prints nothing and leaves a pending note |
| 5 | Question text from the plan's kind | Task 5, `asJob`, plus a check in `foregroundForInstantCommands` |
| 6 | Too-many-jobs message | Task 2 builds the message. Task 5 adds `runBash`'s prefix |
| 7 | `cleanup()` callers | Task 3 lists them all and says to grep |
| 8 | Names | `addJob`, `endJob`, `endAllJobs` |
| 9 | Docstring names a tool | Task 5 says not to |
| 10 | Capabilities | Task 4 tags `stopJob` |
| 11 | Jobs message in `coderTurn` | Task 8 adds it. This was wrong; see finding B |
| 12 | Small corrections | Task 1 and Task 2 |

## A. A guard trip during a `jobOutput` wait must raise `std::guard` (should fix)

A time guard that trips between statements raises a `std::guard` interrupt. A handler can approve it with more time or reject it (`docs/site/guide/guards.md`, "When a guard trips"). A trip that lands while a cancellable wait is in progress takes a different path: the guard's timer aborts the wait, the wait throws, and no handler is asked.

With the round 1 fix, `jobOutput`'s wait throws `leafCancel(...)` when the signal aborts, so it takes that second path. The coder will call `jobOutput(id, wait: 600)` inside its 15-minute budget. When the budget runs out during the wait:

- **The coder's reply loses its draft.** The `@guard` decorator never learns of the trip, so it returns the guard's plain failure. A saved draft comes back without its note, and with nothing saved there is no `draft`.
- **A program's handler is not asked.** A handler that would approve more time on `std::guard` never runs. The guard still stops the work, so this fails safe. It is still a handler that does not run, and `CLAUDE.md` asks for that to be flagged.

This holds whatever the state of ADI-137, which is about `sleep()`. A fix for `sleep()` changes `sleepImpl` and does not reach a new wait in `lib/stdlib/jobs.ts`. `jobOutput` needs its own handling.

**Fix.** Use the approach of the ADI-137 fix in PR #1260, applied to the job wait. When the wait is cut short by a guard trip that the runner will raise, `_jobOutput` does not throw. It returns the report as it stands, with the output so far. The next statement boundary then raises the trip as `std::guard`, and every handler sees it. The check is the one PR #1260 used in `sleepImpl`:

```ts
const raisableTrip =
  readCause(signal.reason)?.kind === "guardTrip" && run.stack.firstRaisableTrip() !== null;
```

`firstRaisableTrip()` is on `StateStack` today (`lib/runtime/prompt.ts:539` calls it). Every other cancel, including Escape, a race loser, and a root budget, still throws `leafCancel(...)`, as round 1 asked.

Unlike `sleep()`, `jobOutput` needs no loop. A cut-short wait has a correct answer to return: the job's state and output at that moment. A `wait` is a "return at the latest by" bound and not a promise to wait the full time.

**Test.** Change `guardEndsTheWaitNotTheJob`. As written, it expects "the guard's own failure, the way a guard trip during `sleep()` does", which is the behaviour this finding removes. Write it so the handler sees the trip:

- The handler has a `std::guard` arm that records that it was called and returns `reject()`, the way `tests/agency/async/time-guard.agency` does.
- The test asserts that the handler was called, that the guarded block is a failure, and that `listJobs()` still shows the job as `"running"`.

A second case approves the trip with more time, `approve({ maxTime: ... })`, and checks that the block then finishes. This is the case that fails today and passes with the fix.

I also checked one part of the test that does hold up. The `try` inside `jobOutput` does not swallow the trip. `__tryCall` turns a guard trip into a failure only for a guard it owns (`ownedGuardIds` in `lib/runtime/result.ts`), and it passes any other trip on.

## B. Remove the jobs message from `coderTurn` (my round 1 finding 11 was wrong)

Task 8 now calls `addJobsNote()` inside `coderTurn`, "so a coder started with `--agent code` would otherwise carry the job tools and never be told what is running". That case cannot happen:

- `coderTurn` is reached only through `coordinatorRunTurn` with the target `"code"` or `"agencyCode"` (`coordinator.agency:371-373`). A target comes only from the `--agent` flag.
- In a one-shot run, the coder carries no job tools.
- In an interactive session, only the seeded first turn uses the target (`startInteractive` calls `runSeedTurn(seedTarget, seedPrompt)`, `lib/agents/agency-agent/lib/repl.agency:495-498`). Every later turn calls `runTurn("", ...)` (`repl.agency:434`), which goes to `mainAgent`. The first turn runs before any job exists, so the message `coderTurn` would add is always empty.

Remove that bullet from Task 8, and its sentence about `--agent code`. The routed coder and the coder called as a tool both run on the main thread and get the message from `mainAgent`, which is what the plan already says.

## C. The spec is behind the plan in a few places (minor)

The plan is the document the implementer follows, but reviewers read the spec. These spots disagree:

- "Where the code goes" says `stopAll` in `cleanup()`. The plan calls it `endAllJobs`.
- The spec's "How to test" still describes the read test with a sleep ("a second read after the sleep returns only the second line") and says the stop takes "within three seconds". The plan uses the marker file and four seconds.
- The spec's example result for `startJob` leaves out the "Do not call jobOutput right away" sentence that decision 7 and Task 5 both include.

Either update these, or add one line at the top of the spec saying the plan wins where they differ.

## D. Wording (minor)

Task 8, `toolWiring` tests: "With one-shot on, neither includes any of them." There are three lists, so it should say "none of the three lists includes them".

## New claims I checked, which hold

- The REPL reports `idle` at the top of each loop (`lib/stdlib/cli.ts:1473`) and `working` once a line is read (`cli.ts:1543`). A `turnRunning` flag set and cleared at those two points is accurate.
- `activeStopSpinner` cannot say whether a turn is running. Nested prompts stop the spinner through `__agencyStopSpinner` (`cli.ts:1311-1339`), so Task 7 is right to use its own flag.
- Slash commands run inside `_runTurn` (`repl.agency:289` onward), which runs during a turn. So the finish line for a `/jobs stop` is printed with `turnRunning` true, as a plain write with no prompt to redraw.
- `addNote` is in `lib/agents/agency-agent/lib/pendingNotes.agency:9`, and `!command` uses it (`slashCommands/shell.agency:54`).
- `memoryHost` passes `start` through to the fake subprocess a test supplies, so the rejected-`wait()` test in Task 2 can be built as described.

---

# Round 1

I checked the plan's claims against the code on `main` at 73cdecc0c. Most of them hold. Two findings need a change before building: the cancel thrown from a wait, and a job whose process fails after it starts. The rest are smaller.

The plan builds the spec's default answer to each of its four open questions. If the owner answers any of them differently, Tasks 5 and 8 change.

## Must fix

### 1. A cancelled wait must keep the reason it was cancelled

Task 4 says: "If that signal is aborted when the wait returns, throw `AgencyCancelledError`, the way a cancelled `sleep` does."

A cancelled `sleep` does something else. `abortableSleep` (`lib/stdlib/abortable.ts:271-287`) rejects with `leafCancel("sleep cancelled", signal)`, and `leafCancel` copies the signal's cause into the error. The cause says why the run stopped:

- `userInterrupt` for Escape. The REPL reads it and keeps the session.
- `guardTrip` for the coder's time budget. `__tryCall` turns it into a failure, and the guard's `delivered` flag stops the trip from being reported twice (`lib/runtime/errors.ts:111-120`).

A new `AgencyCancelledError` with no cause gets the default cause `userKill` (`lib/runtime/errors.ts:235-247`), which is the cause for a run stopped from outside. This breaks both cases the plan relies on:

- The user presses Escape during `jobOutput("job-1", wait: 600)`. The error says `userKill` instead of `userInterrupt`, so the REPL treats the turn as killed instead of interrupted.
- The coder's 15-minute budget runs out during the same wait. The guard sees a cancel that is not its own trip, and the run stops where the guard should have handled the trip.

Fix: reject with `leafCancel("job wait cancelled", signal)`, using the composed signal from `run.ctx.getAbortSignal(run.stack)`. `leafCancel` is private to `lib/stdlib/abortable.ts:12`. Either export it, or put the cancellable part of the wait in `abortable.ts` beside `abortableSleep`. Add one test with a guard. Run `jobOutput(id, wait: 30)` on a `sleep 30` job inside a 200 ms time guard. The call should end as the guard's failure, and the job should still be running.

### 2. A job whose process fails after `start` returns stays "running" forever

Task 2 says "A start that fails rejects and adds nothing to the table." That covers only an error thrown while the child is being spawned. In the Node host, most spawn failures arrive later, as the child's `error` event, which rejects the `ended` promise (`lib/host/node/nodeSubprocess.ts`, `child.on("error", ...)` inside `startChild`). By then `start` has already returned a handle, and `nodeSubprocess.start` swallows the rejection until someone calls `wait()`.

If the table only handles a resolved `wait()`, a rejected one leaves the job in state `"running"` for good. It then:

- counts toward the eight-job limit for the rest of the session,
- appears in every turn's jobs message,
- makes `jobOutput` with `wait` block for the full wait every time.

Fix: when `wait()` rejects, the table records the job as ended with `exitCode: null`, puts the error's message in `note`, marks it `unread`, and calls the end listeners. Add a test. `memoryHost` passes `start` through to a fake subprocess the test supplies (`lib/host/memoryHost.ts:479-483`), so a fake whose `wait()` rejects is a few lines.

## Should fix

### 3. The timing tests will flake on CI

Task 1 reads output "after 500 ms". Task 2 reads "after 300 ms" and expects `"A\n"`. On a loaded CI runner, bash may not have printed anything yet. The unit-test shards already have timeout flakes, so this would add more.

Fix: let the test decide when the script continues, instead of the clock. For example:

```
printf 'A\n'; while [ ! -f go ]; do sleep 0.05; done; printf 'B\n'
```

The test polls `output()` until it contains `A`, with a deadline of a few seconds. It checks that `B` has not been printed, creates `go`, and then waits for the end. The tests that measure "resolves in under 2 seconds" can keep their bounds, because those bounds are wide.

### 4. Say who clears `unread`, and what `/jobs stop` tells the model

The plan defines `unread` as "no read has returned its final state yet". Two cases are left open.

- **`stopJob` from the model.** It returns the final report, so it should clear `unread`. Say so in Task 2 and add it to the test list.
- **`/jobs stop` from the user.** The user's stop prints the report to the terminal, and the model never sees it. If this clears `unread`, the model's next jobs message no longer lists the job, and the model may still think the job is running. Recommendation: a stop from `/jobs` leaves `unread` set, so the next turn's message lists the job as `stopped`.

Also, a `/jobs stop` prints its result and the REPL prints the finish line from Task 7, so the user sees the same job end twice. Pick one: either `/jobs stop` prints only a failure for an unknown id, or the finish line skips jobs the user stopped.

### 5. Choose the question text and limit from the plan's kind, not from the caller

Task 5 calls `approvedPlan(command, dir, maxMinutes * 60000, true)` for every `startJob`, and then runs non-bash plans in the foreground with a 120-second limit.

Today this gives the right prompt, but only because of how the planner works now. The "background" text changes only `std::bash` and `std::exec`, and today only plans of kind `bash` raise those two. An `agency` line has no effects of its own (`agencyCommandPlan`, `stdlib/safeBash.agency:2944-2962`), and reads, writes, greps, and chains raise other effects. If a later plan kind raises `std::exec` and runs in process, the prompt would say "in the background" for a command that runs in the foreground, and its `timeout` field would show hours for a command that runs under a different limit.

Fix: inside `approvedPlan`, compute `const asJob = background && exec is { kind: "bash" }`. Pass `asJob` to `raiseAll`, and pass the 120-second limit when `asJob` is false. This is one line, and the prompt then always describes what will run. `foregroundForInstantCommands` already covers the foreground path. Add an assertion there that no question text ends in "in the background?".

### 6. `JobLimitReached` cannot be matched from Agency

Task 5 says "On a `JobLimitReached` failure, return a failure that says eight jobs are running and lists their ids and commands." A `try` around a TypeScript call turns the thrown error into a failure that carries only the message (`docs/dev/language/result-failures.md`). Agency code cannot check the error's class, so `startJob` has no clean way to tell this failure from a spawn error.

Fix: have the table throw the finished message, with the list of running jobs, and let `startJob` return the failure unchanged. The same applies to the missing-folder case. `runBash` adds "`<command>` was not run: " in front of `_bash`'s message (`stdlib/safeBash.agency`, inside `runBash`). If `startJob` should give "the same failure `safeBash` gives" (review item 6), it needs that same prefix.

### 7. List every `cleanup()` caller in the dev doc

Task 3 says `cleanup()` has three callers. `lib/runtime/interrupts.ts` has two (lines 903 and 1053: a resumed run, and a resumed served invocation). The debugger also calls `ctx.cleanup()` six times in `lib/debugger/overlays.ts`, on the contexts it creates for its overlays. None of these change the design, because each cleans up a context whose run is over. The dev doc in Task 9 will state what stops a job, so its list should be complete.

## Minor

### 8. Three things named `startJob`, and two named `stopJob`

The table in `jobTable.ts` exports `startJob` and `stopJob`. `lib/stdlib/jobs.ts` exports `_startJob` and `_stopJob`, and the Agency modules export `startJob` and `stopJob`. A reader following a stack trace cannot tell which one they are in. Name the table's functions for what they do to the table, for example `addJob` and `endJob`.

### 9. The `startJob` docstring names another tool

Item 7 of "How to write a good docstring" in `docs/dev/stdlib/adding-a-module-to-the-agency-stdlib.md` says not to mention other functions in a docstring, because the agent may not have them. Task 5's docstring says output is read with `jobOutput`. The result text already says this, and the result arrives only when the job started. Leave `jobOutput` out of the docstring and keep it in the result.

### 10. Decide on `@capabilities` for `jobOutput` and `stopJob`

The capability check cannot see into TypeScript helpers (`docs/dev/language/capabilities.md`, the paragraphs around lines 183 and 254). Task 5 tags `startJob`, but Task 4 says nothing about `jobOutput` and `stopJob`. `stopJob` sends signals to processes. A program without `subprocess` can never start a job, so the risk is small, but the plan should state the choice so the implementer does not guess. My suggestion is `@capabilities(subprocess)` on `stopJob` and no tag on `jobOutput`.

### 11. The coder started from `coderTurn` does not see the jobs message

`coderTurn` (`lib/agents/agency-agent/brains/coordinator/coordinator.agency:335-347`) opens its own thread. A coder reached that way carries the job tools but does not get the jobs message, because that message is on the main thread. The routed coder and the coder the main agent calls as a tool both run on the main thread, so they do get it. Either accept this and say so in the dev doc, or call `addJobsNote()` inside `coderTurn`'s thread too.

A related check for the by-hand list: the message is claimed by the first `llm()` call after it is added (`docs/dev/runtime/expiring-messages.md`, lines 103-109). For the routed coder, confirm that the first `llm()` call is the coder's tool loop and not a side call that would take the message with it. Asking a routed coder "how is job-1 going?" with no id in the message would show this.

### 12. Small corrections

- Task 1 says "If the browser host implements `start`". It does not. `lib/host/browserHost.ts` refuses subprocesses, so remove that bullet.
- The plan's claim about character positions holds, and the dev doc can say why. `startChild` calls `setEncoding("utf8")` on both streams, so a multi-byte character split across two chunks is joined before it reaches the collector. A read position counted in characters never lands inside a character.

## Checked and correct

These claims in the plan match the code:

- Escape calls `replCtx.cancel(...)` with a `userInterrupt` cause (`lib/stdlib/cli.ts:1558`). That aborts the context's controller. A job with its own `AbortController` is untouched.
- A time guard puts its controller into `stack.abortSignal` (`lib/runtime/guard.ts`, around line 155), so `getAbortSignal(run.stack)` fires on a budget trip. Cost guards do not, which is fine, because waiting costs nothing.
- `cleanup()` aborts the context's controller and clears its fields (`lib/runtime/state/context.ts:833-846`). It does not reach a job's controller, so the explicit `stopAllJobs` in Task 3 is needed.
- `_runLineRepl` uses `run.ctx` as `replCtx` (`lib/stdlib/cli.ts:1431`), which is the execution context that will hold the table.
- The routed coder runs on the main thread after `addGlobalInstructions()` (`coordinator.agency:290-297`), so `addJobsNote()` on the next line reaches it. `codeAgent` is a `handoff def`, so the coder the main agent calls as a tool also continues the main thread.
- `runCoder` builds both the coder and the Agency coder (`subagents/code.agency:142-155`), so the Task 8 change gives both the job tools. The `toolWiring` test should check both.
- The repeated-call guard compares results as well as arguments (`docs/dev/agents/tool-loop-guards.md:130-137`). `runningFor` changes on every `jobOutput` call, so polling a job does not trip it.
- `std::bash` pins `@always(command, cwd)` (`stdlib/shell.agency:53`), as the spec says.
- `resolveSpawnCwd` is private in `lib/stdlib/shell.ts:72`, so Task 4's export is needed.
- Every plan of kind `bash` raises at least one effect, as `runBash`'s comment says, so the `_startJob` call behind `approvedPlan` cannot run without an approval. The test `rejectedStartsNothing` plus the one-time check that it fails is enough to guard this.
