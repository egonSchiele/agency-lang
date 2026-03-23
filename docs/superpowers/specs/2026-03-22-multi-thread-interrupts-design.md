# Multi-Thread Interrupts Design

## Problem

Agency supports async function calls that run concurrently on forked state stacks. Currently, if more than one of these concurrent threads triggers an interrupt, the runtime throws `ConcurrentInterruptError`. This design adds support for multiple threads interrupting concurrently: all interrupts are collected, returned to the caller as a batch, and then all threads are resumed with the caller's responses.

## Background

Read these docs for context:
- `docs/dev/async.md` — how async function calls work, the forked state stack model, and why phase 1 throws `ConcurrentInterruptError`
- `docs/dev/checkpointing.md` — how checkpoint/restore works and how interrupts use checkpoints under the hood
- `CLAUDE.md` — overall architecture, runtime, and state serialization

### Running example

```agency
def foo() {
  async a()
  async b()
}

def a() {
  async a1()
  async a2()
}

def b() {
  response = interrupt("What's your name?")
}

def a1() {
  // completes normally
}

def a2() {
  age = interrupt("How old are you?")
}

node main() {
  foo()
}
```

Execution: main → foo → (async A, async B). A → (async A1, async A2). B interrupts. A2 interrupts. A1 completes. We need to surface both interrupts to the caller, collect responses, and resume all threads.

### Key insight: resume from a single root thread

We don't need to resume multiple threads simultaneously. All concurrent threads were spawned from a single root thread (node main). On resume, we re-execute from main. As re-execution reaches each `async` call, it restores the saved state for that thread. The tree of threads is reconstructed by replaying the call structure.

This means the problem reduces to **serializing and deserializing a tree of state stacks**.

## Design

### 1. Tree-shaped state — branches on State frames

The `State` type gains an optional `branches` field. Each branch represents a forked state stack from an async call, keyed by `__stack.step` (the step counter at the point the async call was made).

At runtime, branches hold live `StateStack` instances. In serialized form, they hold `StateStackJSON`. We use separate types for clarity:

```ts
type BranchState = {
  stack: StateStack;
  interrupt_id?: string;        // nanoid, set when this thread interrupted
  interruptData?: InterruptData;
};

type BranchStateJSON = {
  stack: StateStackJSON;
  interrupt_id?: string;
  interruptData?: InterruptData;
};

type State = {
  args: Record<string, any>;
  locals: Record<string, any>;
  threads: ThreadStoreJSON | null;
  step: number;
  branches?: Record<number, BranchState>;  // live — keyed by __stack.step
};

type StateJSON = {
  args: Record<string, any>;
  locals: Record<string, any>;
  threads: ThreadStoreJSON | null;
  step: number;
  branches?: Record<number, BranchStateJSON>;  // serialized
};
```

Why `__stack.step` and not `__step`: `__stack.step` is the live counter that increments with each statement. `__step` is the snapshot from when deserialization started. The branch key must reflect the actual step at call time.

Why step numbers are sufficient: step numbers are unique within a function scope. Branches at different levels of the tree are on different `State` frames, so step numbers only need to be unique among siblings, not globally. The tree position + step number together form a globally unique path.

For the running example, the serialized tree looks like:

```json
{
  "stack": [
    { "step": 0, "locals": {}, "args": {} },
    { "step": 2, "locals": {}, "args": {},
      "branches": {
        "0": {
          "stack": {
            "stack": [
              { "step": 2, "locals": {}, "args": {},
                "branches": {
                  "0": {
                    "stack": { "stack": [{ "step": 1, "locals": {}, "args": {} }] }
                  },
                  "1": {
                    "stack": { "stack": [{ "step": 0, "locals": {"age": null}, "args": {} }] },
                    "interruptData": {}
                  }
                }
              }
            ]
          }
        },
        "1": {
          "stack": { "stack": [{ "step": 0, "locals": {"response": null}, "args": {} }] },
          "interruptData": {}
        }
      }
    }
  ]
}
```

