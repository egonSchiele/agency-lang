# The session driver

The TypeScript a front-end uses to run the agent's session program:
start the run, answer its pause, answer its approvals, save it, and load
it again. It lives in `lib/stdlib/agentDriver/`. A front-end imports it
as `agency-lang/stdlib-lib/agentDriver/index.js`.

Every front-end shares this one copy. Two copies would have to agree
exactly on the file format and on what a crash in the middle of a turn
means.

The program it drives is described in `session-core.md`. Read that first.

## What the driver does, and what it leaves to the front-end

The driver decides what the run does next. It does not draw anything.
Each step it takes reports a list of `Happened` events, and each
front-end shows them its own way.

The driver keeps no state either. The front-end holds the phase and
passes it in:

```ts
let phase = initialPhase;
const started = await startRun({ agent, callbacks, policy });
let step = reduceDriver(phase, { type: "legFinished", result: started.result, settle });
// step.phase is the new phase. step.happened is what to show.
```

## The phases

`reduceDriver(phase, action)` is the one place that decides what happens
next. It is pure.

| Phase            | Meaning                                                                    |
| ---------------- | -------------------------------------------------------------------------- |
| `starting`       | `main` is running up to the first pause.                                   |
| `waitingForUser` | The run is paused on `agent::sessionInput`. It takes a message.            |
| `working`        | A leg is running. `leg` says which interrupts it answers, and how.         |
| `approving`      | The run is paused on approvals. `queue` holds them and the answers so far. |
| `answering`      | A settings answer (a model, an effort) is on its way into the run.         |
| `ended`          | The run could not start, or it cannot be continued. `reason` says why.     |

`toStep` reads a pause as `waitingForUser` only when `agent::sessionInput`
is the one interrupt in it. If it comes with others, `toStep` fails, since
one answer cannot serve them all.

An action that does not fit the phase changes nothing and reports
nothing. A second Enter while a turn runs is harmless.

Every turn keeps `pause`, the pause it started from. A cancel or a
failure goes back to it. Answering the same pause again continues the run
from there, with the conversation as it was before the turn.

- **A cancel** (an abort, or `approvalCancelled` at a prompt) drops the
  turn and reports `turnCancelled`. Its text goes into `cancelledTexts`.
  The next message starts with a note that names it, because the agent
  forgets the request but its changes to files stay
  (`withCancelNote`).
- **A turn that finishes** reports `turnFinished`: a leg came back and
  the run waits for a message again. A front-end saves and closes any
  tool calls that never got an end.
- **A failed leg** goes back to the pause and reports `legFailed`. Like
  a cancel, its text goes into `failedTexts`, since it may have changed
  files before it failed. The next message's note names it as failed.
  A turn that finishes clears both lists.
- **A settings answer is not a turn.** When the run pauses again,
  `answered` reports what the pause said before and after, and not
  `turnFinished`. The front-end
  shows what changed. When the core refused the change, the two are the
  same, and the core has already sent a notice that says why.
- **A session that moved to another folder** reports
  `{ type: "moved", from, to }` after `answered`, when `record.cwd`
  changed across the answer (a `folder` answer). The pause's `cwd` is not
  it: a coder moves that within a turn. The front-end has two jobs: move
  the session's saved files to the folder for `to`, and resume the run on
  a host for `to`, since the core does not move the host's folder and `.`
  in a policy rule follows the host. See the `folder` answer in
  `session-core.md`.

## Background jobs

A job the model starts is a process outside the run (`docs/dev/stdlib/jobs.md`).
The run holds it on its context, and every checkpoint saves the list. But
under the driver each leg is a new run, and its list comes only from the
checkpoint it resumes. A cancel or a failure goes back to the pause the
turn started from, which was taken before the turn's jobs existed. Without
more, a job started in a dropped turn would keep running with nothing in
the session holding it: no `/jobs` line, no note to the model, and no way
to stop it.

So the driver keeps the jobs a turn starts:

- `startRun` and `resumeRun` pass the run an `onJobStarted` listener
  (`InvocationOptions.onJobStarted`). `_launchJob` calls it with each job
  as it starts. The leg's `LegOutcome.startedJobs` lists them, for every
  outcome, an abort and a failure included. The listener is TypeScript:
  a held job carries its token, which Agency code never sees.
- The front-end passes them on as `legFinished`'s `startedJobs`.
  `working` and `approving` keep them in `turnJobs`.
