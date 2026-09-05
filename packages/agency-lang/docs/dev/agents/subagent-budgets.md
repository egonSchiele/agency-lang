# Subagent budgets

How a deadline or spend limit the user states reaches the subagent that
does the work, what happens when it runs out, and why the harness no
longer wraps the whole turn in a guard.

## The shape

There are exactly two places a budget can come from:

- **The `--max-time` and `--max-cost` flags.** These cap the whole agent
  process. The runtime installs them as a root budget before any Agency
  code runs (`installRootBudget`, `lib/runtime/node.ts`), and a root budget
  cannot be granted more. Nothing in the agent's own code is involved.
- **A parameter on the subagent tool.** `researchAgent`, `explorerAgent`,
  and `oracleAgent` take `maxSeconds` and `maxDollars`. The coordinator
  fills them in from the user's words ("do this in five minutes" becomes
  `maxSeconds: 300`), the wrapper converts them to the milliseconds and
  dollars the stdlib agent takes, and the stdlib agent's own `guard`
  enforces them. When the model sets neither, the wrapper passes the
  stdlib agent's usual default, so the cap is the same as calling that
  agent directly.

The conversion and the stop text live in
`brains/coordinator/lib/budgets.agency`. `codeAgent` still runs on fixed
internal budgets; giving it the same parameters means threading them
through its triage, escalation, and supervision paths, and is not done
yet.

## What happens when a budget runs out

1. The stdlib agent's guard trips and raises `std::guard`.
2. No handler inside the agent owns the trip, so it reaches
   `guardStopHandler` in `lib/budget.agency`, the handler `runTurn` wraps
   every turn in. It prints one line in an interactive session and
   rejects. Rejecting is what makes the budget a hard stop: passing would
   park the turn on an interrupt nobody answers.
3. The guard converts the rejection at its own site into a failure, or
   into a success carrying the saved draft when the agent saved one.
4. The subagent wrapper turns that into the tool's result through
   `agentOutcome`: a failure whose text names the budget that ran out
   ("its time budget of 5m ran out"), and an empty answer is reported as
   a stop rather than a blank success.
5. The coordinator's tool loop pushes the resume message for a stopped
   handoff (`finishStoppedHandoff`, `lib/runtime/handoff.ts`): the
   subagent stopped, why, and that its work is in the messages above from
   the line where it was dispatched onward. The loop then makes the coordinator's next
   request as it would after any tool.
6. The coordinator continues with the user's request from that work. The
   prompt tells it to answer if the work is enough, say what is unfinished
   if not, and not to re-dispatch the same task on its own.

Step 5 is the payoff of the handoff design: a research agent that ran for
four of its five minutes has left every search result on the coordinator's
thread, so the coordinator can answer from them without another call.

## Why the turn guard is gone

The harness used to parse a deadline out of the user's message with an
extra LLM call and wrap the entire turn, the coordinator's own `llm()`
loop included, in a guard labeled `agency-turn`. When that guard tripped
and the user declined more time, the reject unwound the coordinator along
with the subagent, so nothing could pick the research up. In one session
the researcher had finished a complete answer, a review sent it back for
revision, the turn guard tripped during the revision, and the user got a
bare "stopped" line with the research sitting unread in the thread.

The guard was in the wrong place. "Five minutes" limits the research. It
does not limit the coordinator reading what the research found. Putting
the budget on the tool call keeps the coordinator outside it, and the
coordinator decides what the user meant without a separate parsing call.

What was dropped with it: the mid-run "I've used 5m, give me more time?"
prompt. The coordinator can ask the same question with the partial results
in hand, which is a better moment for it.

## Files

- `lib/agents/agency-agent/lib/budget.agency`: `guardStopHandler`.
- `lib/agents/agency-agent/lib/turn.agency`: `runTurn` installs it.
- `lib/agents/agency-agent/brains/coordinator/lib/budgets.agency`:
  `timeBudget`, `costBudget`, `describeStop`, `agentOutcome`.
- `lib/agents/agency-agent/brains/coordinator/subagents/{research,explorer,oracle}.agency`:
  the tool parameters and their docstrings, which are what the model reads.
- `lib/runtime/handoff.ts` and `lib/runtime/prompt.ts`: the stopped resume
  message, pushed for a handoff that fails or comes back aborted.
- `lib/agents/agency-agent/brains/coordinator/prompts/main-*.md`: the
  "Budgets and subagents that stop early" section.
- Tests: `lib/agents/agency-agent/tests/turn.agency`
  (`budgetTripIsHardStopAndBrainContinues`) and
  `tests/agency-js/handoff/` (`failureInside`).
