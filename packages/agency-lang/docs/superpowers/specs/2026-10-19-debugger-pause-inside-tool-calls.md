# Stopping the debugger inside a tool call

Linear: ADI-13, the spec for ADI-5 (milestone "Debugger refresh" of the
project "Attach to a running Agency program").

## The problem

For an agent program, almost the whole run is one statement:

```
node main(task: string) {
  const answer = llm(task, tools: [search, fetchPage, writeUp])
  return answer
}
```

Everything interesting happens below that statement, inside the tool loop
`runPrompt` runs for `llm()`: model requests, tool calls, subagents on their
own threads. In the research run that motivates this project, that one
statement ran for 60 minutes and covered 77 model requests and 115 tool
calls. The debugger today stops at the `llm()` statement, then at the
`return`, and sees nothing in between.

Two things stop it. The debug hook returns early while the runtime is inside
a tool call, so a `def` called as a tool never pauses even though every one
of its statements is a step. And the tool loop's own steps, one per model
request and one per tool call, never call the hook at all, so there is no
place to stop between tool calls.

This spec says how the debugger stops inside the loop, what a stop there
looks like to the driver and the UI, and what `step`, `next`, `step out`,
and `continue` mean once the current position can be inside a tool.

## What the runtime already does

The runtime can halt inside a tool call. It does it every time a tool raises
an interrupt and every time a guard trips inside one. The path is worth
tracing, because the design below rides it unchanged.

1. The tool is a `def`. Its body runs on a branch stack of its own, kept in
   the `runPrompt` frame's `branches` record under a key like
   `tool_0_call_abc`. Its statements are `runner.step` calls like any other.
2. A statement raises. The generated leaf code
   (`interruptReturn.mustache`) stamps a checkpoint from the branch's own
   stack, never from `ctx.stateStack`, writes the interrupt id into the
   frame, and halts the runner. The halt is a return value, an
   `Interrupt[]`, passed up by every generated call site.
3. The tool loop sees `hasInterrupts(toolResult)` in `runInvokeStep` and
   records the interrupt on the branch with `setInterruptOnBranch`, which
   stores the leaf checkpoint on the branch.
4. `runBatch` collects the branch outcomes and stamps one shared checkpoint
   from the `runPrompt` frame's stack. When that frame is serialized, each
   branch's slot holds the leaf checkpoint's stack, so the whole tree is in
   one document. The interrupt's `checkpoint` field is overwritten with the
   shared one.
5. `PromptRunner.step` snapshots the thread into `messagesJSON`, stamps a
   checkpoint against the node's stack, and bails out. The node halts.
   `runNode` returns `{ messages, data: Interrupt[] }`.
6. On resume the node replays, `runPrompt` re-enters its uncompleted steps,
   `runBatch` re-enters the branch with its saved stack in deserialize mode,
   the tool replays to its saved step, reads the recorded answer, and
   finishes. Its result reaches the thread once.

A guard trip at a step boundary (`maybeRaiseGuardTrip`) takes the same
route, and it is not skipped inside tool calls. Its comment in `runner.ts`
explains why that is safe: the tool completes on resume, so there is never
a dangling tool call.

So the question is not how to halt inside a tool. It is how to make a debug
stop one more thing that halts this way.

## Why the debugger cannot stop there today

Four things, all small.

**The early return.** `maybeDebugHook` returns when
`ctx.isInsideToolCall()`. That window is opened in two places: around a tool
invocation in `prompt.ts`, and around a handler body in `interrupts.ts`,
with the comment "treat handler execution as atomic for the debugger, same
as LLM tool calls". The two cases are not the same. A handler body has no
step address a resume can re-enter, so it must stay atomic. A tool body is
ordinary stepped code.

**The checkpoint comes from the wrong stack.** `debugStep` builds the
halting checkpoint with `Checkpoint.fromContext(ctx)`, which reads
`ctx.stateStack`, the root. Inside a branch that breaks the slice rule in
`concurrent-interrupts.md`: `setInterruptOnBranch` would store a root
checkpoint on the branch, `State.toJSON` would put the root's stack in the
branch's slot, and the resume would consume the wrong frames first. The
leaf template and `raiseGuardTripsAtStep` both stamp from the local stack
for this reason.

**The loop has no hook.** `PromptRunner.step` runs the loop's round and
tool-call steps as idempotent steps with their own bailout, but never calls
`debugStep`. There is no stop between "the model answered" and "the next
tool runs".

**The driver assumes the root.** The UI reads locals from the checkpoint's
last frame and maps the checkpoint's `moduleId:scopeName#stepPath` to a
source line. After the join, the interrupt's checkpoint is the shared one:
its last frame is the `runPrompt` frame, and its location is the loop's
batch location, not the tool's step. The debugger would highlight the
wrong line and show the wrong locals.

## Design

### D1. A debug stop inside a tool is an ordinary interrupt

A debug stop is already an interrupt: `createDebugInterrupt` builds one
with effect `debug` and `debugger: true`, the runner halts with it, and the
driver answers it with `approve`. Inside a tool it travels exactly as a
tool's own interrupt travels, through steps 2 to 6 above, with no new
transport and no marker type.

