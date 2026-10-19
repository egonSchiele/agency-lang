# Plan: stopping the debugger inside a tool call

Implements `docs/superpowers/specs/2026-10-19-debugger-pause-inside-tool-calls.md`.
Linear: ADI-5, with ADI-14 for the first PR and ADI-15 for the second.

Two PRs against `main`, reviewed on their own. The first is the fix; the
second is an addition the fix makes possible. Run the built binary after
each build, not only the tests, on a program with two Agency tools in one
round as well as on the fixture.

Reading before starting: the spec; `docs/dev/runtime/concurrent-interrupts.md`,
the sections "Slice-only checkpoint composition" and "LLM tool calls:
implementation today"; `docs/dev/runtime/rewind.md`, since PR 1 changes how
a rewind finds its frame; `docs/dev/runtime/trace.md`;
`docs/dev/cli/debugger-tests.md`.

## PR 1. Stop inside a tool call (ADI-14)

Spec D1 to D5, D7 (the first table), D8 (the interim behaviour), and D10.
After this PR, `step` from the `llm()` statement stops at the first
statement of the first Agency tool that runs, `next` runs the whole call,
a `debugger()` placed inside a tool stops under `continue`, and once
stopped inside a tool `next` and `step out` work on the tool's own lines
with the right locals and the right source line. Stopping between tool
calls is PR 2.

### The test harness first

Nothing in `lib/debugger` runs a real tool loop today; `thread.test.ts`
mocks `runPrompt` away. The fix cannot be shown without one, so it is the
first commit of the PR.

- `tests/debugger/agent-shaped.agency`: one node whose `llm()` call offers
  Agency tools with a few statements each. One tool opens a
  `thread { … }` and calls `llm()` in it, so there is a subagent. That tool
  holds a `debugger("in search")` statement behind a node argument, so a
  test can turn the breakpoint on. A second node calls the same `llm()`
  inside a handler body, for the handler-safety test.
- `tests/debugger/fork-test.agency`: a fork in a node with no `llm()`.
- `lib/debugger/testHelpers.ts`: a helper that runs a session with the
  deterministic model client. The runtime builds that client when the host
  setting `AGENCY_LLM_MOCKS` holds a JSON list of mocks
  (`lib/runtime/state/context.ts`), so the helper sets the variable around
  the session's start and restores it after.
- The mock queue is in the order the program asks for replies, and the
  subagent's request sits inside the outer tool's call: the outer `llm()`
  asks for `search`; `search`'s own `llm()` takes the next reply; then the
  outer `llm()` asks for the remaining tools and gives its final reply.
- `lib/debugger/agentShaped.test.ts`: compile the fixtures in `beforeAll`
  as `driver.test.ts` does, run the agent-shaped node through
  `DebuggerTestSession` with `continue`, and assert the return value. This
  proves the harness before any change.
- `docs/dev/cli/debugger-tests.md`: a section "Scripting the model".

### The runtime change

1. `lib/runtime/state/stateStack.ts`: `StateStack` gets two live-only
   fields, `branchPath: string[]` and `baseDepth: number`, both zero for
   the root. `runBatch` sets them on every branch it starts, next to the
   handler-mark copy in `rehydrateInheritedGuards`: the parent's path plus
   the child key, and the parent's base depth plus the parent's frame
   count. Neither is serialized; a resume rebuilds them the same way.
2. `lib/runtime/state/sourceLocation.ts` and `checkpointStore.ts`:
   `SourceLocation` gains `branchPath?: string[]`. `Checkpoint` stores it
   (default `[]`), writes it to JSON only when non-empty, and the schema
   accepts it. `getCurrentFrame()` follows the path. `pathEquals`,
   `findCheckpoint`, and `removeDuplicate` compare the path too.
3. `lib/runtime/debugger.ts`, `debugStep`: the `stack` argument is
   required. It reads the depth and the branch path from the stack, passes
   the path into the rolling checkpoint's location, creates the halting
   checkpoint from the stack with `ctx.checkpoints.create(stack, ctx, …)`,
   and puts a `DebugStopData` record in the interrupt. The trace checkpoint
   is written only when the stack is the root (spec D3). It asks
   `DebuggerState` whether to stop at the depth, and tells it the depth
   when it does.
4. `lib/runtime/runner.ts`, `maybeDebugHook`: replace the
   `isInsideToolCall()` return with `this.stack.hasExecutingHandlers()`
   and `isInsideCallback(run)`. `recordsStepCheckpoints()` counts the trace
   writer only on the root stack. Fix the comment that says a function
   context halts with a single interrupt object; it halts with an array.
5. `lib/runtime/state/checkpointStore.ts`: `removeDebugFlagsFor` strips
   the flags of `getCurrentFrame()`, which now follows the path.
