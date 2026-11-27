# Review: four fixes for `agency agent -p` runs (ADI-383 to ADI-386)

Plan reviewed: `docs/superpowers/plans/2026-11-27-agent-run-fixes-adi-383-386.md`

## Verdict

The four root causes are right. I checked each one against the code in this
worktree, and the plan describes what the code does. The plan is not ready to
build yet, because Part 1 has a gap that could leave the clock running while
a person is answering an interrupt, and Part 2 does not say how the extra
turn gets past the router. Both are fixable in the plan without changing its
direction.

The findings are in order of importance. Each one says what I checked.

| # | Part | Finding | Blocks approval? |
| -- | -- | -- | -- |
| 1 | 1 | The halt that passes an interrupt up to a caller is missing from the table, and it is the halt that keeps the clock paused today | yes |
| 2 | 2 | The extra turn goes through the router, which may send "continue" to the wrong agent | yes |
| 3 | 1 | Subagent time budgets have never been enforced on model time, so the defaults are untested | decision needed |
| 4 | 2 | The check has no measured false-positive rate, and it runs after a failed turn | no |
| 5 | 3 | The backstop's count must survive a resume, and the plan should say what happens to an earlier draft | no |
| 6 | 4 | The open question about the interactive session decides the hand-back wording, so it belongs in the plan | no |
| 7 | all | Part 1 should be its own PR | recommendation |

---

## 1. Part 1: the halt that passes an interrupt upward is not in the table

**What the plan says.** Split `halt` into `halt` (never touches the clock) and
`pauseGuards`. The places that raise an interrupt call `pauseGuards` first.
A `return` no longer pauses.

**What the code does today.** Three facts, all verified:

1. `Runner.step` calls `beforeStep()` before it checks `shouldSkip()`
   (`lib/runtime/runner.ts`, in `step`, `pipe`, and `fork`). `beforeStep`
   restarts every time limit on the stack, and it does so even when the
   runner has already halted.
2. A compiled function body is a list of `await runner.step(...)` calls. A
   halt inside one step does not stop the later calls from being made. Each
   later step is entered, restarts the clock, and then skips its body.
3. When a call returns interrupts, the caller's compiled code halts too:

   ```ts
   if (hasInterrupts(__funcResult)) {
     runner.halt(__funcResult);
     return;
   }
   ```

   This is emitted by `typescriptBuilder.ts` (near line 3758). `Runner.pipe`
   does the same at `runner.ts:665`.

Put together, here is what happens today when a function two calls deep
raises an interrupt that goes to a person:

```
def inner() {
  interrupt std::env("ok?", {})   // halt: clock pauses
  print("after")                  // skipped step: beforeStep restarts the clock
}

def outer() {
  inner()                         // sees interrupts, halts: clock pauses AGAIN
  print("more")                   // skipped step: clock restarts
}
```

The comment on `halt` says this on purpose: "subsequent halts from outer
Runners propagating the same interrupt see 'paused' and no-op". In practice
those outer halts are not no-ops. They are what pauses the clock again after
the skipped steps restarted it.

**Why this matters for the plan.** The plan's table has one row for generated
code: "`return` in generated code, halts with the return value, no pause".
The propagation halt in fact 3 is a second kind of halt in generated code,
and it carries interrupts. The table also lists "the rest of `runner.ts`" as
"a value or a failure", but `runner.ts:665` and `:667` halt with interrupts.

If those sites call plain `halt` after the change, the sequence becomes:
`inner` pauses the clock, `inner`'s skipped steps restart it, and nothing
pauses it again. The program then waits on a person with the clock running
and the timer armed. A `--max-time 60m` run that waits 61 minutes for an
approval could trip while the person is still deciding.

I did not verify what state the clock is in today at the very end of this
sequence (after the outermost halt, the outermost function's own skipped
steps also call `beforeStep`). That is worth knowing before changing
anything here, because it tells you whether the current tests would catch
the regression.

**What I suggest.** Make `beforeStep` do nothing on a runner that has already
halted:

```ts
private beforeStep(): void {
  if (this.halted) return;
  this.stack?.guards.forEach((g) => g.resume(this.stack!));
}
```

