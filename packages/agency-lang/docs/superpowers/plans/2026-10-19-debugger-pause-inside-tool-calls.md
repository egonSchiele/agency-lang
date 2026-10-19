# Plan: stopping the debugger inside a tool call

Implements `docs/superpowers/specs/2026-10-19-debugger-pause-inside-tool-calls.md`.
Linear: ADI-5 and its sub-issues ADI-14 to ADI-17; ADI-18 for the batch
answer. Each task is one PR against `main`, reviewed on its own. Run the
built binary after each build, not only the tests.

Reading before starting: the spec; `docs/dev/runtime/concurrent-interrupts.md`
sections "Slice-only checkpoint composition" and "LLM tool calls:
implementation today"; `docs/dev/cli/debugger-tests.md`.

## Task 1. A debugger test that runs a real tool loop

The other tasks need a program with `llm()` and tools that the headless
debugger session can drive without a network. Nothing in `lib/debugger`
does that today: `thread.test.ts` mocks `runPrompt` away.

Files:
- `tests/debugger/agent-shaped.agency`: one node, one `llm()` call with
  three tools. `search` and `writeUp` are Agency `def`s with three
  statements each; `fetchPage` is imported from a TypeScript file beside
  the fixture. `search` opens a `thread { … }` and calls `llm()` inside it,
  so there is a subagent. One `debugger("in search")` statement in
  `search`, reachable only when a test wants it (behind an argument).
- `lib/debugger/agentShaped.test.ts`: compiles the fixture in `beforeAll`
  the way `driver.test.ts` does, selects the deterministic client, queues
  a script with `ToolCallMock` entries (`search`, then `fetchPage`, then
  `writeUp`, then a plain reply), and asserts the program's return value
  with no stepping at all. That proves the harness before any debugger
  change.
- `lib/debugger/testHelpers.ts`: a helper that installs the deterministic
  client and its mock queue for a test, mirroring however
  `tests/agency` selects it (find the switch with a grep for
  `DeterministicClient` under `lib/runtime` and `lib/cli`).

Done when the test passes and `docs/dev/cli/debugger-tests.md` has a
section "Scripting the model".

## Task 2. The hook fires inside tool calls, with the checkpoint from the local stack

Spec D1 to D4. Runtime only; the driver is Task 3.

Steps:
1. `lib/runtime/state/context.ts`: leave `enterToolCall` and
   `isInsideToolCall` as they are. In `lib/runtime/interrupts.ts`, remove
   the `enterToolCall`/`exitToolCall` pair around the handler body; the
   stack's `executingHandlerEntries` already marks it.
2. `lib/runtime/runner.ts`, `maybeDebugHook`: replace the
   `isInsideToolCall()` return with
   `if (this.stack?.hasExecutingHandlers() || isInsideCallback(run)) return false;`.
   Check who else read the tool-call window for the handler case and
   confirm nothing depended on it.
3. `lib/runtime/debugger.ts`, `debugStep`: build the halting checkpoint
   with `ctx.checkpoints.create(stack ?? ctx.stateStack, ctx, info)` and
   the trace and rolling checkpoints as today from the root. The `stack`
   argument becomes required; every caller passes `this.stack`.
4. `lib/runtime/interrupts.ts`, `createDebugInterrupt`: the data is the
   `DebugStopData` record from spec D4. Add `kind: "step"` at the runner's
   call sites.
5. Tests, in `lib/runtime/runner.test.ts` and `lib/runtime/debugger.test.ts`
   (new): the hook fires on a branch stack; the checkpoint attached to the
   interrupt holds only the branch's frames; the hook does not fire inside
   a handler body; a resume through the tool finishes it and its result
   reaches the thread once (the fixture from Task 1, driven with
   `respondToInterrupts` directly, no UI).

Done when a debug interrupt raised inside `search` reaches `runNode`'s
result with a checkpoint whose root last frame is `runPrompt` and whose
`tool_…` branch holds `search`'s frame.

## Task 3. The driver and UI follow the halt path

Spec D4, D5, and the locals and call stack panes.

Files: `lib/debugger/driver.ts`, `lib/debugger/uiState.ts`,
`lib/debugger/ui.ts`.

Steps:
1. `uiState.ts`: a function `haltPath(checkpoint, interruptId)` that
   returns the list of frames from the root's last frame down through
   branches whose `interruptId` matches, and the stopped frame at its end.
   Unit test it on a hand-built checkpoint JSON with two levels.
2. `setCheckpoint` takes the interrupt as well as the checkpoint, reads the
   source location from `interrupt.data`, and reads locals and args from
   the stopped frame.
3. The call stack pane draws the halt path: `main › llm() round 1 › search`.
   Keep the hook-fed entries for TypeScript functions until ADI-27 replaces
   the pane.
