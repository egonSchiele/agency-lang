# Architecture review: `agency agent` back to one run

Reviews `docs/superpowers/plans/2026-11-24-agent-plain-repl.md`, against
the goal it states: less code and fewer moving parts, with nothing else
changed for the person.

I checked the plan's claims against the code again for this review. That
found two mistakes and two behaviors the plan missed. They are first.

A second review, which checked the revised plan against the code, is at
the end of this file ("Second review"). It corrects two points in this
first review: the cut of the per-line policy call, and the claim that
`saveSeedTurn` goes away with `saveNow`.

## Mistakes in the plan (fixed in the plan)

1. **`checkPolicy` takes the policy first.** The plan wrote
   `checkPolicy(intr, currentPolicy())`. It is
   `checkPolicy(policy, interrupt)` (`stdlib/policy.agency` line 308),
   and it returns approve, reject or propagate.
2. **Nothing has to stop a cancelled turn's jobs.** The plan left this
   open. `docs/dev/stdlib/jobs.md` ("What stops a job and what does
   not") says why the driver stops them: each of its legs is a new run,
   so a cancelled turn goes back to a checkpoint taken before its jobs
   started, and nothing would hold them. In one run the turn is not
   rolled back, so the run still holds the jobs, and `/jobs` lists them.
   The task is deleted, not built.

## Behaviors the plan missed (added to the plan)

3. **A cancelled turn stays in the conversation.** Today Esc drops the
   turn whole: the session run goes back to its last pause, and the next
   message carries a note, "The user cancelled their previous request …
   partway through" (`cancelNote` in `lib/stdlib/agentDriver/run.ts`),
   because the agent no longer remembers it. In one run there is no
   pause to go back to. The conversation keeps what the turn did before
   Esc, as it did before PR #1516, and the note is not needed. This is a
   fourth thing that changes for the person, and the plan listed three.
4. **Herdr is told about a save by the driver**
   (`onSaved: reportHerdrSession` in `agentTerminalDriver.ts` line 92).
   The one-run save has to call `reportHerdrSession(id)` itself, or
   Herdr stops seeing the session's id.

## Major features and public API

The plan touches three things outside the agent.

- **`repl` in `std::ui/cli` loses its `tokens` argument, and
  `setReplJobsSource` is removed.** Both are in the published standard
  library and its generated docs (`docs/site/stdlib/ui/cli.md` line 70).
  They were added on 19 November for a REPL whose turns run in another
  run, and went out in 0.45.0. After this plan nothing in the repo uses
  them. Removing them breaks any program that passes `tokens`.
  **Recommendation:** remove them, and say so in the changelog. They are
  five days old and exist for the design being removed. Keeping them
  would keep `cliTokens.ts` (101 lines) for no caller. This is the
  owner's call, since it is a public API.
- **The `./agent-session` export in `package.json`** is public too. Its
  only users were front-ends of the session program. Perry does not
  import it. Removing it is right.
- **Saved sessions.** Covered by decisions 3 and 6 in the plan.

Nothing in `lib/runtime/` changes, which is correct: the `policy` option
on a node's start is used by Perry's driver.

## Effort and impact, by task

| Task | Effort | Impact | Verdict |
| --- | --- | --- | --- |
| Perry copies two driver files | Small | Must do | Keep |
| 1a. Save and resume tests first | Small | Must do; everything rests on it | Keep |
| 1b. The sitting policy | Small to medium | Needed for PR #1549 on a resume | Keep, simplified (below) |
| 2. Setup in the agent's run | Medium | Must do | Keep |
| 3. `sessionFacts` | Small | Keeps today's command code nearly as it is | Keep, trimmed (below) |
| 4. Commands call functions | Medium | Must do | Keep, without `saveNow` (below) |
| 5. The turn, edit diffs | Medium | Must do | Keep |
| 6. The session's own policy | Small | Must do | Keep |
| 7. Resume and the refusal | Small | Must do | Keep the refusal, cut the picker change (below) |
| 8. `-p`, `/jobs` | Small | Must do | Keep |
| 9. End-to-end tests | Medium | Must do | Keep |
| 10. Delete and docs | Medium | The point of the plan | Keep |

No task is high effort for low impact. Three have parts that should go.

### Cut: the dimmed rows in the session picker (Task 7)

The plan lists sessions saved by the session program as "(can't be
continued)" in the picker. Those sessions exist only for the days
between 19 November and this release, on the machines of people who ran
the agent then. The refusal line is enough. Cut the picker change.

