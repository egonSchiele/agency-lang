# Plan: four fixes for `agency agent -p` runs (ADI-383, ADI-384, ADI-385, ADI-386)

The agency-plans sweep turned up four ways a one-shot run (`agency agent -p`)
goes wrong. This plan covers all four. They ship as two PRs from the branch
`adit/adi-383-386-agent-runs`:

| PR | Part | Ticket | Effort | Impact |
| -- | -- | -- | -- | -- |
| 1 | 1 | ADI-384: time limits don't count model time | medium | high |
| 2 | 2 | ADI-386: a `-p` run stops with the work unfinished | medium | high |
| 2 | 3 | ADI-385: a model calls `saveDraft` forever | small | medium |
| 2 | 4 | ADI-383: a research step ends the run | small | medium |

Part 1 gets its own PR, and it goes first, for two reasons:

1. It changes time accounting for every Agency program, so it deserves a review
   about nothing else.
2. It will move eval results by itself: runs will end at their time limit, and
   subagents will hit theirs. If the other parts landed with it, nobody could
   tell which change moved a score.

PR 2 branches from PR 1. Both go out in the same release.

---

## Part 1. ADI-384: time limits don't count model time

**Effort: medium.** The code change is small: `halt` stops pausing the clock,
and the few places where a run stops pause it instead. Most of the work is a
new test for interrupts that go to a person, and confirming where a run stops.

**Impact: high.** Time limits start working in every program that has a
callback. That includes `--max-time` and the subagents' own budgets. See
"What this turns on" below for the numbers, because it needs a decision.

### What I found

I reproduced the bug with this program:

```
let loud = false

def isLoud(): boolean {
  return loud
}

callback("onLLMCallStart") as data {
  if (isLoud()) {
    print("starting")
  }
}

node main() {
  const r: string = llm("go")
  print(r)
}
```

I ran it with a scripted model reply that takes 4 seconds:

```
AGENCY_LLM_MOCKS='[{"return":"done","delayMs":4000}]' agency run --max-time 1s k.agency
```

It printed `done` and exited 0 after 5 seconds. Delete the callback and the
same command stops at 1 second with "Exceeded time limit" and exit 3.

So a time limit does not count the time the program spends waiting on a
model, as long as a callback runs some Agency code just before the request.
The agent has such callbacks. `lib/agents/agency-agent/lib/trace.agency`
registers `onLLMCallStart`, `onToolCallStart`, and others, and they call small
functions like `isVerbose()` and `debugOn()`. So in the agent, almost no model
time is counted. The qwen run that took 95 minutes spent about 76 of them
waiting on model replies, and its 60-minute limit never tripped.

### Why it happens

A time limit counts "working time". It has a clock that can be paused. These
things are meant to pause it:

- `input()` pauses it while waiting for the user to type.
- An interrupt pauses it while waiting for a person to answer.
- A `fork` pauses the parent's clock and gives each branch its own copy.

`sleep()` does not pause it. Time spent sleeping counts.

In compiled code, a `return` statement becomes `runner.halt(value)`. `halt`
was written for interrupts, and it pauses every time limit on the stack
(`lib/runtime/runner.ts`, `halt`):

```ts
halt(result: any): void {
  this.stack?.guards.forEach((g) => g.pause());
  this.halted = true;
  this.haltResult = result;
}
```

The clock starts again when Agency code enters its next step:
`Runner.beforeStep` restarts every time limit, and `step`, `hook`, `pipe`,
`thread`, and `fork` all call it first. In normal code that happens right
away: the function returns, and the caller's next step starts the clock.

A callback is different. The runtime calls it from TypeScript, just before it
sends the request. The callback calls `isLoud()`, and `isLoud()` returns, so
the clock pauses. Then the runtime sends the request and waits. No Agency code
runs during the wait, so the clock stays paused for the whole request. The
time limit's timer is cancelled too, so the request is never cut off.

I confirmed this by logging every pause and restart of the root time limit
during a scripted agent run. The last pause before a 9-second model call came
from `Runner.halt`, called from the compiled `traceSettings.agency`. The clock
started again only after the reply came back.

