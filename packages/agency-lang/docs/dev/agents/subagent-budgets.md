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
2. **A trip, and a completed answer reached the guard.** The answer, as a
   success. A string answer gets one line appended:
   `[researcherAgent: the time budget ran out before this answer was accepted. This is the best answer so far.]`
   The line says "accepted" and not "verified" because the trip can come
   after a review that rejected the attempt.
3. **A trip, and nothing reached the guard.** A failure naming the
   budget, "its time budget of 30m ran out", with
   `{ dimension, limit, draft }` in its data. `draft` is the trip's
   `draftValue`: the innermost draft saved anywhere on the stack when the
   guard tripped (`draftPreview`, `lib/runtime/guardTripInterrupt.ts`).
   It can belong to a nested agent. When the researcher's guard trips
   inside the `reviewAgent` call that checks its answer, `draft` is
   whatever Feedback list the reviewer had saved.

The message in rule 3 is built from the trip, never from the guard's
Result. A guard whose `finalize` returned an empty local hands back
`success(null)`, which has no error to reuse.

## How an agent keeps in-flight drafts away from its guard

Rule 2 trusts that anything reaching the guard is a completed answer. The
runtime cannot check that. A draft the model saves halfway through its
work and a finished attempt look the same: both are `saveDraft` values,
and both travel up the same two ways, by return position or through a
`finalize` (`docs/dev/runtime/saveDraft.md`). So the agents `budgeted`
wraps are written so that only completed answers can travel up.

The rule: the model's draft must stop at an assignment in a scope with no
`finalize`. When the model calls the `saveDraft` tool, the draft is filed
on the frame running the `llm()` call
(`tests/agency/guards/savedraft-tool-basic.agency`). If that frame's
caller assigns the result and has no `finalize`, the draft is dropped
there, and it reaches `budgeted` only as the trip's `draftValue`.

The four agents `budgeted` wraps:

- **The researcher** (`stdlib/agents/researcher.agency`) returns
  `researchLoop(...)` in return position. The model's drafts land in the
  `revise` block's frame and stop at `result = block(feedback)` inside
  `revise`, which has no `finalize`. What `revise` sends up is its own
  draft: it saves each completed attempt (`stdlib/strategy.agency`).
- **The explorer, the oracle, and the Agency researcher** call a def that
  returns `llm(...)` in return position, so the model's draft rides up to
  the guard block. Each guard block assigns the result, `reply =
  survey(...)`, and has no `finalize`, so the draft stops there. Each
  carries a comment saying why. Changing one to `return survey(...)`
  would carry the model's half-written notes to the guard, and rule 2
  would report them as the answer.

These three used to have `finalize { return reply }` to salvage the
model's draft. A caller that uses one of them directly, without
`budgeted`, now gets the guard's plain failure on a trip. The guard's
failure data has no draft field, so that caller does not see the draft.

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

## Tests

- `lib/agents/agency-agent/brains/coordinator/tests/budgets.agency`:
  `budgeted` with a fake agent per real agent shape: in-flight draft,
  no draft, a recovered `revise` answer, a finished answer, an empty
  answer, and another label's trip.
- `tests/agency/guards/revise-salvages-completed-attempt.agency`: `revise`
  under a guard that trips in the check, in an attempt, or in a later
  attempt, and the `agencyCodingAgent` shape.
- `lib/agents/agency-agent/tests/turn.agency`:
  `budgetTripIsHardStopAndBrainContinues`.
- `tests/agency/guards/unowned-guard-rejected.agency`: `guardStopHandler`.
- `tests/agency-js/handoff/`: `failureInside`.
