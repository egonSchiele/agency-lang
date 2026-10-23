# Subagent budgets

A budget is a parameter on the subagent tool call, enforced by the
stdlib agent's own `@guard` decorator (`std::strategy`). The harness does
not guard the turn.

## Where a budget comes from

- The `--max-time` and `--max-cost` flags cap the whole agent process. The
  runtime installs them as a root budget before any Agency code runs
  (`installRootBudget`, `lib/runtime/node.ts`), and a root budget cannot
  be granted more.
- `researchAgent`, `explorerAgent`, and `oracleAgent` take `maxSeconds`
  and `maxDollars`. The coordinator fills them in from the user's words.
  Each wrapper (`brains/coordinator/subagents/*.agency`) converts them in
  one line before it calls the stdlib agent:

  ```
  const maxTime = if maxSeconds == null then 30m else maxSeconds * 1s
  ```

  and passes `maxCost: maxDollars ?? $50.00`. Unset means the default the
  wrapper names, which is the stdlib agent's own default.

`codeAgent` runs on fixed internal budgets and does not take the
parameters yet.

## The decorator

Every stdlib agent with a budget carries the decorator:

```
import { guard } from "std::strategy"

@guard(cost: maxCost, time: maxTime)
export handoff def oracleAgent(question: string, maxCost: number = $20.00, maxTime: number = 15m, ...): Result<string> {
  return consider(question: question, ...)
}
```

`guard` runs the body under a `guard` block labelled with the function's
name (or `label:`), answers that guard's trip itself, and reports through
`_budgetOutcome` (below). It is the one place the three rules are applied.

An agent that post-processes its guarded result cannot call the decorator
inline: `guard(...) {` is always the block form. Such an agent puts the
guarded part in a hidden inner def that carries the tag, with an explicit
`label:` so the guard keeps the agent's name.

## When a budget runs out

1. The decorated agent's guard trips and raises `std::guard`.
2. The decorator's handler is the innermost one on the chain. It matches
   the trip by its label, remembers the trip's data, and rejects. A
   rejection ends the consultation (`lib/runtime/interrupts.ts`, the
   handler loop), so no outer handler sees this trip: not the caller's,
   and not `guardStopHandler` (`lib/budget.agency`). `guardStopHandler`
   stays for guards that are not decorators, so no trip parks the turn on
   an unanswered interrupt.
3. The guard converts the rejection into a failure, or into a success
   carrying whatever partial reached it. The decorator reports that by the
   rule below.
4. For a handoff agent, the tool loop pushes the stopped-handoff resume
   message (`finishStoppedHandoff`, `lib/runtime/handoff.ts`) for a
   failure: the subagent stopped, why, and that its work is in the
   messages above. The coordinator's next request follows as after any
   tool.

Because the decorator answers its own trip, a caller cannot give a
decorated agent more budget, and `agency run --interactive` never asks.
A caller that wants more passes a larger `maxTime` or `maxCost`.

The whole-turn guard that used to wrap the coordinator's own loop is gone:
rejecting it unwound the coordinator along with the subagent, so nothing
could pick the research up from the thread. It also took the mid-run
"give me more time?" prompt with it.

## The rule

`_budgetOutcome(name, guarded, trip)` (`stdlib/index.agency`) takes the
guard's Result and the trip's interrupt data (`null` when the guard did
not trip). It is a pure function in the prelude, so the rule is written
once.

1. **No trip.** The guard's Result, except that a finished `""` is a
   failure, "it returned no answer". An empty list is a clean result, not
   "no answer".
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

## How the decorator keeps in-flight drafts away from its guard

Rule 2 trusts that anything reaching the guard is a completed answer. The
runtime cannot check that. A draft the model saves halfway through its
work and a finished attempt look the same: both are `saveDraft` values,
and both travel up the same two ways, by return position or through a
`finalize` (`docs/dev/runtime/saveDraft.md`). An assignment drops a
callee's draft, and the stopped caller returns its own draft instead.

When the model calls the `saveDraft` tool, the draft is filed on the frame
running the `llm()` call (`tests/agency/guards/savedraft-tool-basic.agency`).
Most agents call a def that ends in `return llm(...)` and return that call,
so without help the draft rides all the way up. Before the decorator, the
review of this work found twelve of the seventeen agents carrying the
model's draft to their guard this way, through return position or a
`finalize`.

The decorator owns the fix. By default its guard block does

```
const answer = block()
saveDraft(answer)
return answer
```

