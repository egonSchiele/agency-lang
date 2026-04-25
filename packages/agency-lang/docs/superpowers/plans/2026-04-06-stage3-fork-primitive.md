# Stage 3: Fork Primitive and Continuation Infrastructure

## Goal

Add the `fork` keyword — the core continuation primitive. `fork` runs a block multiple times in parallel with different inputs, each with fully isolated state. Returns an array of results.

Also add `race` as a second primitive that shares most of the implementation but returns the first result to complete rather than waiting for all.

## Prerequisites

- Stage 1 (Runner class) — Runner provides the state capture and forking mechanism
- Stage 2 (Block arguments) — blocks provide the code-as-value mechanism
- **Concurrent interrupt support** — fork makes concurrent interrupts a first-class scenario. The existing `InterruptBatch` infrastructure in `lib/runtime/interrupts.ts` needs to be completed. This may be a sub-stage or prerequisite. See "Concurrent Interrupts" section below.

## Language Design

### Fork Syntax

```
// Fork with an array of inputs — note parentheses around the input array
let results = fork ([0.3, 0.7, 1.0]) as temp {
  let summary: string = llm("Summarize: ${doc}") with { temperature: temp }
  return summary
}
// results: string[] — one per fork

// Fork with an array of objects
let results = fork ([
  { temp: 0.3, model: "gpt-4" },
  { temp: 0.7, model: "gpt-4" },
  { temp: 1.0, model: "gpt-3.5" },
]) as params {
  let summary: string = llm("Summarize: ${doc}") with { temperature: params.temp, model: params.model }
  return summary
}
```

### Race Syntax

```
// Race: run all in parallel, return first to complete
let winner = race ([prompt1, prompt2, prompt3]) as p {
  return llm(p)
}
```

### Fork vs Race

`fork` and `race` share the same state capture, isolation, and branch creation infrastructure. They differ only in how results are collected:

| | `fork` | `race` |
|---|---|---|
| Semantics | Wait for all, return array | Return first to complete |
| Return type | `U[]` (array) | `U` (single value) |
| Runtime | `Promise.allSettled` | `Promise.race` (+ cancel others) |
| Interrupts | Collects all interrupts | First interrupt or first result wins |

The implementation shares: state capture (`Runner.capture()`), fork creation (`Runner.fork()`), isolated branch execution, `BranchState` serialization. The difference is a single function: `collectAll` vs `collectFirst`.

### Why two primitives

`race` cannot be built from `fork` because `fork` always waits for all forks to settle. `race` needs to return as soon as the first result is available and discard the rest. This requires `Promise.race` semantics at the runtime level.

They share enough implementation that the added complexity is minimal — it's the same fork infrastructure with a different await strategy.

### Semantics