- A turn that finishes forgets the list: the pause it ends on holds those
  jobs.
- A turn that is cancelled or fails reports `turnJobsDropped` right after
  `turnCancelled` or `legFailed`. The front-end stops each job with
  `stopDroppedJobs(host, jobs)`. It and the other two functions that read
  or stop a job (`sessionJobs`, `stopSessionJob`) are in `jobControl.ts`,
  which is Node-only like the job processes, so the driver's index does
  not export them: a front-end imports
  `agency-lang/stdlib-lib/agentDriver/jobControl.js`. Esc means "stop what the agent is doing",
  and the next message already says the turn's changes may be half made.
- A loaded turn that waits on approvals gets its `turnJobs` from the
  approvals' checkpoints (`jobsStartedBetween`), so a cancel after the
  load stops them too.
- **A process that dies in the middle of a turn** cannot stop anything,
  and its turn's jobs are in no checkpoint. They run to their time limit.
  `agency jobs` lists and stops them. This is accepted.

`heldJobsOf(interrupts)` reads the jobs the interrupts' checkpoints hold.
It merges all of them: two parallel tool calls can pause at different
times, and an earlier checkpoint can lack a job the other started.

## Approvals

When a leg comes back paused on approvals, the driver puts them in a
queue and asks about them in order. Every `legFinished` and `decided`
action carries a `settle` function. It gives the answer something on
record already decides, or null to ask a person:

```ts
const settle: Settle = (interrupt) =>
  ruleApproves(interrupt) ? { response: approve(), by: "rule" } : null;
```

- `settle` is asked again after every answer. Say three edits wait, and
  the person answers the first one "always". The front-end saves a rule,
  and its `settle` now approves the other two. Each of those is reported
  as `settled`, so the terminal can print "Approved … by the rule just
  saved".
- A raise that wants a typed value, such as `question()`, is passed to
  `settle` like any other. The queue does not reject it. A front-end that
  cannot ask for a value declines it in its own `settle`.
- `undecidedDeclined` is for a run with no one to ask. It declines every
  approval still open, with the reason `reasonFor` gives.
- A `decided` action names the `interruptId` it answers. An answer for an
  approval that is not showing is ignored, so a repeated key cannot answer
  the next prompt.

## The policy and the pin

`startRun` and `resumeRun` pin `agent::sessionInput` to `propagate` in the
policy they are given (`withPauseLeftAlone`). They do it themselves, so no
front-end can forget. Without the pin, a policy like `{ "*": [{ action:
"reject" }] }` would answer the pause with nothing, and the core ends the
session when that happens.

With no policy given, the run gets the pin alone. That changes nothing a
front-end sees: the run's policy handler says nothing about an effect no
rule names, so every other interrupt still reaches the front-end. One
difference: a run given a policy does not read the `AGENCY_RUN_POLICY`
environment variable that `agency run --policy` sets.

The callbacks and the policy go in again on every resume. The runtime
does not keep the ones given to `main`. `startRun` and `resumeRun` do
this. Nothing else should call `main` or `respondToInterrupts`.

Each call returns `{ result, usage }`. `usage` is the run's total spend so
far, or null when the call threw.

### Which policy a session runs under

A session started with policy flags runs under the policy they resolved
to, wherever it is resumed. That policy is a file of the session's own,
`<agent home>/session-policies/<id>.json`, beside the user's
`policy.json` (`lib/stdlib/agentDriver/sessionPolicy.ts`):

- The front-end that starts the session writes it with
  `saveCarriedPolicy({ home, id, policy })`, which refuses a policy that
  is not valid.
- When a settings answer gives the session a new `record.id` (a `fork`),
  `reduceDriver` reports `{ type: "forked", from, to }` after `answered`.
  A front-end handles it by calling `copyCarriedPolicy({ home, from, to
  })`. Without the copy, a session started with `--policy minimal` would
  run its fork under the saved policy. No file at `from` copies nothing;
  one that can't be read is a failure.
- A front-end that resumes the session reads it with
  `readCarriedPolicy({ home, id })`: null when there is no file.

