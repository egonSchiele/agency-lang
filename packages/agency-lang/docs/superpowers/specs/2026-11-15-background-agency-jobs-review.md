# Review: Background Agency jobs

> **Replaced, never built.** The design this file reviews was dropped on 2026-11-15 for starting a program in its own process (`spawn`, #1476). See `docs/superpowers/specs/2026-11-15-start-a-program-in-its-own-process.md`. This review stays as a record.

Reviewed: `docs/superpowers/specs/2026-11-15-background-agency-jobs.md`, on 2026-11-15, against the code in this worktree (`a80b90157`).

Paths are relative to `packages/agency-lang`. I read the code and ran nothing.

**Out of date.** This review is of the first design, in which the parent's handlers answered a job's interrupts. The spec was rewritten later the same day around a policy the job holds. Problems 1, 2, and 4 below do not arise in that design. Problem 3, on cost guards, still does, and the new spec keeps its fix.

## Summary

The design reuses what exists: the job table, the subprocess session, the resume instruction, and the `eligible` filter. I found no layer that duplicates something the runtime already has. Decision 5 (a blocked job is answered with data, and no handler takes part) matches how `respondToInterrupts` and `/resume` work.

Four problems need a decision before a plan is written. All four come from the same fact: a job's session keeps the stack and the handler list of the call that started it, and that call has returned. The spec deals with this for handlers that are added later (rule A). It does not yet deal with handlers, cost guards, and cancel signals that were live at the start and have ended since.

| # | Problem | Where in the spec |
| --- | --- | --- |
| 1 | Rule B rejects every interrupt of a job the agent's model starts, from the next turn on | Decision 4, line 161 |
| 2 | The recorded handler list includes handlers of sibling branches | Decision 4, line 153 |
| 3 | A cost guard that was live at the start still caps the job after its block ends | Decision 7, line 227 |
| 4 | A cancelled starting stack turns the job's interrupts into rejections | Decision 7, line 231 |

## 1. Rule B fires in the main case in `agency agent`

The spec says (line 161) that a job the main agent starts records one handler, the session's policy handler, so rule B never applies. The code registers more than that one.

`runTurn` wraps every turn in its own handler:

```agency
// lib/agents/agency-agent/lib/turn.agency:187
handle {
  return dispatchToBrain(target, userMsg)
} with guardStopHandler
```

This entry is pushed when a turn starts and removed when the turn ends. A model starts a job from a tool call inside the turn, so the job records this entry. When the turn ends the entry is gone. Rule B then rejects every interrupt the job raises, with "a handler is gone". A background job exists to outlive the turn that started it, so this is the normal case.

The coders have the same problem one level down. Both carry the job tools (`sessionJobTools()` in `brains/coordinator/subagents/code.agency:153`), and `codingAgent` is wrapped by `@guarded` (`stdlib/agents/coding.agency:95`), which registers a handler for the length of the call (`stdlib/decorators.agency:48`). A job a coder starts loses that handler when the coder returns.

Both handlers only answer `std::guard` and pass on everything else (`lib/agents/agency-agent/lib/budget.agency:19`). Rule B cannot know that, because it looks at whether the entry exists and not at what it would answer.

Test 10 does not catch this. Its handler wraps the whole tool loop, so it is still registered when the job raises.

Two ways to resolve it:

- **The job keeps consulting its recorded handlers after their blocks end.** The job holds the entries, so none of them is ever "gone", and rule B is not needed. This is the closest match to a waiting `run()`, where the handlers stay registered because the caller is still inside them. It needs one check I have not done: that a compiled handler function can be called after the frame that registered it has returned.
- **Keep rule B and change what the agent registers**, so that a model's tool call sits under session-long handlers only. This is a larger change to the agent, and every `@guarded` subagent that gets job tools later has the same problem again.

I would take the first. Either way the sentence at line 161 needs to change, and the test list needs a case where a job is started in one REPL turn and raises in a later one.

## 2. The recorded list includes sibling branches' handlers

The spec says a job "records the entries in `ctx.handlers` when it starts". That list is shared by every branch of the run. The comment on `removeHandler` says so: "concurrent branches share this one list and leave their `handle` blocks in any order" (`lib/runtime/state/context.ts:739`).

So the snapshot can hold a handler from a sibling fork arm, or from another tool call of the same model round, that happened to be inside a `handle` block at that moment. `inSiblingBranch` already keeps such a handler from hearing the job's interrupts. Rule B still checks that it exists. When the sibling leaves its block, rule B rejects every interrupt of the job because of a handler that never applied to it.

The fix is to record only the entries that pass the sibling check for the starting stack. The spec should say this, and a test should start a job in one fork arm while the other arm is inside a `handle` block.

## 3. Cost guards that were live at the start keep capping the job

The spec says (line 227) that a `guard(cost:)` block around the `startRun` call does not cap the job, because the block has ended by the time the job spends. The existing code does something else.

Each charge from a child goes through `accountChildUsage` (`lib/runtime/ipc.ts:840`). It bills the guards on the session's stack and then calls `enforceGuards()` on that stack. If a guard is over its limit, the child is killed and the session is rejected. A cost guard is shared by reference with every branch (`CostGuard.cloneForBranch` returns `this`, `lib/runtime/guard.ts:408`), and its `check` has no notion of a block that has ended (`lib/runtime/guard.ts:341`). The session's stack keeps its list of guards after the starting call returns.

So this happens:

```agency
const started = guard(cost: $1.00) {
  return startRunFile("./scripts", "report.agency", "main")
}
// The guard block has ended. The job spends $1.50 an hour later,
// and its next paid call kills it with a guard trip.
```

In the agent, a job started by a coder is capped by that coder's `maxCost` (twenty dollars by default, shared with everything the coder itself spent) long after the coder returned.

The spec needs to say what a background session does with the starting stack's guards. My suggestion: it bills the run's total, as line 227 says, and it does not enforce the guards of the starting stack. The spec should then say whether the root budget from `--max-cost` still stops a job. I think it should.

I did not work out what a time guard on the starting stack does when `enforceGuards()` reaches it after its block has ended. That needs the same answer.

A smaller point in the same decision: line 225 says "the session adds them up". A session lasts one stretch of running, because each resume forks a new child with a new `RunSession` (`lib/runtime/ipc.ts:1112`). A total kept on the session starts from zero after every resume. The total has to live on the job.

## 4. A cancelled starting stack rejects the job's interrupts

Decision 7 says Escape does not stop a job. The job's child keeps running, but its interrupts are affected.

The handler chain throws when the stack it was given is cancelled (`lib/runtime/interrupts.ts:348`), and `handleInterruptMessage` turns any throw into a rejection that reads "Parent handler error: ..." (`lib/runtime/ipc.ts:728`). `isCancelled` is true in two cases (`lib/runtime/state/context.ts:784`):

- **The run's own signal is aborted.** Escape aborts it (`lib/stdlib/cli.ts:1580`), and the REPL swaps in a fresh one before the next prompt. A job that raises between those two moments is rejected.
- **The starting stack's signal is aborted.** A tool call's stack carries the abort signal of its branch (`lib/runtime/runBatch.ts:228`). When one tool call of a round fails, `runBatch` aborts the controller of every other branch in the round, including ones that already returned (`lib/runtime/runBatch.ts:819`). If the model starts a job and a sibling call in the same round throws, the job's starting stack stays aborted, and every interrupt the job raises afterwards is rejected.

The spec should say that the chain run for a job's interrupt does not read the cancel state of the starting stack or of the turn. The job has its own stop signal for that. A test should cancel a turn while a job is running and assert that the job's next interrupt still reaches the handlers.

## Smaller points

**A wait already in progress when the job blocks.** `waitForJob` wakes on `job.ended`, a timer, or the caller's signal (`lib/runtime/jobs/jobTable.ts:205`). The spec covers a wait that starts on a blocked job. A wait that started while the job was running also has to return when the job blocks, or the model waits out its full `wait:` on a job that cannot move. The unit test list should have this case.

**The `_handler` sketch drops some of what the real handler does.** The real one (`stdlib/policy.agency:1329`) calls `maybeLoadPolicy()` and `maybeFlush()`, rejects when no policy is loaded, and lets a rule approve only when the raise does not expect a value. The non-interactive branch then gives a different reason when a rule approved but could not be used. So `nobodyToAsk(intr)` needs to know whether a rule approved, and `ruleVerdict` returning `null` does not carry that. The spec should give the two functions signatures that keep this.

**From `askVerdict`'s verdict to a `JobAnswer`.** `askVerdict` returns what a handler returns, and `resumeJob` takes `{ interruptId, action, value }`. The spec should say which code converts one to the other, since `/jobs answer` and any other caller need it.

**Checking the answers.** `validateResumeBatch` (`lib/runtime/interrupts.ts:741`) already checks a set of interrupts against a set of responses for `respondToInterrupts`. `resumeJob` should use it for the count and id checks and add only the lookup by `interruptId`.

**`startJob`'s `maxMinutes` for an Agency job.** Decision 9 routes `agency run file.agency` to `startRunFile`. The spec should say that `maxMinutes` becomes the job's `wallClock`. `runFile`'s own default is 60 seconds (`stdlib/agency.agency:439`), which is too short for a job.

**Where a resumed child's interrupts go.** Decision 5 says the place `resumeJob` is called from must not change the answer. Add one sentence saying the resumed child's later interrupts also go to the job's recorded stack and handlers, and that the `/jobs answer` call site contributes none.

## Claims I checked that hold

- The three-step order of a child's interrupt, and the pause, match `docs/dev/runtime/subprocess-ipc.md` and `handleInterruptMessage`.
- The table of five things a waiting call provides matches `attachStdoutForwarder`, `runSubprocessSession`, `saveSubprocessPayload`, `invokeSubprocess`, and `_runProgram`.
- `gatherChainOutcome` takes the optional `eligible` filter (`lib/runtime/interrupts.ts:543`).
- `StateStack.parent` is set in one place (`lib/runtime/runBatch.ts:333`) and nothing clears it.
- The rule A example is right: a `with approve` on a later line of the same stack would be consulted for the job's interrupt today.
- An `agency run <file>` line already runs through `runFile` (`cliRun`, `stdlib/agency.agency:1322`), so starting it with `startRunFile` changes when it returns and nothing about what it may import.
- The child's standard input is a pipe (`lib/runtime/ipc.ts:458`), so a background child cannot read from the user's terminal.
- A program started with `run()` has its own job table, so sandboxed code cannot reach a blocked job of the root program.

## Open question 1

I agree with the spec: `resumeJob` should raise no effect. An effect would send the answer through handlers, which is what decision 5 forbids. The protection is that the function is in no tool bundle.

## Tests to add

1. A job started in one REPL turn raises in a later turn, and its interrupt reaches the session's handler (problem 1).
2. A job started inside a `@guarded` function raises after that function returned (problem 1).
3. A job started in one fork arm while the other arm is inside a `handle` block; the arm leaves its block; the job's interrupt is not rejected (problem 2).
4. A job started inside `guard(cost:)` spends past that limit after the block ended and keeps running (problem 3).
5. A job with `maxCost` blocks, is resumed, and is stopped when its total across both stretches passes the cap (problem 3).
6. A turn is cancelled while a job runs, and the job's next interrupt still reaches the handlers (problem 4).
7. A `jobOutput` wait that is in progress returns when the job blocks.
