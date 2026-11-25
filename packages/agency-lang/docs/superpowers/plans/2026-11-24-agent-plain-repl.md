# `agency agent` back to one run with a plain REPL

**Goal:** `agency agent` runs as one program again. The REPL calls a turn
directly, and the session program, the session driver and the second run
are deleted. The reason is less code and fewer moving parts. Nothing the
person sees should change, except the three things listed under "What
changes for the person".

**Size:** about 3,300 lines of source deleted and about 500 added, across
two agency-lang pull requests and one small Perry pull request.

## Background

### How the terminal agent works today

Since 19 November (PR #1516) one `agency agent` process holds two runs:

- **The shell run** is `lib/agents/agency-agent/agent.agency`. It parses
  the flags, picks the session, installs the policy handler and runs
  `repl()`. `lib/repl.agency` turns each line into an "answer", and
  `lib/terminal.agency` is its side of the session.
- **The session run** is `program.agency`, which sets the session up and
  goes to the node `session` in `core.agency`. That node waits at one
  interrupt, `agent::sessionInput`, and takes one answer at a time: a
  message, a model change, a rename and so on.
- **The driver** joins them. It is TypeScript: `lib/stdlib/agentDriver/`
  (ten files), `lib/stdlib/agentTerminalSession.ts` and
  `lib/stdlib/agentTerminalDriver.ts`. It starts and resumes the session
  run, queues its approvals, asks the shell run to draw each one, and
  saves the session at every pause.

A slash command today reads the session's last pause and sends an answer.
For example `/model openai/gpt-5` in `lib/repl.agency` reads `_pause()`,
calls `_send({ kind: "model", spec })`, reads `_pause()` again and prints
what changed.

### Why it was built, and why it is no longer needed

The two runs existed so that Perry and the terminal could resume each
other's sessions: both ran the same session program through the same
driver. On 24 November that was given up. Perry now has its own session
program (`src/agency/core.agency`, `program.agency`, `turn.agency`) and
its own driver (`src/agent/driver/`). The terminal is the only user left
of agency-lang's session program and driver.

### How it worked before

The commit before PR #1516 (`4fd6baf54~1`) has the one-run agent, with
save, resume and `/fork`:

- `agent.agency` did the setup, then called `runSession(true) { startInteractive(...) }`.
- `lib/runSession.agency` installed `cliPolicyHandler` in one `handle`
  block around the REPL.
- `lib/repl.agency` called `runTurn` directly for a message, and each
  slash command called the session's functions directly.
- After each turn `recordTurn` updated the record, and a TypeScript hook
  (`_sessionOnSubmit` in `lib/stdlib/agentSessions.ts`) took a
  checkpoint of the run and saved it.
- A resume read that checkpoint and called `restore` in `main`, after the
  process-level setup.

That commit is the model for this plan. It is not a revert target: eight
pull requests since then changed the same code, and each has to be kept
(see "What was built since, and where it goes").

### What Perry imports from agency-lang

Perry must keep compiling against the release this ships in. It imports:

- **About 30 of the agent's Agency modules**, by path
  (`pkg::agency-lang/dist/lib/agents/agency-agent/lib/...`): `turn`,
  `record`, `notice`, `cliTools`, `session`, `presets`, `lastSettings`,
  `grounding`, `answer`, `sessionFolder`, `shared`, `utils`,
  `traceSettings`, `toolLimits`, `startTargets`, `settings`,
  `sessionSearch`, `sessions`, `search`, `rewrittenMessage`,
  `projectContext`, `pendingNotes`, `models`, `modelRequest`, `jobsNote`,
  `compaction`, `commandPalette`, `capabilityChange`, `budget`,
  `attachments`.
- **From `stdlib-lib`:** `agentSessions.js` (the saved file's format,
  including `readSavedRun`, `isSavedRun`, `canResume`, `checkpointIn`),
  `agentTranscript.js`, `agentLastSettings.js`, `agentProcess.js`,
  `agentDriver/jobs.js`, `agentDriver/jobControl.js`, and
  `agentDriver/index.js` in one test.

**The rule this plan follows:** no function Perry imports from the 30
modules or from `agentSessions.js`, `agentTranscript.js`,
`agentLastSettings.js` or `agentProcess.js` is removed, renamed or
changed in what it does. The three `agentDriver` imports are the
exception: Perry takes its own copies first (the Perry pull request
below).

## Decisions

The first five were agreed on 24 November. The last three came out of
writing this plan and need a yes.

1. **Only the two-run split and the driver go.** The agent's modules stay
   as they are.
2. **A session is saved as a checkpoint of the one run**, as before PR
   #1516. A conversation format is a later design.
3. **Sessions the terminal saved since 19 November end once.** They were
   saved by the session program, and a one-run agent can't resume them.
   `--resume` on one prints a line that says so and exits.
4. **CHANGED 24 November: `agentDriver/jobs.ts` and `jobControl.ts` stay
   in agency-lang.** The plan was for Perry to copy them. It can't: they
   read the runtime's own record of a job (`heldJobSchema` and
   `mergeHeldJobs` in `lib/runtime/jobs/heldJobs.ts`, `heldJobStatus` and
   `requestStop` in `lib/runtime/jobs/detachedJobs.ts`), and the package
   exports those nowhere. So pull request 2 keeps these two files and
   their tests, moved out of the deleted folder to
   `lib/stdlib/agentJobs.ts` and `lib/stdlib/agentJobControl.ts`. Perry's
   three imports change path in the Perry pull request that takes the
   new release. Keep the old paths working until then: leave the two
   files where they are in pull request 2, and move them only once Perry
   is on the new paths. The simplest way is not to move them at all, and
   to accept a folder `agentDriver/` that holds two job files and no
   driver. That is the owner's call.