A halted runner is finished, so it has no reason to restart a clock. With
this in place the split is sound: the raise site pauses once, no skipped
step restarts the clock, and the propagation halts need no pause. The table
then only has to be right about the raise sites. The plan should confirm
that nothing depends on a halted runner restarting the clock, and add the
propagation halts to the table with "carries interrupts, relies on the raise
site's pause".

**A simpler design worth considering first.** The suggestion above patches
the plan's design. A different design removes the problem: pause the clock
in the one place where a run really stops, and nowhere else.

`runBatch` already works this way for branches. `pauseBranchTimeGuards`
(`lib/runtime/runBatch.ts`) pauses a branch's clock "when a branch settles
and on interrupted exits, so a dormant branch cannot trip (or keep accruing)
while a human thinks". It does not depend on which statement halted.

The root run can do the same. Where the run stops and hands its interrupts
to the host (and where the debugger pauses), pause the root stack's guards
once. Then:

- `halt` never touches the clock, for a `return` or for an interrupt.
- No raise site calls `pauseGuards`, so the plan's table of call sites is
  not needed, and a new raise site cannot forget the call.
- `beforeStep` stays as it is. Skipped steps restarting the clock no longer
  matters, because the pause happens after all of them.

The checkpoint is still right. It is captured at the raise, while the clock
is running, and `TimeGuard.toJSON` already saves `currentElapsed()`, which
includes the time since the last pause.

I have not found the exact place where the root run exits with interrupts,
so the plan should name it before choosing between the two designs.

**A test the plan needs.** The plan says existing tests cover "an interrupt
that goes to a person must still pause the clock". I could not find one that
covers the shape above. `tests/agency/handlers/handler-guard-trip.agency` is
about a trip, and `guard-time-input-wait-free.agency` is about `input()`. Add
a fake-clock test where:

- the interrupt is raised in a function called from another function,
- both functions have statements after the call,
- no handler answers, so it goes to a person,
- the fake clock advances past the limit before the approval, and
- the run finishes without a trip after the approval.

Run it once before the change. If it fails today, that is a second bug and
the plan should say so.

## 2. Part 2: the extra turn passes through the router

**What the plan says.** On `"unfinished"`, the agent "adds this message to the
conversation and runs the coordinator again".

**What the code does.** `oneShot` reaches the coordinator through
`runTurn` → `dispatchToBrain` → `answerTurn` → `coordinatorBrain`, and
`coordinatorBrain` starts with `routeFor` (`stdlib/agents/brains/coordinator.agency`).
`routeFor` asks the router about any plain-text message shorter than
`ROUTE_MAX_CHARS` when a router model is set. The continue message is plain
text and one line long, and the check only runs when a router model is set.
So every extra turn asks the router where to send "You have budget left.
Continue the task now, or say why you can't."

The router picks between the coordinator, the coder, and the researcher from
that text alone. Whichever it picks, the plan's Terra case needs the
coordinator, because the coordinator is the one that sends work back to the
coder with the right framing.

The plan should say how the extra turn skips routing, and test 1 should
assert that the router's mock queue holds exactly one routing entry (the
first turn's) plus the check's own entries. As written, test 1 would need an
unplanned extra `{ decide }` entry for the second turn's routing, which is
how this would show up during the build.

`dispatchToBrain` also runs `expandSlash` and `withProjectContextIfMoved` on
the message. Neither should change the continue text, but the plan should
say the message is not treated as user input.

## 3. Part 1: subagent budgets have never applied to model time

The plan's impact note says time limits "start working", including "the
coder's 15 minutes and the researcher's 30 minutes". Since the agent's trace
callbacks fire before every model call, those budgets have counted almost no
model time in any run so far. The qwen run spent 76 of 95 minutes waiting on
the model.

So this fix also turns on limits whose values were never tested against real
model time. A coder call with a slow model may now trip at 15 minutes in most
runs. Combined with Part 2, a tripped coder returns a partial result, the
coordinator reports unfinished work, and the end check asks it to continue.
That may be exactly right, but it is a large change in how the agent behaves
and the plan treats it as a side effect.