Frame 0 is main (step 0, at the `foo()` call). Frame 1 is foo (step 2, at awaitAll). Foo's branches hold A (key 0) and B (key 1). A's frame has its own branches for A1 (key 0) and A2 (key 1). Completed threads (A1) are included in the tree — their step counter is past the last statement, so on resume all statements are skipped and the function returns immediately. No separate "done" status is needed; the step counter itself encodes whether a thread completed.

### 2. Serialization — how the tree gets built

The forked state stack is attached to the parent frame's `branches` at call time in the generated code:

```ts
// Generated code for: async a()
const __forked = __ctx.forkStack();
__stack.branches = __stack.branches || {};
__stack.branches[__stack.step] = { stack: __forked };
__ctx.pendingPromises.add(a({ ctx: __ctx, stateStack: __forked }));
```

The parent frame holds a live reference to each child's forked `StateStack` object — `__stack.branches[step].stack` and the async function's stack are the same JS object reference. As async threads run and modify their stacks, the parent's branches stay up to date automatically.

**Serialization**: The existing `StateStack.toJSON()` uses `deepClone` (`JSON.parse(JSON.stringify(...))`), which will not correctly serialize live `StateStack` instances in branches — `JSON.stringify` does not call `toJSON()` on class instances. The serialization must be updated to explicitly walk `branches` on each frame and call `toJSON()` recursively on each branch's `StateStack`. Similarly, `StateStack.fromJSON()` must reconstruct live `StateStack` objects from the serialized `BranchStateJSON` entries.

`PendingPromiseStore` does not need to track forked stacks or step numbers — it remains unchanged. The tree structure is maintained entirely by the frames themselves.

### 3. Deserialization — how the tree gets restored

On resume, execution replays from node main. When re-execution hits an async call, it checks for a saved branch on the current frame:

```ts
// Generated code for: async a() — with deserialization support
let __forked;
if (__stack.branches && __stack.branches[__stack.step]) {
  __forked = __stack.branches[__stack.step].stack;
  __forked.deserializeMode();
} else {
  __forked = __ctx.forkStack();
}
__stack.branches = __stack.branches || {};
__stack.branches[__stack.step] = { stack: __forked };
__ctx.pendingPromises.add(a({ ctx: __ctx, stateStack: __forked }));
```

Async calls need a modified guard. Normally, statements use `if (__step <= N)` to skip past already-executed statements during deserialization. But async calls with saved branches must always fire so the thread can resume, even if the parent's step counter is past them:

```ts
if (__step <= N || (__stack.branches && __stack.branches[N])) {
  // trigger async call with saved or fresh branch
}
```

This ensures:
- **Interrupted threads** (A2, B): re-triggered with saved stack in deserialize mode, step counter resumes at interrupt point, interruptData injected
- **Completed threads** (A1): re-triggered with saved stack, step counter is past everything, all statements skipped, function returns immediately
- **Fresh execution** (no branch exists): normal fork, normal execution

Each forked StateStack independently tracks its own serialize/deserialize mode. On resume, some stacks may finish deserializing before others — this is fine because they are independent objects. When main's stack finishes deserializing, it switches to serialize mode. Meanwhile, thread A2's stack may still be in deserialize mode. No conflict.

### 4. Interrupt collection — awaitAll changes

`PendingPromiseStore.awaitAll()` currently throws `ConcurrentInterruptError` when it discovers an interrupt among resolved promises. The new behavior: collect all interrupts into a list and return them.

```ts
async awaitAll(): Promise<Interrupt[]> {
  const keys = Object.keys(this.pending);
  if (keys.length === 0) return [];

  const entries = keys.map((k) => ({ key: k, entry: this.pending[k] }));
  this.pending = {};

  const results = await Promise.all(entries.map((e) => e.entry.promise));

  const interrupts: Interrupt[] = [];
  for (let i = 0; i < entries.length; i++) {
    const { entry } = entries[i];
    const result = results[i];

    if (isInterrupt(result)) {
      interrupts.push(result);
    } else if (entry.resolve) {
      entry.resolve(result);
    }
  }
  return interrupts;
}
```

