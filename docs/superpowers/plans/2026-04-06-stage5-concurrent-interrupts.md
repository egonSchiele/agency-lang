# Stage 5: Concurrent Interrupt Support

## Goal

Complete the concurrent interrupt infrastructure so that multiple forks can interrupt simultaneously. Interrupts are collected into a batch and surfaced to the caller for resolution. Uses a simple batch model (not streaming).

## Prerequisites

- Stage 3 (Fork/Race primitives)

## Background

Currently, concurrent interrupts throw `ConcurrentInterruptError`. With `fork`, concurrent interrupts become a common scenario. The existing `InterruptBatch` type in `lib/runtime/interrupts.ts` is a starting point.

## Design

### The algebraic effects insight

In algebraic effect systems, there's no special "multiple interrupts" concept. Each effect is handled independently. If 3 forks all perform effects, the handler gets called 3 times — each with its own continuation. The concurrency is managed by the fork infrastructure, not the handler.

This means: **no new handler semantics needed**. Each interrupt is collected and processed individually. The fork infrastructure collects results (values + interrupts) into an array.

### Batch model

Fork runs all threads → all settle → return results. Some results are values, some are interrupts. The caller handles each interrupt individually and resumes.

```
fork ([a, b, c]) as x {
  return interrupt("Approve: ${x}")
  return execute(x)
}
// Returns: [Interrupt, Interrupt, Interrupt]
// Or:      [value, Interrupt, value]
```

**Why batch, not streaming:**
- Fits Agency's existing request/response API
- No persistent connection infrastructure needed (WebSocket/SSE)
- Simpler for debugging, traces, and serialization
- Works naturally with web servers handling multiple concurrent requests (each request is isolated)
- Streaming could be added later as an optimization if needed

### InterruptBatch type

```typescript
type InterruptBatch = {
  type: "interruptBatch";
  interrupts: BatchedInterrupt[];
  completedResults: BatchedResult[];
  state: InterruptState;  // serialized full state tree
};

type BatchedInterrupt = {
  forkIndex: number;
  interruptId: string;
  data: any;
};

type BatchedResult = {
  forkIndex: number;
  value: any;
};
```

### Caller API

```typescript
import { foo, isInterruptBatch, respondToBatch } from "./foo.ts"

let result = await foo()

if (isInterruptBatch(result)) {
  // Inspect each interrupt
  for (const interrupt of result.interrupts) {
    console.log(`Fork ${interrupt.forkIndex}: ${interrupt.data}`)
  }

  // Respond to ALL interrupts (no partial resume)
  const responses = result.interrupts.map(interrupt => ({
    interruptId: interrupt.interruptId,
    response: { type: "approved" },
  }))

  result = await respondToBatch(result, responses)
}
```

All interrupts must be responded to before resuming. No partial resume — it adds complexity without a clear use case. If a user wants to approve some and reject others, they provide different response types per interrupt:

```typescript
const responses = [
  { interruptId: batch.interrupts[0].interruptId, response: { type: "approved" } },
  { interruptId: batch.interrupts[1].interruptId, response: { type: "rejected" } },
]
result = await respondToBatch(result, responses)
```

### Race + interrupts

`race` returns the first fork to settle, whether that's a value or an interrupt. Simple and predictable. If the user doesn't want interrupted races to surface, they put a `handle` block inside the race to auto-approve:

```
let result = race ([a, b, c]) as x {
  handle {
    return interrupt("Approve: ${x}")
    return execute(x)
  } with (data) {
    return approve()  // auto-approve within each fork
  }
}
```

### Handlers + fork interrupts

Handlers work the same as today — they process each interrupt individually:

- `handle` **inside** a fork block → handles interrupts per-fork (local). Each fork has its own handler scope.
- `handle` **outside** a fork → catches effects that propagate from any fork. The handler is called once per interrupt, independently.

No changes to handler semantics needed. The handler doesn't know or care about batching — it just handles one interrupt at a time.

### Nested fork interrupts

If an inner fork interrupts:

```
fork ([a, b]) as outer {
  fork ([1, 2, 3]) as inner {
    return interrupt("Approve: ${outer}-${inner}")
  }
}
```