These all stopped on time under `--max-time 1s`, so they are not the cause:

- a loop of `sleep` calls inside a `guard()` block
- `sleep` calls inside `fork` branches
- a loop of interrupts answered by a handler
- a tool loop whose tool sleeps
- a `@guarded` `handoff def` subagent with its own tool loop
- `try`, `handle { } with handler`, and `cliPolicyHandler` around a slow model call
- the real agent calling the code agent four times, where each call ran `sleep 3` in bash

The ticket's lead, that a subagent's own time budget hides the root one, was
wrong. A subagent's time is added back to the main clock correctly.

The existing `--max-time` tests in `lib/cli/budgetRun.spawn.test.ts` missed
the bug because their slow part is always `sleep()`. None of them waits on a
model, and none has a callback.

### How an interrupt keeps the clock paused today

Removing the pause from `halt` is only safe if something else still pauses the
clock when an interrupt goes to a person. Today that works by accident.

A halt does not end a function body right away. A compiled body is a list of
`await runner.step(...)` calls. After a halt, each later step is still
entered. It calls `beforeStep`, which restarts the clock, and only then sees
that the runner halted and skips its body.

When a call returns interrupts, the caller halts too. `typescriptBuilder.ts`
emits this after the call (near line 3758), and `Runner.pipe` does the same
(`runner.ts:665`):

```ts
if (hasInterrupts(__funcResult)) {
  runner.halt(__funcResult);
  return;
}
```

So when a function two calls deep raises an interrupt that goes to a person,
the clock goes back and forth:

```
def inner() {
  interrupt std::env("ok?", {})   // halt: the clock pauses
  print("after")                  // skipped step: beforeStep restarts it
}

def outer() {
  inner()                         // sees interrupts, halts: the clock pauses again
  print("more")                   // skipped step: the clock restarts
}
```

Each caller's halt pauses the clock again after the skipped steps restarted
it. If `halt` simply stopped pausing, the last skipped step would leave the
clock running while the program waits on a person. A `--max-time 60m` run
that waits 61 minutes for an approval could trip while the person is still
deciding.

### The change

`halt` stops pausing the clock, for a `return` and for an interrupt. Instead,
the clock pauses once, at the point where a run really stops and hands its
interrupts to the host. Skipped steps that restart the clock no longer matter,
because the pause comes after all of them.

`runBatch` already works this way for branches. `pauseBranchTimeGuards`
(`lib/runtime/runBatch.ts`) pauses a branch's clock when the branch settles and
on an interrupted exit, whichever statement halted.

**Found while building: the stop already ends the clock.** Every place a run
stops with interrupts (a node run, a resumed run, an exported function, a
`PauseSignal`, a debugger stop, a `spawn` question held for `agency attach`)
ends the run's leg. Every leg ends in `finalizeExecCtx`, which calls
`RuntimeContext.cleanup`, and `cleanup` pops every guard, timer included. The
resume is a new leg that restores the guards from the checkpoint. So there
is no live clock left to pause, and the change is only this: `halt` stops
pausing. No new method was needed. The new agency-js test passes before and
after the change.

The checkpoint is still right. It is captured when the interrupt is raised,
while the clock is running. `TimeGuard.toJSON` saves `currentElapsed()`, which
includes the time since the clock last started (`lib/runtime/guard.ts:824`).

I am not patching `beforeStep` to skip a halted runner. That would keep the
pause in `halt` and keep a list of every place that halts for an interrupt,
which a new raise site could forget.

### What this turns on

Today the subagents' default time limits count almost no model time, because
the agent's callbacks run before every model call. After this change they
count it. I measured how long each subagent call took in the two sweeps (113
runs). Those times now count in full:

| Subagent | Default limit | Calls | Calls longer than the limit | Runs with such a call | Longest |
| -- | -- | -- | -- | -- | -- |
| `codeAgent` | 15 min | 167 | 27 | 23 | 29.8 min |
| `agencyCodeAgent` | 15 min | 21 | 2 | 2 | 26.6 min |
| `oracleAgent` | 15 min | 18 | 0 | 0 | 7.5 min |
| `researchAgent` | 30 min | 2 | 0 | 0 | 0.8 min |
| `explorerAgent` | 30 min | 1 | 0 | 0 | 1.1 min |