**How interrupts are collected**: All pending promises from all levels of nesting register on the shared `RuntimeContext.pendingPromises`. Functions do not have their own `awaitAll` — only `runNode` calls `awaitAll` at the top level. So when A calls `async a1()` and `async a2()`, those promises register on the same `PendingPromiseStore` as A and B themselves. When `awaitAll` runs in `runNode`, it sees all promises flat: A, B, A1, A2. A2's and B's promises resolve with interrupt objects; A1's and A's resolve with normal values. The interrupts are collected into a flat list regardless of nesting depth.

The nesting information is NOT lost — it's preserved in the branch tree on the frames. But interrupt collection itself is flat.

`ConcurrentInterruptError` is removed entirely.

### 5. Interrupt batch — return type and IDs

Each interrupt gets a globally unique `interrupt_id` (nanoid) assigned at the leaf where the interrupt originates:

```ts
type Interrupt<T = any> = {
  type: "interrupt";
  interrupt_id: string;    // nanoid
  data: T;
  interruptData?: InterruptData;
};
```

All interrupts are returned to the caller as a batch, along with a shared checkpoint that captures the full tree:

```ts
type InterruptBatch = {
  type: "interrupt_batch";
  interrupts: Interrupt[];
  checkpoint: Checkpoint;
};
```

The checkpoint captures the complete tree of state stacks (main + all branches). The `interruptData` for each interrupted thread lives on its branch in the tree.

Agency's interrupt model is fundamentally stateless: the agent returns all state needed to resume. No state is saved on the agent between calls. The `InterruptBatch` contains everything needed to resume — the caller can serialize it, store it, and resume on a different machine. This is why all interrupts must be returned at once rather than one at a time (an iterator approach would require storing remaining interrupts on the agent, breaking statelessness).

### 6. Responding to interrupts

The caller collects responses for all interrupts and calls `respondToInterrupts`:

```ts
// Internal runtime function
async function respondToInterrupts(args: {
  ctx: RuntimeContext<GraphState>;
  checkpoint: Checkpoint;
  responses: Record<string, InterruptResponse>;  // keyed by interrupt_id
  metadata?: Record<string, any>;
}): Promise<any>  // returns result or another InterruptBatch
```

The compiled module exports a convenience wrapper bound to `__globalCtx`, so the caller never sees `ctx`:

```ts
// Generated code in compiled module
export const respondToInterrupts = (
  checkpoint: Checkpoint,
  responses: Record<string, InterruptResponse>,
  metadata?: Record<string, any>
) => _respondToInterrupts({ ctx: __globalCtx, checkpoint, responses, metadata });
```

Usage from TypeScript:

```ts
const batch = await run("main");
if (batch.type === "interrupt_batch") {
  const responses = {
    [batch.interrupts[0].interrupt_id]: { type: "approve" },
    [batch.interrupts[1].interrupt_id]: { type: "resolve", value: 25 },
  };
  const result = await respondToInterrupts(batch.checkpoint, responses);
}
```

Internally, `respondToInterrupts`:

1. Validates that all interrupt IDs in the batch have corresponding responses (throws if any are missing)
2. Restores state from the checkpoint (which contains the full tree of branches)
3. Re-executes from the root node, passing the `responses` map down through execution
4. During deserialization, when a thread reaches an interrupt point, it finds the `interrupt_id` in the deserialized state and looks up the matching response from the `responses` map
5. If resumed threads trigger new interrupts, returns another `InterruptBatch`
6. Otherwise returns the final result

**Interrupt-to-response matching**: The `interrupt_id` connects interrupts to responses at deserialization time. When an interrupt is created during original execution, it gets a nanoid. That same nanoid appears both on the `Interrupt` object returned to the caller AND in the serialized state tree (stored alongside the interrupted frame). On resume, when deserialization reaches an interrupt point, the code finds the `interrupt_id` in the deserialized state and looks up the corresponding response from the caller's `responses` map. No tracing from promises to branches is needed — the `interrupt_id` is the only link required. The exact location where `interrupt_id` is stored in the serialized state (e.g., on the `State` frame, as a local variable, or on the `BranchState`) is an implementation detail.

