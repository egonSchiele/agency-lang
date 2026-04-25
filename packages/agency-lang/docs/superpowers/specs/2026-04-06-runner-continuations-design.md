# Runner and Continuations Design

## Motivation

LLMs produce non-deterministic output. Programmers need strategies to get reliable results: running multiple versions of the same prompt in parallel and picking the most common response, trying different LLM parameters, trying several different prompts and picking the best branch, retrying with feedback, etc.

Agency already has the core infrastructure for this: state serialization, execution isolation per call, and parallel branches with independent state stacks. What's missing is a clean abstraction that lets users express these patterns.

This design introduces:
1. A **Runner** class that centralizes step execution, replacing scattered if-statement step guards
2. **Block arguments** that let users pass code blocks to functions (serializable, with substeps and interrupt support)
3. **`fork`** and **`race`** primitives that run a block multiple times in parallel with different inputs, each with isolated state
4. **Stdlib functions** (`sample`, `retry`, `consensus`, etc.) built on `fork` and blocks

## Design Principles

- **Two compiler primitives (`fork` and `race`), one language feature (block arguments), everything else is library code.** `race` can't be built from `fork` because `fork` waits for all results while `race` returns the first. Users can write their own strategies as regular Agency functions using these primitives.
- **Forks are fully isolated.** Each fork gets a deep copy of state. Mutations inside a fork don't affect the parent. The only way to communicate back is the return value.
- **No replay on resume.** All variable values live in `State.locals` and are restored from the serialized snapshot. When resuming, just jump to the right step — no need to re-execute prior steps.
- **Incremental delivery.** Each stage is independently valuable and testable.

## Architecture

### Runner Class

Replaces the current pattern where each step is an if-statement:

```typescript
// Current (generated code)
if (__step <= 0) {
  __stack.locals.x = 5;
  __stack.step++;
}

// New (generated code)
await __runner.step(0, async () => {
  __stack.locals.x = 5;
});
```

The Runner centralizes:
- **Skip/execute logic**: checks `frame.step > id` to skip already-executed steps
- **Debugger hooks**: calls `ctx.debugger?.beforeStep()` / `afterStep()` at every step boundary
- **Trace capture**: writes checkpoints via `ctx.traceWriter` at every step
- **Step advancement**: increments `frame.step` after callback execution

```typescript
class Runner {
  private ctx: RuntimeContext;

  async step<T>(id: number, callback: () => Promise<T>): Promise<T | void> {
    const frame = this.ctx.stateStack.lastFrame();

    // Skip: already past this step (resuming from interrupt/checkpoint)
    if (frame.step > id) {
      return;
    }

    // Debugger hook
    await this.ctx.debugger?.beforeStep(id, this);

    // Trace checkpoint
    if (this.ctx.traceWriter) {
      const cp = Checkpoint.fromContext(this.ctx, stepInfo);
      this.ctx.traceWriter.writeCheckpoint(cp);
    }

    // Execute
    const result = await callback();
    frame.step = id + 1;

    // Debugger hook
    await this.ctx.debugger?.afterStep(id, result, this);

    return result;
  }

  // Capture continuation = snapshot the current state
  capture(): Continuation {
    return { state: this.ctx.stateToJSON() };
  }

  // Fork = create independent runner with cloned state
  fork(): Runner {
    const forkedCtx = this.ctx.createIsolatedContext();
    forkedCtx.restoreFromJSON(deepClone(this.capture().state));
    return new Runner(forkedCtx);
  }
}
```

### Block Arguments

Blocks are closures: a function reference + captured state. They are **directly serializable** and support **substeps** so that interrupts can resume mid-block. They participate in the fork/continuation system — each fork gets its own copy of the closed-over variables.

Agency syntax:

```
// Block as last argument to a function
let results = sample(5) {
  llm("Classify: ${text}")
}

// Block with explicit parameter
let results = fork ([0.3, 0.7, 1.0]) as temp {
  llm("Summarize: ${doc}") with { temperature: temp }
}
```

Blocks can be optional (`block?: () -> string`), and work alongside variadic arguments (variadic args inside parens, block trailing after parens). Default values for blocks are not supported — use optional + null check.

