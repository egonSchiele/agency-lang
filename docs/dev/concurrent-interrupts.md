# Concurrent Interrupts

NOTE: this is a work in progress.

## What this feature is for

Agency supports async function calls that run concurrently on forked state stacks. Previously, if more than one of these concurrent threads triggered an interrupt, the runtime threw `ConcurrentInterruptError`. This feature adds support for multiple threads interrupting concurrently: all interrupts are collected, returned to the caller as a batch, and then all threads are resumed with the caller's responses.

### Example

```agency
def a(): string {
  response = interrupt("approve a?")
  return "a done"
}

def b(): string {
  response = interrupt("approve b?")
  return "b done"
}

node main() {
  x = async a()
  y = async b()
  return { x: x, y: y }
}
```

Both `a()` and `b()` run concurrently and both throw interrupts. The runtime collects both, returns them as an `InterruptBatch`, and the caller responds to both before execution resumes.

## Design spec

See `docs/superpowers/specs/2026-03-22-multi-thread-interrupts-design.md` for the full design document.

## Core implementation

### Tree-shaped state stacks

The `State` type (a single stack frame) has a `branches` field that maps step numbers to child `StateStack`s. Each async call creates a branch on the parent frame. This forms a tree that mirrors the execution tree.

```
main_frame (branches: { 1: a_stack, 2: b_stack })
  └─ a_stack: [a_frame (branches: { 0: a1_stack, 1: a2_stack })]
  └─ b_stack: [b_frame]
```

Key files:
- `lib/runtime/state/stateStack.ts` — `BranchState`, `BranchStateJSON` types, recursive `toJSON`/`fromJSON`

### Forked stacks and branches

When the builder generates an async call, it creates a forked stack and stores it on the parent frame's branches, keyed by the step index at the time of the call:

```ts
let __forked;
if (__stack.branches && __stack.branches[STEP]) {
  __forked = __stack.branches[STEP].stack;
  __forked.deserializeMode();
} else {
  __forked = __ctx.forkStack();
}
__stack.branches = __stack.branches || {};
__stack.branches[STEP] = { stack: __forked };
```

The parent holds a live JS reference to the forked stack, so mutations by the async thread are visible. On checkpoint, `toJSON` walks the branches recursively.

`forkStack()` creates an empty `StateStack` (not a clone of the parent). Each branch only contains its own frames.

Key files:
- `lib/runtime/state/context.ts` — `forkStack()`
- `lib/backends/typescriptBuilder.ts` — async call generation

### Modified step guard

Async calls use a modified step guard so they fire on resume even if the parent's step counter is past them:

```ts
if (__step <= N || (__stack.branches && __stack.branches[N])) {
  // trigger async call with saved or fresh branch
}
```

This is implemented via a `branchCheck` flag on `TsStepBlock` in the IR.

Key files:
- `lib/ir/tsIR.ts` — `branchCheck` on `TsStepBlock`
- `lib/ir/prettyPrint.ts` — conditional guard printing
- `lib/ir/builders.ts` — `stepBlock` builder

### Interrupt collection

`PendingPromiseStore.awaitAll()` collects interrupts instead of throwing `ConcurrentInterruptError`. All pending promises from all nesting levels register on the shared `RuntimeContext.pendingPromises`. Functions do not have their own `awaitAll` — only `runNode` calls `awaitAll` at the top level.

`awaitPending()` (for assigned async vars) returns a boolean indicating whether any resolved to interrupts. Interrupt entries are left in the store for `awaitAll` to collect later.

Key files:
- `lib/runtime/state/pendingPromiseStore.ts`

### Interrupt batch and IDs

Each interrupt gets a globally unique `interrupt_id` (nanoid). All interrupts from a single execution are returned as an `InterruptBatch` with a shared checkpoint. The batch is returned as `result.data` from `runNode`, maintaining the `RunNodeResult` shape `{ data, messages, tokens }`.

`runNode` collects interrupts from two paths:
1. Sync interrupts returned directly as the graph result (`result.data`)
2. Async interrupts left in `PendingPromiseStore` by `awaitPending`

Key files:
- `lib/runtime/interrupts.ts` — `Interrupt`, `InterruptBatch`, `isInterruptBatch`
- `lib/runtime/node.ts` — unified interrupt collection in `runNode`

### Responding to interrupts