5. **One agency-lang release** carries this with #1565, #1566 and the
   last-settings setter.
6. **A session is still saved while it waits on an approval.** A spike on
   24 November showed it works in one run (Task 1c). The policy handler
   passes on what no rule decides, so the turn stops and hands its
   interrupt, with a checkpoint, to the REPL's hook. The hook saves that
   checkpoint, and the turn is picked up from it with the handler now
   asking the person. A session whose process stops while a turn is
   running, with no approval on screen, still resumes from the end of the
   last finished turn.
7. **The saved-run functions move to Perry.** After this change nothing
   in agency-lang calls `SavedRun`, `SavedTurn`, `isSavedRun`,
   `readSavedRun` or `canResume` (about 80 lines of
   `lib/stdlib/agentSessions.ts`). The Perry pull request copies them,
   and pull request 2 deletes them here. `checkpointIn` stays, because
   `_searchSessions` uses it to read a file in either format, and so does
   `_recordRunFormat`, which the refusal in Task 7 uses.
8. **NEW: commands call functions; there is no `Answer` type in the
   terminal.** The core's arms for each answer become one exported
   function each (see Task 4). A command calls its function. This is the
   same amount of work as keeping a dispatcher, and it leaves less
   behind.

**Agreed by the owner on 24 November, after the review:**

- The two job files stay where they are, in `lib/stdlib/agentDriver/`,
  so Perry's imports keep working. The folder then holds two job files,
  the session policy code until Task 6 moves it, and no driver.
- `repl`'s `tokens` argument and `setReplJobsSource` are removed from the
  standard library, and the changelog says so.
- A `/model`, `/effort` or `/preset` change is saved with the next turn.
- A turn cancelled with Esc stays in the conversation as far as it got.

## What changes for the person

1. A session saved by today's agent can't be continued (decision 3).
2. (Removed: an approval on screen is still saved. See decision 6.)
3. "This session was continued in another front-end" is never printed.
   Two terminals that resume the same session each save it, and the last
   save wins, as before PR #1516.
4. A turn cancelled with Esc stays in the conversation as far as it got.
   Today the session goes back to before the turn, and the next message
   carries a note that the last request was cancelled. In one run there
   is nothing to go back to, and the note is not needed.
5. A `/model`, `/effort` or `/preset` change is saved with the next
   turn, where today it is saved at once. Quitting straight after
   `/model` and resuming gives the model from before.

Everything else is meant to be the same as today: the header, the
footer, every slash command's lines, `-p`, `-i`, `--incognito`, the
session's own policy file, the scratch folder, the last settings, the
transcript shown on a resume, and edit diffs.

## What is deleted, what is kept

### Deleted from agency-lang

| File | Lines | Note |
| --- | --- | --- |
| `lib/agents/agency-agent/core.agency` | 549 | Its helpers move (Task 4). |
| `lib/agents/agency-agent/program.agency` | 136 | Its setup moves (Task 2). |
| `lib/agents/agency-agent/lib/terminal.agency` | 271 | Its policy half moves (Task 6). |
| `lib/stdlib/agentTerminalSession.ts` | 515 | |
| `lib/stdlib/agentTerminalDriver.ts` | 268 | |
| `lib/stdlib/agentDriver/` except `sessionPolicy.ts`, `policy.ts`, `jobs.ts` and `jobControl.ts` | about 1,000 | `approvals`, `index`, `interface`, `machine`, `run`, `savedRun`, and their tests. The two job files stay (decision 4). |
| `lib/stdlib/agentSessionProgram.d.ts`, `lib/stdlib/agentSessionImports.test.ts` | | The program they describe is gone. |
| `lib/stdlib/cliTokens.ts`, and the `tokens` argument of `repl` in `lib/stdlib/cli.ts` | 101 | Added for the second run. The REPL reads its own run's tokens again. |
| `setReplJobsSource` in `lib/stdlib/cliJobLine.ts` | | The REPL's run holds the jobs. |
| The `./agent-session` entry in `package.json` | | Perry does not import it. |
| `tests/agency-js/agent-terminal`, `agent-terminal-repl`, `agent-terminal-oneshot`, `agent-driver` | | Replaced (Task 9). |
| `docs/dev/agents/session-core.md`, `session-driver.md` | | Folded into `agent-sessions.md` (Task 10). |