1. **State capture**: At the fork/race point, the current state is captured.
2. **Isolation**: Each fork gets a **deep copy** of the captured state. Mutations inside a fork don't affect the parent or other forks.
3. **Parallel execution**: All forks run in parallel.
4. **Result collection**:
   - `fork`: Returns array of all results via `Promise.allSettled`. Results are in the same order as the input array.
   - `race`: Returns first result via `Promise.race`. Other forks are discarded (their state is dropped — no cleanup needed since they're pure isolated state).
5. **Block scope**: The fork variable (e.g., `temp`) is available inside the block. All other variables are copies from the enclosing scope.
6. **Return value**: Each fork's block must return a value.

### Type inference

```
// If inputs are T[] and block returns U:
// fork returns U[]
// race returns U
let inputs: number[] = [0.3, 0.7, 1.0]
let allResults: string[] = fork (inputs) as temp { return llm("...") }
let firstResult: string = race (inputs) as temp { return llm("...") }
```

### Nesting

Forks can be nested:

```
let results = fork ([a, b]) as outer {
  let inner_results = fork ([1, 2, 3]) as inner {
    return process(outer, inner)
  }
  return bestOf(inner_results)
}
```

Each level of nesting creates its own isolation boundary. Inner forks are fully contained within their parent fork.

## Concurrent Interrupts

Fork makes concurrent interrupts a **common scenario** rather than an edge case. Currently, concurrent interrupts throw `ConcurrentInterruptError`. This needs to change.

### The problem

```
let results = fork ([action1, action2, action3]) as action {
  return interrupt("Approve: ${action}")
  return execute(action)
}
// What happens? Three interrupts fired in parallel.
```

### Required infrastructure

The existing `InterruptBatch` type in `lib/runtime/interrupts.ts` is a starting point. The plan:

1. **Collect, don't throw**: When multiple forks interrupt, collect all interrupts into an `InterruptBatch` instead of throwing `ConcurrentInterruptError`.
2. **Batch serialization**: The parent's state is serialized with all fork branches. Each branch's `interruptId` and `interruptData` are preserved (this already exists in `BranchState`).
3. **Batch response**: The caller receives an `InterruptBatch` containing all pending interrupts. They respond to each one individually (approve/reject/etc.).
4. **Partial resume**: When some interrupts are responded to and others aren't, only the responded-to forks resume. The rest stay paused.
5. **Inner fork interrupts**: If an inner fork interrupts, the outer fork is waiting for it. The interrupt bubbles up through the fork layers. The outermost fork collects all interrupts from all levels and returns them as a batch.

### Sub-plan needed

This is complex enough to warrant its own detailed plan document. It should cover:
- InterruptBatch API changes
- How the caller receives and responds to batched interrupts
- Partial resume semantics
- How bubbling through nested forks works
- Changes to the TypeScript caller API (isInterrupt, approveInterrupt, etc.)
- Backwards compatibility with single-interrupt code

This sub-plan should be written and implemented as part of Stage 3, ideally before the fork primitive itself.

## Relationship to Async

The current `async` keyword provides unstructured concurrency — fire off a function, join implicitly when the value is used. `fork` provides structured concurrency — explicit fork point, explicit join point, always know when things finish.

### For this stage

Keep `async` working as-is. Don't change its behavior. Internally, `async` continues to use the existing branch infrastructure (`PendingPromiseStore`, `BranchState`). `fork` uses a similar but independent code path.

### Future consideration

After `fork` is stable, consider:
- Implementing `async` on top of the fork infrastructure (share code, reduce complexity)
- Documenting `fork` as preferred for new code
- Eventually deprecating `async` in favor of `fork`

This is a future decision, not part of this stage.

## Deliverables

### 1. AST node types (`lib/types/`)

```typescript
// lib/types/fork.ts
export type ForkExpression = BaseNode & {
  type: "forkExpression";
  inputs: Expression;            // The array expression (in parentheses)
  paramName: string;             // The `as <name>` variable
  paramType?: VariableType;      // Optional type annotation
  body: AgencyNode[];            // The block body
  mode: "all" | "race";         // fork vs race
};
```

Add to `AgencyNode` union in `lib/types.ts`.

### 2. Parser (`lib/parsers/`)

```
forkExpr = "fork" "(" expression ")" "as" identifier "{" body "}"
raceExpr = "race" "(" expression ")" "as" identifier "{" body "}"
```

Both parse to `ForkExpression` with different `mode` values. Add unit tests.

### 3. Type checker (`lib/typeChecker.ts`)

- Verify the inputs expression is an array type
- Infer the fork parameter type from the array element type
- Type-check the block body with the fork parameter in scope
- Fork return type: `U[]` where `U` is block's return type
- Race return type: `U` where `U` is block's return type
- Verify the block has a return value

### 4. Preprocessor (`lib/preprocessors/typescriptPreprocessor.ts`)

- Resolve variable scopes in the fork body — identify captured variables
- Mark the fork parameter as a local variable within the block scope
- Handle nested forks (each fork body is an independent scope)

### 5. Runner continuation methods (`lib/runtime/runner.ts`)

Add `capture()` and `fork()` methods to the Runner class:

```typescript
class Runner {
  /**
   * Capture the current execution state as a continuation.
   */
  capture(): Continuation {
    return {
      state: this.ctx.stateToJSON(),
    };
  }

  /**
   * Create a new isolated Runner from a captured continuation.
   */
  static fork(continuation: Continuation, parentCtx: RuntimeContext): Runner {
    const forkedCtx = parentCtx.createForkContext();
    forkedCtx.restoreFromJSON(deepClone(continuation.state));
    return new Runner(forkedCtx);
  }
}

export type Continuation = {
  state: InterruptState;
};
```

### 6. Fork execution runtime (`lib/runtime/fork.ts`)

```typescript
/**
 * Execute a fork: run block for each input in parallel with isolated state.
 * Returns array of results (fork mode) or first result (race mode).
 */
export async function executeFork<T, U>(
  inputs: T[],
  blockFn: (input: T, runner: Runner) => Promise<U>,
  ctx: RuntimeContext,
  mode: "all" | "race",
): Promise<(U | Interrupt)[] | U | Interrupt> {
  const continuation = ctx.runner.capture();

  // Create isolated branches
  const branches = inputs.map((input, i) => {
    const forkRunner = Runner.fork(continuation, ctx);
    const branchKey = `fork_${i}`;

    // Store branch for serialization
    const frame = ctx.stateStack.lastFrame();
    frame.branches = frame.branches || {};
    frame.branches[branchKey] = { stack: forkRunner.stateStack };

    return { input, runner: forkRunner, branchKey };
  });

  // Execute based on mode
  if (mode === "all") {
    const settled = await Promise.allSettled(
      branches.map(b => blockFn(b.input, b.runner))
    );
    return settled.map(r =>
      r.status === "fulfilled" ? r.value : r.reason
    );
  } else {
    // race mode: first to complete wins
    return Promise.race(
      branches.map(b => blockFn(b.input, b.runner))
    );
    // Other forks' state is simply dropped (GC'd)
  }
}
```

### 7. Builder (`lib/backends/typescriptBuilder.ts`)

Add `processForkExpression()`:

```typescript
// Agency:
let results = fork ([0.3, 0.7, 1.0]) as temp {
  let summary: string = llm("Summarize: ${doc}") with { temperature: temp }
  return summary
}

// Generated TypeScript:
const results = await executeFork(
  [0.3, 0.7, 1.0],
  async (temp, __forkRunner) => {
    const __forkState = __forkRunner.getState();
    __forkState.locals.doc = deepClone(__stack.locals.doc);  // capture

    await __forkRunner.substep("f0", 0, async () => {
      __forkState.locals.summary = await runPrompt(__forkCtx, ...);
    });
    return __forkState.locals.summary;
  },
  __ctx,
  "all",
);
```

### 8. Serialization

Uses existing `BranchState` infrastructure. Fork branches are stored in `State.branches` on the parent frame. `toJSON()` / `fromJSON()` already walk branches recursively.

On resume from interrupt inside a fork:
1. Parent function re-entered, Runner skips to fork step
2. `executeFork` detects branches in state (deserialize mode)
3. Completed forks: return cached result
4. Interrupted forks: restore branch StateStack, resume from interrupt point
5. Not-yet-started forks: run fresh

### 9. Debugger integration

When debugger hits a fork/race, all forks run to completion without stepping (same as current async behavior). Debugger resumes stepping after results are collected.

### 10. Trace integration

Fork checkpoints are captured as nested branch data within parent checkpoints. Each fork's Runner writes checkpoints tagged with the fork's branch key. No trace format changes needed.

## Testing Strategy

### Unit tests
- Parser tests for fork and race syntax
- Type checker: valid fork/race, wrong input type, missing return, type inference
- Runner: capture/fork creates isolated copies, mutations don't cross-propagate

### Integration test fixtures (`tests/typescriptGenerator/`)
- `fork-basic.agency` / `.mts` — basic fork
- `fork-objects.agency` / `.mts` — fork with object inputs
- `fork-capture.agency` / `.mts` — verify captured variables are copies
- `fork-nested.agency` / `.mts` — nested forks
- `race-basic.agency` / `.mts` — basic race

### End-to-end tests (`tests/agency/fork/`)
- Fork returns array of results in correct order
- Fork isolation: parent state unchanged after fork
- Fork isolation: forks don't affect each other
- Fork with interrupt in one fork (others complete)
- Fork with interrupts in all forks (interrupt batch)
- Fork resume after interrupt response
- Nested fork with inner interrupt
- Race returns first result
- Race discards other forks
- Fork capturing outer variables (copies, not refs)

### Serialization tests (`tests/agency-js/fork/`)
- Fork + interrupt → serialize → deserialize → resume
- Nested fork interrupt → round trip
- Race + interrupt → round trip

## Files to Modify

| File | Change |
|------|--------|
| `lib/types/fork.ts` | **New** — ForkExpression AST node |
| `lib/types.ts` | Add to AgencyNode union |
| `lib/parsers/fork.ts` | **New** — fork/race parsers |
| `lib/parser.ts` | Wire in fork parsers |
| `lib/typeChecker.ts` | Type check fork/race |
| `lib/preprocessors/typescriptPreprocessor.ts` | Scope resolution for fork bodies |
| `lib/runtime/runner.ts` | Add capture() and fork() methods |
| `lib/runtime/fork.ts` | **New** — executeFork runtime |
| `lib/runtime/interrupts.ts` | Update concurrent interrupt handling |
| `lib/runtime/index.ts` | Export fork runtime |
| `lib/backends/typescriptBuilder.ts` | processForkExpression |
| `lib/backends/agencyGenerator.ts` | Format fork/race expressions |
| `lib/ir/tsIR.ts` | IR node for fork if needed |
| `lib/ir/prettyPrint.ts` | Print fork IR |
| `lib/ir/audit.ts` | Audit logging for fork/race |
| `tests/typescriptGenerator/fork-*.agency` | **New** — fixtures |
| `tests/agency/fork/` | **New** — e2e tests |
| `tests/agency-js/fork/` | **New** — serialization tests |
