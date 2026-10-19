# Plan: stopping the debugger inside a tool call

Implements `docs/superpowers/specs/2026-10-19-debugger-pause-inside-tool-calls.md`.
Linear: ADI-5, with ADI-14 for the first PR and ADI-15 for the second.

Two PRs against `main`, reviewed on their own. The first is the fix; the
second is an addition the fix makes possible. Run the built binary after
each build, not only the tests. Answering a batch of several interrupts is
ADI-18 and is not part of this plan; until it lands, a test that stops two
parallel tools at once is expected to fail and is marked so.

Reading before starting: the spec; `docs/dev/runtime/concurrent-interrupts.md`,
the sections "Slice-only checkpoint composition" and "LLM tool calls:
implementation today"; `docs/dev/cli/debugger-tests.md`.

## PR 1. Stop inside a tool call (ADI-14)

Spec D1 to D5 and D10. After this PR, `step` from the `llm()` statement
runs the whole call as today, but a `debugger()` placed inside a tool
stops under `continue`, and once stopped inside a tool, `step`, `next`,
and `step out` work on the tool's own lines with the right locals and the
right source line. Stopping between tool calls is PR 2.

### The test harness first

Nothing in `lib/debugger` runs a real tool loop today; `thread.test.ts`
mocks `runPrompt` away. The fix cannot be shown without one, so it is the
first commit of the PR.

- `tests/debugger/agent-shaped.agency`: one node whose `llm()` call offers
  three tools. `search` and `writeUp` are Agency `def`s with three
  statements each; `fetchPage` is imported from a TypeScript file beside
  the fixture. `search` opens a `thread { … }` and calls `llm()` in it, so
  there is a subagent. `search` holds a `debugger("in search")` statement
  behind an argument, so a test can turn the breakpoint on.
- `lib/debugger/testHelpers.ts`: a helper that installs the deterministic
  model client (`lib/runtime/deterministicClient.ts`) with a queue of
  `ToolCallMock` entries. Find how `tests/agency` selects that client with
  a grep for `DeterministicClient` under `lib/runtime` and `lib/cli`, and
  do the same.
- `lib/debugger/agentShaped.test.ts`: compile the fixture in `beforeAll`
  as `driver.test.ts` does, queue `search`, `fetchPage`, `writeUp`, then a
  plain reply, run it through `DebuggerTestSession` with `continue`, and
  assert the return value. This proves the harness before any change.
- `docs/dev/cli/debugger-tests.md`: a section "Scripting the model".

### The runtime change

1. `lib/runtime/interrupts.ts`: remove the `enterToolCall` and
   `exitToolCall` pair around the handler body. The stack's
   `executingHandlerEntries` already marks handler execution. Grep for
   other readers of `isInsideToolCall` and confirm none relied on it for
   the handler case.
2. `lib/runtime/runner.ts`, `maybeDebugHook`: replace the
   `isInsideToolCall()` return with a check of
   `this.stack?.hasExecutingHandlers()` and `isInsideCallback(run)`.
3. `lib/runtime/debugger.ts`, `debugStep`: make the `stack` argument
   required, and create the halting checkpoint from it with
   `ctx.checkpoints.create(stack, ctx, info)`. The trace checkpoint and the
   rolling checkpoint keep coming from the root through
   `Checkpoint.fromContext`.
4. `lib/runtime/interrupts.ts`, `createDebugInterrupt`: the data becomes
   the `DebugStopData` record from spec D4, with `kind: "step"` at the
   runner's call sites. The driver reads the label from it.
5. `lib/runtime/state/checkpointStore.ts`: `removeDebugFlagsFor` and
   `removeDuplicate` walk every frame in the branch tree, not only the
   root's last frame. Add a `forEachFrame` on `StateStackJSON` for it.

### The debugger change

6. `lib/debugger/uiState.ts`: `haltPath(checkpoint, interruptId)` returns
   the frames from the root's last frame down through each branch whose
   `interruptId` matches, ending at the stopped frame. Unit test it on a
   hand-built checkpoint with two levels.