`respondToInterrupts` takes the full `InterruptBatch` and a `responses` map keyed by `interrupt_id`. It stores both the responses and the interrupt data (messages, toolCall) on `ctx.interruptResponses`, then restores from the batch checkpoint and re-executes.

On resume, the interrupt templates check `ctx.getInterruptData(interruptId)` to find the response and any associated interrupt data (for tool call resume).

Key files:
- `lib/runtime/interrupts.ts` — `respondToInterrupts`
- `lib/runtime/state/context.ts` — `interruptResponses`, `getInterruptData()`
- `lib/templates/backends/typescriptGenerator/interruptReturn.mustache`
- `lib/templates/backends/typescriptGenerator/interruptAssignment.mustache`

### AwaitPending AST node

The preprocessor inserts `AwaitPending` AST nodes (instead of raw code) to signal where async variables need to be awaited. The builder handles `AwaitPending` by generating the `awaitPending` call plus an early-return if interrupts are found:

```ts
const __hasInterrupts = await __ctx.pendingPromises.awaitPending([keys]);
if (__hasInterrupts) {
  __stack.hasChildInterrupts = true;
  return undefined;
}
```

Key files:
- `lib/types/awaitPending.ts` — `AwaitPending`, `AwaitPendingVariable` types
- `lib/preprocessors/typescriptPreprocessor.ts` — `_insertAwaitPendingCalls`
- `lib/backends/typescriptBuilder.ts` — `processAwaitPending`

### Frame pop control

The finally block in generated function code conditionally pops the stack frame:

```ts
if (!__state?.isForked && !__stack.hasChildInterrupts && !__stack.interrupted) {
  __setupData.stateStack.pop();
}
```

- `isForked`: passed in the function call config for async calls. Forked stack frames are never popped — the stack is ephemeral, and leaving the frame ensures the checkpoint captures the completed state. Without this, completed threads would re-execute their side effects on resume.
- `hasChildInterrupts`: set by `processAwaitPending` when child threads interrupted. Prevents the parent's frame from being popped so the branch tree is preserved for the checkpoint.
- `interrupted`: set by the interrupt template when the function itself triggered an interrupt.

Note: `hasChildInterrupts` and `interrupted` are set dynamically on the `State` object at runtime. They are NOT declared on the `State` type and are NOT serialized by `toJSON`. They only affect behavior within a single execution.

### Scope marker and awaitScope

`PendingPromiseStore` has `scopeMarker()` and `awaitScope(marker)` methods. A scope marker records the current promise counter value. `awaitScope` awaits only promises added since that marker, scoped to the current function.

These were added for an earlier iteration where interrupt templates called `awaitScope` before creating interrupts. They are currently unused in the templates (removed during simplification) but the runtime methods remain.

Key files:
- `lib/runtime/state/pendingPromiseStore.ts` — `scopeMarker()`, `awaitScope()`

## Issues and edge cases encountered

### 1. The InterruptBatchSignal approach (abandoned)

The first implementation had `awaitPending` throw an `InterruptBatchSignal` exception when it discovered interrupts. This was wrong because:

- Throwing from `awaitPending` inside function A would reject A's promise, killing all sibling threads via `Promise.all` fail-fast semantics
- It required complex checkpoint merging in `runNode` to reconstruct the state tree from per-function checkpoints
- The exception needed to be caught and re-thrown at every level (try/catch/finally blocks in generated code)

**Resolution**: Interrupts propagate as values in the flat `PendingPromiseStore`, not as exceptions. `awaitPending` returns a boolean. Generated code checks the boolean and returns early. `awaitAll` at the `runNode` level collects all interrupts.

### 2. Interrupts propagating as return values (abandoned)

An early approach had functions return child interrupts as their own return values. This caused duplication — the same interrupt appeared in both the child's pending store entry and the parent's return value. It also conflated "this function interrupted" with "a child of this function interrupted."

**Resolution**: Functions that have child interrupts return `undefined`, not the interrupt. The interrupt stays only in the flat store. The function sets `hasChildInterrupts = true` so its frame isn't popped. `awaitAll` at `runNode` collects the leaf interrupts without duplicates.

### 3. Completed threads re-executing side effects

When thread A1 completes normally (no interrupt) while sibling A2 interrupts, A1's frame gets popped by the finally block. On resume, A1's branch has an empty stack. A1 re-executes from scratch, repeating all side effects.