So about 1 coder call in 6 would now stop at 15 minutes, in about 1 run in 5.
A stopped coder hands back its saved draft, or a failure that names the
budget. The coordinator then continues. With Part 2, a `-p` run whose
coordinator then reports unfinished work gets another turn.

This is a decision for you: keep the 15-minute coder default, or raise it.
The data says 30 minutes would have covered every coder call in the sweeps.
I would keep 15 for this PR and decide after the next sweep. That way PR 1
changes one thing: time limits count model time.

### Tests

**Interrupts that go to a person.** A new agency-js test, written and run
before the change:

1. `outer()` calls `inner()`. Both have statements after the call.
2. `inner()` raises an interrupt that no handler answers, so it goes to the
   TypeScript caller.
3. The clock moves past the time limit before the caller answers.
4. The caller approves, and the run finishes with no trip.

The test uses the fake clock if agency-js tests can use it. If they can't, it
uses a real 1-second limit and waits 2 seconds before answering. If this test
fails before the change, that is a second bug, and I will report it before
going on.

**Callbacks and model waits.** Two integration tests in
`lib/cli/budgetRun.spawn.test.ts`, beside the existing `--max-time` tests. Both
run the built CLI as a child process, like the tests already there.

Neither test can hang CI, because the slow work ends on its own. The scripted
model reply takes a fixed time and then returns. If the limit works, the run
exits 3 early. If the limit is broken, the run finishes normally a few seconds
later, and the test fails. The harness also kills the child after 60 seconds
as a backstop. Neither test needs an API key or the network.

1. **`agency run`.** The program above, with a scripted reply that takes 8
   seconds, under `--max-time 2s`. It expects exit 3 and "Exceeded time
   limit". Today it exits 0 after about 9 seconds.
2. **`agency agent -p`.** The real agent with scripted replies, under
   `--max-time 5s`. The coordinator's reply takes 9 seconds. It expects exit 3
   after about 5 seconds. Today it exits 0 after about 12 seconds. I ran
   exactly this by hand while investigating. The router makes the first model
   call, so the scripted replies need one queue for `router`, holding a
   `{ decide }` entry, and one for everything else. The test uses a throwaway
   `--agent-home` and `HOME`.

Together these add about 15 seconds to the spawn tests.

**Existing tests that must pass unchanged:** the fake-clock guard tests in
`tests/agency/guards/` (including the fork time tests, which cover a function
returning inside a branch), `tests/agency/handlers/handler-guard-trip.agency`,
and `guard-time-input-wait-free.agency`.

### Docs

`docs/dev/runtime/interrupts.md` gets a short section:

- A `return` does not pause the clock.
- A run pauses its clock once, at the place where it stops.
- A callback is why this matters.

---

## Part 2. ADI-386: a `-p` run stops with the work unfinished

**Effort: medium.** The loop in `oneShot` is small. The work is the
measurement step and a test that runs the real agent with scripted replies.

**Impact: high.** The two runs in the ticket stopped early with most of their
budget left. Both would have kept going.

### What happens today

In `-p` mode, the run ends as soon as the coordinator's `llm()` call returns
text. Nothing checks whether that text says the work is done. The ticket has
two runs.

**GLM.** The coordinator's last reply was "Tasks 4–5 are committed.
Continuing with Tasks 6–10: end-to-end generator fixtures and execution
tests." That reply ended the run, after 49 minutes and $0.64 of $10.

**Terra.** The code agent made 100 rounds of tool calls, reached its round
limit, and wrote "The plan is not fully implemented." The coordinator got
this message back:

```
[codeAgent finished. **PLAN.md is not fully implemented.** ...]
Continue with the user's request.
```

It says "finished", because the code agent did return an answer. The
coordinator passed it on, and the run ended after 29 minutes and $1.56 of $10.

The ticket says that in most of the 23 runs where a coder neared its round
limit, the coordinator did send the work back. That is the model choosing
well, not the agent making it happen. The fix should not depend on the
coordinator choosing.

### The change