The core never holds the policy. If it did, it would be in the
checkpoint and in the pause's interrupt data, and an edit to either
would change what the session is allowed to do. The file is guarded as
`policy.json` is: no built-in policy but `approve-all` approves a write,
an edit, a remove, a copy onto, or a move of or onto a file under
`session-policies/` (`lib/runtime/builtinPolicies.ts`). Under
`with-writes`, a remove of a folder that holds the agent home is not
caught; see `approval-policies.md`.

`sessionRunPolicy` picks the policy to give the run:

```ts
const carried = await readCarriedPolicy({ home, id });
const policy = sessionRunPolicy({ carried, saved: savedPolicyFile, extra: null });
if (!policy.success) {
  // Show policy.error. Do not resume the session.
  return;
}
await resumeRun({ agent, callbacks, policy: policy.value, interrupts: pause, responses });
```

- With a policy of its own, the run gets that policy with the saved
  policy's reject rules ahead of its rules. The saved approvals are left
  out. Every handler is consulted, and a policy with no rule for an
  effect says nothing, so beside `recommended` a session started with
  `--policy minimal` would have its reads approved.
- With none, the run gets `saved`.
- When the file can't be read, or is not a valid policy, it fails with
  "This session's own policy can't be read, so it can't be continued
  here." It never falls back to `saved`, which is why `carried` is a
  `Result` and not a policy or null.
- `extra` is the flags given at resume. Its rules go ahead of the others
  for the same effect, as `--approve` and `--reject` do (`layerPolicy` in
  `lib/runtime/policyFlags.ts`). So `--approve std::bash` at resume beats
  a reject the session was started with. That is intended: the person
  typed it.

"Always" answers given in a session with a policy of its own are saved
to its policy file, approvals and rejections both, so they follow the
session to any front-end. Only the answer's rule is added to the file;
the flags given at resume and the saved policy's rejects stay out of it.
The terminal does this by passing that file to `askAbout`
(`approval-policies.md`).

`sessionRunPolicy` does not pin the pause. `startRun` and `resumeRun` pin
whatever policy they are given.

## What is saved, and when

`savedRun(phase)` is what to write. The front-end saves at every pause.

| Phase                       | Saved as                                    |
| --------------------------- | ------------------------------------------- |
| `starting`, `ended`         | Nothing.                                    |
| `waitingForUser`            | The pause, `turn: null`.                    |
| `answering`                 | The same. The change in flight is not made. |
| `working`                   | The pause, and the turn's text.             |
| `approving`                 | The pause, the text, and the approvals.     |

Every interrupt in it carries its checkpoint. The format, `SavedRun`, is
in `lib/stdlib/agentSessions.ts`. `failedTexts` is optional in it: a file
without it reads as none failed. The entry point re-exports
`readSavedRun`, `isSavedRun`, `canResume` and `checkpointIn` from there,
so a front-end needs one import.

`saveRun({ dir, record, run, holder })` writes `<id>.json`, then
`<id>.meta.json`. The record gets `runFormat: "savedRun"` and `heldBy`.
It returns a `Result`. When the record on disk names another holder, it
writes nothing and fails with `held by perry (process 20)`.

`saveRun` does not make the sessions folder private. A front-end that
wants that does it itself.

## Where a loaded session picks up

`restoredPhase(run, { settle, carried })`, both optional:

- **Waiting for a message:** where it was.
- **Waiting on approvals:** each goes through `settle`, as a new
  pause's approvals do. The front-end chooses it. With no `settle`, every
  approval is asked again. When `settle` answers all of them, the phase
  is `working` with a leg still to run, and the front-end runs it as it
  would after a person answered the last one.
- **A turn that was running** (the process stopped mid-turn): back to the
  turn's start, as if the person had cancelled it. It reports
  `turnCancelled`, and the next message carries the note.
- **Saved by other code:** a checkpoint can be resumed only by the same
  compiled code. `canResume` compares the hash of each module the run is
  paused in with the module loaded now, so this is found when the session
  loads, not on the next message. Both cases below end with no event
  (`happened` is empty). The front-end reads `phase.reason` and shows it.
  - `changed`: a module is loaded with another hash. `ended`, with
    `CANNOT_CONTINUE`.
  - `notLoaded`: none differs, but a module is not loaded in this
    process, so its hash is not known. `ended`, with
    `PROGRAM_NOT_LOADED`. A front-end loads the session program before it
    loads a session. A session saved by another program also lands here.

The two turn cases go through `reduceDriver`, so they behave as the live
ones do.

