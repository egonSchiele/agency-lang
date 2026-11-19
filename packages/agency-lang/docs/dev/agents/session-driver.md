# The session driver

The TypeScript a front-end uses to run the agent's session program:
start the run, answer its pause, answer its approvals, save it, and load
it again. It lives in `lib/stdlib/agentDriver/`. A front-end imports it
as `agency-lang/stdlib-lib/agentDriver/index.js`.

It came from Perry, so that Perry and the `agency agent` terminal share
one copy. Two copies would have to agree exactly on the file format and
on what a crash in the middle of a turn means.

The program it drives is described in `session-core.md`. Read that first.

## What the driver does, and what it leaves to the front-end

The driver decides what the run does next. It does not draw anything.
Each step it takes reports a list of `Happened` events, and each
front-end shows them its own way. Perry will turn them into transcript
items. The terminal will print a line.

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
  the run waits for a message again. Perry closes the tool calls that
  never got an end. The terminal saves and prints at the end of a turn.
- **A failed leg** goes back to the pause and reports `legFailed`.
- **A settings answer is not a turn.** When the run pauses again,
  `answered` reports what the pause said before and after, and not
  `turnFinished`. The front-end
  shows what changed. When the core refused the change, the two are the
  same, and the core has already sent a notice that says why.

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

A session started with policy flags carries the policy they resolved to.
The front-end puts it in `SessionStart.policy`, and the session's pause
reports it as `policy`. A front-end that resumes the session runs it
under that policy. `sessionRunPolicy` picks the policy to give the run:

```ts
const policy = sessionRunPolicy({
  carried: carriedPolicy(pause),
  saved: savedPolicyFile,
  extra: null,
});
if (!policy.success) {
  // Show policy.error. Do not resume the session.
  return;
}
await resumeRun({ agent, callbacks, policy: policy.value, interrupts: pause, responses });
```

- When the session carries a policy, the run gets it. `saved` is not
  used at all.
- When it carries none, the run gets `saved`.
- When the session's policy can't be read, `sessionRunPolicy` fails with
  "This session's own policy can't be read, so it can't be continued
  here." It never falls back to `saved`. That is why `carried` is the
  `Result` that `carriedPolicy` gives, and not a policy or null: a null
  would mean "carries none", and the run would get `saved`.
- `extra` is what the front-end adds for this sitting: flags given at
  resume, and "always" answers given in a session that carries a policy.
  Its rules go ahead of the others for the same effect, as `--approve`
  and `--reject` do (`layerPolicy` in `lib/runtime/policyFlags.ts`).

The session's policy replaces the saved one. It does not sit beside it.
Every handler is consulted, and a policy with no rule for an effect says
nothing. Say the saved policy is `recommended` and the session was
started with `--policy minimal`. `minimal` has no rule for `std::read`.
Beside `recommended`, the read would be approved, and only `minimal`'s
rejects would carry over.

`sessionRunPolicy` does not pin the pause. `startRun` and `resumeRun` pin
whatever policy they are given.

A session whose policy can't be read is not resumed. `pauseData` is null
for its pause, and `restoredPhase` ends a loaded one with the reason.

**A front-end must put a valid policy in `SessionStart.policy`.** Neither
the core nor `startRun` checks it: `startRun` is given `main` with the
start data already bound, so it never sees them. A policy that is not
valid shows up only later, and the session then can't be resumed.

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
in `lib/stdlib/agentSessions.ts`.

`saveRun({ dir, record, run, holder })` writes `<id>.json`, then
`<id>.meta.json`. The record gets `runFormat: "savedRun"` and `heldBy`.
It returns a `Result`. When the record on disk names another holder, it
writes nothing and fails with `held by perry (process 20)`.

`saveRun` does not make the sessions folder private. The terminal never
did. Perry makes its folder private itself.

## Where a loaded session picks up

`restoredPhase(run, settle)`:

- **Waiting for a message:** where it was.
- **Waiting on approvals:** each goes through `settle`, as a new
  pause's approvals do. The front-end chooses it. Perry passes the one
  that declines a raise wanting a typed value. With no `settle`, every
  approval is asked again.
- **A turn that was running** (the process stopped mid-turn): back to the
  turn's start, as if the person had cancelled it. It reports
  `turnCancelled`, and the next message carries the note.
- **Saved by code that is not loaded now:** `ended`, with the reason. A
  checkpoint can be resumed only by the same compiled code
  (`canResume`), so this is found when the session loads, not on the
  next message. No event is reported (`happened` is empty). The
  front-end reads `phase.reason` and shows it.
- **Carrying a policy that is not valid:** `ended`, with the reason, in
  the same way. Run under a front-end's own policy instead, it could be
  approved what its own policy asks about.

The two turn cases go through `reduceDriver`, so they behave as the live
ones do.

## One session, one holder

A session's record names the front-end that has it open:
`heldBy: { frontEnd, pid }`. Nothing is locked. This is two programs of
one user on one machine.

- A front-end calls `takeHold` when it resumes a session, before its
  first leg. It writes `heldBy` on the record alone, so the run file is
  left as it is. It returns a `Result`: it fails when the session has no
  record, or the record can't be written.
- Before each leg and each save, a front-end calls `stillHeld`. It is
  false once the record names another holder. The front-end then stops,
  runs no leg, writes nothing, and says where the session went.
- So the second front-end takes the session at once, before it has saved
  anything. The first sees it at its next check.
- The same front-end in another process is another holder: the pid
  differs.
- A session with no record yet, or one no one has taken hold of, is
  still held.
- `saveRun` checks the holder too, so a front-end that forgets
  `stillHeld` does not overwrite newer work. Nothing is locked: two saves
  at the same moment can still cross. Each reads the record, then
  writes, and the other can write in between.

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
| `lib/stdlib/agentDriver/interface.ts`    | The core's interface: `ProgramStart`, `PauseData`, `Answer`, `carriedPolicy`. |
| `lib/stdlib/agentDriver/run.ts`          | `startRun`, `resumeRun`, `toStep`, `withCancelNote`.        |
| `lib/stdlib/agentDriver/policy.ts`       | `withPauseLeftAlone`, `sessionRunPolicy`.                   |
| `lib/stdlib/agentDriver/approvals.ts`    | The approval queue.                                         |
| `lib/stdlib/agentDriver/machine.ts`      | `reduceDriver`, the phases, `Happened`.                     |
| `lib/stdlib/agentDriver/savedRun.ts`     | Saving, loading, and the holder.                            |
| `tests/agency-js/agent-driver`           | A real run driven through the driver, with a small fixture. |
