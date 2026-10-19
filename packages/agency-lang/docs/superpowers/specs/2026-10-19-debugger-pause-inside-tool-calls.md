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
halting checkpoint with `ctx.checkpoints.create(ctx.stateStack, ...)`, the
root. Inside a branch that breaks the slice rule in
`concurrent-interrupts.md`: `setInterruptOnBranch` would store a root
checkpoint on the branch, `State.toJSON` would put the root's stack in the
branch's slot, and the resume would consume the wrong frames first. The
leaf template and `raiseGuardTripsAtStep` both stamp from the local stack
for this reason. Fork, race, and parallel-block branches are not tool
calls, so the hook already fires in them today and already stamps from the
wrong stack. No debugger test covers a fork, which is why nobody noticed.

**The loop has no hook.** `PromptRunner.step` runs the loop's round and
tool-call steps as idempotent steps with their own bailout, but never calls
`debugStep`. There is no stop between "the model answered" and "the next
tool runs".

**The driver assumes the root.** The UI reads locals from the checkpoint's
last root frame and maps the checkpoint's `moduleId:scopeName#stepPath` to
a source line. After the join, the interrupt's checkpoint is the shared
one: its last root frame is the `runPrompt` frame, and its location is the
loop's batch location, not the tool's step. The debugger would highlight
the wrong line and show the wrong locals. Rolling checkpoints have the same
problem from the other side: they are stamped from the root, so for a step
inside a tool their last root frame is `runPrompt`'s, and nothing records
which branch the step ran on.

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
reason: neither has a step address. The check is
`stack.hasExecutingHandlers() || isInsideCallback(run)`, and
`maybeDebugHook` stops reading `isInsideToolCall()`.

`hasExecutingHandlers()` covers the case that matters for handler safety:
a tool called by an `llm()` inside a handler body. `runBatch` copies the
parent's handler marks into every branch it starts, so the tool's branch
stack carries the mark and its steps do not stop.

The `enterToolCall` and `exitToolCall` pair around the handler body in
`interrupts.ts` stays as it is. Once the debugger no longer reads the
counter, the pair serves only `_insideToolCall()` in `stdlib/thread.ts`,
which decides whether `attachToReply` does anything and whether `viewFile`
may report success. Changing that is a separate change to two stdlib
functions with its own test, not part of this work.

A `debugger("label")` statement inside a tool body follows the same rule,
so a breakpoint placed in a tool works under `continue`.

### D3. Which stack each checkpoint is stamped from

`debugStep` requires the runner's stack. The checkpoint it attaches to the
debug interrupt is created from that stack, as the leaf template and the
guard trip do. At the top level the local stack is the root stack, so
nothing changes there. This fixes forks, races, and parallel blocks at the
same time as tool calls.

Rolling checkpoints, the ones the rewind selector lists, keep being stamped
from the root stack. A root checkpoint taken while a tool runs includes the
live branch stacks through `State.toJSON`, so it is the one a rewind can
replay: `runBatch` and `State.deserializeMode` both recurse into branches,
and `runPrompt` re-invokes any branch without a result.

Trace checkpoints (`--trace`) keep recording root-stack steps only. A trace
checkpoint is a copy of the whole root stack, including the `runPrompt`
frame's `messagesJSON`, so recording one at every step inside every tool
would multiply a trace of an agent run by the number of tool statements.
For the motivating run that is about 350 copies of a growing conversation
in place of two. Tracing inside tools waits for a design that records a
branch checkpoint as a delta, and until then a trace replay cannot step
inside a tool.

### D4. The interrupt carries its own location

After the join the interrupt's `checkpoint` is the shared one, whose
location is the loop's, so the driver can no longer read where the stop
happened from the checkpoint. The debug interrupt's `data` carries it:

```ts
type DebugStopData = {
  moduleId: string;
  scopeName: string;
  stepPath: string;
  /** Branch keys from the root down to the stack the step ran on. */
  branchPath: string[];
  label: string | null;
};
```