A draft from anywhere in the body stops at that assignment. The guard
block has saved nothing of its own yet, so the guard returns its plain
failure, and rule 3 puts the trip's `draftValue` in the failure's data. A
body that finishes reaches `saveDraft(answer)`, so the finished answer
survives a trip in the one step before the guard block returns. So a
decorated body may return its call directly, or `return` from inside a
`thread` block, and an in-flight draft still never becomes the answer.

`@guard(..., draftsAreAnswers: true)` skips the assignment, so the body's
draft reaches the guard by return position. It is only safe when every
draft the body can send up is a finished answer. Two agents use it:

- **The researcher** (`stdlib/agents/researcher.agency`) returns
  `researchLoop(...)`, which returns `revise(...)`. The model's drafts land
  in the `revise` block's frame and stop at `result = block(feedback)`
  inside `revise`. What `revise` sends up is its own draft: it saves each
  completed attempt (`stdlib/strategy.agency`).
- **`agencyCodingAgent`** (`stdlib/agents/agency/coding.agency`), in its
  inner def `agencyCodingUnderBudget`, returns `generateLoop(...)` from
  inside its thread, and `generateLoop` returns `revise(...)`. What reaches
  the guard is the last `WriteOutcome` `revise` saved, a finished attempt
  even when it is invalid.

Setting `draftsAreAnswers: true` on a body whose model can save a draft
brings the old bug back, and nothing checks it. Leave it off unless the
body's drafts all come through something like `revise`.

## What a trip returns, by agent

| Agents | On a trip with only an in-flight draft |
|---|---|
| researcher, `agencyCodingAgent` | the last completed attempt, as a success with the note; a failure when no attempt completed |
| oracle, explorer, Agency researcher, coding, data, expert, Agency expert, planner, writing rewrite | a failure naming the budget, with the draft in `data.draft` |
| review, TypeScript review, Agency review, verifier, Agency verifier | a failure, which `failOpenFeedback` turns into `success([])` |
| writing review | the failure; its `failOpen` flag decides as before |

The seven agents that post-process their guarded result (the five
reviewers and verifiers above, the writing review, and
`agencyCodingAgent`) keep their exported def and move the guarded part
into a non-exported inner def named `<agent>UnderBudget`, which carries the
tag with the agent's own label. The writing rewrite needed no inner def: it
returns the reviewer's failure from inside its loop, and the decorator
passes a failure the body returns through unchanged.

**Known gap: a reviewer's partial findings are lost on a trip.** Before
the decorator, a reviewer that ran out of budget returned the findings the
model had saved so far. Now the trip is a failure and `failOpenFeedback`
reports no findings. Getting them back would mean reading `data.draft` as
a `Feedback[]` in `failOpenFeedback`, which is not done.

**Known gap: a trip during `sleep()` bypasses the handler.** A time guard
that fires while `sleep()` is running cancels the sleep directly, and no
handler sees a `std::guard` interrupt. The decorator then has no trip
data, so `_budgetOutcome` takes rule 1 and returns the guard's own Result
unchanged. For a body with nothing finished, that is the guard's plain
failure, "Guard 'oracleAgent' exceeded its time budget: ran 100.9ms of
100ms.", with `GuardFailureData` and no `draft`. For a
`draftsAreAnswers` body with a finished attempt, it is the success
without the note. The outcome is still right; only the wording and the
draft are missing. No stdlib agent sleeps inside its budget today.

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
6. `budgeted`, the coordinator's wrapper at the time, saw the trip and
   returned "its time budget of 30m ran out". The coordinator wrote a
   recap instead of the answer.

Step 3 was the missing piece. `revise` now saves each completed attempt,
so step 3 returns it, and the decorator (with `draftsAreAnswers: true`)
lets it reach the guard, which returns it as a success that rule 2
reports.

## Tests

- `tests/agency/guards/guard-decorator.agency`: the decorator against each
  agent shape: a direct return and a thread return that save a draft and
  trip, a trip with nothing saved, a recovered `revise` answer with and
  without a thread, an outer budget that runs out inside an inner
  decorated call, a label override, a finished answer, an empty answer,
  an empty list, a failure the body returns, and the reviewer shape (an
  inner decorated def whose trip the outer def turns into no findings).
- `tests/agency/guards/revise-salvages-completed-attempt.agency`: `revise`
  under a guard that trips in the check, in an attempt, or in a later
  attempt, and the `agencyCodingAgent` shape.
- `lib/agents/agency-agent/tests/turn.agency`:
  `budgetTripIsHardStopAndBrainContinues`.
- `tests/agency/guards/unowned-guard-rejected.agency`: `guardStopHandler`.
- `tests/agency-js/handoff/`: `failureInside`.