When a `-p` turn ends, `oneShot` (`lib/agents/agency-agent/agent.agency`)
asks the router's decision model one question about the coordinator's last
reply. The question runs on its own thread, the way `askRouter` does, so the
conversation is not changed:

```
type ReplyState = "finished" | "unfinished" | "blocked"

thread(label: "end-check") {
  userMessage(reply)
  const state: ReplyState = llm(END_CHECK_QUESTION, { ...modelOptions(model, provider), type: "decision", retries: 0 })
}
```

The question text:

```
That was the last reply an agent wrote at the end of a task. Nobody is
watching the run, so the agent cannot ask a question and wait for an answer.
Which one is true?
finished: the reply says the task is done.
unfinished: the reply says work remains that the agent could still do now,
for example "continuing with the next tasks" or "not fully implemented".
blocked: the reply says the agent cannot go on without something it does not
have, such as access, a decision, or an answer from a person.
```

The third label is there because a reply that asks a question, or reports a
blocker, is neither finished nor something a nudge can fix.

What happens with the answer:

- `"finished"` or `"blocked"`: the run prints the reply and ends, as today.
- `"unfinished"`: the agent runs one more turn with this message:

  ```
  The task is not finished. Continue it now, or say why you can't.
  ```

The agent asks at most 2 times per run.

The check is skipped, and the run ends as today, in these cases:

- No router model is set.
- The question fails.
- The turn itself failed. In that case `oneShot` holds an error message from
  `formatTurnFailure`, for example because the root budget ran out. There is
  nothing to continue.
- The run used a start target (`target != ""`). That turn runs a program, not
  the brain.

### The extra turn skips the router

`oneShot` reaches the coordinator through `runTurn`, then `dispatchToBrain`,
then `answerTurn`, then `coordinatorBrain`. `coordinatorBrain` asks the router
about any short plain-text message. The router would see only "The task is not
finished…" and could send it to the coder or the researcher. The Terra case
needs the coordinator, because the coordinator is the one that sends work back
to the coder with the right brief.

The agent already has a way to skip routing. When the harness changes the
user's message, `dispatchToBrain` calls `setMessageRewritten(true)`, and
`routerModelFor` (`lib/agents/agency-agent/lib/answer.agency`) then passes no
router model for that turn. The continue message is also text the user did
not type, so it uses the same flag.

I will add `runContinueTurn(message)` to `lib/agents/agency-agent/lib/turn.agency`,
beside `runTurn`. It:

1. calls `setMessageRewritten(true)`,
2. skips `expandSlash`, the project-context block, and attachment detection,
   because the message is the harness's, not the user's,
3. calls `answerTurn` with the message, under the same `guardStopHandler` that
   `runTurn` uses.

### Measure the check before wiring it in

The check is a model's judgment, so it can be wrong in both directions:

- A wrong `"unfinished"` costs up to 2 coordinator calls over the whole
  conversation.
- A wrong `"finished"` leaves the run where it is today.

The sweeps hold 113 final replies (`evalOutputRecorded` in each run's
`statelog.jsonl`). The first build step runs the question over all of them
with the default router model. It reports how many come out in each label.
I will read every `"unfinished"` and every `"blocked"`, plus a sample of the
`"finished"` ones, and count the mistakes. The numbers go in the PR
description. If more than a few finished replies come out `"unfinished"`, I
will stop and bring the question back to you before wiring it in.

### What I am not doing

- **The coder continuing on its own after its round limit.** For `-p`, the
  check covers it. In an interactive session, the user can say "keep going."
- **Raising the coder's 100-round limit** (the ticket's option 3). It only
  moves the problem.

### Tests

1. The ticket's "done when": a `-p` run whose scripted coordinator first
   replies "continuing with the next tasks", then finishes. The scripted check
   answers `"unfinished"`, then `"finished"`. The run's output is the second
   reply. The router's queue holds exactly one routing entry, the first
   turn's, plus the two check entries. That proves the extra turn skipped
   routing. This is a spawn test of the real agent, like Part 1's test 2.
2. A check that answers `"finished"` makes no extra turn.
3. A check that answers `"blocked"` makes no extra turn.
4. A check that answers `"unfinished"` three times makes exactly 2 extra
   turns, then ends.