The old single-interrupt functions (`approveInterrupt`, `rejectInterrupt`, `modifyInterrupt`, `resolveInterrupt`, `respondToInterrupt`) are replaced by `respondToInterrupts`.

### 7. Edge cases and error handling

**Single interrupt**: The batch has one interrupt. The caller responds with one entry. No special case needed.

**No interrupts**: Normal execution, no batch returned. Same as current behavior.

**Thread throws an error**: If any thread rejects with an actual error (not an interrupt), `Promise.all` in `awaitAll` fails fast. The error propagates up. Pending interrupts from other threads are discarded. Errors take priority over interrupts.

**Nested interrupts on resume**: After responding to all interrupts and resuming, threads may hit new interrupts. This returns another `InterruptBatch`. The caller loops until they get a final result.

**Missing response for an interrupt**: `respondToInterrupts` validates upfront that every `interrupt_id` from the batch has a corresponding response. Throws a clear error if any are missing.

**Extra/unknown interrupt IDs in responses**: Ignored silently — they might be stale from a previous attempt.

## Files to modify

### Runtime
- `lib/runtime/state/stateStack.ts` — add `branches` to `State` type, add `BranchState`/`BranchStateJSON` types, update `toJSON`/`fromJSON` to serialize/deserialize branches recursively (cannot rely on `deepClone` for `StateStack` instances)
- `lib/runtime/state/pendingPromiseStore.ts` — change `awaitAll` to return `Interrupt[]` instead of throwing `ConcurrentInterruptError` (no other changes needed)
- `lib/runtime/interrupts.ts` — add `InterruptBatch` type, add `respondToInterrupts`, remove old single-interrupt functions, add `interrupt_id` to `Interrupt`
- `lib/runtime/state/context.ts` — no changes expected (forkStack stays as-is)
- `lib/runtime/node.ts` — update `runNode` to handle interrupt arrays from `awaitAll` and return `InterruptBatch`
- `lib/runtime/errors.ts` — remove `ConcurrentInterruptError`
- `lib/runtime/index.ts` — update exports

### Builder / code generation
- `lib/backends/typescriptBuilder.ts` — modify async call generation to attach forked stacks to `__stack.branches`, add modified step guard for async calls (`if (__step <= N || branches[N])`)
- `lib/templates/backends/` — update import templates to export `respondToInterrupts` instead of old interrupt functions

### Tests
- `lib/runtime/state/pendingPromiseStore.test.ts` — update tests: remove `ConcurrentInterruptError` tests, add tests for interrupt collection
- `lib/runtime/state/stateStack.test.ts` — add tests for tree serialization/deserialization with branches
- `tests/typescriptGenerator/` — add fixture for multi-thread interrupt code generation
- `tests/agency-js/` — add integration tests for the running example and edge cases

## Test cases

1. **Two sibling threads interrupt** — the running example (foo calls async A and B, B and A2 interrupt). Verify both interrupts returned in batch, respond to both, verify final result.

2. **One thread interrupts, one completes** — async A completes normally, async B interrupts. Verify batch has one interrupt. On resume, A does not re-execute side effects (step counter past end).

3. **Nested async with interrupts at different levels** — the full running example with A1 completing and A2 interrupting. Verify tree structure serializes correctly and deserializes at each level.

4. **Resume triggers new interrupts** — after responding to first batch, resumed threads hit new interrupts. Verify another `InterruptBatch` is returned.

5. **Single thread interrupts** — only one async thread, it interrupts. Behaves like current single-interrupt case but uses new batch API.

6. **No threads interrupt** — all async threads complete normally. No batch, normal result returned.

7. **Thread throws error** — one thread throws, another would have interrupted. Verify error propagates, no batch returned.

8. **Missing response in respondToInterrupts** — caller omits a response for one interrupt ID. Verify clear error thrown.

9. **Deeply nested async tree** — three levels of async nesting with interrupts at the leaves. Verify tree serialization/deserialization works at arbitrary depth.

10. **Interrupt in loop with async** — async call inside a loop where multiple iterations interrupt. Verify each gets a unique step number and branch.