Today `data` is the label alone. The UI reads the source line and the
frame from this record and uses the checkpoint only for state. The `:save`
command writes a rolling checkpoint, not an interrupt, so no saved file
holds the old shape.

### D5. Every checkpoint records its branch path

A checkpoint is a tree of stacks. To find the frame a checkpoint was taken
in, the checkpoint records the path to it: the list of branch keys from
the root to the stack the step ran on, for example
`["tool_0_call_abc", "fork_1"]`. The root stack's path is empty.

A branch stack learns its path when `runBatch` starts it: the parent
stack's path plus the branch key. The path is live state on `StateStack`,
rebuilt the same way on resume, and never serialized with the stack. It is
serialized on the checkpoint, as a `branchPath` field next to `moduleId`,
`scopeName`, and `stepPath`, and omitted when empty so a checkpoint from
before this change still verifies its signature.

`Checkpoint.getCurrentFrame()` follows the path: the last frame of the
root, then the last frame of the named branch's stack, and so on. Every
reader of "the frame this checkpoint was taken in" goes through it: the
locals pane, `print`, and the flag stripping in D10. This works the same
for a debug interrupt, a rolling checkpoint in the rewind list, and
`step back`. `step back` has one more detail: it skips the rolling
checkpoint at the step the program is stopped at, and that step is the
stop's location, not the shared checkpoint's, so the driver passes the
stop's location to `findBefore`.

An earlier draft walked down from the root through each branch whose
`interruptId` matched the debug interrupt. That fails for a rolling
checkpoint, which has no interrupt, and for a branch that holds two
stopped sub-branches, since a branch records only its first interrupt.

The call stack pane keeps its hook-fed entries in this work. Drawing the
path from the checkpoint's frames is ADI-27.

### D6. Stops between tool calls

`PromptRunner` gets two hook sites, both inside the step whose body they
precede so that the existing bailout machinery stamps the checkpoint and
snapshots the thread:

- Before each model request: kind `round`, label `round 3`. The first
  request is its own step, `initialLlmCall`, outside the loop; later ones
  are `round.N.nextLlmCall` inside it. Both sites get the hook, or `step`
  from the `llm()` line would skip `round 1`. The stop comes before the
  request rather than after, so that milestone four can edit the thread
  before the model sees it; the `tool` stops already show the reply.
- Before each tool call, kind `tool`, label `search(query: …)`. These stops
  run on the `runPrompt` frame, in a step before the parallel batch starts,
  one stop per call in order. Running them inside each tool's branch would
  raise one debug interrupt per call in a single batch, which the driver
  cannot show until ADI-18. On the `runPrompt` frame the stops are
  sequential, and they give milestone four a natural place to edit a call
  before it runs.

Each site calls `debugStep` with scope name `runPrompt`, module id `""`,
and step path `<runPrompt's base>/<step key>`, and returns the interrupts
it gets back so `PromptRunner.step` surfaces them. Like the runner's hook it
keeps a flag in the `runPrompt` frame's locals (`__dbg_<key>`) so a resume
re-entering the same step does not stop twice. `DebugStopData` gains a
`kind: "step" | "round" | "tool"` field at that point, and the UI checks
the kind before asking the source map for a line, since an empty module id
has no entry.

These stops have no source line. The source pane keeps the `llm()`
statement highlighted and the activity log says where the loop is.

A tool written in TypeScript has no steps and cannot be stopped inside. The
next stop after it is its `tool` stop's successor: the next tool in the
round, or the next round. The activity log says `[ts] fetchPage()` as it
does today, so the person is not left thinking the debugger hung.

### D7. Depth, and what the stepping commands mean

The debugger decides whether to stop at a step by comparing the step's
depth with a target. Today the depth is a counter the driver moves on
every `onFunctionStart` and `onFunctionEnd`. That is one number for the
whole program, so two tools running in parallel push it twice and `next`
inside one of them compares against the wrong value. It also leaves the
counter one too high after a failed tool call if a `tool` level were added
through hooks, because `onToolCallEnd` runs only on success.