### Kept, with a new home

- `lib/stdlib/agentDriver/sessionPolicy.ts` and `policy.ts`
  (`sessionRunPolicy`) become `lib/stdlib/agentSessionPolicy.ts`. The
  session's own policy file (PR #1549) stays a feature of the terminal.
  `withPauseLeftAlone` is deleted: there is no pause to pin.
- `lib/stdlib/agentTerminalDiff.ts` (`renderEditDiff`) stays as it is.

### Not touched

The 30 modules Perry imports, `agentSessions.ts`, `agentTranscript.ts`,
`agentLastSettings.ts`, `agentProcess.ts`, the export of the agent's
compiled modules in `package.json`, and everything under `lib/runtime/`.
The `policy` option on a node's start, added in PR #1516, stays: Perry's
driver uses it.

## What was built since, and where it goes

| PR | What it added | Where it lives after this plan |
| --- | --- | --- |
| #1520 | New chats start with the last settings chosen | `startPresetAndModels` is called from the agent's own setup (Task 2). `rememberSettings` is called by the model, effort and preset functions (Task 4). |
| #1525 | A preset's changes stay in the session | `notePresetBaseline` in the setup. `presetChanges` is read by `sessionFacts` (Task 3). |
| #1533 | A `folder` answer moves a session | No terminal command sends it. Not carried over. Perry has its own. |
| #1538 | A reopened session shows what the user typed and the replies | `_addToTranscript` is called around the turn (Task 5). The transcript is read from the checkpoint on resume, as now. |
| #1544, #1545 | `std::exec` scopes, the command judge | Policy and safeBash only. Nothing to move. |
| #1549 | A session's own policy replaces the saved policy | Task 6. |
| #1550 | A scratch folder for temporary files | Set up where the core does it today: `startIncognito` before the grounding (Task 2). |