4. `driver.ts`: `lookupVariable` and `set` act on the stopped frame. The
   override for `set` must land in that frame on resume: `applyLocalOverrides`
   writes to the root's last frame today. Add a path option to the resume
   overrides (`overrides.locals` plus a `frame` selector built from the
   halt path's branch keys), or defer `set` inside a tool to milestone four
   and refuse it with a message. Decide in review; the refusal is the
   smaller change and this plan assumes it.
5. Tests with the Task 1 fixture through `DebuggerTestSession`: spec tests
   1, 5, and 6.

## Task 4. Stops between tool calls

Spec D6 and D7, ADI-15.

Files: `lib/runtime/promptRunner.ts`, `lib/runtime/prompt.ts`,
`lib/runtime/debugger.ts`, `lib/debugger/debuggerState.ts`.

Steps:
1. `PromptRunner` gets `debugStop(kind, key, label)`: if the frame local
   `__dbg_<key>` is set, return; else set it, call `debugStep` with
   scope `runPrompt`, step path `<base>/<key>`, the label, `kind`, and a
   `depthOffset` of one; return the interrupts. The step that calls it
   returns them so the bailout stamps the checkpoint and snapshots the
   thread. Clear the flag when the step completes, the way `step()` does
   for the runner.
2. `prompt.ts`: call it at the top of the round's request step with label
   `round N`, and at the top of each tool's invoke step with the tool's
   name and cut arguments (reuse the argument formatting the activity log
   uses for `onToolCallStart`).
3. `DebuggerState`: `isAtOrBelowTargetDepth(offset)` adds the offset to the
   call depth for the comparison. `debugStep` passes it through.
4. The activity log entry for a `round` or `tool` stop names it; the
   source pane keeps the `llm()` line.
5. Tests: spec tests 2, 3, and 10, and a `promptRunner.test.ts` case that a
   resumed step does not stop twice.

## Task 5. Rolling checkpoints and rewind inside the loop

Spec D10, ADI-16.

Steps:
1. `lib/runtime/state/checkpointStore.ts`: `removeDebugFlagsFor` and
   `removeDuplicate` walk the branch tree. `State.removeDebugFlags` already
   exists per frame; add a `forEachFrame` over the tree and use it.
2. Verify, with a test before any code, that `rewindFrom` on a rolling
   checkpoint taken inside `search` lands on the chosen statement of
   `search` and that the round's request is not repeated. If it does not
   land, the likely cause is the branch slot: `State.toJSON` serializes
   `branch.checkpoint.stack` when a checkpoint was set on the branch in an
   earlier cycle, which can be stale. Clear `branch.checkpoint` when a
   branch is re-entered, or serialize the live stack when the branch has
   no `interruptId`. Decide from the failing test.
3. The rewind selector marks `round` entries with "replays a model
   request".
4. Tests: rewind to before the second tool and see it run again; rewind to
   a `round` stop and see the mock's queue consumed again.

## Task 6. Several stopped branches at once

Spec D8. Depends on ADI-18 for the batch answer; do that first if it has
not landed.

Steps:
1. `driver.ts`: when the batch holds more than one interrupt, answer the
   real ones through the interrupt prompt and the debug ones with
   `approve`, one response per interrupt in order.
2. `ui.ts`: a stopped-branch list when the batch holds several debug
   interrupts, with `[` and `]` moving the focus. The halt path and the
   locals follow the focused one.
3. Tests: spec tests 7, 8, and 9.

## Task 7. Docs and the small items

- `docs/dev/cli/debugger.md`: rewrite "Tool calls" under "Known
  limitations" as a section "Stops inside the tool loop": the halt path,
  the depth rule, the two loop stops, and what a TypeScript tool does.
- `docs/dev/runtime/pause.md`: one paragraph under "Statements that cannot
  take a pause" saying the debugger's stop is an interrupt and takes the
  in-tool path, with a pointer to the spec.
- `docs/dev/cli/debugger-tests.md`: the "Scripting the model" section from
  Task 1 if it was not written then.
- `CLAUDE.md` and the `agency-cli-docs` skill: update the one-line
  description of `debugger.md`.
- Close ADI-13 with a link to the spec, and ADI-14 to ADI-16 as each task
  lands.

## Order and size

Tasks 1 and 2 first, in that order; 2 is the risky one and 1 is what proves
it. Task 3 right after, since without it a stop inside a tool shows the
wrong frame. Tasks 4 and 5 can go in either order. Task 6 waits for ADI-18.
Task 7 rides along with whichever PR finishes a section.

Rough sizes: Task 1 a day; Task 2 two to three days including the handler
check; Task 3 two days; Task 4 two days; Task 5 one to three days depending
on what the verification test shows; Task 6 a day after ADI-18; Task 7 half
a day.