Depth is instead read from the stack. A stack knows how many frames it
holds, and a branch stack learns its base depth from its parent when
`runBatch` starts it: the parent's base depth plus the parent's frame
count. The depth of a step is the stack's base depth plus its frame count
minus one. With `main` at 0, the `runPrompt` frame is at 1, a statement of
`search` is at 2, and a statement of a fork branch inside `search` is at
3. Nothing is counted by hooks, nothing drifts, and a resume rebuilds the
value from the checkpoint.

`DebuggerState` records the depth of the stop it is paused at, and
`step in`, `next`, and `step out` set their targets from that. The
counter, `enterCall`, and `exitCall` go away.

After PR 1, with no loop stops yet:

| Command | At the `llm()` statement | Inside a tool's body |
|---|---|---|
| `step` | stops at the first statement of the first Agency tool that runs | the next step anywhere, including a subagent's tools |
| `next` | runs the whole `llm()` | the tool's next statement, over any call |
| `step in` | same as `step` | the first statement of a called `def` |
| `step out` | runs to the caller | the statement after `llm()` |
| `continue` | runs to a breakpoint | the same |

After PR 2, with the loop's own stops at depth 1:

| Command | At the `llm()` statement | At a `round` or `tool` stop | Inside a tool's body |
|---|---|---|---|
| `step` | stops at `round 1` | the next stop of any kind | the next step anywhere |
| `next` | runs the whole `llm()` | the next `tool` or `round` stop, over the tool's body | the tool's next statement |
| `step in` | stops at `round 1` | the tool's first statement | the first statement of a called `def` |
| `step out` | runs to the caller | the statement after `llm()` | the loop's next stop |
| `continue` | runs to a breakpoint | the same | the same |

### D8. Several branches stop at once

Parallel tool calls run under `Promise.allSettled`. A stop in one branch
does not stop its siblings: they run to their own next stop or to
completion before the join, and only then does the driver see anything.
In stepping mode every Agency tool in the round stops at its next step, so
the batch that reaches the driver holds one debug interrupt per stopped
branch, and may hold a tool's real interrupt beside them. This is the
normal case for an agent, not an edge case.

Until ADI-18 lands, the driver keeps the first interrupt of the batch and
drops the rest. That is safe: the resume never looks up an answer for a
debug interrupt, because the `__dbg_` flag in each stopped frame makes its
hook skip, so the other stopped branches continue without showing
anything. A real interrupt the driver did not answer is not approved; its
tool replays, finds no answer, and runs its handler chain again. The person
sees one stop out of several and nothing is approved without being asked.

With ADI-18, the driver answers the whole batch in one
`respondToInterrupts` call, one answer per interrupt in order, as
`validateResumeBatch` requires: `approve` for every debug interrupt, and
the person's answer for each real one, asked first. The UI focuses the
first stopped branch and lists the others; `[` and `]` move between them.
Stepping then moves every stopped branch one step, in lockstep, which is
the honest picture of what the runtime does.

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

`removeDebugFlagsFor` strips the `__dbg_` flags from the frame the
checkpoint was taken in, found through the branch path, and from that
frame only. Ancestors keep their flags so the replay passes through the
call sites: `main` keeps `__dbg_` for the `llm()` statement, reaches it,
skips the hook, and re-enters the loop, which re-enters the tool, which
stops at the chosen step. Sibling branches keep their flags too, so a
sibling that was mid-step when the checkpoint was taken replays past its
own stop. An earlier draft stripped every frame in the tree; that would
make a rewind into any nested call stop at the call site first.

`createRolling` replaces an earlier unpinned checkpoint at the same
location, and the location now includes the branch path. Two calls of
`search` in different rounds run on branches with different keys, so each
call keeps its own rewind entries, and the store's eviction limit bounds
the total. A loop inside one call of `search` still replaces its earlier
entries, as a loop at the top level does today.

## Interactions to keep straight

- **A guard trip and a debug stop at one step.** `step` raises the guard
  trip before the debug hook. The trip halts first; after it is answered
  the step re-enters, and the debug hook fires. Both are seen, in that
  order.