### Cut: `saveNow` (Task 4)

The plan adds a helper that saves after each command that changes the
session. It is not needed. The hook from Task 1 runs `recordTurn` after
every submitted line, a command included, and saves when `recordTurn`
returns a target. `recordTurn` (`lib/record.agency` line 181) already
returns one after `/rename` and `/fork`, through its `_renamed` mark.

What this leaves: a `/model`, `/effort` or `/preset` change is saved
with the next turn, where today it is saved at once. Quitting straight
after `/model` and resuming gives the model from before. The last
settings file still remembers the choice for new sessions. I think that
is acceptable, and it is how it worked before PR #1516. If it is not,
`changeModel`, `changeEffort` and `changePreset` can set the same mark
that `/rename` sets, which is three lines and still no new helper.

### Simplify: one place applies the sitting policy (Task 1b)

The plan calls `applySittingPolicy()` on the line after the checkpoint
"and at the start of each submitted line as a second guard". Two call
sites for one rule is how they drift apart. The line after the
checkpoint is the first line that runs after a restore, and Task 1b's
test proves it. Keep that one and drop the guard.

It is worth being clear about why this mechanism is needed at all, since
it is the one new idea in the plan. Before PR #1516 a resume ignored
`--policy` and kept the policy that was in the checkpoint
(`agent-sessions.md` at `4fd6baf54~1`, line 132). That also meant a
resumed session never saw a rule saved to `policy.json` by another
session since. PR #1549 made a resumed session run under its own policy
file with today's flags on top. Keeping that in one run needs the policy
to be set again after the restore. About 30 lines and one test, for a
feature that shipped two days ago. The alternative is to go back to
"flags on a resume are ignored", which loses part of #1549. I would keep
the mechanism.

### Trim: `sessionFacts` holds only what the terminal reads (Task 3)

