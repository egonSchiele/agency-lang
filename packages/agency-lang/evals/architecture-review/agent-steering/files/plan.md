# Steering a running agent

Status: draft for review. Nothing here is built.

## What the user sees

The agent is working. The user presses Escape.

```
⠹ Working…
  Pausing after the current step. Press Esc again to cancel the task.
```

The step in flight finishes. Then the agent stops and asks:

```
────────────────────────────────────────────
 Steering: what should I do instead?
 Enter to continue · Esc to cancel the task
 > use the v2 endpoint, not v1▌
```

The user has three choices:

1. Type a message and press Enter. The agent reads the message and carries
   on from where it stopped.
2. Press Enter on an empty line. The agent carries on as if nothing
   happened.
3. Press Escape. The task is cancelled and the terminal prints
   `Task cancelled.` This is what a single Escape does today.

The same Escape pressed before the prompt appears also cancels. So two
quick presses cancel, as one press does now.

## Background

This section describes the parts of the runtime the design uses. Each one
exists today.

### The tool loop and its round boundary

One `llm()` call with tools is a loop. The model replies with tool calls,
the runtime runs them, and the results go back in the next request. One
pass is a round.

Between rounds there is a point where every tool call has a result and the
next request has not been sent. A message may be added to the conversation
there without breaking the rule that a tool result follows its tool call.
The code calls this the round boundary. It is `runRoundBoundary` in
`lib/runtime/turnBoundary.ts:226`, called from `lib/runtime/prompt.ts:1842`.

The boundary already does four things, in order:

1. Adds images that tools returned.
2. Adds messages that were queued on the thread with `queueMessage`.
3. Adds a warning when few rounds are left.
4. Raises any tripped guard, then adds the approver's message.

### A guard trip is an interrupt raised at the boundary

A guard limits cost or time. When a guard is over its limit, step 4 above
raises an interrupt with the effect `std::guard`. The code is
`raiseGuardTripsUntilClear` in `lib/runtime/guardTripInterrupt.ts:44`.

This is the model for steering, because it shows that the tool loop can
stop between rounds, ask a person something, and continue. Three details
matter:

- **A handler can answer in the same process.** The loop awaits
  `interruptWithHandlers`. If a handler approves or rejects, the loop
  continues at once. No checkpoint is restored, and no state changes.
- **With no answer, the run is saved.** The step returns the interrupt, the
  runner stamps a checkpoint, and the run exits. A later resume runs the
  same step again, finds the recorded answer, and applies it.
- **An approval can carry a message.** The message is queued for the branch
  that raised the interrupt and is added before that branch's next request
  (`guardTripInterrupt.ts:230`).

### How `agency agent` answers interrupts

The agent wraps each turn in its policy handler (`stdlib/policy.agency`).
When an interrupt arrives and no rule decides it, the handler shows a
prompt at the bottom of the terminal and waits. That prompt is the
approval prompt users know. It accepts typed text, and Escape cancels the
whole turn (`stdlib/policy.agency:974`).

So in the terminal agent an interrupt never leaves the process. The
program waits at the line that raised it, the user answers, and the
program continues from that line.

### An interrupt that expects a value

Some interrupts ask for an answer, not for permission. The `question` tool
is one. Such an interrupt is marked `expectsValue`. A policy rule cannot
answer it, because a rule's approval carries no value. The handler sends
it to the person every time (`stdlib/policy.agency:1160`), and the prompt
does not offer "approve always".

### Subagents share the coordinator's thread

The code, Agency code, research, oracle, and explorer subagents are
declared `handoff def`. A handoff function called as a tool continues its
caller's conversation. Its `llm()` calls read and write the caller's
thread (`docs/dev/language/handoff-functions.md`).

While the code subagent works, there are two `llm()` calls in progress on
the main thread. The coordinator's call is waiting for the handoff to
return. The subagent's call is the one running rounds.

Other model calls run on threads of their own. The session title has its
own session thread (`lib/agents/agency-agent/lib/sessionTitle.agency:80`).
Compaction uses a hidden thread (`lib/compaction.agency:159`). The review,
writing, and rewrite agents each have a session thread. A branch of a
`fork` or an `async` call gets a new subthread.

### What Escape does today

During a turn the REPL watches for Escape and calls `ctx.cancel`
(`lib/stdlib/cli.ts:1515`). The model request in flight is aborted, the
turn unwinds, and the thread is repaired with `[Response cancelled.]`
(`lib/runtime/threadRepair.ts:96`).

## Design

### Summary

Escape marks the conversation thread as "the user wants to steer". The
next `llm()` call on that thread to reach a round boundary raises a
`std::steer` interrupt that expects a value. The agent's policy handler
shows the steering prompt. The answer is queued on the thread as a user
message, and the boundary adds it before the next request.

### The request is a mark on the thread

```ts
thread.requestSteer();
```