`carried` is what `readCarriedPolicy` gave. When it is a policy, and the
session can go on, `happened` starts with `{ type: "carriedPolicy",
policy }`. The front-end shows the person what that policy approves
before the first leg: a session's own policy decides what runs without
asking on whichever machine opens it.

## One session, one holder

A session's record names the front-end that has it open:
`heldBy: { frontEnd, pid, processId }`. `processId` is a random id the
process makes once (`thisProcessId()`). Two holders are the same when
`frontEnd` and `processId` match. A pid alone is not enough: two machines
can share a session folder and give out the same pid, and the system
reuses a pid after a crash. The pid is kept for messages.

- A front-end calls `takeHold` when it resumes a session, before its
  first leg. It writes `heldBy` on the record alone, so the run file is
  left as it is. It returns a `Result`: it fails when the session has no
  record, or the record can't be written.
- Before each leg and each save, a front-end calls `stillHeld`. It is
  false once the record names another holder. The front-end then stops,
  runs no leg, writes nothing, and says where the session went.
- So the second front-end takes the session at once, before it has saved
  anything. The first sees it at its next check.
- The same front-end in another process is another holder: the
  `processId` differs.
- A session with no record yet, or one no one has taken hold of, is
  still held.
- After a `fork` answer the session has a new `record.id`. Every later
  save, `stillHeld` and `takeHold` uses that id. Checking the old one
  would watch the original session and miss another front-end taking
  the fork.
- `saveRun` checks the holder too, so a front-end that forgets
  `stillHeld` does not overwrite newer work.
- `saveRun` reads the record, checks it and writes under the host's lock
  on the record's file (`withLock`), and `takeHold` reads and writes
  under it. So a save and a take in one process do not cross. The lock
  lives in the process: across two processes, a take can still land
  between another process's check and its write. That window is
  accepted. Outside a run, the lock is taken on one host kept for the
  process, since `currentHost()` builds a new host on each call there.

## The terminal

`agency agent` runs its interactive sessions through the driver. The
process has two runs:

- **The shell run** is `agent.agency`. It parses the flags, picks the
  session, installs the policy handler, and runs `repl()`. It is never
  saved. `lib/terminal.agency` is its side of the session, and
  `lib/repl.agency` turns each line into an answer.
- **The session run** is `program.agency`, started and resumed by
  `lib/stdlib/agentTerminalSession.ts`. `agentTerminalDriver.ts` holds the
  process's one session and gives the shell run its functions
  (`_startSession`, `_resumeSession`, `_send`, `_pause`, ...). It imports
  the program as `agency-lang/agent-session`, declared in
  `lib/stdlib/agentSessionProgram.d.ts`.

The session calls back into the shell run for three things, each an
Agency function of `terminal.agency`:

- **`ask`**: `askAbout(intr, currentPolicy(), file)` from `std::policy`.
  It draws the approval prompt (the diff of an edit, the typed value, the
  "what should the agent do instead?" follow-up), and saves an "always"
  answer through the handler's own writer. Esc at the prompt throws a
  cancellation, and the session drops the turn (`approvalCancelled`).
- **`policy`**: `currentPolicy()`, read before each leg and after each
  answer. So an "always" answer settles the rest of its pause, and the
  driver prints "Approved … by the rule just saved" for each.
- **`show`**: prints the reply, an error, an edit's diff, or a line of
  the driver's. Notices (`session.notice`) and tool traces print from
  `trace.agency`'s callbacks, which fire for every run in the process.
- **`forked`**: the session was forked, so a session policy file the
  shell saves "always" answers to moves to the new id.