5. A run with no router model makes no check.
6. A turn that failed makes no check.

### Docs

`docs/dev/agents/agent-brains.md` gets a section on `-p`:

- the end check, its three labels, and which model it asks
- the limit of 2 extra turns
- why the extra turn skips routing
- why a failed check never blocks the end of a run

---

## Part 3. ADI-385: a model calls `saveDraft` forever

**Effort: small.** The changes go in `lib/runtime/toolLoopGuards.ts` and the
tool loop, with tests against the existing scripted client.

**Impact: medium.** It fixes two runs. One ran into the eval's 2-hour kill
limit, so all its work was lost. With Part 1, the time limit would also have
ended these runs, but only after 60 minutes of wasted calls.

### What I found

In the GLM layout-table run, the code agent made 100 requests that offered 12
tools. Then it made 294 requests that offered exactly 1 tool, and it called
that tool every time. The tool was `saveDraft`.

100 is the code agent's round limit. When a call reaches its round limit, the
tool loop stops offering tools, so the model has to answer in text. That is
the rule from ADI-46 (`toolsOffered` in `lib/runtime/toolLoopGuards.ts`). But
the rule keeps one kind of tool: the "intrinsic" tools, and `saveDraft` is the
only one. The tool loop handles an intrinsic call itself, and intrinsic calls
ignore the round limit. The loop's comment says so: "Intrinsics deliberately
ignore maxToolCallRounds".

So at the limit, the model is offered `saveDraft` and nothing else. The
tool's description tells it to save "whenever you complete a meaningful piece
of work". GLM called it, the loop ran it and asked again, and nothing ever
ended the loop. The "rounds used up" refusal never fired, because `saveDraft`
was offered, so calling it broke no rule.

The repeated-call guard did not catch it either. That guard runs only for
ordinary tool calls, and intrinsic calls skip it.

### The change

1. **At the round limit, offer no tools at all.** `toolsOffered` returns an
   empty list at the limit, `saveDraft` included. A draft saved at the limit
   is useless: the next thing the model writes is the call's answer anyway.
2. **The round limit applies to intrinsic calls.** At the limit, a
   `saveDraft` call gets the same "rounds used up" refusal as any other call
   and is not run. This matters for a provider that returns a tool call it
   was not offered.
3. **A backstop for a model that keeps calling tools.** If a request at the
   limit returns tool calls, the calls are refused, as today. If the next
   request returns tool calls again, the `llm()` call ends with a failure:
   "The model kept calling tools after its 100 tool rounds were used up."
   Today, nothing bounds this.

None of these name a tool. Rules 1 and 2 remove the exception for intrinsic
tools, and rule 3 applies to every call.

The backstop's count has to survive an interrupt and a resume, because
`docs/dev/agents/promptRunner.md` requires tool-loop decisions to be durable.
The count lives on the `runPrompt` frame, beside `toolCallRound`, and the
failure is decided inside a step.

### What the caller gets

In the normal case, a model at the limit is offered no tools, so it answers in
text, and that answer is the result. It is newer than any draft.

In the backstop case, the call ends with a failure, and a draft the model
saved earlier is lost. For example, if the coder saved a real draft at round
40 and then kept sending tool calls at the limit, its caller gets only the
failure. The `@guarded` decorator hands back a draft only when a budget trips,
and this is not a trip. Returning the draft here would need the tool loop to
read the `saveDraft` slot, which is a special case for one tool. The ticket
asked for the draft. I am not providing it in this case, because rule 1 makes
the case rare: the model would have to send a tool call it was not offered,
twice in a row.

### What I am not changing

Below the round limit, a model can still call `saveDraft` every round. Each
such round counts toward the limit, so it ends at the limit like any other
loop. Test 4 below checks that.

### Tests

In `lib/runtime/prompt.toolRounds.test.ts`, with its scripted client and a
round limit of 3:

1. The request at the limit offers no tools, even when `saveDraft` is in the
   tool list.
2. A model that calls `saveDraft` at the limit gets the refusal, and the draft
   is not saved.
