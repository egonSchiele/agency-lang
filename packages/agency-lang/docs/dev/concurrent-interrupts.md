# Concurrent Interrupts

This doc covers how Agency handles multiple interrupts that arise from concurrent execution paths. There are two user-facing constructs that produce concurrent interrupts:

- **`fork(items) as item { ... }`** — runs the block in parallel for each item. Each item is a separate "branch." If multiple branches interrupt, all interrupts are batched together and returned to the caller in a single `Interrupt[]`.
- **`llm(prompt, { tools })`** — when the LLM calls multiple tools in a single response, those tool invocations run as parallel branches inside `runPrompt`. If multiple tools interrupt, those interrupts are also batched.

A third construct — **`race(items) as item { ... }`** — also creates parallel branches, but only one wins; interrupts from losers are cancelled rather than batched. See the race section below.

The user responds to a batch via `respondToInterrupts(interrupts, responses)`. Resume reconstructs the full execution state, replays only the work that hadn't completed, and continues.

## Quick mental model

Think of each parallel branch as having its own miniature state stack. The parent frame holds a map of branches under its `branches` field. The runtime serialises this tree on interrupt, restores it on resume, and tracks which branches have completed (cached result) versus interrupted (saved checkpoint) versus never-finished (just a stack reference).

```
main_frame
├─ branches:
│  ├─ "fork_1_0": BranchState { stack, interruptId?, result?, abortController? }
│  ├─ "fork_1_1": BranchState { ... }
│  └─ "fork_1_2": BranchState { ... }
```

Same shape applies to tool-call branches inside `runPrompt`, just keyed differently:

```
runPrompt_frame
├─ branches:
│  ├─ "tool_call_abc123": BranchState { ... }
│  └─ "tool_call_def456": BranchState { ... }
```

## Core data types

### `BranchState` (`lib/runtime/state/stateStack.ts`)

```ts
export type BranchState = {
  stack: StateStack;            // this branch's own isolated stack
  interruptId?: string;         // set if this branch is paused on an interrupt
  interruptData?: any;
  checkpoint?: Checkpoint;      // the inner checkpoint this branch produced when it interrupted
  result?: { result: any };     // set if this branch completed normally
  abortController?: AbortController;  // live, not serialised — used by race
};
```

Two important rules:

- **`result !== undefined`** means "branch finished, here's the value." On resume, `runForkAll`/`runRace` short-circuits past this branch entirely without calling `blockFn` again. The wrapper object distinguishes "no result" from "result was the value `undefined`."
- **`interruptId` set** means "branch paused at an interrupt." On resume, `blockFn` is re-invoked with the saved `stack`. The inner code finds its saved `__interruptId_N` in frame locals, looks up the user's response via `ctx.getInterruptResponse`, and either continues past the interrupt or halts with rejection.

`abortController` and `result` are NOT serialised in `BranchStateJSON`. `abortController` is purely a live execution concept; `result` is reconstructed via `result?: { result }` field which IS serialised.

### `StateStack.abortSignal`

Each `StateStack` carries an optional `abortSignal?: AbortSignal`. When fork/race creates a branch, it sets the signal on the branch's stack. Anywhere downstream code holds the stack reference (e.g., `runPrompt`'s setupFunction call), it can use `ctx.isCancelled(stack)` and `ctx.getAbortSignal(stack)` to be branch-aware. See "Branch-aware abort signals" below.

## Fork: implementation

### Setting up branches

`Runner.runForkAll` (in `lib/runtime/runner.ts`) handles the `fork` mode. For each item:

1. Build a `branchKey` from the step path and item index, e.g. `fork_1.2_0`.
2. Call `frame.getOrCreateBranch(branchKey)` — returns the existing branch on resume, or creates a fresh `BranchState` with an empty `StateStack` on first run.
3. **If `existing.result !== undefined`** → this branch finished in a previous cycle. Resolve immediately with the cached value. Don't call `blockFn`.
4. **Otherwise** → create an `AbortController` (composed with parent's signal for nested fork support, see below), invoke `blockFn(item, i, existing.stack)`. The block receives the branch's stack so its `setupFunction` pushes frames onto it, isolated from siblings.

`Promise.allSettled` waits for every branch (resolved value or interrupt array). The runner walks the settled list:

- **Branch returned a value** → `frame.setResultOnBranch(branchKey, value)`. Cached for any future resume cycles.
- **Branch returned `Interrupt[]`** (via `hasInterrupts`) → `frame.setInterruptOnBranch(branchKey, interruptId, interruptData, checkpoint)`. The branch's saved checkpoint comes from the inner `interruptReturn` template.

If any branch produced interrupts, the runner stamps a single shared **fork-level checkpoint** onto every collected interrupt and returns the array. If no branch interrupted, the runner returns the array of values and `popBranches()` clears the entire branches map.

### Slice-only checkpoint composition

This is the most subtle part of the fork implementation, and the source of the most painful bug we've fixed.

When the inner code (`interruptReturn` template at `lib/templates/backends/typescriptGenerator/interruptReturn.mustache`) creates the leaf-level checkpoint for a given interrupt, it captures **only its local `__stateStack`** — the branch's own stack. NOT `ctx.stateStack` (the global root).

That is critical. If the inner code captured the global root, then when the outer fork serialises a branch's state via `State.toJSON`, it would transplant the global root's snapshot into the branch's slot. The result would be a tree where every branch contains a duplicate of the parent stack from main downward, and on resume `setupFunction` would consume the wrong frames first. Infinite-loop territory.

By capturing only the local stack at every layer, the snapshots compose cleanly:

- Innermost interrupt: captures `[block_frame, function_frame_with_locals]`.
- Fork: stamps that innermost checkpoint onto its sub-branch via `setInterruptOnBranch`. The fork's own checkpoint captures `[search_frame { branches: { fork_X_i: { stack: <innermost slice>, interruptId, ... } } }]`.
- runPrompt (if fork is inside a tool): stamps fork's checkpoint onto its tool branch. runPrompt's own checkpoint captures `[main_frame, runPrompt_frame { branches: { tool_call_*: { stack: <fork slice>, interruptId, ... } } }]`.

`State.toJSON` walks `this.branches` and, when a branch has `branch.checkpoint` set, uses `branch.checkpoint.stack` as that branch's serialised stack — meaning the inner slice plugs into the outer slot. The final serialised structure mirrors the execution tree top-to-bottom with no duplication.

The capture sites that must use a local stack (not `ctx.stateStack`):
- `interruptReturn.mustache:32` and `interruptAssignment.mustache` — innermost.
- `Runner.runForkAll` and `Runner.runRace` (`runner.ts`) — use the `stateStack` parameter, NOT `this.ctx.stateStack`.
- `runPrompt` (`prompt.ts`) — uses the `stateStack` returned by its `setupFunction` call.

If you ever add a new layer that wraps concurrent execution and stamps checkpoints, follow the same pattern: capture only the local slice.

### Multi-cycle resumes

Branches can interrupt across multiple respond/resume cycles. Common pattern: thread A interrupts and gets approved, then later interrupts again. Meanwhile sibling threads B and C may have completed in cycle 1 and shouldn't replay.

The mechanism: `BranchState.result` and `BranchState.interruptId` survive across cycles via `BranchStateJSON`. On any resume:

- Branch with `result` set → short-circuit, no `blockFn` call, no side effects re-run.
- Branch with `interruptId` only → re-invoke `blockFn` with the saved stack (deserialise mode). The inner code's frame still has its saved `__interruptId_N` in locals; it looks up the response and either continues or interrupts again.

This works for arbitrary cycle counts and any mix of completed/interrupted branches.

## Race: implementation

`Runner.runRace` is similar in shape but with different semantics: only one branch wins; the others are cancelled.

### First run

1. Build a tagged promise per branch: `blockFn(item, i, existing.stack).then(value => ({ index, value }))`.
2. `Promise.race(taggedPromises)` resolves with whichever branch settles first.
3. The losers' promises continue running in the JS event loop (we can't truly cancel synchronous JS) but their resolved values are discarded.
4. **Abort losers**: walk every non-winner branch and call `branch.abortController?.abort()`. This fires their `stack.abortSignal`, so any cooperative downstream code (LLM HTTP, runPrompt's per-iteration check) tears down. See "Branch-aware abort signals" below.
5. **Record the winner**: `frame.locals[__race_winner_<id>] = winnerIndex`. This is what makes resume work.
6. **Save winner state**:
   - If winner returned `Interrupt[]` → `setInterruptOnBranch` for the winner only. Stamp a fork-level checkpoint. Delete loser branches via `frame.deleteBranch(...)`. Return the interrupt array.
   - If winner returned a value → `setResultOnBranch` for the winner. Delete loser branches. Return the value.

Loser branches are deleted before any serialisation happens, so the saved checkpoint contains only the winner's slice.

### Resume

`Runner.fork` checks `frame.locals[__race_winner_<id>]` at entry. If set, it dispatches to `resumeRaceWinner` instead of `runRace`:

- Read the saved winner index.
- Look up `existing = frame.getBranch(winnerBranchKey)`.
- If `existing.result` is set, return it.
- Otherwise, re-invoke `blockFn` for that single index with the saved `existing.stack`. No race, no losers — just resume the winner.

This is what guarantees the resume path doesn't re-run loser side effects: the loser branches simply aren't there in the saved state.

### Multi-cycle race

If the winner interrupts a second time after being approved, `resumeRaceWinner` is called again. It still sees the same `winnerIndex`, finds the branch still pending (no `result`), re-invokes the block. The inner code advances past the first interrupt site (cached in frame locals), hits the second interrupt site, mints a new `interruptId`, halts. We stamp another fork-level checkpoint and return.

Each subsequent resume keeps re-entering the same winner until it either produces a value or rejection.

## LLM tool calls: implementation

When `llm(prompt, { tools })` is called, the LLM may emit multiple `toolCalls` in a single round. `runPrompt` processes those tools sequentially in a `for` loop, but each tool's invocation creates its own branch — same machinery as fork.

### Per-tool branches

In `runPrompt` (`lib/runtime/prompt.ts`):

```ts
for (const toolCall of toolCalls) {
  const branchKey = `tool_${toolCall.id}`;
  const existing = stack.getBranch(branchKey);

  // Cached result (completed in a previous cycle): skip — toolMessage was
  // already pushed into messagesJSON when it first succeeded.
  if (existing?.result !== undefined) continue;

  // Previously interrupted, user rejected: emit a "tool call rejected"
  // toolMessage, remove the tool, move on.
  if (existing?.interruptId) {
    const response = ctx.getInterruptResponse(existing.interruptId);
    if (response?.type === "reject") { ... continue; }
  }

  const branchStack = stack.getOrCreateBranch(branchKey).stack;
  const result = await handler.invoke(args, { ..., stateStack: branchStack, isForked: true });

  if (hasInterrupts(result)) {
    interrupts.push(...result);
    stack.setInterruptOnBranch(branchKey, ...);
    continue;
  }

  // Tool succeeded: cache and push toolMessage, but do NOT delete the branch.
  stack.setResultOnBranch(branchKey, result);
  messages.push(smoltalk.toolMessage(result, ...));
}
```

A few things worth knowing:

**Don't `deleteBranch` on success.** A previous version of this code deleted the branch immediately after caching the result. That broke multi-cycle resumes when one tool succeeded and another interrupted: on resume, the deleted branch had no `existing.result`, so the cached short-circuit didn't fire, and runPrompt re-invoked the tool, pushing a duplicate `toolMessage` to the saved `messagesJSON`. OpenAI then rejected the request with `Duplicate value for 'tool_call_id'`. Branches are cleaned up by `popBranches()` after the entire tool-call loop completes without interrupts.

**The cached short-circuit just `continue`s.** It does not re-push the `toolMessage`. The message is already in `messagesJSON` from the original run; on resume `messages` is restored from `messagesJSON`, so the message comes back in place.

**`handler.invoke` runs with `isForked: true`** so the tool's frame stays on its branch stack on interrupt rather than being popped by the function's finally block. This preserves the inner state for resume.

### Tool-call interrupt collection

Same pattern as fork: after the for-loop, if `interrupts.length > 0`, `runPrompt` stamps a single shared checkpoint onto every collected interrupt (capturing its local stack), saves `self.messagesJSON`, returns the array, and skips popping its own frame (`shouldPop = false`).

### LLM tool calls + fork

When a tool's body contains `fork`, that's the most-nested case the runtime supports. Composition trace:

1. `confirmItem` (innermost function in the fork block) hits `interrupt(...)`. The `interruptReturn` template captures the block-frame stack and stamps it on the interrupt object.
2. The fork-block returns the interrupt array. `Runner.runForkAll` sees `hasInterrupts`, calls `setInterruptOnBranch` on the matching `fork_*` sub-branch, and stamps its own checkpoint (capturing the search-frame slice with its `branches` populated).
3. The search function returns the fork's interrupt array. `runPrompt`'s tool loop sees `hasInterrupts(result)`, calls `setInterruptOnBranch` on the `tool_*` branch, and stamps its own checkpoint (capturing the runPrompt-frame slice with its `branches` populated).
4. `runPrompt` returns the array. The calling node's runner halts; `runNode` returns it as `result.data`.

On resume, the user's responses are matched by `interruptId`. Each layer's setupFunction consumes saved frames in order (StateStack `deserializeMode`); each layer's branches map back to the resumed sub-branches; each layer's blockFn re-enters the saved stack; the innermost interrupt site reads its saved `__interruptId_N`, finds the response, continues.

## Branch-aware abort signals

Because race needs to actually stop loser work — not just discard the value — the runtime threads an `AbortSignal` per branch.

### Storage

The signal lives on `StateStack.abortSignal`. When `Runner.runRace` (or `runForkAll`, for parity / future use) creates a branch:

```ts
existing.abortController = new AbortController();
const parentSignal = stateStack.abortSignal;
existing.stack.abortSignal = parentSignal
  ? AbortSignal.any([parentSignal, existing.abortController.signal])
  : existing.abortController.signal;
```

Composing with the parent stack's signal means a nested fork inside a race-loser inherits the loser's abort: when the outer race aborts, every level of nested branch beneath sees the abort.

### Read sites

Three places use the per-branch signal:

- **`Runner.shouldSkip()`** — every step in the runner first checks `this.stack?.abortSignal?.aborted`. If set, the runner halts. The Runner's `stack` opt is set by the `forkBlockSetup.mustache` template to `__forkBranchStack`, so each branch's runner observes its own abort.
- **`ctx.isCancelled(stack)`** — used in `runPrompt` and `interruptWithHandlers` for cancellation checks. Returns true if the global ctx is aborted OR the given stack's signal is aborted. The 5 sites that previously called `ctx.aborted` now call `ctx.isCancelled(stateStack)` and pass the local stack.
- **`ctx.getAbortSignal(stack)`** — used in `runPrompt` for the smoltalk HTTP call. Returns a composite `AbortSignal.any([ctx.abortController.signal, stack.abortSignal])`, so when a race loser is mid-LLM-call and the abort fires, the underlying OpenAI SDK cancels the HTTP request and the await throws.

### What this guarantees

When `Runner.runRace` aborts a loser:

- The loser's `stack.abortSignal` fires.
- The loser's runner halts at the next step (the runner's `shouldSkip()` sees the abort).
- Any in-flight LLM call inside the loser tears down (via the composite signal in `runPrompt`).
- Any tool call inside the loser's `runPrompt` skips new invocations (its per-iteration `ctx.isCancelled(stateStack)` check).
- The global ctx is unaffected — the winner keeps running.