**Esc while the model works** cancels the shell run's call. `_send` passes
that run's abort signal to the leg, so it aborts the leg too. The shell
run stays cancelled until the REPL resets it after the line, so the shell
can't run anything until then. That is why, after each leg, the driver
first does what needs no shell (stops a dropped turn's jobs, copies a
fork's policy, saves) and only then shows lines. A line it can't show is
lost.

**An edit's diff.** An edit a rule approves inside the run gets no prompt,
so the terminal shows its diff from the core's `session.editDiff`
(`lib/stdlib/agentTerminalDiff.ts`). An edit the new pause asks about is
drawn by its prompt and not shown twice.

**An error in the middle of a turn**, such as the shell failing, drops the
turn: one waiting on approvals as Esc drops it, one whose leg was not
applied as a failed leg. The session waits for a message again and its
turn's jobs are stopped, but nothing is saved until the next pause. If
the process exits first, the saved session still holds the turn as
running, and a resume treats it as cancelled.

**The policy.** A new session started with policy flags saves what they
resolve to as its own policy file (`saveCarriedPolicy`), and "always"
answers go there. If the session ends before its first turn, it is never
saved, and the file is removed (`removeCarriedPolicy`). A resumed session
that carries a policy file runs under
`sessionRunPolicy({ carried, saved: policy.json, extra: <flags given now> })`.
A session started with no flags carries no policy, so flags given when it
is resumed apply to that sitting only: the next resume, here or in
another front-end, runs it under the saved policy again. The shell
installs `cliPolicyHandler` with the session's policy and file, and with
`answersOnly: true`, since the policy can be layered from the session's
own, the saved policy's rejects and flags given now, and only what a
person answers "always" belongs in the file. A resume of a session this
build can't run is refused before `takeHold`, so the front-end that has
it open keeps it.

**What the commands read.** The footer, `/cost`, `/model`, `/preset`,
`/settings` and `/search` read the session's last pause (`_pause()`) and
its usage (`_footerTokens`, `_costRows`). A command that changes the
session sends an answer: `rename`, `fork`, `compact`, `model`, `preset`,
`savePreset`, `search`, `local`, `capabilities`. A message carries the
notes made since the last one (`!cmd`, `/image`).

**Jobs.** The REPL's job watch reads `heldJobs()` through
`setReplJobsSource`, so a job gets its finish line from the moment it
starts. `/jobs` and `/jobs stop` read and stop the jobs through
`sessionJobs` and `stopSessionJob` and run no leg. A stop changes nothing
in the session run, so its note to the model carries no output; the jobs
message lists the job as stopped and unread.

**Saving.** The session is saved at every pause once it has a turn, with
holder `{ frontEnd: "terminal", pid, processId }`. When another front-end
takes it, the next line prints "This session was continued in …" and the
REPL ends.

## Things that are easy to get wrong

- **Every pause stays in the session program.** The driver adds no frame
  to a saved session. A pause in a front-end's own code would make the
  session one only that front-end could resume.
- **The driver imports no terminal code** and nothing of a front-end's.
  `lib/stdlib/agentSessionImports.test.ts` walks its imports.
- **`turnFinished` is only for a turn.** The run's first pause reports
  nothing, and a settings answer reports `answered`. A cancelled turn
  reports `turnCancelled`.
- **`legFailed` is the same event for a turn and a settings answer.** The
  front-end knows which from the phase it was in.

## Files

| File                                     | Job                                                         |
| ---------------------------------------- | ----------------------------------------------------------- |
| `lib/stdlib/agentDriver/index.ts`        | The entry point.                                            |
| `lib/stdlib/agentDriver/interface.ts`    | The core's interface: `ProgramStart`, `PauseData`, `Answer`. |
| `lib/stdlib/agentDriver/run.ts`          | `startRun`, `resumeRun`, `toStep`, `withCancelNote`.        |
| `lib/stdlib/agentDriver/policy.ts`       | `withPauseLeftAlone`, `sessionRunPolicy`.                   |
| `lib/stdlib/agentDriver/sessionPolicy.ts` | The session's policy file.                                 |
| `lib/stdlib/agentDriver/approvals.ts`    | The approval queue.                                         |
| `lib/stdlib/agentDriver/machine.ts`      | `reduceDriver`, the phases, `Happened`.                     |
| `lib/stdlib/agentDriver/savedRun.ts`     | Saving, loading, and the holder.                            |
| `lib/stdlib/agentDriver/jobs.ts`         | The jobs a pause holds.                                     |
| `lib/stdlib/agentDriver/jobControl.ts`   | Listing and stopping jobs. Node-only, not in the index.     |
| `lib/stdlib/agentTerminalSession.ts`     | The terminal's session: legs, approvals, saves, the holder. |
| `lib/stdlib/agentTerminalDriver.ts`      | The process's one session, for the shell run's Agency code. |
| `tests/agency-js/agent-terminal`         | The terminal's session driving the real program.            |
| `tests/agency-js/agent-terminal-repl`    | `agency agent`'s REPL, typed into, end to end.              |
| `tests/agency-js/agent-driver`           | A real run driven through the driver, with a small fixture. |