Open pull requests that change the same files (#1512 detached jobs,
#1482 and #1488 brains) will conflict. Whichever merges second merges
main in and resolves it. This plan should start from main as it is on the
day the work starts, and the table above must be checked again then:
`git log 356a17061..origin/main -- lib/agents/agency-agent lib/stdlib/agentDriver lib/stdlib/agentTerminalSession.ts lib/stdlib/agentTerminalDriver.ts`.

## The pull requests

### Perry pull request: the saved run's format (OPEN: Perry #78)

Needs no release, and merges first. Built on 24 November.

- The two job files are not copied (decision 4).
- `src/agent/driver/savedRun.test.ts` no longer imports
  `agency-lang/stdlib-lib/agentDriver/index.js`. It states what a
  restore gives for each kind of saved session.
- Copy `SavedRun`, `SavedTurn`, `isSavedRun`, `readSavedRun` and
  `canResume` from `lib/stdlib/agentSessions.ts` into
  `src/agent/driver/savedRun.ts`, and import them from there (decision
  7). `checkpointIn` and the rest of `agentSessions.js` stay imported
  from the package.
- Check: `grep -rn "agentDriver" src` finds only `jobs.js` and
  `jobControl.js`.
  `pnpm run typecheck`, `pnpm test:run`, `pnpm run engine:stage` and the
  smoke script pass.

### agency-lang pull request 1: the terminal runs in one run

After this pull request the session program and the driver are still in
the tree, but `agency agent` no longer uses them. Tasks 1 to 9.

### agency-lang pull request 2: delete what has no user, and the docs

Task 10. Mostly deletions, so it is quick to review.

## Tasks for pull request 1

Each task names the test that proves it. Run only the tests named, save
the output to a file, and run `make` once before the agency-js tests.

### Task 1: the two risky mechanisms, proved first

Two things in this plan depend on how a restore behaves. Prove both
with tests before building on them.

**a. Save and resume in one run.** Bring back
`tests/agency-js/agent-session-resume` and
`tests/agency-js/agent-session-escaped-interrupt` from `4fd6baf54~1`
(`git show 4fd6baf54~1:packages/agency-lang/tests/agency-js/agent-session-resume/agent.agency`
and the other files in both folders). They drive a small agent that
takes a turn, saves, and is restored in a second stage. Bring back the
two hooks they need, in a new file `lib/stdlib/agentReplSession.ts`, not
in `agentSessions.ts`:

    export function _installSessionHooks(onSubmit: unknown, afterTurn: unknown): void
    export async function _sessionOnSubmit(line: string): Promise<unknown>

Their bodies are the ones in `agentSessions.ts` at `4fd6baf54~1`, lines
500 to about 560: `_sessionOnSubmit` calls the Agency `onSubmit`, then
the Agency `afterTurn` (`recordTurn`), and when that returns a save
target it takes a checkpoint and writes it with `_saveSession`. The
hooks are TypeScript module state on purpose: a closure made by an
Agency statement would be a finished step in the checkpoint and would
come back from a restore as nothing.

Both tests should pass once the hooks exist, since the runtime's
`checkpoint` and `restore` did not change. If one fails, stop and find
out why before any other task: everything else assumes this works.

**b. The policy for this sitting survives a restore.** The policy
handler keeps its state in Agency globals (`_policy`,
`globalCliPolicyOpts` and others in `stdlib/policy.agency`, set by
`cliPolicyHandler` at line 1628). A restore replaces every Agency global
with the saved one. So after a resume the handler would hold the policy
of the sitting that saved the session, not the one worked out now from
the session's own file, `policy.json` and today's flags.

The fix: the policy for this sitting is worked out before the restore
and kept in TypeScript module state, which a restore leaves alone. The
first Agency code that runs after the restore applies it by calling
`cliPolicyHandler` again with the same arguments, which only sets those
globals and returns the handler already installed.

    // lib/stdlib/agentReplSession.ts
    export function _setSittingPolicy(policy: { file: string; policy: unknown } | null): void
    export function _takeSittingPolicy(): { file: string; policy: unknown } | null   // returns it once, then null

    // lib/sessionPolicy.agency (Task 6)
    export def applySittingPolicy()   // takes it, and when there is one calls cliPolicyHandler(file:, policy:, interactive: true, answersOnly: true)

`applySittingPolicy()` is called in one place: the line after the
checkpoint is taken, which is the first line that runs after a restore.

The save also calls `reportHerdrSession(record.id)` from
`agentSessions.ts`, which the driver does today (`onSaved` in
`agentTerminalDriver.ts`).

Test, added to `agent-session-resume`: stage one runs under a policy
that approves `std::read`. Stage two is started with a sitting policy
that rejects it, restores, and reads a file. The read must be rejected.
Without `applySittingPolicy` this test fails, which is how to know it
tests the right thing.

**c. A turn that waits on an approval is saved and picked up.**

The spike is in `tests/agency-js/spike-approval-save/` in this worktree
(untracked; delete it once this task's real test exists). It has a turn
that raises an approval, a handler that passes it on unless a flag says
to ask, and a TypeScript loop in the REPL's shape. What it showed:

- A turn that stops on an approval no handler answers comes back to the
  loop as its interrupts, and the first one carries a checkpoint of the
  whole run at that line.
- **In a new process:** `restore` of that checkpoint, then the loop
  submitting a line, picks the turn up at the approval. The code before
  the approval does not run again (a counter there stayed at 1), the
  handler is asked again and answers, the turn finishes, and the next
  line is a new turn.
- **In the same process:** the same `restore`, called after the loop
  returns, does the same. So one mechanism serves both: going on after
  the person answers, and a resume after the terminal was closed.
- The line the loop submits after a restore is not used. The saved turn
  runs in its place.

So the design is:

1. `cliPolicyHandler` gets a mode in which it decides what a rule
   decides and returns `propagate()` for the rest, without prompting.
   The agent's handler is in that mode unless the hook has said "ask
   now".
2. When a turn comes back as interrupts, `_sessionOnSubmit` saves the
   first interrupt's checkpoint with the session's record, marked as
   waiting on an approval. Then it sets "ask now" and restores that
   checkpoint.
3. After the restore the REPL starts again and submits once without
   reading a line, which picks the turn up. The handler, now asking,
   draws the prompt as it does today. When the turn ends, "ask now" is
   cleared.
4. A resume in a new process is step 3 alone: the record says the
   session waits on an approval, so the agent sets "ask now" before the
   restore.

**What the spike did not show, which this task must before the rest is
built on it:**

- (Shown since, by a second spike: see "The real REPL" below.)
- **Several approvals at once.** Tool calls in one round raise together.
  All of them come back in one list. Check that a restore of the first
  one's checkpoint raises all of them again, and that the handler asks
  about each in turn.
- **An approval raised inside a subagent's subprocess**, where the
  parent's handlers reach in over IPC
  (`docs/dev/runtime/subprocess-ipc.md`). Read that doc first.
- **An approval raised by a tool call in the middle of an `llm()`
  call.** The spike raised from plain code.
- **The cost.** Every approval a person is asked about now writes a
  checkpoint and restores it. Measure it on a long session's checkpoint
  before deciding it is fine.

If one of these can't be made to work, come back to the owner with the
choice. Do not build a queue or a second run to get around it.

**The real REPL.** A second spike,
`tests/agency-js/spike-approval-repl/`, runs the real `repl()` and the
real approval prompt (`cliPolicyHandler`, then `askAbout` from the
handler), typed into through a pipe as `agent-terminal-repl` does.
`node drive.js same` and `node drive.js resume`, with `ANSWER` set to
`a` and a carriage return, both pass:

- The turn stops on the approval, the hook saves the checkpoint and
  returns `false`, and `repl()` ends through its own `finally`, which
  closes readline and saves the history.
- The program restores the checkpoint. `repl()` starts again, takes the
  line as submitted without reading one, and the approval prompt is
  drawn. Answered `a`, the turn finishes with the code before the
  approval run once, and the next line is a normal turn.
- The header is printed once, and the line's "User:" banner once.
- In `resume` mode the first process exits at the approval, and a second
  process shows the prompt and finishes the turn.

It needed one change to `lib/stdlib/cli.ts`, about 15 lines, which is in
the worktree uncommitted and marked SPIKE: `_setReplResubmit(line)`
gives the next prompt a line to take as submitted, once, and that line
gets no banner. The real version should keep the line in a
`processSlot`, as `agentSessions.ts` keeps its lock host, not in a
module `let`.

One thing to tidy that the output shows: the "Thinking" spinner line is
printed once more when the REPL starts again.

### Task 2: the setup moves into the agent's own run

**Files:** create `lib/agents/agency-agent/lib/startup.agency`. Modify
`agent.agency`.

Today `program.agency`'s `main` does the session's setup from a
`ProgramStart` that `programStartFor` in `terminal.agency` builds from
the flags. Put the same steps, in the same order, in one function the
agent's `main` calls:

    export def setUpSession(args: any, brainName: string, oneShot: boolean): Result<string[]>

It does what `program.agency` lines 73 to 135 do, reading the flags
directly: `setJobToolsOn(!oneShot)`; `startPresetAndModels({ preset:
args.flags.preset ?? "", flags: startupModelFlags(args),
saveSearchChoice: true, settings })`; `setStartupLimitFlags(limitFlagsFromArgs(args))`;
`applyToolLimits(activePreset(), oneShot)`; `notePresetBaseline()`; the
`maxTokens` cap from `getCapabilities()`; `disableMemory() with approve`.
It returns the warnings, and `main` prints each in yellow, or prints the
failure in red and exits with 1.

Then the steps the node `session` does before its loop (`core.agency`
lines 392 to 408), in `agent.agency` after `setUpSession`:
`setSessionFolder(cwd())`, `startIncognito()` for `--incognito` before
the grounding, `setReplyStyle(REPL_STYLE)` (or "" for `-p`),
`checkCliBundles()` under the policy handler, and
`setGrounding(groundingText(brainName, args.flags))`.

`setDebug`, `setVerbose` and `setInteractive` are already called from the
flags in `main`. The brain and the statelog name are already set there
too, so the checks `program.agency` repeats are not copied.

**Order that must hold**, as the comments at `4fd6baf54~1` say: every
read of `settings.json`, the model resolution, memory and MCP happen
before the policy handler exists, or they prompt. On a resume all of
this still runs, and then the restore replaces the Agency state.

**Test:** `tests/agency-js/agent-effort`, `agent-search-selection`,
`agent-global-instructions` and `set-agent-name` start the agent with
flags and read what it resolved. They should pass unchanged.
`lib/agents/agency-agent/tests/lastSettings.agency` covers the last
settings.

### Task 3: the session's facts, for the header and the commands

**Files:** create `lib/agents/agency-agent/lib/sessionFacts.agency`.

The header, the footer, `/model`, `/preset`, `/settings` and `/search`
read the pause today. Move `pauseData` out of `core.agency` (line 248)
as:

    export def sessionFacts(): SessionFacts

with only the fields the terminal reads. Find them by grep when the task
starts: every field read from `_pause()` in `repl.agency`,
`header.agency`, `capabilitiesUi.agency` and `agent.agency`. `budget`,
`presetChanges`, `thread` and `cwd` are likely not among them. Each
place that calls `_pause()` calls `sessionFacts()`. The functions that word a command's
lines from a "before" and an "after" (`modelsChanged`, `pushSlots`,
`getHeader(brainName, pause)`) keep working on the same shape.

`/cost` and the footer's tokens read the run's own meter again:
`getModelCosts()` and `getCost()` from `std::thread`, as `costSlashCommand`
did at `4fd6baf54~1`. `_cost`, `_costRows` and `_footerTokens` go.

### Task 4: each command calls its function

**Files:** create `lib/agents/agency-agent/lib/sessionChanges.agency`.
Modify `lib/repl.agency`, `lib/capabilitiesUi.agency`,
`lib/slashCommands/session.agency`.

Move the core's helpers and inline arms into one module, one function
per change. A failure is a `notice(reason, "error")`, as now, which
`trace.agency` prints.

| Command | Today sends | Calls after this |
| --- | --- | --- |
| `/model <spec>` | `model` | `changeModel(spec)`: `applyModelSpec`, then `rememberSettings(activePresetName(), modelChoices())` |
| `/effort` | `effort` | `changeEffort(effort)`: `applyEffortAnswer`, then `rememberSettings` |
| `/preset <name>` | `preset` | `changePreset(name)`: `refreshPresetTable() with approve`, `applyPresetAnswer`, `rememberSettings` |
| `/preset save` | `savePreset` | `saveToPreset(name)`: the core's `savePresetNotice` |
| `/compact` | `compact` | `compactNow(keep)`: the core's `compactNotice` |
| `/rename` | `rename` | `renameSession(title)`, then `recordTurn("")`, then the line from `renameLine` |
| `/fork` | `fork` | `forkSession()`, then `recordTurn("")`, then `forkLine`, then the policy file is copied to the new id (Task 6) |
| `/search` | `search` | `switchSearchBackend(backend)` |
| `/local` | `local` | `useLocalModel(model)` |
| `/settings` | `capabilities` | `applyCapabilityChange(change)` |

`/rename` and `/fork` use the terminal's own wording
(`lib/slashCommands/session.agency`), which exists today for the lines
after the answer. The core's `renameNotice` and `forkNotice` wording is
dropped.

No command saves the session itself. The hook from Task 1 runs
`recordTurn` after every submitted line, a command included, and saves
when it returns a target. `recordTurn` (`lib/record.agency` line 181)
returns one after `/rename` and `/fork`, through its `_renamed` mark. A
model, effort or preset change is saved with the next turn.

**Tests:** `lib/agents/agency-agent/tests/presetSession.agency`,
`presetTools.agency` and `modelRequest.agency` call the session's
functions and should pass unchanged. Add cases to a new
`tests/sessionChanges.agency` for a refused model spec (a notice, and
the models unchanged) and for `changePreset` on a preset deleted since
the start.

### Task 5: a message is a turn in the same run

**Files:** modify `lib/repl.agency`.

`renderUserTurn` and `runSeedTurn` call the turn directly again. The
body is the core's `message` arm (`core.agency` lines 420 to 470) with
the terminal's drawing:

1. Refuse an unknown start target, as now.
2. `_addToTranscript("user", text)` before the turn, so a cancel takes
   the entry away with the turn.
3. `const message = withPendingNotes(text)` on its own line. A call
   inside the argument of a `try` call is run again on a resume (#1506).
4. `const reply = try runTurn(startTarget, message)`, inside the edit
   diff handler below.
5. On success `_addToTranscript("assistant", replyText)` and
   `renderReply`. On failure the red line, with `formatTurnFailure`.
6. `applyPendingLlmOptions()`, `markTurnDone()`,
   `compactIfDue(conversationThread(), ESC_HINT)`.

The turn budget is not set: no terminal command sets one, so it is
always off today.

**Edit diffs.** Today an edit a rule approves shows its diff, and an edit
the person is asked about shows it once, in the prompt. Keep that with
one handler around the turn, as the core has, which never decides:

    handle { reply = try runTurn(startTarget, message) } with (intr) {
      if (intr.effect == "std::edit" && checkPolicy(currentPolicy(), intr) is an approval) {
        print(renderEditDiff(intr.data.filename, editDiff(intr.data.before, intr.data.after)))
      }
      return pass()
    }

`checkPolicy(policy, interrupt)` is in `stdlib/policy.agency` at line
308, and returns approve, reject or propagate. An edit no rule decides
reaches the outer `cliPolicyHandler`, whose prompt draws the diff.

**Esc.** In one run Esc cancels the REPL's call, which is the turn. The
REPL resets the cancel after the line, as `repl()` already does. The
driver's care about "what needs no shell first" has nothing left to
guard.

**A cancelled turn's jobs need nothing.** The driver stops them today
because each of its legs is a new run: a cancelled turn goes back to a
checkpoint taken before its jobs started, and nothing would hold them
(`docs/dev/stdlib/jobs.md`, "What stops a job and what does not"). In
one run the turn is not rolled back, so the run still holds the jobs and
`/jobs` lists them. Update that paragraph of `jobs.md` in Task 10.

**No cancel note.** `cancelNote` goes with the driver. The conversation
keeps what a cancelled turn did, so the model needs no note about it.

**Test:** `lib/agents/agency-agent/tests/turn.agency` and
`agentTurn.agency`. The typed end-to-end test is Task 9.

### Task 6: the session's own policy

**Files:** create `lib/agents/agency-agent/lib/sessionPolicy.agency`
from the policy half of `terminal.agency`. Create
`lib/stdlib/agentSessionPolicy.ts` from `agentDriver/sessionPolicy.ts`
and `agentDriver/policy.ts`.

Moved as they are: `SessionPolicy`, `newSessionPolicy`,
`resumedSessionPolicy`, `forgetUnsavedPolicy`, `setSessionPolicyFile`,
`usesSavedPolicy`, `carriedPolicyPath`. `forgetUnsavedPolicy` reads
`currentRecord()` in place of the pause.

`interactive` in `agent.agency` keeps its shape: choose the session,
work out its policy, install `cliPolicyHandler(file:, policy:,
interactive: true, answersOnly: true)` in one `handle` block, and run
the REPL inside it. Two changes:

- On a resume, call `_setSittingPolicy({ file, policy })` before the
  restore (Task 1b).
- `/fork` copies the session's policy file to the new id with
  `copyCarriedPolicy`, and calls `setSessionPolicyFile` with the new
  path, which is what `forkedForSession` does today.

**Test:** `lib/stdlib/agentDriver/sessionPolicy.test.ts` moves with its
file. The resume case is Task 1b's test.

### Task 7: resume, and refusing a session this agent can't continue

**Files:** modify `lib/resume.agency`.

`startSession(chosen, brainName)` comes back from `4fd6baf54~1`
(`lib/resume.agency` lines 113 to 145): a new session gets a fresh
record, and a chosen one has its checkpoint read, its transcript printed
(`_readTranscript`, then `showTranscript`) and is restored.

A record whose `runFormat` is `savedRun` was saved by the session
program. `_recordRunFormat(record)` says which. Refuse it before
anything is printed:

    This session was saved by an earlier version of agency agent and can't be continued.

The picker is not changed. A record with no `runFormat` is a checkpoint,
as before.

`recordTurn` writes `runFormat: "checkpoint"`. Check that
`lib/record.agency` does not write `savedRun` anywhere: the driver's
`saveRun` did that, and it is gone.

**Test:** `lib/stdlib/agentSessions.test.ts` covers the formats. Add a
case to `agent-session-resume`: a record marked `savedRun` is refused
with the line above and exit code 1.

### Task 8: `-p`, and `/jobs`

**Files:** modify `agent.agency`, `lib/slashCommands/jobs.agency`.

- **`-p`.** `oneShot` installs the handler with `interactive: false` and
  calls the turn directly inside it, as `oneShotAgent` did at
  `4fd6baf54~1`: `setUpSession(args, brainName, true)`, the grounding,
  then `runTurn(target, prompt)`. Its output stays the reply, then
  "Session cost: $…" from `getCost()`. `evalValue` and `evalOutput`
  stay.
- **`/jobs` and `/jobs stop`.** They read `_sessionJobs` and
  `_stopSessionJob` from the driver. In one run the REPL's own run holds
  the jobs, so they call `std::jobs` directly, as at `4fd6baf54~1`
  (`git show 4fd6baf54~1:packages/agency-lang/lib/agents/agency-agent/lib/slashCommands/jobs.agency`).
  Keep today's wording, including "stopped and unread" in the note to
  the model.

**Test:** `lib/agents/agency-agent/tests/jobsSlash.agency`, with the
test file from `4fd6baf54~1` as the starting point.
`tests/agency-js/agent-terminal-oneshot` is rewritten in Task 9.

### Task 9: the end-to-end tests

The three terminal tests drive the two-run design. Replace them:

- **`tests/agency-js/agent-repl`** (from `agent-terminal-repl`): the
  REPL, typed into. Keep every case that is about what the person sees:
  a message and its reply, `/model`, `/rename`, `/fork`, `/cost`, an
  approval answered "always", Esc during a turn. Drop the cases about
  the holder and about an approval saved across a restart.
- **`tests/agency-js/agent-oneshot`** (from `agent-terminal-oneshot`):
  `-p` with a rule that approves, and with nothing deciding (declined,
  with the reason in the reply).
- **`agent-session-resume`** from Task 1 is the resume test.
- `tests/agency-js/agent-terminal` and `agent-driver` are deleted in
  pull request 2, with the driver.

Run with `--check-capabilities`, as CI does.

## Task 10 (pull request 2): delete, and write the docs

1. Delete every file in "Deleted from agency-lang" above. After each
   group, `pnpm run typecheck` and `pnpm run lint:structure`.
2. `grep -rn "agentDriver\|agentTerminal\|agent-session\|sessionInput\|ProgramStart\|PauseData" lib stdlib tests docs/dev`
   must find only Perry-facing text in the docs.
3. **Check Perry against the built package.** In a Perry worktree,
   install the package from this branch (`pnpm pack` here, then
   `pnpm add <tarball>` there), and run `pnpm run typecheck`,
   `pnpm test:run` and `pnpm run engine:stage`. This is the check that
   decision 1 held. Do not commit the tarball or the changed lockfile.
   To keep catching it later, extend
   `tests/agency-js/agent-modules-import`, which already imports one
   agent module the way Perry does, to import the functions only Perry
   uses after this change: `moveRecord` from `lib/record`, and any other
   that step 2's grep shows has no caller left in agency-lang.
4. **Docs**, mechanism and rule only:
   - `docs/dev/agents/agent-sessions.md`: how a session is saved and
     resumed in one run (the hooks, the checkpoint, the restore in
     `main`, why setup runs before it), the sitting policy, and the
     refusal of a `savedRun` session.
   - Delete `session-core.md` and `session-driver.md`. Move two things
     out of them first: "The agent's modules, from outside the package"
     goes to `agent-brains.md`, since Perry still relies on it, and the
     session's own policy goes to `agent-sessions.md`.
   - `user-commands.md`, `agent-presets.md`, `agent-brains.md`,
     `jobs.md`: remove each mention of the pause, an answer or the
     driver.
   - Update the index in `packages/agency-lang/CLAUDE.md`.

## Pull request 1 as built

What differs from the tasks above, found while building it.

- **The policy handler's two new behaviors are in `std::policy`, not in
  the agent.** `deferUndecided` leaves an interrupt no rule decides
  unanswered, and `policyAfterRestore` gives the handler a policy to take
  after a restore. A handler written in the agent would have had to
  repeat the handler's own rules (its own file reads and writes, guard
  trips, an approving rule on a raise that expects a value). Both keep
  their state in a `processSlot`, since a restore replaces the handler's
  Agency globals. This replaces Task 1b's `_setSittingPolicy`.
- **Only a submitted line defers.** `_sessionOnSubmit` turns deferring on
  for the line and off after it. At startup the handler asks at once.
- **The grounding is built before the handler exists**, as at
  `4fd6baf54~1`. Its scratch folder approves its own `mkdir`, and the
  handler would still ask about it.
- **The `-i` prompt is the REPL's first submitted line**
  (`_setReplResubmit`), not a turn run before the REPL. So it is saved,
  and its approvals are, as any line's.
- **A cancelled line comes back as an `AbortedResult`, not an error.**
  `_sessionOnSubmit` throws it on. The old test's scripted model ignored
  the cancel signal, which the driver hid by dropping the turn from
  outside. The model in `tests/agency-js/agent-repl` obeys it.
- **A new session's record says `runFormat: "checkpoint"`.** A record
  with no `runFormat` is from the agent before 19 November, and
  `savedRun` from the one after. Both are left out of the picker
  (`listSessions`) and refused by `--resume <id>`. A session whose code
  has changed since is refused the same way (`_checkpointFitsThisCode`).
- **There is no `/effort` command**, so there is no `changeEffort`.
- **`lib/terminal.agency` is deleted in this pull request**, since
  everything in it moved. `sessionPolicy.agency` imports the two files
  in `lib/stdlib/agentDriver/` that hold the session policy code. Moving
  them is pull request 2's.
- **Tests:** `agent-terminal-repl` became `agent-repl`, with three
  sittings: the commands and an approval, a sitting killed at an
  approval, and the sitting that picks it up. `agent-terminal-oneshot`
  became `agent-oneshot`. `cli-policy-handler-deferred` covers the two
  `std::policy` functions. The two tests named in Task 1a were not
  brought back: `agent-repl` covers save, resume and an approval with
  the real agent.

## After both merge

One release with #1565, #1566 and the last-settings setter. Then one
Perry pull request bumps the version and uses the setter.

## Risks

- **The restore.** Everything rests on Task 1. It worked on 19 November,
  and the runtime's checkpoint code has not changed since, but the
  agent's setup has. That is why it is first.
- **Something built since PR #1516 that I missed.** The table lists what
  the commit log shows. The typed end-to-end test (Task 9) is the net
  for the rest, so its cases should be kept, not rewritten to fit.
- **Two standard library removals.** `repl`'s `tokens` argument and
  `setReplJobsSource` are public and went out in 0.45.0. Removing them
  breaks a program that uses them. The changelog should say so.
- **Perry.** The check in Task 10 step 3 is the only thing that proves
  Perry still builds. Run it before pull request 2 is opened, not after.