The inner fork produces a batch (3 interrupts). The outer fork receives this as part of its execution. Since the outer fork is waiting for its body to settle, the inner batch propagates up. The outermost caller receives a flat batch with path information:

```typescript
type BatchedInterrupt = {
  path: number[];        // [outerForkIndex, innerForkIndex]
  interruptId: string;
  data: any;
};
```

Flattening means the caller always sees a single batch regardless of nesting depth.

## Deliverables

### 1. InterruptBatch type (`lib/runtime/interrupts.ts`)
Complete the type definition with all fields.

### 2. Batch collection in executeFork (`lib/runtime/fork.ts`)
After `Promise.allSettled`, collect results and interrupts. Return `InterruptBatch` if any interrupts exist, otherwise return value array.

### 3. respondToBatch function
Takes an `InterruptBatch` and responses for all interrupts. Deserializes state, resumes all forks, returns final results (or a new batch if forks re-interrupt).

### 4. isInterruptBatch utility
Type guard for detecting batch interrupts vs single interrupts vs normal results.

### 5. Remove ConcurrentInterruptError
Replace the throw in `PendingPromiseStore.awaitAll()` with batch collection.

### 6. Nested batch flattening
Inner fork batches are flattened into the outer batch with path information.

### 7. Generated module exports
Compiled modules export `isInterruptBatch`, `respondToBatch` alongside existing interrupt utilities.

## Testing Strategy

### Unit tests
- 2 of 3 forks interrupt, 1 completes → batch has 2 interrupts + 1 result
- All forks interrupt → batch has 3 interrupts
- No forks interrupt → normal results (no batch)
- Nested fork interrupts → flat batch with correct paths
- Race: first to settle is interrupt → returns interrupt
- Race: first to settle is value → returns value (others discarded)

### Handler tests
- Handle inside fork: auto-approves per-fork interrupts
- Handle outside fork: handles each fork's interrupt independently
- Handle rejects some, approves others

### Serialization round-trip tests
- InterruptBatch → serialize → respondToBatch → correct results
- Nested fork batch → round trip
- Batch with mixed responses (approve some, reject others) → round trip

### Backwards compatibility
- Single interrupt (no fork) still works with `isInterrupt` / `approveInterrupt`
- Existing interrupt tests all pass unchanged

## Known Bug: Branch Stack Isolation for Nested Function Calls

`processForkCall()` builds a fork block that receives `__forkBranchStack`, but the compiled block body does not pass that stack through to nested Agency function calls. Those calls default to `__ctx.stateStack` via `setupFunction`, which is the shared global stack — not the per-branch stack.

**Impact:** For simple cases (no interrupts, or interrupts directly in the fork body), this works because the function frames are pushed/popped synchronously within a single branch's execution. But for multi-step functions that interrupt inside a fork body and then resume, the deserialized state won't be found on the correct stack.

**Fix:** Plumb `__forkBranchStack` into the generated call configs. The builder should compile the fork body with a `stateStack` override so that `generateFunctionCallExpression` passes `stateStack: __forkBranchStack` for Agency function calls inside the block. This is the same pattern used by the existing async branch code (which passes `stateStack: ts.id("__forked")`).

**Test case:** A fork where a nested function call has multiple steps and interrupts mid-execution, then resumes. The interrupt serialization and resume must use the branch-specific stack.

## Additional Bug: Race Branch Cancellation

In `runner.fork()` with mode "race", losing branches are not cancelled after the first promise resolves. They continue running in the background and may trigger LLM calls, tool calls, or interrupts whose results are discarded. Consider adding `AbortController` support plumbed into block execution, checked before LLM/tool calls.

## Files to Modify

| File | Change |
|------|--------|
| `lib/runtime/interrupts.ts` | Complete InterruptBatch, add respondToBatch |
| `lib/runtime/fork.ts` | Batch collection |
| `lib/runtime/state/pendingPromiseStore.ts` | Replace ConcurrentInterruptError |
| `lib/runtime/types.ts` | Export batch types |
| `lib/backends/typescriptBuilder.ts` | Export batch utilities from compiled modules |
| `tests/agency/fork/` | Batch interrupt tests |
| `tests/agency-js/fork/` | Serialization round-trip tests |