6. Delete `lib/templates/backends/typescriptGenerator/debugger.mustache`
   and its generated `.ts`. The `debugger()` statement compiles to
   `runner.debugger`, which goes through `maybeDebugHook`; the template is
   imported by `typescriptBuilder.ts` but never rendered, and it calls
   `debugStep` without a stack.

### The debugger change

7. `lib/debugger/debuggerState.ts`: `callDepth`, `enterCall`, `exitCall`,
   and `resetCallDepth` go. In their place `stopDepth`, set by
   `stoppedAt(depth)`, and `shouldStopAt(depth)`, which compares against
   the target. `stepIn`, `stepNext`, and `stepOut` set targets from
   `stopDepth`. The driver's hooks stop moving the counter.
8. `lib/debugger/uiState.ts`: `setCheckpoint(checkpoint, stop?)`. The
   location is the stop's when one is given, else the checkpoint's own;
   the frame is `checkpoint.frameAt(location.branchPath)`. The driver
   passes the interrupt's `DebugStopData` for a debug interrupt and nothing
   for a rolling checkpoint or a user interrupt. The driver today passes
   the interrupt itself as the checkpoint when rendering a user interrupt;
   it passes the interrupt's checkpoint instead.
9. `lib/debugger/driver.ts`: `print` reads from the stop's frame. `set` at
   a stop whose path is not empty is refused with "set inside a tool call
   is not supported yet".

### Tests for the PR

With the fixtures through `DebuggerTestSession`, the eleven cases in the
spec's list. In `lib/runtime/state/checkpointStore.test.ts` and
`lib/debugger/uiState.test.ts`, hand-built checkpoints with two levels of
branches for `getCurrentFrame()` and `removeDebugFlagsFor`. In
`lib/debugger/debuggerState.test.ts`, the targets from the stop depth.

### Docs in the PR

- `docs/dev/cli/debugger.md`: the "Tool calls" limitation becomes a section
  "Stops inside a tool call".
- `docs/dev/runtime/checkpointing.md`: the `branchPath` field.
- `docs/dev/runtime/pause.md`: one paragraph on the debugger's stop.
- `docs/dev/runtime/trace.md`: root-stack steps only.
- `docs/dev/cli/debugger-tests.md`: "Scripting the model".

## PR 2. Stop between tool calls (ADI-15)

Spec D6 and the second table of D7. After this PR, `step` from the `llm()`
statement stops at `round 1`, then before each tool, then inside the tool,
and the stepping commands have the meanings in that table.

1. `lib/runtime/promptRunner.ts`: `debugStop(kind, key, label)`. If the
   `runPrompt` frame local `__dbg_<key>` is set, return; else set it, call
   `debugStep` with scope `runPrompt`, module id `""`, step path
   `<base>/<key>`, the label, and the kind, and return the interrupts. The
   step that calls it returns them so the bailout stamps the checkpoint
   and snapshots the thread. Clear the flag when the step completes, as
   `Runner.step` does. The `runPrompt` frame is at depth 1 under the node,
   so no offset is needed: the stack gives the depth.
2. `lib/runtime/prompt.ts`: call it at the top of the `initialLlmCall`
   step and of each `round.N.nextLlmCall` step with label `round N`, and in
   a step on the `runPrompt` frame before each round's parallel batch, once
   per tool call in order, with the tool's name and cut arguments, reusing
   the formatting the activity log uses for `onToolCallStart`.
3. `DebugStopData` gains `kind`. `lib/debugger/ui.ts` and `uiState.ts`: a
   `round` or `tool` stop keeps the `llm()` line highlighted, asks the
   source map for nothing, and names itself in the activity log. A
   TypeScript tool's stop says `[ts] fetchPage()` so the next `step`
   landing on the following stop is not mistaken for a hang.
4. The rewind selector marks `round` entries with "replays a model
   request".
5. PR 1's test that `step out` from inside a tool lands on the statement
   after `llm()` changes on purpose: it lands on the loop's next stop. Say
   so in the PR description.

Tests: one case per row of the spec's second table, including a round with
two tool calls, with the fixture; and a `promptRunner.test.ts` case that a
resumed step does not stop twice.

Docs: `docs/dev/cli/debugger.md` gains the second depth table; `CLAUDE.md`
and the `agency-cli-docs` skill get the updated one-line description.

## Order and size

PR 1 first. PR 2 depends on it and on nothing else: its `tool` stops run
on the `runPrompt` frame, so a round with three tool calls is three stops
in a row, not three interrupts in one batch. Stepping into the bodies of
two parallel tools still shows one stop until ADI-18, whichever order that
lands in.

PR 1 is about a week: a day for the harness, three for the runtime, the
branch path, and the depth change, two for the debugger side. PR 2 is two
to three days.