`MessageThread` gets a runtime-only field, `steerRequested`. It is not
saved in a checkpoint. `requestSteer()` sets it, and the boundary clears
it.

Putting the mark on the thread decides who answers it:

- A call on the marked thread sees the mark. That is the coordinator, or
  the handoff subagent that is working on its thread.
- A call on any other thread never sees it. The title, memory, and
  compaction calls are on other threads, so a steering message cannot
  reach them.

This is the same choice `queueMessage` made: the caller names a thread and
the runtime delivers at that thread's next safe point.

When the subagent and the coordinator both have a call on the thread, the
subagent's call reaches a boundary first, because the coordinator's call
is waiting on it. The subagent's call raises the interrupt and clears the
mark. This gives "the nearest subagent" with no rule that names subagents.

### The gate

`runRoundBoundary` gets one new step, placed before the queued messages
are delivered:

```ts
export async function runRoundBoundary(round: number, bctx: BoundaryContext): Promise<void> {
  await drainProducer(attachmentsProducer, `round.${round}.attachReplies`, bctx);
  await bctx.step(`round.${round}.steerGate`, () => raiseSteerIfRequested(round, bctx));
  await drainProducer(queuedMessagesProducer, `round.${round}.queuedMessages`, bctx);
  await drainProducer(roundWarningProducer, `round.${round}.roundWarning`, bctx);
  await runGateAndFeedback(`round.${round}.guardGate`, `round.${round}.guardFeedback`, bctx);
}
```

`raiseSteerIfRequested` lives in a new file, `lib/runtime/steer.ts`. It
follows `raiseOneTrip`:

1. If a `std::steer` interrupt id is recorded on the stack for this call
   and round, look up its answer. If there is one, apply it and return. If
   there is none, return the same interrupt again. This is the resume
   path, and it runs first so a resumed run never asks twice.
2. If the thread is not marked, return.
3. Clear the mark.
4. If a handler body is executing on this stack, return. A handler cannot
   pause, and guard trips follow the same rule.
5. Call `interruptWithHandlers` with the effect `std::steer` and
   `expectsValue: true`.
6. If the verdict is an approval with a non-empty string, call
   `thread.queueMessage(text, { label: "steer" })`. The next step in the
   boundary adds it to the conversation.
7. If the verdict is an approval with an empty value, or a rejection, do
   nothing. The run continues.
8. If there is no verdict, record the interrupt id on the stack and return
   the interrupt. The runner stamps a checkpoint and the run exits, as it
   does for any unanswered interrupt.

The gate is not added to the boundary at the start of an `llm()` call.
Nothing has run at that point, so there is nothing to steer away from.

### The effect

```
effect std::steer {
  thread: string
  round: number
}
```

`thread` is the label of the thread, such as `main`. `round` is the round
that just finished. Both are there for a handler or a hosted client that
wants to show where the run stopped. Neither is read on resume.

### What the model sees

The user's text is added as an ordinary user message, after the tool
results of the round that just finished:

```
assistant: (tool calls: read src/api.ts, grep "v1")
tool:      …
tool:      …
user:      use the v2 endpoint, not v1
```

The message carries the debug label `steer`, which the logs viewer and the
debugger show. The text is not wrapped or prefixed. On the shared thread a
user message is a real message from the user, so the subagent needs no
extra signal to trust it. When the subagent hands back, the coordinator
finds the message in its history.

### The REPL

`repl()` in `lib/stdlib/cli.ts` gets an opt-in option that names the
thread to steer. `agency agent` sets it to the brain's session. A program
that does not set it keeps today's Escape.

With the option set, Escape during a turn works like this:

| When Escape is pressed | What happens |
|---|---|
| A turn is running and no steer is pending | Mark the thread. Print the "Pausing…" line. |
| A steer is pending and the prompt has not appeared | Cancel the turn, as today. |
| The steering prompt is open | Cancel the turn. The prompt widget already does this. |
| An approval prompt or a `question` is open | Unchanged. The widget cancels the turn. |

When the turn ends for any reason, the REPL clears the mark. If a steer
was pending and never raised, it prints
`The task finished before it could pause.`

### The steering prompt

The policy handler renders `std::steer` with the existing prompt widget,
with these differences from an approval:

- The title is `Steering: what should I do instead?`
- There are no menu choices.
- Enter on an empty line submits an empty answer. Today the widget ignores
  an empty Enter (`lib/stdlib/cli.ts:480`), so it needs a setting for this.
- The hint line reads `Enter to continue · Esc to cancel the task`.

## Interrupts, handlers, and policies

- **Every handler in the chain is consulted.** The gate raises through
  `interruptWithHandlers`, the same call guard trips use. No handler is
  skipped.
- **A policy rule cannot answer.** The interrupt expects a value, so an
  approving rule is passed over and the person is asked. A rule may reject
  `std::steer`. A rejection means "do not steer", and the run continues.