7. `setCheckpoint` takes the interrupt too. It reads the source location
   from `interrupt.data` and the locals and args from the stopped frame.
8. The call stack pane draws the halt path, `main › llm() › search`. The
   hook-fed entries for TypeScript functions stay until ADI-27.
9. `driver.ts`: `print` reads from the stopped frame. `set` inside a tool
   is refused with "set inside a tool call is not supported yet", because
   resume overrides land in the root's last frame today and targeting a
   branch frame is milestone four's work.

### Tests for the PR

With the fixture through `DebuggerTestSession`:

- `continue` with the breakpoint on stops inside `search`; the locals pane
  shows `query` and the call stack shows `main › llm() › search`.
- From that stop, `next` twice shows `url` then `page`; `step out` lands on
  `return answer`.
- After a stop inside `search`, the program finishes with the same return
  value as the unstepped run, and the thread holds `search`'s result once.
- A stop inside a fork branch inside `search`: four levels in the call
  stack, the branch's locals.
- A guard trips at the same step as a stop: the trip is asked first.
- Rewind: from a stop inside `search`, rewind to the rolling checkpoint
  before `const page = …` and see that line run again without a second
  model request. If this fails, the likely cause is `State.toJSON`
  serializing a stale `branch.checkpoint`; the fix is its own small PR.
- Two tools stopped at once: marked as expected to fail until ADI-18.

In `lib/runtime/runner.test.ts`: the hook fires on a branch stack, and
still does not fire inside a handler body or a callback body.

### Docs in the PR

- `docs/dev/cli/debugger.md`: the "Tool calls" limitation becomes a section
  "Stops inside a tool call": the halt path, the local-stack checkpoint,
  and the `set` refusal.
- `docs/dev/runtime/pause.md`: one paragraph noting that the debugger's
  stop is an interrupt and takes the in-tool path.

## PR 2. Stop between tool calls (ADI-15)

Spec D6 and D7. After this PR, `step` from the `llm()` statement stops at
`round 1`, then before each tool, then inside the tool, and the stepping
commands have the meanings in the spec's table.

1. `lib/runtime/promptRunner.ts`: `debugStop(kind, key, label)`. If the
   `runPrompt` frame local `__dbg_<key>` is set, return; else set it, call
   `debugStep` with scope `runPrompt`, module id `""`, step path
   `<base>/<key>`, the label, the kind, and a depth offset of one, and
   return the interrupts. The step that calls it returns them so the
   bailout stamps the checkpoint and snapshots the thread. Clear the flag
   when the step completes, as `Runner.step` does.
2. `lib/runtime/prompt.ts`: call it at the top of each round's request
   step with label `round N`, and at the top of each tool's invoke step
   with the tool's name and cut arguments, reusing the formatting the
   activity log uses for `onToolCallStart`.
3. `lib/debugger/debuggerState.ts`: `isAtOrBelowTargetDepth(offset)` adds
   the offset before comparing, so the loop's stops count one level deeper
   than the statement that called `llm()`.
4. `lib/debugger/ui.ts` and `uiState.ts`: a `round` or `tool` stop keeps
   the `llm()` line highlighted and names itself in the activity log and
   the call stack: `main › llm() round 2 › search(query: …)`. A TypeScript
   tool's stop says `[ts] fetchPage()` so the next `step` landing on the
   following stop is not mistaken for a hang.
5. The rewind selector marks `round` entries with "replays a model
   request".

Tests: the spec's table, one case per row, with the fixture; and a
`promptRunner.test.ts` case that a resumed step does not stop twice.

Docs: `docs/dev/cli/debugger.md` gains the depth table; `CLAUDE.md` and the
`agency-cli-docs` skill get the updated one-line description.

## Order and size

PR 1 first. PR 2 depends on it and on nothing else. The two-tools test
turns green when ADI-18 lands, whichever order that happens in.

PR 1 is about a week: a day for the harness, two to three for the runtime
and the handler check, two for the debugger side, and the rewind test may
add a day if it fails. PR 2 is two to three days.