This is simpler than the design issue #1046 proposes for `pauseSignal`.
That design needs a marker because a host's pause has no answer. A debug
stop has one, the driver's `approve`, so it is a real interrupt and every
layer between the tool and the node handles it with the code it has.

### D2. Where the hook may fire

The hook fires at every step except inside a handler body or a callback
body, which is the same rule `pauseIfRequested` applies for the same
reason: neither has a step address.

`enterToolCall` and `exitToolCall` stop serving two purposes. The handler
site in `interrupts.ts` marks handler execution the way it already does on
the stack (`executingHandlerEntries`), and the debugger checks
`stack.hasExecutingHandlers()` and `isInsideCallback(run)`. The tool-call
depth stays for the code that still needs it, and `maybeDebugHook` stops
reading it.

A `debugger("label")` statement inside a tool body follows the same rule,
so a breakpoint placed in a tool works under `continue`.

### D3. The halting checkpoint is stamped from the local stack

`debugStep` already receives the runner's stack as its third argument. The
checkpoint it attaches to the debug interrupt is created from that stack,
as the leaf template and the guard trip do. At the top level the local
stack is the root stack, so nothing changes there.

Rolling checkpoints, the ones the rewind selector lists, keep being stamped
from the root stack. A root checkpoint taken while a tool runs includes the
live branch stacks through `State.toJSON`, so it is the one a rewind can
replay. Whether a rewind to such a checkpoint re-enters the tool at its
saved step is the question ADI-16 answers with a test; the reading of
`runBatch` and `State.deserializeMode` says it should, since both recurse
into branches and `runPrompt` re-invokes any branch without a result.

### D4. The interrupt carries its own location

After the join the interrupt's `checkpoint` is the shared one, whose
location is the loop's, so the driver can no longer read where the stop
happened from the checkpoint. The debug interrupt's `data` carries it:

```ts
type DebugStopData = {
  moduleId: string;
  scopeName: string;
  stepPath: string;
  label: string | null;
  /** A statement in Agency code, a model request, or a tool dispatch. */
  kind: "step" | "round" | "tool";
};
```

Today `data` is the label alone. The UI reads the source line from this
record and uses the checkpoint only for state.

### D5. The halt path: where in the tree the stop is

A checkpoint is a tree of stacks. The driver finds the stopped frame by
walking it: start at the root's last frame; if it has a branch whose
`interruptId` is the debug interrupt's id, descend into that branch's stack
and repeat; the last frame reached is the stopped one. Nothing new is
stored. The tool loop sets `interruptId` on the branch today through
`setInterruptOnBranch`, and a fork inside a tool sets it one level down.

The UI shows that frame's locals and args in the locals pane, and the whole
path in the call stack pane: `main › llm() round 3 › search › fork[2]`.

### D6. Stops between tool calls

`PromptRunner` gets two hook sites, both inside the step whose body they
precede so that the existing bailout machinery stamps the checkpoint and
snapshots the thread:

- At the start of a round, before the request step: kind `round`, label
  `round 3`.
- Before each tool's invoke step: kind `tool`, label `search(query: …)`.

Each site calls `debugStep` with scope name `runPrompt`, module id `""`,
and step path `<runPrompt's base>/<step key>`, and returns the interrupts
it gets back so `PromptRunner.step` surfaces them. Like the runner's hook it
keeps a flag in the `runPrompt` frame's locals (`__dbg_<key>`) so a resume
re-entering the same step does not stop twice.

These stops have no source line. The source pane keeps the `llm()`
statement highlighted and the activity log says where the loop is.

A tool written in TypeScript has no steps and cannot be stopped inside. The
next stop after it is its `tool` stop's successor: the next tool in the
round, or the next round. The activity log says `[ts] fetchPage()` as it
does today, so the person is not left thinking the debugger hung.

### D7. What the stepping commands mean inside the loop

Stops inside `llm()` count one level deeper than the statement that called
it, so the four commands keep their meaning:

| Command | At the `llm()` statement | Inside the loop |
|---|---|---|
| `step` | stops at round 1 | stops at the next stop of any kind, including inside a tool |
| `next` | runs the whole `llm()` | runs to the next stop at the same depth: the next tool or round, over a tool's body |
| `step in` | stops at round 1 | on a `tool` stop, stops at the tool's first statement |
| `step out` | runs to the caller | from a tool's body, stops at the loop's next stop; from a loop stop, runs to the statement after `llm()` |
| `continue` | runs to a breakpoint | the same |

The depth is counted by the existing call-depth hooks for Agency `def`s.
The loop's own stops pass a depth offset of one to `DebuggerState`, so no
hook fires for `runPrompt` itself and nothing is replayed on resume.

### D8. Several branches stop at once

Parallel tool calls run under `Promise.allSettled`. A stop in one branch
does not stop its siblings: they run to their own next stop or to
completion before the join, and only then does the driver see anything.
In stepping mode every branch stops at its next step, so the batch that
reaches the driver holds one debug interrupt per stopped branch, and may
hold a tool's real interrupt beside them.