- **A non-interactive run is unaffected.** Nothing marks a thread unless a
  REPL with the option does, so `std::steer` is never raised.
- **A program's own handler may answer.** `handle { … } with (intr) {
  return approve("do X") }` steers the run. Tests use this.
- **The answer is not a permission.** It adds one user message. It grants
  nothing, so approving it cannot widen what the agent may do.

## Checkpoints and resume

- **In the terminal agent no checkpoint is restored.** The handler answers
  in process and the loop continues.
- **Unanswered, the run saves and exits like any interrupt.** The
  checkpoint is taken at the gate step. On resume the tool loop runs again
  from the top and skips completed steps. The gate step runs again, finds
  the answer by the recorded id, and queues the message.
- **The decision is made inside a step.** `docs/dev/agents/promptRunner.md`
  requires that anything read from mutable state be decided in a step. The
  mark is read only inside the gate step.
- **The mark is not saved.** A run that is checkpointed for another reason
  while a steer is pending loses the request. The user presses Escape
  again.
- **The queued message is saved.** The thread's queue is part of the
  checkpoint, so a message queued by the gate survives a pause that lands
  before the next step delivers it.

## State isolation

The mark is on a `MessageThread` object, and threads belong to one run.
Two runs in one process cannot see each other's mark.

## What steering does not do in this version

- **It does not stop a tool that is running.** A long shell command
  finishes first. The second Escape is the way out.
- **It does not stop a model request in flight.** The request finishes. If
  it was the final answer, the turn ends and the REPL says so.
- **It does not reach a subagent in a child process.** The mark is on a
  thread in the parent. The steer is raised when the child returns.
- **It does not reach branches on subthreads.** If the research agent
  starts three branches, the steer is raised by the research agent's call
  after the branches finish.
- **It does not reach a subagent with its own thread.** While the review
  or writing agent runs, the steer waits for it to return.
- **Parallel subagents.** One handoff per round is the limit today. When
  parallel subagents exist, each will have its own thread, and the harness
  will mark every one of them.
- **Hosted agents.** A TypeScript host can mark a thread and will get the
  interrupt and checkpoint back. That path is covered by a test, but no
  HTTP route sets the mark.

## Open questions

1. **Time guards.** The code subagent runs under a time budget. Time spent
   typing at the steering prompt should not count. A guard trip freezes
   its own scope while its question is out (`suspendForDecision`). I have
   not checked whether an ordinary approval prompt freezes time guards.
   The plan must find out and make steering match.
2. **The shared thread object.** The design assumes the handoff's `llm()`
   call and the coordinator's call hold the same `MessageThread` object,
   so one mark is visible to both. The handoff doc says the body runs on
   the caller's thread. The first test in the plan should confirm it.
3. **A prefix on the message.** The spec delivers the text as typed. A
   prefix such as `[The user interrupted:]` would tell the model the
   message arrived mid-task. I left it out because it is one more string
   to tune.
4. **Where the prompt is drawn.** `question` and approvals are drawn by the
   policy handler in `stdlib/policy.agency`. Steering would add a third
   case there. If you would prefer the REPL to own it, the handler would
   pass `std::steer` through and the REPL would need its own way to answer
   an interrupt.

## Tests

Agency-js tests can cover the runtime half with no terminal:

1. A tool marks the thread during round 0. The run returns a `std::steer`
   interrupt. The test answers with a string and checks that the thread
   has the user message after round 0's tool results.
2. The same, answered with an empty string. No message is added.
3. The same, rejected. No message is added and the run finishes.
4. A handler answers in process. No checkpoint is created.
5. A handoff is running when the thread is marked. The interrupt is raised
   inside the handoff's call, and the coordinator's call does not raise a
   second one.
6. A call on another thread runs while the main thread is marked. It
   raises nothing.
7. The mark is set during the final round. The run finishes and raises
   nothing.
8. A policy with an approve rule for `std::steer` does not answer it.

The REPL half is tested with the pure reducer for the Escape states and
one run in a pseudo-terminal.

## Files

| File | Change |
|---|---|
| `lib/runtime/state/messageThread.ts` | `steerRequested`, `requestSteer()`, `takeSteerRequest()` |
| `lib/runtime/steer.ts` | New. `raiseSteerIfRequested` |
| `lib/runtime/turnBoundary.ts` | One step in `runRoundBoundary` |
| `stdlib/thread.agency` or `stdlib/agent.agency` | The `std::steer` effect |
| `stdlib/policy.agency` | The steering prompt |
| `lib/stdlib/cli.ts` and a new `cliSteerKey.ts` | The Escape states and the opt-in option |
| `lib/agents/agency-agent/lib/repl.agency` | Pass the brain's session to `repl()` |
| `docs/dev/agents/steering.md` | New dev doc, with index lines |

