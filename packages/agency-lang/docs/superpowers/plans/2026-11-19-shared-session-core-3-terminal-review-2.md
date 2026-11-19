# Review 2: Shared Session Core, Plan 3 (the terminal on the core)

This reviews the plan as it stands in the `adit/terminal-on-core` worktree, with its uncommitted edits, on top of `4ae5c8cb0` (#1512, jobs). Parts A, B and C are merged (#1510, #1511), so this review is about **Part D and Part E**, and mostly about the new jobs text. Every claim below was read from the code at `4ae5c8cb0`.

The first review (`...-terminal-review.md`) was against `cfc225a6f`. Its ten points are all answered in this version of the plan or in the merged code: the session's policy replaces the front-end's (1), the pause pin (2), `askAbout` uses `std::policy`'s state (3), Esc at a prompt (4), `takeHold` (5), `sessionApprovals.ts` (6), `by: "rule"` (7), Perry's engine taking no flags (8), the handler alternative turned down with a reason (9), and `Shell` given to `_startSession` (10).

## Summary

The jobs edits make the right calls. `/jobs` reads the jobs from the pause without running a leg. `/jobs stop` becomes an answer, because a stop moves the run's read positions. One-shot runs offer no job tools. These claims are correct:

- A checkpoint saves the run's `heldJobs` (`checkpointStore.ts:863`).
- `watchHeldJobs` reads `held()` on every poll (`jobEndWatcher.ts`).
- `program.agency:66` calls `setInteractive(start.trace.interactive)`, and that calls `setJobToolsOn` (`trace.agency:176`).
- The core already keeps notes with `addNote` (`core.agency:340`), so a `stopJob` answer can leave its note the same way.

The plan has one gap that makes the switch a regression: **a turn that is dropped forgets the jobs it started** (see 1). There are also two smaller gaps in how the job watch gets its list (see 2 and 3).

---

## Must fix

### 1. A cancelled, failed or interrupted turn forgets its jobs

Under the driver, each leg is a new run. Its `heldJobs` start empty (`context.ts:590`). It gets them back only from the checkpoint it resumes (`adoptHeldJobs`, `context.ts:917`). Every way a turn can be dropped goes back to `phase.pause`, the checkpoint taken **before** the turn:

- Esc while the model works. `resumeRun` returns `{ kind: "cancelled" }` with nothing else (`run.ts:133`), and `cancelTurn` goes back to `phase.pause` (`machine.ts:202`).
- A leg that fails. `legFinished` goes back to `phase.pause` (`machine.ts:239`).
- Esc at an approval prompt (`approvalCancelled`). The queue's interrupts do hold the job, but they are thrown away.
- The process stops mid-turn. `savedRun` for `working` saves only `pause` (`savedRun.ts:42`), and `restoredPhase` treats it as a cancel.

So suppose the model calls `startJob("npm run dev")` and the user then presses Esc. The job keeps running, since it is a separate process, but nothing holds it any more. `/jobs` does not list it. `/jobs stop` refuses it ("There is no job … in this session"). The model's jobs message never mentions it. Nobody can stop it from inside the session, and it runs until `maxMinutes`, which defaults to 60. `docs/dev/stdlib/jobs.md` names this exact case as the one to avoid: "a list that forgot it would leave it running with nothing to stop it."

Today's REPL is one run, so its `heldJobs` survive a cancel. The switch is where this gets worse. Perry has the same gap as soon as it runs a release that has #1512, since the core now offers job tools to every session.

**Suggested fix.** Keep the held jobs in the driver, not only inside a checkpoint:

- A leg's result gives back the run's `heldJobs`, **also when the leg was aborted or failed**. This is a runtime change: today an aborted run gives back nothing. A small option on the run is enough. For example, `RunNodeResult.heldJobs`, plus an `onHeldJobs(jobs)` callback in the run options that fires when `_launchJob` adds a job, so that an abort before any pause still reports it.
- Every phase except `starting` and `ended` gets `heldJobs: HeldJob[]`. The reducer merges each leg's list into it with `mergeHeldJobs`. A cancel keeps the list. Only the conversation goes back.
- `SavedRun` gains `heldJobs?: HeldJob[]`, so a process that stops mid-turn keeps them.
- `startRun`/`resumeRun` take `heldJobs` and pass them to the run, which adopts them as it adopts a checkpoint's. `mergeHeldJobs` already has the right rule: the checkpoint's read positions win, and no job is forgotten.

This also simplifies D2. `heldJobsOf(pause)` and the "every interrupt of one pause carries the same checkpoint; confirm that first" step both go away. `_heldJobs()` and `sessionJobs` read the phase's list.

Add to D2's tests: a scripted turn starts a job, then Esc. `/jobs` still lists the job, and `/jobs stop <id>` stops it. Run the same test for a `--resume` after the process was killed mid-turn.

This is driver and runtime work, so it fits as a new task D0 in agency-lang, before D1.

---

## Should fix

### 2. The job watch's `held` is synchronous, but a callback passed through `repl()` is not

D1 has `repl()` take `heldJobs: () => HeldJob[]`, which `_runLineRepl` passes to `watchHeldJobs` as `held`. Two problems:

- **`held` is called synchronously** (`for (const job of held())` in `jobEndWatcher.ts`). `_runLineRepl` calls its other Agency callbacks (`status`, `onSubmit`) with `callBridgeFn`, which is `async` (`cli.ts:41`). If `heldJobs` arrives as an `AgencyFunction`, the watch receives a promise and iterates nothing. If it arrives as the raw TS function, it works, but only because nothing wrapped it.
- **The token passes through Agency.** The plan says "A held job's token stays in TypeScript and is never given to Agency code". But `agent.agency` holds `_heldJobs`, and if it were called through `__call`, every `HeldJob`, token included, would go through the Agency call path once a second, while `onSubmit` is mid-call on the same run.

D1 should say that `_runLineRepl` calls `heldJobs` directly, as a plain JS function, never through `callBridgeFn`. D1's test should go through `repl()` from Agency with a TS-imported function, not call `_runLineRepl` from TS, so it catches a wrapper. If an imported TS function does come through wrapped, a cleaner path is for `agentTerminalDriver.ts` to hand the list to the REPL from the TS side (for example, `_runLineRepl` takes a `jobsSource` that the driver module provides), so no Agency value is involved.

### 3. If `heldJobsOf` stays, read every interrupt, not the first

If fix 1 is not taken: `heldJobs` is the run's list at the moment each checkpoint was taken. Two parallel tool calls can pause at different times, and a job started by the first can be missing from an earlier checkpoint. So "every interrupt of one pause carries the same checkpoint" is not something to confirm. It can be false. Merge the lists of all of them with `mergeHeldJobs`. Also, "the last pause" must mean the latest interrupts the driver received, including an approval pause. `phase.pause` is the pause the turn **started** from (`machine.ts:36`), so it lags a whole turn behind.

### 4. `sessionJobs` should reuse the summary code, not copy it

`lib/stdlib/jobs.ts` already turns a held job into a summary: `heldSummary` → `statusOf` → `summaryOf` → `forAgency`. These use only `run.ctx.host`. Change them to take a `Host` and export one function, for example `_summariesOf(host, held: HeldJob[])`. Then `_heldSummaries` and the driver's `sessionJobs` both call it. That way the terminal's `/jobs` rows (`status`, `runningFor`, `unread`) are the same words the model sees from `listJobs`. The plan's own wording, "`unread` comes from the held job's `finalRead`", is a second copy of `summaryOf`'s rule `state !== "running" && !held.finalRead`. Also reuse `listedJobs`' row format from `slashCommands/jobs.agency`, rather than rewriting it in the shell.

### 5. Turn job tools off with `oneShot`, not `trace.interactive`

D3: "`_runOnce` must start with `trace.interactive: false`". But `trace` is optional, and when it is left out the run counts as interactive (`program.agency`, "Left out: … interactive"). So a one-shot start that sets `oneShot: true` and no `trace` gets job tools. That is the case the plan is trying to prevent. Perry is the obvious way in: its `programStart` (`perry/src/agent/coreInterface.ts:88`) sends no `trace`, and `perry -p` will set `oneShot` when it moves to the new interface.

`ProgramStart.oneShot` already exists (C2) and already means "its turn is the whole run". Have `program.agency` call `setJobToolsOn(!oneShot)`, so a front-end cannot get one flag right and the other wrong. `trace.interactive` then only decides what is shown. D3's test should start with `oneShot: true` and **no** `trace`, and check that `startJob` is not offered.

### 6. Say what `stopJob` reports, so the finish line is printed once

D2's test expects "the finish line is printed once". The plan also says the core "reports the outcome at the next pause". Today's slash command prints nothing on a stop that worked, because the watch's line is the report (`slashCommands/jobs.agency`, comment above `stoppedNote`). It prints its own message only for a job that had already ended. Spell this out for the answer:

- stopped: no notice, and a note is kept for the model;
- already ended: an info notice, `"<id> had already ended (<status>)."`, and no note;
- not held: an error notice.

Otherwise the obvious way to build it, a notice for every outcome, prints two lines for one stop.

---

## Smaller points

- **The holder has three fields.** D2 says holder `{ frontEnd: "terminal", pid }`. The merged `SessionHolder` is `{ frontEnd, pid, processId }` (`agentSessions.ts:55`), and `stillHeld` compares `processId`. Write `{ frontEnd: "terminal", pid, processId: thisProcessId() }`. E1 needs the same for Perry.
- **C3's interface describes a function that was not built.** The plan has `askAbout(intr: any): any`. The merged one is `askAbout(intr, policy, file)` (`stdlib/policy.agency:1436`), and it uses the policy it is passed (`useRunPolicy`). D2 already uses the three-argument form. Change C3's text to match, since D2 refers back to it. Also check the "Decisions" line that says "`std::policy`'s own state stays the one copy". It holds only because D2 always passes `currentPolicy()` back in.
- **`saveRun` already refuses another holder's session** (`savedRun.ts`, "Fails, and writes nothing, when the record names another holder"). D2 checks `stillHeld` before each leg too, which is right, since a leg is work. Say that the save check is the backstop, so nobody removes one of the two checks thinking they are duplicates.
- **A job that ended while no terminal was open** gets no finish line after `--resume`. The watch skips anything with `endedAt` before it began. That is fine, because the model's jobs message lists it as unread. Say so in D2, so it is not "fixed" later.
- **Perry and jobs.** Since #1512, a Perry session's model can start jobs. Perry shows no finish line and no list, and cannot stop one. Out of scope here, but E1 or a ticket should note it, together with fix 1.
- **The plan's header** still says "Written against … `cfc225a6f`". Part D is now written against `4ae5c8cb0`. Update that line.

## Effort and impact

| Part | Effort | Impact | Note |
| --- | --- | --- | --- |
| D0 (new): the driver holds the jobs | M | High | Fix 1. A runtime option and the driver's phase. Without it, the switch loses jobs on Esc. |
| D1 footer and job watch | S | Medium | See 2. |
| D2 terminal driver loop | L | High | The core of the switch. 3, 4 and 6 make it smaller and clearer. |
| D3 one-shot | S | Medium | See 5. |
| D4 delete the old loop | S | High | As planned. |
| E1 lazy list and hold | M | High | Add `processId` to the holder. |
| E2 by hand, docs | S | Medium | Add "start a job, Esc, `/jobs`" to the hand check. |

Nothing here should be cut. The jobs text adds the right amount of work: two functions and one answer, plus the fix above.

## Existing code to reuse (checked)

| Need in plan | Existing | Use it? |
| --- | --- | --- |
| Merging job lists across legs and pauses | `mergeHeldJobs` (`lib/runtime/jobs/heldJobs.ts`) | Yes (fixes 1 and 3). |
| A run taking in held jobs | `adoptHeldJobs` (`context.ts:917`) | Yes. Expose it as a run option. |
| A job summary from a held job | `heldSummary` / `summaryOf` / `forAgency` (`lib/stdlib/jobs.ts:241-264`) | Yes. Make them take a `Host` (fix 4). |
| The `/jobs` row format | `listedJobs` (`slashCommands/jobs.agency`) | Yes. |
| The stop note's text | `stoppedNote` (`slashCommands/jobs.agency`) | Move it into the core with the answer. |
| Reading a job's state by token | `heldJobStatus` (`detachedJobs.ts:178`) | Yes, through the shared summary code. |
| The process id in a holder | `thisProcessId()` (`agentDriver/savedRun.ts:36`) | Yes. |