The driver answers the whole batch in one `respondToInterrupts` call, one
answer per interrupt in order, as `validateResumeBatch` requires: `approve`
for every debug interrupt, and the person's answer for each real one, asked
first. The UI focuses the first stopped branch and lists the others; `[`
and `]` move between them. Stepping then moves every stopped branch one
step, in lockstep, which is the honest picture of what the runtime does.

Answering batches is ADI-18; this spec depends on it.

### D9. A stop requested from outside

Milestone two needs to stop a running program at a moment of the person's
choosing. With the hook firing everywhere, that is one line: set
`DebuggerState` to stepping mode from the control channel, and the next
step anywhere in the program, including inside a tool, halts. The debugger
needs no `pauseSignal`. Issue #1046 stays open for hosts that embed the
runtime without a debugger; nothing here changes `pauseSignal`.

### D10. Rewind inside the loop

A rolling checkpoint taken inside a tool replays from the node: the loop
re-enters its uncompleted steps, the model request for the current round
is not repeated (the round's request step is complete, and its reply is in
`messagesJSON`), and the branch replays to the chosen step. Rewinding to a
`round` stop replays that round's request, which costs a model call. The
rewind selector says so on those entries.

`removeDebugFlagsFor` and `createRolling`'s duplicate removal both look at
the checkpoint's last frame only. Both must walk the branch tree, or a flag
left in a branch frame makes the replayed tool skip its hook, and two
rolling checkpoints at the same tool step pile up.

## Interactions to keep straight

- **A guard trip and a debug stop at one step.** `step` raises the guard
  trip before the debug hook. The trip halts first; after it is answered
  the step re-enters, and the debug hook fires. Both are seen, in that
  order.
- **The skip after a rewind.** `_skipNextCheckpoint` is consumed by the
  first `debugStep` after a restore, wherever it is, so a rewind into a tool
  does not record the checkpoint it just restored.
- **Time guards.** `halt` pauses every guard on the stack and the first
  step after resume re-arms them, so time spent at a debug stop inside a
  tool is not charged, the same as at the top level.
- **`onCheckpoint` for hosts.** Stays root-only. A host cannot re-enter a
  branch from outside; the debugger can, because it resumes through the
  interrupt path.
- **The tool-call depth counter.** `prompt.ts` keeps `enterToolCall` for
  whatever else reads it. The handler site stops calling it, and
  `isInsideToolCall` is no longer consulted by the debugger.

## Out of scope

- Stopping inside a TypeScript tool, a handler body, or a callback body.
- A subprocess started with `run()`. The child has no debugger state, so it
  raises no debug interrupts; its own interrupts travel as today.
- Changing `pauseSignal` or any serve route. No code outside `lib/debugger`
  and the two hook sites learns anything new about debug interrupts.
- The threads, branches, and guards panes (ADI-8). This spec only requires
  the locals and call stack panes to follow the halt path.

## Tests

All drive the headless session in `lib/debugger/testSession.ts` with the
deterministic model client, whose `ToolCallMock` and multi-tool mocks make
the loop call real `def`s without a network request. The fixture is the
agent-shaped program from ADI-17: one `llm()` with three tools, two of them
Agency `def`s and one TypeScript, and a subagent on a thread.

1. `step` from the `llm()` statement lands on `round 1`, then on the first
   tool, then on that tool's first statement. The locals pane shows the
   tool's locals and the call stack shows `main › llm() round 1 › search`.
2. `next` from the `llm()` statement runs the whole call.
3. `step out` from inside a tool lands on the loop's next stop.
4. A `debugger()` inside a tool stops under `continue`.
5. After a stop inside a tool, resume finishes the tool and its result
   reaches the thread once; the program's return value is unchanged.
6. A stop inside a fork branch inside a tool: the call stack shows four
   levels and the locals are the branch's.
7. Two tools in parallel in stepping mode: the batch holds two debug
   interrupts, both are answered, both tools complete.
8. One tool stops while its sibling raises `std::env`: the person is asked
   about the real interrupt, the debug one is approved alongside it, and
   both tools complete.
9. A guard trips at the same step as a stop: the trip is asked first.
10. The TypeScript tool: `step` from its `tool` stop lands on the next
    tool's stop, and the activity log names it.
11. `runner.test.ts`: the hook fires on a branch stack, and still does not
    fire inside a handler body.

## Docs to update

- `docs/dev/cli/debugger.md`: the "Tool calls" limitation becomes a section
  on stops inside the loop, the halt path, and the depth rule.
- `docs/dev/runtime/pause.md`: a note that the debugger's stop is an
  interrupt and is not subject to the branch-stack deferral.
- `docs/dev/cli/debugger-tests.md`: how to script the model in a debugger
  test.

## Open questions

1. Should the `round` stop come before or after the request? Before lets a
   person change the thread (milestone four) before the model sees it;
   after lets them see the reply before the tools run. This spec puts it
   before, and the tool stops cover the reply. Decide in review.
2. `recordsStepCheckpoints()` gates the hook today. It should keep gating
   on the branch stacks, so a program with no debugger and no trace writer
   pays nothing. Confirm it reads the context, not the stack.