- **The skip after a rewind.** `_skipNextCheckpoint` is consumed by the
  first `debugStep` after a restore, wherever it is. With parallel
  branches that may be a sibling of the rewind's destination, in which case
  the destination's checkpoint is recorded a second time and
  `createRolling`'s duplicate removal collapses the two.
- **Time guards.** `halt` pauses every guard on the stack and the first
  step after resume re-arms them, so time spent at a debug stop inside a
  tool is not charged, the same as at the top level.
- **`onCheckpoint` for hosts.** Stays root-only. A host cannot re-enter a
  branch from outside; the debugger can, because it resumes through the
  interrupt path.
- **The checkpoint gate.** `recordsStepCheckpoints()` decides whether a
  step builds a checkpoint. On a branch stack only an attached debugger
  counts; the trace writer and `onCheckpoint` consumers count on the root
  stack only (D3). A program with neither pays nothing inside tools.
- **The tool-call counter.** `prompt.ts` and the handler site keep
  `enterToolCall` for `_insideToolCall()` in the stdlib.
  `isInsideToolCall` is no longer consulted by the debugger.

## Out of scope

- Stopping inside a TypeScript tool, a handler body, or a callback body.
- A subprocess started with `run()`. The child has no debugger state, so it
  raises no debug interrupts; its own interrupts travel as today.
- Changing `pauseSignal` or any serve route. No code outside `lib/debugger`
  and the two hook sites learns anything new about debug interrupts.
- The threads, branches, and guards panes (ADI-8), and the call stack from
  frames (ADI-27). This spec only requires the locals pane and the source
  pane to follow the stop.
- `set` at a stop inside a tool. Resume overrides are applied to the
  root's last frame, and addressing a branch frame is milestone four's
  work. The command is refused with a message until then.
- Trace checkpoints inside tools (D3).

## Tests

All drive the headless session in `lib/debugger/testSession.ts` with the
deterministic model client, whose `ToolCallMock` and multi-tool mocks make
the loop call real `def`s without a network request. The main fixture is an
agent-shaped program: one `llm()` with Agency tools, one of which opens a
`thread { … }` and makes its own model request, and a breakpoint inside a
tool behind an argument.

1. `step` from the `llm()` statement lands on the first statement of the
   first tool. The locals pane shows the tool's argument and the source
   pane shows the tool's line.
2. `next` from the `llm()` statement runs the whole call.
3. From inside a tool: `next` stops at the tool's next statement, and
   `step out` lands on the statement after `llm()`.
4. A `debugger()` inside a tool stops under `continue`.
5. After a stop inside a tool, the program finishes with the same return
   value as the unstepped run.
6. A fork in a node with no `llm()`: stepping stops inside a branch with
   the branch's locals, and the program finishes with the right value.
7. Two tools in one round in stepping mode: one stop is shown, both tools
   complete, the return value is right. ADI-18 changes this test's
   assertions on purpose.
8. A tool called by an `llm()` inside a handler body: with the breakpoint
   on, `continue` does not stop inside it.
9. Rewind: from a stop inside a tool, `step back` lands on the tool's
   previous statement, not on the `llm()` line, and makes no model
   request.
10. The branch path: `getCurrentFrame()` on a hand-built checkpoint with
    two levels of branches, and `removeDebugFlagsFor` stripping only the
    frame at the path.
11. Depth: `DebuggerState` targets set from the recorded stop depth.

PR 2 adds one test per row of its table, including a round with two tool
calls, and a `promptRunner.test.ts` case that a resumed step does not stop
twice.

## Docs to update

- `docs/dev/cli/debugger.md`: the "Tool calls" limitation becomes a section
  on stops inside a tool, the branch path, the depth rule, the interim
  behaviour with several stopped branches, and the `set` refusal.
- `docs/dev/runtime/checkpointing.md`: the `branchPath` field.
- `docs/dev/runtime/pause.md`: a note that the debugger's stop is an
  interrupt and is not subject to the branch-stack deferral.
- `docs/dev/runtime/trace.md`: traces record root-stack steps only.
- `docs/dev/cli/debugger-tests.md`: how to script the model in a debugger
  test.