Serialization: a block is serialized as its compiler-generated ID (which maps to the block's compiled function) plus the captured variable values (stored in the StateStack). Substep state within the block is also serialized, enabling interrupt resume at any point inside a block.

Blocks can contain any Agency statements including `interrupt()` calls.

### Fork and Race Primitives

**`fork`** and **`race`** are the two compiler primitives. They share state capture, isolation, and branch creation — they differ only in how results are collected.

```
// fork: wait for all, return array
let results: string[] = fork ([0.3, 0.7, 1.0]) as temp {
  let summary: string = llm("Summarize: ${doc}") with { temperature: temp }
  return summary
}

// race: return first to complete
let winner: string = race ([prompt1, prompt2, prompt3]) as p {
  return llm(p)
}
```

Note: arguments to fork/race are in parentheses.

Each fork gets:
- Its own `StateStack` (via existing `BranchState` infrastructure)
- Its own copy of locals (including closed-over variables)
- Independent step counters
- Independent interrupt tracking

`race` cannot be built from `fork` because `fork` uses `Promise.allSettled` (wait for all) while `race` needs `Promise.race` (first to complete). They share enough implementation that the added complexity is minimal.

### Concurrent Interrupts

Fork makes concurrent interrupts a **common scenario** rather than an edge case. The existing `InterruptBatch` type in `lib/runtime/interrupts.ts` is a starting point, but this requires its own detailed sub-plan covering:
- Batch interrupt collection (replace `ConcurrentInterruptError` with collection)
- How callers receive and respond to batched interrupts
- Partial resume semantics (respond to some interrupts, leave others pending)
- How interrupts bubble through nested forks

### Stdlib Functions

Built on `fork`, `race`, and block arguments:

```
def sample(n: number, block: () -> any): any[] {
  return fork (range(n)) as _ { return block() }
}

def retry(n: number, test: (any) -> boolean, block: () -> any): any {
  for i in range(n) {
    let result = block()
    if test(result) { return result }
  }
  return null
}

def consensus(n: number, block: () -> any): any {
  let results = sample(n, block)
  return mostCommon(results)
}

def bestOf(n: number, scorer: (any) -> number, block: () -> any): any {
  let results = sample(n, block)
  return maxBy(results, scorer)
}
```

### Relationship to Async

The current `async` keyword provides unstructured concurrency (fire and forget, join when value is used). `fork` provides structured concurrency (explicit fork, explicit join). Structured concurrency is strictly better for debugger, traces, and serialization.

For now, `async` is kept as-is. After `fork` is stable, consider implementing `async` on top of fork infrastructure, documenting `fork` as preferred for new code, and eventually deprecating `async`.

## Cross-Cutting Concerns

### Serialization

**When a fork interrupts:** Only that fork pauses. Other forks continue. The parent waits at the `fork` step for all forks to settle (complete or interrupt). Then results are collected — each element is either a value or an interrupt. The full state tree (parent frame + all fork branches) is serialized using the existing `BranchState` recursive serialization.

This follows `Promise.allSettled` semantics: wait for everything, then let the user decide what to do with mixed results (some values, some interrupts).

**Serialized state structure:**
```
Parent StateStack
  └─ Frame (step = fork step, waiting for results)
     └─ branches:
        ├─ "fork_0": { stack: Fork0Stack, interruptId?: ..., interruptData?: ... }
        ├─ "fork_1": { stack: Fork1Stack }  // completed
        └─ "fork_2": { stack: Fork2Stack, interruptId?: ..., interruptData?: ... }
```

This is the same tree structure that async branches already use. No new serialization infrastructure needed.

### Debugger

**Phase 1 (Runner rework):** Debugger behavior is preserved. The Runner calls `debugStep()` at every step boundary, same as today. When the debugger hits a `fork`, all forks run to completion without stepping. The debugger resumes stepping in the parent after fork results are collected. This matches the current behavior with async branches.

**Phase 2 (future, not part of this plan):** Fork-aware debugging. When hitting a `fork`, show a fork selector UI. User picks which fork to step into. Others run to completion. This is a UX enhancement that can be added later.

### Traces

Each fork writes its own checkpoints to the same `TraceWriter`, tagged with a fork identifier. The trace file remains linear JSONL, but manifests include a `forkId` field (`null` for parent, `"fork_0"`, `"fork_1"`, etc. for forks).

**Trace structure for a fork:**
```
Parent checkpoints: step 0, step 1, [FORK at step 2]
  Fork 0 checkpoints: step 0, step 1, step 2 → result
  Fork 1 checkpoints: step 0, step 1, step 2 → result
  Fork 2 checkpoints: step 0, step 1, step 2 → result
Parent checkpoints: step 3 (after fork, with results)
```

The `TraceReader` reconstructs this as a tree. The content-addressable storage naturally deduplicates: forks that start from the same captured state share chunks.

**Phase 1 (Runner rework):** Traces capture fork checkpoints as nested branch data within parent checkpoints (using existing `BranchState` serialization in `StateJSON`). No changes to trace format needed.

**Phase 2 (future, not part of this plan):** Add `forkId` to trace manifests for richer visualization. Show the trace as a tree that forks and rejoins.

## Implementation Stages

### Stage 1: Runner Class

Replace if-statement step guards with a Runner class. This is a refactor — no new language features, no behavior changes. All existing tests must continue to pass.

See: `docs/superpowers/plans/2026-04-06-stage1-runner-class.md`

### Stage 2: Block Arguments

Add the ability to pass code blocks as arguments to functions. This is a language feature that requires parser, type checker, builder, and runtime changes.

See: `docs/superpowers/plans/2026-04-06-stage2-block-arguments.md`

### Stage 3: Fork/Race Primitives and Continuation Infrastructure

Add the `fork` and `race` keywords. This requires the Runner's `capture()` and `fork()` methods, parallel execution of fork blocks, result collection, and integration with serialization/debugger/traces.

See: `docs/superpowers/plans/2026-04-06-stage3-fork-primitive.md`

### Stage 4: Stdlib Functions

Build `sample`, `retry`, `bestOf`, `consensus`, and other utility functions using `fork`, `race`, and block arguments. These are written in Agency code and shipped as part of the standard library.

See: `docs/superpowers/plans/2026-04-06-stage4-stdlib-functions.md`

### Stage 5: Concurrent Interrupt Support

Complete the concurrent interrupt infrastructure so multiple forks can interrupt simultaneously. Uses a batch model: all forks settle, interrupts are collected, caller responds to all at once. No partial resume, no streaming — simple request/response.

See: `docs/superpowers/plans/2026-04-06-stage5-concurrent-interrupts.md`

### Stage 6: Fork-Aware Debugger UI

Extend the debugger to let users step through individual forks interactively. Adds fork selector, fork switching, fork status panel, and per-fork variable inspection.

See: `docs/superpowers/plans/2026-04-06-stage6-fork-aware-debugger.md`