The plan copies every field of the core's pause. Some exist only for
other front-ends: `presetChanges` ("The terminal does not draw this
field yet", `session-core.md`), `thread`, `cwd`. Each field costs a call
on every read, and `presetChanges` compares two snapshots. Build
`SessionFacts` from the fields `repl.agency`, `header.agency` and
`capabilitiesUi.agency` actually read, found by grep when the task
starts.

## The 80/20 question

Is there a way to get most of the saving for much less work?

- **Leave it as it is.** No work, no saving. The owner chose against it.
- **Keep the session program, drop only the driver, and answer the pause
  with a handler in the same run.** This would delete the 2,300 lines of
  TypeScript and keep `core.agency`. It does not work cleanly: `repl()`
  owns the loop that reads a line, and the core's loop owns the pause, so
  one of the two loops has to go anyway. And the core is reached by
  `goto` from a node, which a `handle` block around a call can't wrap.
- **The plan.** It deletes both.

So the plan is the small version already. The parts that make it more
than a deletion are the eight pull requests built on the core since, and
the plan handles those by moving code, not rewriting it.

## Reusing code

- **`saveNow` and `saveSeedTurn` were the same thing.** With `saveNow`
  cut, this goes away.
- **The two hooks go in a new file, `agentReplSession.ts`, not back in
  `agentSessions.ts`.** Right: `agentSessions.ts` is the file format,
  which Perry shares, and the hooks are the terminal's own.
- **`SessionFacts` replaces `PauseData`**, which is deleted with
  `agentDriver/interface.ts`. No second type is left.
- **`sessionChanges.agency` repeats what Perry's `core.agency` does for
  each answer.** That is deliberate, and correct after the untying: a
  shared function would tie Perry's commands to the terminal's again.

## Concepts

One concept is added (the sitting policy) and these are removed: the
shell run and the session run, the pause, an answer, a leg, the phases,
the approval queue, the holder, a carried turn. That is the goal met.

## What stays tied, and should be said

After this plan a few functions in agency-lang have Perry as their only
user: `moveRecord` in `record.agency` (the `folder` answer), the
saved-run functions in `agentSessions.ts`, `agentProcess.ts`, and
`startTargets.agency` if the terminal stops reading it. Nothing in
agency-lang calls them, so a later tidy-up could delete one without a
test failing here. The check in Task 10 step 3 catches it once. To catch
it later too, extend `tests/agency-js/agent-modules-import`, which
already imports one agent module the way Perry does, to import the
functions that only Perry uses. That is a small addition to Task 10 and
I recommend it.

## Documentation, CI time, visibility

- **Docs:** two dev docs are deleted and one is rewritten. That is in
  proportion.
- **CI time:** four agency-js tests go and three come, so CI gets
  shorter.
- **Visibility:** the only changes outside the agent are the two
  standard library removals above.

## What I would change in the plan

Done in the plan already: items 1 to 4 at the top, the picker change
cut, `saveNow` cut, the second policy guard cut, `sessionFacts` trimmed,
and the import test added to Task 10.

For the owner to decide:

- **A.** Removing `tokens` from `repl` and `setReplJobsSource` from the
  standard library (recommended: remove).
- **B.** A `/model`, `/effort` or `/preset` change is saved with the
  next turn, not at once (recommended: accept).
- **C.** A cancelled turn stays in the conversation as far as it got,
  and the "cancelled their previous request" note goes (no real choice
  in one run, but it should be known).

---

# Second review: the revised plan, checked against the code

I read the revised plan against main at `95e7a58a7`, the one-run code at
`4fd6baf54~1`, and Perry at `025dd0a`. Most of the plan holds up. The
Perry imports match the plan: none of the 30 modules Perry imports pulls
in the driver, the terminal files or the session program, and the only
`agentDriver` imports in Perry are in `src/agent/driver.ts`,
`driver/savedRun.ts`, `driver/heldJobs.ts` and `driver/savedRun.test.ts`,
as the Perry pull request says. `cliPolicyHandler` does what Task 1b
needs: a second call only sets the module's globals and returns the same
`_handler` (`stdlib/policy.agency` line 1628). `pass()` exists and is the
"no opinion" verdict, so the edit-diff handler in Task 5 is valid.

Three findings would make the agent lose data or run under the wrong
policy. They come first.

## 1. The sitting policy has no "line after the checkpoint" to run on (Task 1b)

Task 1b says `applySittingPolicy()` is called on "the line after the
checkpoint is taken, which is the first line that runs after a restore".
For almost every save, that line does not exist.

An ordinary save is taken in TypeScript. `_sessionOnSubmit`
(`agentSessions.ts` at `4fd6baf54~1`, line 515) calls the turn, then
`recordTurn`, then `checkpointFor(run)`, all inside the TypeScript
`repl()` loop. No Agency statement follows the checkpoint. On a restore
the runtime skips every step that had finished and re-runs the step that
was in progress, which is the statement that calls `repl()`. The old doc
says so: "On replay, `main`'s completed steps are skipped, the replayed
`handle` block in `runSession` installs the policy handler again, and the
REPL starts fresh" (`agent-sessions.md` at `4fd6baf54~1`, line 90).

Only one save has an Agency line after its checkpoint: `saveSeedTurn`
calls Agency `checkpoint()`, and its comment says "on resume execution
continues at the line after `checkpoint()` and then starts the REPL"
(`resume.agency` at `4fd6baf54~1`, line 146).

So a resume has two entry points. If `applySittingPolicy()` is placed
after a `checkpoint()` line, a session saved after any typed line resumes
under the policy of the sitting that saved it. That is the failure Task
1b exists to prevent: a `--reject` given today would be ignored, and a
rule the person removed from `policy.json` would still approve.

**Fix.** Apply the sitting policy at the top of `_sessionOnSubmit`,
before it calls the turn. Install `applySittingPolicy` as a third hook
next to `onSubmit` and `afterTurn`, and keep the take-once behavior of
`_takeSittingPolicy`. Both entry points reach `_sessionOnSubmit` before
any turn runs, and nothing between the restore and the first submitted
line raises an interrupt. This is one call site.

The first review cut "the start of each submitted line" as a second
guard. That cut was wrong: the per-line call is the only one that covers
both entry points. Task 1b's test should resume from both kinds of save:
one saved after a typed line, and one saved after a seed turn.

## 2. `/rename` and `/fork` throw away their own save (Task 4)

The table in Task 4 has `/rename` call `renameSession(title)` and then
`recordTurn("")`, and `/fork` do the same. The paragraph under the table
says the hook's `recordTurn` saves after `/rename` and `/fork` "through
its `_renamed` mark". Both cannot be true.

`recordTurn` (`lib/record.agency` line 181) clears `_renamed` and returns
the save target. When the command calls it, the command gets the target
and drops it. The hook's call after the line then finds no turn and no
mark, and returns null, so nothing is saved. A `/rename` is lost if the
person quits before the next message. A `/fork` is worse: the record
under the new id is never written, but Task 6 has already copied the
policy file to that id.

The core calls `recordTurn("")` after a rename today
(`core.agency` lines 291 and 328) because the driver saves at every pause
whatever `recordTurn` returns. That reason goes with the driver.

**Fix.** The commands do not call `recordTurn`. The hook's call does both
jobs the core's call did: it copies the conversation's thread id onto the
record, and it returns the target that gets saved. Add a case to Task 9:
`/rename`, quit, then `--resume` shows the new title.

## 3. The seed turn is never saved (Task 5)

Task 5 has `runSeedTurn` call the turn directly. A seed turn is the
prompt given with `-i`, and it runs before `repl()` reads a line, so it
does not go through `_sessionOnSubmit` and nothing saves it. At
`4fd6baf54~1`, `runSeedTurn` ended with `saveSeedTurn(msg)`
(`repl.agency` line 435, defined in `resume.agency` line 150) for this
reason.

Without it, `agency agent -i "fix the failing test"` followed by quitting
at the prompt leaves no session. If the person types one more line, the
hook's `recordTurn` sees one finished turn mark for two turns and counts
one.

The first review said "`saveNow` and `saveSeedTurn` were the same thing.
With `saveNow` cut, this goes away." `saveNow` went. `saveSeedTurn` is
still needed. **Fix:** bring `saveSeedTurn` back in Task 5, and name it in
Task 1b as the second restore entry point.

## 4. No test resumes the real agent (Tasks 1 and 9)

Task 9 says "`agent-session-resume` from Task 1 is the resume test". That
test drives a small agent through a JavaScript loop (`fakeRepl` in
`loop.js`). It proves the hooks save and restore. It does not run
`agency agent --resume`, so it does not show that the real agent's
`handle` block installs the policy handler again after the restore, that
the sitting policy is applied, or that the transcript is printed. The
policy handler is the part a resume must never skip.

**Fix.** Add a resume case to `tests/agency-js/agent-repl`: the first
sitting sends a message and quits; the second starts with `--resume` and
`--reject` for an effect the next turn's tool call raises; the call must
be rejected, and the saved messages must be printed first. Also, the two
restored test folders import the hooks from `agentSessions.js`. Point
them at `agentReplSession.js`. The small agent in `agent-session-resume`
installs no `cliPolicyHandler` today, so Task 1b's test case needs one
added.

## 5. Smaller points

- **Task 5, step 2.** "Before the turn, so a cancel takes the entry away
  with the turn" comes from the two-run design. The transcript lives in
  the run's globals (`agentTranscript.ts` line 75). In one run a cancel
  rolls nothing back, so the person's line stays in the transcript with
  no reply after it. Change the reason, and add to item 4 of "What
  changes for the person" that a reopened session shows a cancelled
  message with no reply.
- **Task 6** misses one importer. `lib/slashCommands/policy.agency`
  line 15 imports `usesSavedPolicy` from `terminal.agency`. Add it to the
  task's files.
- **Task 2 and Task 6** should say, in one list, the order of `main` for
  an interactive run: the setup, choosing the session, `_setSittingPolicy`
  and the restore, then the `handle` block with `checkCliBundles` and the
  REPL inside it. Every step that finished before the saved point is
  skipped on a resume, so where a step sits decides whether it runs. As
  written, Task 2 lists `checkCliBundles` among the steps after
  `setUpSession`, and Task 6 puts the `handle` block around the REPL,
  without saying they are the same place.
- **Size.** The `agentDriver` files the plan deletes are 1,296 lines of
  source and about 1,450 of tests, not "about 1,100". The plan's total is
  closer to 4,600 lines deleted than 3,300. This changes nothing in the
  plan, but the pull request descriptions should use the real numbers.

## Verdict

Fix 1, 2 and 3 in the plan before starting. Each is a few lines of plan
text and a few lines of code. Finding 1 decides where a security check
runs, so its test must cover both entry points. With those fixed, I would
build the plan as written.