**Resolution**: Pass `isForked: true` in the function call config for async calls. The finally block checks this flag and skips the pop. The frame stays on the forked stack with its step counter past the end, so on resume all statements are skipped.

### 4. Serialization of StateStack instances in branches

`StateStack.toJSON()` originally used `deepClone` (`JSON.parse(JSON.stringify(...))`), which can't handle live `StateStack` class instances in the `branches` field. `JSON.stringify` doesn't call `toJSON()` on nested class instances.

**Resolution**: `toJSON` explicitly walks branches on each frame and calls `toJSON()` recursively. `fromJSON` reconstructs live `StateStack` instances from `BranchStateJSON` entries.

### 5. Tool call interrupt data routing (current blocker)

When a tool call inside `runPrompt` triggers an interrupt, `runPrompt` needs the message history and tool call data on resume. Previously, this was threaded through `interruptData` (passed from the caller through graph state). With the new batch API, the interrupt data is stored on `ctx.interruptResponses` keyed by `interrupt_id`.

The approach taken: save the `interrupt_id` on the caller's stack frame (the node that called `runPrompt`) when `runPrompt` returns an interrupt. On resume, the generated code looks up the interrupt data from the context and passes it to `runPrompt`:

```ts
interruptData: __self.__interruptId ? __ctx.getInterruptData(__self.__interruptId) : __state?.interruptData
```

**Current status**: This works for the simple case (`foo.agency` repro passes). However, there is a remaining issue with tests that involve node transitions (e.g., `bar() → foo()`) where the stack frame ordering during deserialization doesn't match expectations. The `interruptReturnInFunc` test has 3 frames on the stack (from `bar` → `foo` → `greet`), and on resume starting at node `foo`, the deserialization consumes frames in the wrong order. This appears to be a stack frame ordering issue during node-transition resume, not specific to the concurrent interrupt feature.

### 6. Per-function vs batch checkpoints

Early iterations had each interrupt create its own per-function checkpoint (in the interrupt template). The batch checkpoint (created by `runNode` after `awaitAll`) was supposed to capture the full tree. But per-function checkpoints captured the state before the finally block popped the frame, while the batch checkpoint was created after — leading to empty branch stacks in the batch checkpoint.

**Resolution**: With the `isForked` fix (frames aren't popped on forked stacks), the batch checkpoint captures the full tree with all frames intact. Per-function checkpoints are still created by the interrupt template but may be redundant — the batch checkpoint contains everything needed for resume.

### 7. Single-interrupt backward compatibility

The old API had `respondToInterrupt`, `approveInterrupt`, `rejectInterrupt`, `modifyInterrupt`, `resolveInterrupt` — each taking a single interrupt object. The new API has `respondToInterrupts` taking a full `InterruptBatch` and a `responses` map. All interrupts (including single sync interrupts) now go through the batch path.

The evaluate templates (`lib/templates/cli/evaluate.mustache`, `lib/templates/cli/judgeEvaluate.mustache`) were updated to use the batch API. The compiled module export wrapper was changed to accept a batch instead of a checkpoint.

## What works

- Two sibling async threads that both interrupt → batch returned → respond → resume correctly
- Nested async (3 levels: main → foo → (async a → (async a1, async a2), async b)) with interrupts at different levels
- Completed threads don't re-execute side effects on resume (isForked fix)
- Direct `interrupt()` calls in non-tool-call contexts (approve path)
- Tool call interrupts with approve response

## What doesn't work yet

- Tool call interrupts with reject/modify responses in certain node-transition scenarios
- The `interruptReturnInFunc` test (node bar → node foo → func greet with interrupt) — stack frame ordering issue on resume
- Tests involving `__scopeMarker` references may need the scope marker generated in node setup code (added but may need verification)

## Test locations

- Unit tests: `lib/runtime/state/stateStack.test.ts`, `lib/runtime/state/pendingPromiseStore.test.ts`
- Generator fixture: `tests/typescriptGenerator/multi-thread-interrupt.agency`
- Integration tests: `tests/agency-js/multi-thread-interrupt/`, `tests/agency-js/nested-async-interrupt/`
- Design spec: `docs/superpowers/specs/2026-03-22-multi-thread-interrupts-design.md`
- Implementation plan: `docs/superpowers/plans/2026-03-22-multi-thread-interrupts.md`
