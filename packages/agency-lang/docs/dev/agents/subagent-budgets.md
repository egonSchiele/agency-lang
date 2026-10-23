# Subagent budgets

A budget is a parameter on the subagent tool call, enforced by the
stdlib agent's own guard. The harness does not guard the turn.

## Where a budget comes from

- The `--max-time` and `--max-cost` flags cap the whole agent process. The
  runtime installs them as a root budget before any Agency code runs
  (`installRootBudget`, `lib/runtime/node.ts`), and a root budget cannot
  be granted more.
- `researchAgent`, `explorerAgent`, and `oracleAgent` take `maxSeconds`
  and `maxDollars`. The coordinator fills them in from the user's words,
  the wrapper converts them, and the stdlib agent's guard enforces them.
  Unset means the stdlib agent's default.

`codeAgent` runs on fixed internal budgets and does not take the
parameters yet.

## When a budget runs out

1. The stdlib agent's guard trips and raises `std::guard`.
2. `budgeted` (`brains/coordinator/lib/budgets.agency`) wraps each call
   with a handler that rejects a trip carrying the agent's guard label and
   remembers the trip's data. `guardStopHandler` (`lib/budget.agency`),
   which `runTurn` installs, rejects every trip that reaches the top of
   the turn, so no trip parks the turn on an unanswered interrupt.
3. The guard converts the rejection into a failure, or into a success
   carrying whatever partial reached it. `budgeted` then reports the call
   by the rule below, in `_budgetOutcome` (`stdlib/index.agency`).
4. The tool loop pushes the stopped-handoff resume message
   (`finishStoppedHandoff`, `lib/runtime/handoff.ts`) for a failure: the
   subagent stopped, why, and that its work is in the messages above. The
   coordinator's next request follows as after any tool.

The whole-turn guard that used to wrap the coordinator's own loop is gone:
rejecting it unwound the coordinator along with the subagent, so nothing
could pick the research up from the thread. It also took the mid-run
"give me more time?" prompt with it.

## The rule

`_budgetOutcome(name, guarded, trip)` takes the guard's Result and the
trip's interrupt data (`null` when the guard did not trip). It is a pure
function in the prelude, so the rule is written once.

1. **No trip.** The guard's Result, except that a finished `""` is a
   failure, "it returned no answer".
2. **A trip, and a value reached the guard.** That value, as a success.
   A draft that reaches the guard is the backup answer: that is what
   `saveDraft` is for, and the agent prompts promise it ("the most recent
   draft is what the caller receives"). The value can be a finished
   answer, such as the last attempt `revise` saved, or a draft the model
   saved halfway through, which the explorer's and the oracle's
   `finalize` hand to their guards. A string gets one line appended:
   `[researcherAgent: the time budget ran out, so this answer may be unfinished or unchecked. It is the best answer so far.]`
3. **A trip, and nothing reached the guard.** A failure naming the
   budget, "its time budget of 30m ran out", with
   `{ dimension, limit, draft }` in its data. `draft` is the trip's
   `draftValue`: the innermost draft saved anywhere on the stack when the
   guard tripped (`draftPreview`, `lib/runtime/guardTripInterrupt.ts`).
   It can belong to a nested agent, such as the reviewer inside the
   researcher's check.

Rule 2 returns a success, and not a failure carrying the draft, because a
model calling the agent as a tool only sees a failure's message. The tool
loop's `recordFailure` (`lib/runtime/prompt.ts`) shows `failed.error` and
never `data`, so a draft in the data would be lost to the coordinator.

The message in rule 3 is built from the trip, never from the guard's
Result. A guard whose `finalize` returned an empty local hands back
`success(null)`, which has no error to reuse.

## Why the answer was lost (ADI-49)

Trace wX5GvrUq: the researcher had a finished 4 KB answer, and its
30-minute guard tripped inside the `reviewAgent` call that checks it.
Before the fix, the salvage went like this:

1. The trip struck inside `reviewAgent`. That frame returned an aborted
   result with the reviewer's draft.
2. `checkGrounding` received it at an assignment and stopped with its own
   draft: none.
3. `revise` received that at `const critique = check(result)` and stopped
   with its own draft: none. The finished attempt in `result` was
   dropped, because salvage is opt-in per level and `revise` never saved
   it.
4. `researchLoop` returned `revise(...)` in return position, passing the
   empty partial through.
5. The researcher's guard block received it at `answer =
   researchLoop(...)`. Its `finalize` bound the partial, `null`, into
   `answer` and returned it, so the guard returned `success(null)`.
6. `budgeted` saw the trip and returned "its time budget of 30m ran out".
   The coordinator wrote a recap instead of the answer.

Step 3 was the missing piece. `revise` now saves each completed attempt,
so step 3 returns it, the researcher returns it in return position, the
guard returns it as a success, and rule 2 reports it.

A draft the researcher's model saves during its first attempt still does
not reach the guard: it is filed on the `revise` block's frame, and
`revise` assigns the block's result, so the draft stops there. Until an
attempt completes, a trip is a failure.

## Tests

- `lib/agents/agency-agent/brains/coordinator/tests/budgets.agency`:
  `budgeted` with a fake agent per real agent shape: a saved draft
  through a `finalize`, the same shape with nothing saved, a recovered
  `revise` answer, a finished answer, an empty answer, and another
  label's trip.
- `tests/agency/guards/revise-salvages-completed-attempt.agency`: `revise`
  under a guard that trips in the check, in an attempt, or in a later
  attempt, and the `agencyCodingAgent` shape.
- `lib/agents/agency-agent/tests/turn.agency`:
  `budgetTripIsHardStopAndBrainContinues`.
- `tests/agency/guards/unowned-guard-rejected.agency`: `guardStopHandler`.
- `tests/agency-js/handoff/`: `failureInside`.