Synchronous code that has already begun executing (e.g., an `interrupt()` call mid-flight) will complete; it can't be unwound. But its resolved value is orphaned (no one awaits it) and gets GC'd.

### Why a stack-based signal instead of AsyncLocalStorage

ALS would make `ctx.aborted` magically branch-aware without any call-site changes — but it's Node-only. Agency is meant to run anywhere TS runs. The stack-based approach requires explicit `stack` args at the 5 sites that check cancellation, but it has no platform dependency and aligns with Agency's pattern of threading state through `stateStack`.

## Resume mechanics

`respondToInterrupts(interrupts, responses)` is the public entry point (`lib/runtime/interrupts.ts`):

1. Length-check: `interrupts.length === responses.length` or throw.
2. Build `responseMap: Record<interruptId, response>`.
3. Pull the shared checkpoint off `interrupts[0].checkpoint`. This is the top-level snapshot (e.g., from `runPrompt`'s capture) — its `.stack` is the full execution tree.
4. Apply any `overrides` to the checkpoint's `globals`/locals.
5. Create a fresh `execCtx` via `ctx.createExecutionContext(runId)`. Call `execCtx.restoreState(checkpoint)`. This replaces `execCtx.stateStack` with `StateStack.fromJSON(...)` and calls `stateStack.deserializeMode()` — which recursively flips every nested branch stack into deserialise mode.
6. Set the response map: `execCtx.setInterruptResponses(responseMap)`.
7. Re-run the entry node via `execCtx.graph.run(nodeName, ...)`.

During the re-run:

- Every `setupFunction`/`setupNode` call to `getNewState()` consumes a saved frame from the front of the deserialise queue.
- Each runner step counter (`frame.step` for top-level, `__substep_X` for nested) skips already-completed steps.
- Each interrupt site reads its saved `__interruptId_N` from `__self.locals` and consults `ctx.getInterruptResponse(id)`.
- Fork sites find their `branches` map already populated; cached results short-circuit, interrupted branches re-enter `blockFn`.
- Race sites find `__race_winner_<id>` and re-enter only that index.

If the re-run produces another batch of interrupts, the cycle repeats.

## Key files

- `lib/runtime/runner.ts` — `Runner.fork`, `runForkAll`, `runRace`, `resumeRaceWinner`, `shouldSkip`. The heart of branch orchestration.
- `lib/runtime/prompt.ts` — `runPrompt` and `_runPrompt`. The tool-call branch path lives here.
- `lib/runtime/state/stateStack.ts` — `BranchState`, `BranchStateJSON`, `State.branches`, `setInterruptOnBranch`, `setResultOnBranch`, `deleteBranch`, `popBranches`. Also `StateStack.deserializeMode` and `StateStack.abortSignal`.
- `lib/runtime/state/context.ts` — `RuntimeContext.isCancelled`, `getAbortSignal`, `restoreState`.
- `lib/runtime/interrupts.ts` — `interrupt()` factory, `interruptWithHandlers`, `respondToInterrupts`.
- `lib/templates/backends/typescriptGenerator/interruptReturn.mustache` — innermost interrupt site. Stamps the leaf checkpoint on the interrupt.
- `lib/templates/backends/typescriptGenerator/interruptAssignment.mustache` — same as above but for `let x = interrupt(...)` form.
- `lib/templates/backends/typescriptGenerator/forkBlockSetup.mustache` — sets up the per-branch Runner with a `stack: __forkBranchStack` opt so the runner can observe its branch's abort signal.

## Invariants worth maintaining

If you change anything in this area, make sure these still hold:

1. **Capture-time slice rule.** Any code that creates a checkpoint inside concurrent execution must capture its **local** `stateStack`, not `ctx.stateStack`. Otherwise `State.toJSON`'s branch-checkpoint transplant will duplicate the outer state into a branch slot.
2. **Don't `deleteBranch` on success during a tool-call loop or fork loop.** Cached `result` must survive across a sibling's interrupt cycle. Cleanup is `popBranches()` after the entire round resolves without interrupts.
3. **`interruptId` is the single source of truth on resume.** The user's responses are keyed by `interruptId` in `responseMap`. The inner code reads it from `__self.__interruptId_N` (saved in frame locals). If the innermost interrupt template ever mints a new id on resume instead of reading the saved one, you'll see fresh ids each cycle and the resume will infinite-loop.
4. **Race deletes loser branches before serialisation.** Loser state must not survive into the checkpoint. Otherwise resume will re-execute losers.
5. **`abortSignal` composes with parent.** Nested branches must inherit ancestor aborts via `AbortSignal.any` so a top-level race abort cascades.
6. **`ctx.isCancelled` and `ctx.getAbortSignal` get the local stack.** Anywhere new in the runtime that wants cancellation awareness must thread the `stateStack` arg, not just `ctx`.

## Test locations

- Fork basics, multi-interrupt, multi-cycle: `tests/agency/fork/` (top-level files like `fork-multi-interrupt`, `fork-multi-cycle-interrupt`).
- Fork organised by category: `tests/agency/fork/{nested,multi-cycle,control-flow,handlers,llm-tools,race}/`.
- The deepest fork+tool composition: `tests/agency/fork/fork-llm-tool-nested.test.json` (the regression test for the slice-only capture fix).
- Multi-tool batching: `tests/agency/fork/llm-tools/multi-tool-{all-interrupt,mixed,multi-cycle}.test.json`.
- Race + interrupt: `tests/agency/fork/race-interrupt.test.json`, `tests/agency/fork/race/race-{multi-cycle,reject-winner,with-fork-inside,mixed-completion}.test.json`.
- TypeScript-side API: `tests/agency-js/interrupts/{interrupt-approve,interrupt-reject,interrupt-overrides,interrupt-batched-overrides,interrupt-respond-mismatch,interrupt-respond-by-data}/`.
- Fork batching: `tests/agency-js/fork/{fork-parallel-interrupts,fork-nested-interrupts,fork-mixed-responses}/`.

## Known limitations

- **Race loser cancellation is cooperative.** Synchronous JS code in a loser cannot be interrupted — it runs to completion, but its result is discarded. Cancellation only takes effect at await points and at runner step boundaries.
- **Handler that calls `interrupt()` recursively invokes itself.** See the skipped `tests/agency/fork/handlers/handler-throws-interrupt.test.json`. Whether handler-issued interrupts should bypass the active handler is an open design question.
- **Race + reject of winner**: rejection becomes the race result (a failure `Result`). There's no automatic re-race against the surviving losers — the user must run `race` again at a higher level if they want that semantics.
