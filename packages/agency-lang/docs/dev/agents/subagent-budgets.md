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
  Each wrapper (`brains/coordinator/subagents/*.agency`) passes
  `maxTime: timeBudget(maxSeconds, 30m)` (`brains/coordinator/lib/budgets.agency`,
  seconds to milliseconds) and `maxCost: maxDollars ?? $50.00` to the
  stdlib agent. Unset means the default the wrapper names, which is the
  stdlib agent's own default.

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

The decorator lives in `std::strategy`, beside `revise` and `retry`, and
not in the prelude. Every file that uses it says so in an import line, so
a file's own `def guard` cannot silently replace it, and the prelude does
not grow a name only the agents use.

An agent that post-processes its guarded result cannot call the decorator
inline: `guard(...) {` is always the block form. Such an agent puts the
guarded part in a non-exported inner def that carries the tag, with an
explicit `label:` so the guard keeps the agent's name.

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
4. For a handoff agent that failed, the tool loop pushes the
   stopped-handoff resume message (`finishStoppedHandoff`,
   `lib/runtime/handoff.ts`): the subagent stopped, why, and that its work
   is in the messages above. The coordinator's next request follows as
   after any tool.

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
2. **A trip, and a value reached the guard.** That value, as a success.
   A draft that reaches the guard is the backup answer: that is what
   `saveDraft` is for, and the agent prompts promise it ("the most recent
   draft is what the caller receives"). The value can be a finished
   answer, such as the last attempt `revise` saved, or a draft the model
   saved halfway through. A string gets one line appended:
   `[researcherAgent: the time budget ran out, so this answer may be unfinished or unchecked. It is the best answer so far.]`
3. **A trip, and nothing reached the guard.** A failure naming the
   budget, "its time budget of 30m ran out", with
   `{ dimension, limit, draft }` in its data. `draft` is the trip's
   `draftValue`: the innermost draft saved anywhere on the stack when the
   guard tripped (`draftPreview`, `lib/runtime/guardTripInterrupt.ts`).

Rule 2 returns a success, and not a failure carrying the draft, because a
model calling the agent as a tool only sees a failure's message. The tool
loop's `recordFailure` (`lib/runtime/prompt.ts`) shows `failed.error` and
never `data`, so a draft in the data would be lost to the coordinator.

The message in rule 3 is built from the trip, never from the guard's
Result. A guard whose `finalize` returned an empty local hands back
`success(null)`, which has no error to reuse.

## How a draft reaches the guard

The decorator's guard block is `return block()`, so the body's partial
result travels to the guard by the ordinary salvage rules
(`docs/dev/runtime/saveDraft.md`): return position passes a callee's draft
through, a `finalize` hands its return value up, and an assignment without
a `finalize` drops it.

When the model calls the `saveDraft` tool, the draft is filed on the frame
running the `llm()` call (`tests/agency/guards/savedraft-tool-basic.agency`).
So an agent whose inner def ends in `return llm(...)` passes the model's
draft to the guard when its body returns that call, directly or from
inside a `thread` block:

- **The oracle, the explorer, and the Agency researcher** return
  `consider(...)`, `survey(...)`, or `answer(...)`.
- **The coding, data, expert, and Agency expert agents** return their
  inner call from inside their `thread` block.
- **The planner** saves its summary after each step with `saveDraft`, in
  the decorated body itself.
- **The researcher** returns `researchLoop(...)`, which returns
  `revise(...)`. `revise`'s `finalize` hands back the last completed
  attempt, or, before any attempt completes, the draft the unfinished
  attempt saved (`stdlib/strategy.agency`).

An agent that assigns its model's result without a `finalize` drops the
draft there, and a trip becomes a failure. Writing a new agent, return the
call, or assign it and hand the local back through a `finalize`.

**Known gap: a trip during `sleep()` bypasses the handler** (ticket
ADI-137). A time guard that fires while `sleep()` is running cancels the
sleep directly, and no handler sees a `std::guard` interrupt. The
decorator then has no trip data, so `_budgetOutcome` takes rule 1 and
returns the guard's own Result unchanged: a saved draft comes back as a
success without the note, and with nothing saved the result is the guard's
plain failure, "Guard 'oracleAgent' exceeded its time budget: ran 100.9ms
of 100ms.", with no `draft`. No stdlib agent sleeps inside its budget
today.

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

Step 3 was the missing piece. `revise` now has a `finalize` that hands
back the last completed attempt, so step 3 returns it, the researcher
returns it in return position, the guard returns it as a success, and
rule 2 reports it.

## Tests

- `tests/agency/guards/guard-decorator.agency`: the decorator against each
  agent shape: a direct return and a thread return that save a draft and
  trip (the draft is the answer), a trip with nothing saved, a recovered
  `revise` answer with and without a thread, an outer budget that runs
  out inside an inner decorated call, a label override, a finished
  answer, an empty answer, an empty list, and a failure the body returns.
- `tests/agency/guards/revise-salvages-completed-attempt.agency`: `revise`
  under a guard that trips in the check, in a first attempt with and
  without a saved draft, or in a later attempt, and the
  `agencyCodingAgent` shape.
- `lib/agents/agency-agent/tests/turn.agency`:
  `budgetTripIsHardStopAndBrainContinues`.
- `tests/agency/guards/unowned-guard-rejected.agency`: `guardStopHandler`.
- `tests/agency-js/handoff/`: `failureInside`.