Suggested addition: before the PR, read the wall-clock duration of coder and
researcher calls from the sweep logs you already have, and state how many
would have tripped at the current defaults. Then the owner can decide whether
the defaults stay. This needs a decision in "Decisions I need from you".

## 4. Part 2: the check itself

Three smaller points.

- **False positives are not measured.** The type has two labels, so a final
  reply that asks the user a question, or one that reports a blocker
  ("the tests need a database I can't reach"), must be called `"finished"` or
  `"unfinished"`. Each wrong `"unfinished"` costs a coordinator call over the
  whole conversation, up to twice. The sweep has 23 final replies on disk.
  Running the question over them is cheap and gives a real number for both
  directions. The plan should include that as a step, and the prompt text
  (the plan shows only `...`) should be in the plan.
- **A failed turn.** `oneShot` sets `reply` to `formatTurnFailure(...)` when
  the turn fails, for example when the root budget ran out. The plan should
  say the check is skipped then. Otherwise it classifies an error message,
  likely as `"unfinished"`, and tries another turn with no budget.
- **"You have budget left."** The message is sent whether or not a budget was
  set and however little is left. Either drop that sentence or make it true.

## 5. Part 3: two details

I verified the cause: `toolsOffered` keeps intrinsic tools at the limit, the
loop comment says "Intrinsics deliberately ignore maxToolCallRounds", and the
intrinsic path never reaches the gate. The three rules are general and name
no tool. Two things to add:

- **The backstop's count must survive a resume.** Rule 3 counts requests at
  the limit that returned tool calls. `docs/dev/agents/promptRunner.md` has
  the rule that tool-loop decisions must be durable. The plan should say
  where the count lives (the `runPrompt` frame, next to `toolCallRound`) and
  that the failure is decided inside a step.
- **What happens to an earlier draft.** The plan argues that a draft saved at
  the limit is useless, and I agree. But rule 3 ends the call with a failure,
  and the model may have saved a real draft at round 40. The plan should say
  what the coder's caller receives in that case: the failure alone, or the
  round-40 draft through the `@guard` path that already hands back drafts.
  If the draft is lost, say so plainly, because the ticket asked for it.

The plan also says an all-`saveDraft` round "counts toward the limit". That
matches the code as far as I read it (`toolCallRound` advances at the end of
every round), but test it, since the fix depends on it.

## 6. Part 4: settle the interactive question in the plan

The cause is verified: `researchAgent` is a `handoff def` and still calls
`endTurn()` on success.

The plan leaves one check for "before the PR": what the user sees in an
interactive session when research runs. That answer decides the hand-back
text. If the terminal already shows the research answer, then "reply with it
in full" makes the coordinator print a long report a second time, and pay for
it. If the terminal does not show it, the wording is right. This is a
ten-minute check and the plan should carry the answer, with the wording for
each case if they differ.

In `-p` mode a pure research question now costs one more coordinator call,
whose job is to copy a long report. The plan is honest that this is a prompt
and can fail. Test 2 should use a long scripted research answer and assert
the final reply contains its last line, so a coordinator that summarizes
fails the test.

## 7. Split Part 1 into its own PR

The plan offers one PR or four and leans toward one. I would ship Part 1
alone and first, for two reasons:

- It changes time accounting for every Agency program, and finding 1 shows
  the change is subtler than the plan's table suggests. It deserves a review
  that is about nothing else.
- It will move eval results on its own (runs end at their limit, subagents
  trip). If Parts 2 to 4 land in the same PR, you cannot tell which change
  moved a score.

Parts 2, 3, and 4 are fine together.

## Things I checked that are right

- `halt` pauses every guard and a `return` compiles to `runner.halt(value)`.
- `beforeStep` is the only thing that restarts the clock in ordinary code,
  and nothing calls it while the runtime waits on a model request.
- The existing `--max-time` spawn tests only use `sleep()`.
- The intrinsic exception in `toolsOffered` and in the tool loop.
- `handBack` exists and no agent uses it yet, so Part 4 adds its first use.
- The plan's Agency snippets follow the syntax rules.
