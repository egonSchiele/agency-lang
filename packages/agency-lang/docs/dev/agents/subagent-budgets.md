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
   remembers it. `guardStopHandler` (`lib/budget.agency`), which `runTurn`
   installs, rejects every trip that reaches the top of the turn, so no
   trip parks the turn on an unanswered interrupt.
3. The guard converts the rejection into a failure, or into a success
   carrying the saved draft. `budgeted` returns a failure naming the
   budget either way ("its time budget of 5m ran out"), because a draft
   returned as a success would be announced as a finished answer.
4. The tool loop pushes the stopped-handoff resume message
   (`finishStoppedHandoff`, `lib/runtime/handoff.ts`): the subagent
   stopped, why, and that its work is in the messages above. The
   coordinator's next request follows as after any tool.

The whole-turn guard that used to wrap the coordinator's own loop is gone:
rejecting it unwound the coordinator along with the subagent, so nothing
could pick the research up from the thread. It also took the mid-run
"give me more time?" prompt with it.

## Tests

- `lib/agents/agency-agent/brains/coordinator/tests/budgets.agency`:
  `budgeted` with a drafting, a finishing, and an empty fake agent.
- `lib/agents/agency-agent/tests/turn.agency`:
  `budgetTripIsHardStopAndBrainContinues`.
- `tests/agency/guards/unowned-guard-rejected.agency`: `guardStopHandler`.
- `tests/agency-js/handoff/`: `failureInside`.