3. A model that keeps returning tool calls at the limit ends the call with
   the failure after the second such request.
4. Rounds that call only `saveDraft` count toward the limit: three of them,
   and the fourth request offers no tools.

### Docs

`docs/dev/agents/tool-loop-guards.md` changes in the round-limit section: no
tools at the limit, the backstop, and what happens to a draft.

---

## Part 4. ADI-383: a research step ends the run

**Effort: small.** It deletes the `endTurn()` call, adds a `handBack()`
message, and adds two tests with scripted replies.

**Impact: medium.** Only two runs in the sweep called research, and one of
them lost its whole task this way. But any task that starts with a research
step can hit it.

### What happens today

`researchAgent` (`stdlib/agents/brains/coordinator/research.agency`) calls
`endTurn()` when research succeeds and it was called as a tool. That makes the
research answer the reply to the user and ends the coordinator's turn. In
`-p` mode, that ends the run.

The haiku layout-table run asked research for a "read-only check" as a first
step. The run ended with the research report and no code.

The `endTurn()` came in before research was a handoff. Its comment explains
why: the coordinator used to read the research answer as a message to itself
and write "the report above stands" to a user who never saw the report.

When the router sends a turn straight to research, research is called from
code, not as a tool, and its answer is already the turn's reply. That path
does not change.

### The change

Research never ends the turn. I am not doing the ticket's option 1, an
argument that says "this answers the user", because it asks the coordinator
model to choose.

Research is a handoff, so its work lands on the coordinator's conversation.
To keep the old problem from coming back, research sets its own hand-back
message with `handBack()`. Handoffs already support it, and this is its first
use:

```
[researchAgent finished. The user has not seen this answer.]
<the answer>
If it answers the user's request, reply with it in full. Otherwise continue
with the request.
```

### What the user sees

The user does not see the research answer unless the coordinator repeats it.
That is true in both modes:

- **`-p`:** only the final reply is printed.
- **Interactive:** the terminal prints a model reply as it arrives only when
  the reply carries tool calls, or when verbose or debug is on (`onLLMCallEnd`
  in `lib/agents/agency-agent/lib/trace.agency`). The researcher's final
  answer has no tool calls, so it is not shown. The REPL prints the turn's
  reply, which is now the coordinator's.

So "reply with it in full" is the right wording in both modes, and there is
one wording.

The cost: a pure research question asked through the coordinator now takes
one more coordinator call, whose job is to copy the report. This is a prompt,
so the coordinator may summarize instead of copying. Test 2 catches that.

### Tests

1. A scripted coordinator calls `researchAgent`, then calls `codeAgent`. The
   run continues past research and the coder runs. This is the ticket's "done
   when". It fails today.
2. A scripted coordinator calls `researchAgent` with a long scripted research
   answer, and then replies. The test checks that the message the coordinator
   got back contains the whole answer, and that the final reply contains the
   answer's last line. A coordinator script that summarizes fails it.

---

## Decisions I need from you

1. **Part 1, the coder's time limit:** keep the 15-minute default for now, or
   raise it. About 1 coder call in 6 in the sweeps ran longer than 15
   minutes. I would keep it and decide after the next sweep.
2. **Part 1, the design:** `halt` never pauses the clock, and a run pauses it
   once where it stops.
3. **Part 2:** the end check, with three labels, at most 2 extra turns, using
   the router model, measured on the 113 sweep replies before it is wired in.
4. **Part 3:** no tools at the round limit, `saveDraft` included, and a
   failure if the model keeps calling tools there. The earlier draft is lost
   in that case.
5. **Part 4:** research never ends the turn, with a hand-back that says the
   user has not seen the answer.

## Before each PR

- `make`, because PR 2 changes Agency files.
- `pnpm run typecheck`, `pnpm run lint:structure`, and `pnpm run fmt:ts` on
  the changed TypeScript files only.
- Run only the tests that cover the changed files, with output saved to a
  file. CI runs the rest.
- Check the diff against `docs/dev/contributing/anti-patterns.md`.
- Check that no change in `lib/runtime/` names a tool. Part 3 removes the
  intrinsic exception and adds nothing tool-specific.
