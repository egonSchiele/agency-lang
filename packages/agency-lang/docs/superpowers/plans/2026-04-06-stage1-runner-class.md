# Stage 1: Runner Class

## Goal

Replace the scattered if-statement step guards in generated code with a centralized Runner class. This is a pure refactor — no new language features, no behavior changes. All existing tests must continue to pass.

## Background

Currently, each step in generated TypeScript code is wrapped in an if-statement:

```typescript
if (__step <= 0) {
  __stack.locals.x = 5;
  __stack.step++;
}
if (__step <= 1) {
  __stack.locals.y = await runPrompt(__ctx, ...);
  __stack.step++;
}
```

The step counter, stored in `State.step`, controls which steps to skip on resume. The debugger inserts `debugStep()` calls before each step. Substeps (inside handle blocks, threads, if/else, loops) use `__substep_N` variables in locals. There are 6 distinct IR node types that generate step-related code, plus the debug step integration.

This stage replaces all of this with a Runner class that encapsulates the skip/execute/advance logic, with specialized methods for each block type.

## Design

### Core: Recursive runners with explicit step IDs

The builder assigns explicit step IDs and passes them to both the IR nodes (for source maps) and the generated code (for the Runner). Each `step()` call passes a **sub-runner** to the callback for nested steps:

```typescript
const runner = new Runner(__ctx, __stack);

await runner.step(0, async (runner) => {
  // runner here is a sub-runner, counter at __substep_0
  __stack.locals.x = 5;
});

await runner.step(1, async (runner) => {
  // sub-runner, counter at __substep_1
  // nesting: sub-sub-runner at __substep_1_0
  await runner.step(0, async (runner) => {
    __stack.locals.y = 10;
  });
});
```

The counter key derives from nesting:
- Top-level runner: `frame.step`
- First nesting: `frame.locals.__substep_N`
- Second nesting: `frame.locals.__substep_N_M`
- And so on

This matches the existing variable naming convention exactly, preserving backwards compatibility with serialized state.

### Halt propagation (no exceptions)

When an interrupt, debug pause, or rejection occurs, the code calls `runner.halt(result)`. The halt flag propagates up through the runner hierarchy automatically. All subsequent step calls become no-ops.

```typescript
await runner.step(async (runner) => {
  const result = await interruptWithHandlers(data, __ctx);
  if (!isApproved(result)) {
    runner.halt(result);  // halt this sub-runner
    return;
  }
});
// ^^^ parent runner sees sub halted, halts itself

await runner.step(async (runner) => {
  // skipped — runner.halted is true
});

// One check at the end of the function
if (runner.halted) return { messages: __threads, data: runner.haltResult };
```

The debug/trace hook can also halt the runner. Same mechanism — no exceptions, no per-step return value checks.

### Specialized methods

Each block type gets its own method that encapsulates its lifecycle. All methods share the same auto-incrementing counter — calling `step()`, then `ifElse()`, then `thread()` uses counter values 0, 1, 2.

## Deliverables

### 1. Runner class (`lib/runtime/runner.ts`)

```typescript
export class Runner {
  halted: boolean = false;
  haltResult: any = null;

  private ctx: RuntimeContext<any>;
  private frame: State;
  private counterKey: string | null;  // null = frame.step, string = frame.locals[key]
  private nextId: number = 0;         // auto-increment counter for step IDs

  constructor(ctx: RuntimeContext<any>, frame: State, counterKey: string | null = null) {
    this.ctx = ctx;
    this.frame = frame;
    this.counterKey = counterKey;
    // Initialize nextId from the stored counter so auto-numbering stays in sync on resume
    this.nextId = this.getCounter();
  }

  // ── Counter management ──

  private getCounter(): number {
    if (this.counterKey === null) return this.frame.step;
    return this.frame.locals[this.counterKey] ?? 0;
  }

  private setCounter(val: number): void {
    if (this.counterKey === null) this.frame.step = val;
    else this.frame.locals[this.counterKey] = val;
  }

  private takeId(): number {
    return this.nextId++;
  }

  private createSubRunner(parentStepId: number): Runner {
    const subKey = this.counterKey === null
      ? `__substep_${parentStepId}`
      : `${this.counterKey}_${parentStepId}`;
    return new Runner(this.ctx, this.frame, subKey);
  }

  // ── Halt ──

  halt(result: any): void {
    this.halted = true;
    this.haltResult = result;
  }

  private propagateHalt(sub: Runner): boolean {
    if (sub.halted) {
      this.halt(sub.haltResult);
      return true;
    }
    return false;
  }

  // ── Core step method ──

  async step(callback: (runner: Runner) => Promise<void>): Promise<void> {
    const id = this.takeId();
    if (this.halted) return;
    if (this.getCounter() > id) return;

    // Debug/trace hook (can halt)
    if (this.ctx.debugger || this.ctx.traceWriter) {
      const dbg = await this.debugHook(id);
      if (dbg) { this.halt(dbg); return; }
    }

    const sub = this.createSubRunner(id);
    await callback(sub);

    if (this.propagateHalt(sub)) return;
    this.setCounter(id + 1);
  }

  // ── Specialized: thread ──

  async thread(
    method: "create" | "createSubthread",
    callback: (runner: Runner) => Promise<void>,
  ): Promise<void> {
    const id = this.takeId();
    if (this.halted) return;
    if (this.getCounter() > id) return;

    // Setup: create thread + pushActive
    const tid = this.ctx.threads[method]();
    this.ctx.threads.pushActive(tid);

    const sub = this.createSubRunner(id);
    try {
      await callback(sub);
    } finally {
      // Cleanup: always pop, even on halt
      this.ctx.threads.popActive();
    }

    if (this.propagateHalt(sub)) return;
    this.setCounter(id + 1);
  }

  // ── Specialized: handle ──

  async handle(
    handlerFn: HandlerFn,
    callback: (runner: Runner) => Promise<void>,
  ): Promise<void> {
    const id = this.takeId();
    if (this.halted) return;
    if (this.getCounter() > id) return;

    this.ctx.pushHandler(handlerFn);
    const sub = this.createSubRunner(id);
    try {
      await callback(sub);
    } finally {
      this.ctx.popHandler();
    }

    if (this.propagateHalt(sub)) return;
    this.setCounter(id + 1);
  }

  // ── Specialized: ifElse ──

  async ifElse(
    branches: { condition: () => boolean; body: (runner: Runner) => Promise<void> }[],
    elseBranch?: (runner: Runner) => Promise<void>,
  ): Promise<void> {
    const id = this.takeId();
    if (this.halted) return;
    if (this.getCounter() > id) return;

    // Derive condbranch key from counter key
    const condKey = this.counterKey === null
      ? `__condbranch_${id}`
      : `${this.counterKey.replace('__substep', '__condbranch')}_${id}`;

    // Evaluate condition only once (not on resume)
    if (this.frame.locals[condKey] === undefined) {
      let branchIndex = -1;
      for (let i = 0; i < branches.length; i++) {
        if (branches[i].condition()) { branchIndex = i; break; }
      }
      this.frame.locals[condKey] = branchIndex;
    }

    const branchIndex = this.frame.locals[condKey];
    const sub = this.createSubRunner(id);

    if (branchIndex >= 0 && branchIndex < branches.length) {
      await branches[branchIndex].body(sub);
    } else if (elseBranch) {
      await elseBranch(sub);
    }

    if (this.propagateHalt(sub)) return;
    this.setCounter(id + 1);
  }

  // ── Specialized: loop (for) ──

  async loop(
    items: any[],
    callback: (item: any, index: number, runner: Runner) => Promise<void>,
  ): Promise<void> {
    const id = this.takeId();
    if (this.halted) return;
    if (this.getCounter() > id) return;

    const iterKey = this.counterKey === null
      ? `__iteration_${id}`
      : `${this.counterKey.replace('__substep', '__iteration')}_${id}`;

    this.frame.locals[iterKey] = this.frame.locals[iterKey] ?? 0;

    for (let i = 0; i < items.length; i++) {
      if (this.halted) return;

      // Skip to resume iteration
      if (i < this.frame.locals[iterKey]) continue;

      const sub = this.createSubRunner(id);
      await callback(items[i], i, sub);

      if (this.propagateHalt(sub)) return;

      // Reset substep tracking for next iteration
      const subKey = this.counterKey === null
        ? `__substep_${id}`
        : `${this.counterKey}_${id}`;
      this.frame.clearLocalsWithPrefix(subKey);
      this.frame.locals[iterKey] = i + 1;
    }

    this.setCounter(id + 1);
  }

  // ── Specialized: whileLoop ──

  async whileLoop(
    condition: () => boolean,
    callback: (runner: Runner) => Promise<void>,
  ): Promise<void> {
    const id = this.takeId();
    if (this.halted) return;
    if (this.getCounter() > id) return;

    const iterKey = this.counterKey === null
      ? `__iteration_${id}`
      : `${this.counterKey.replace('__substep', '__iteration')}_${id}`;

    this.frame.locals[iterKey] = this.frame.locals[iterKey] ?? 0;
    let currentIter = 0;

    while (condition()) {
      if (this.halted) return;

      if (currentIter < this.frame.locals[iterKey]) {
        currentIter++;
        continue;
      }

      const sub = this.createSubRunner(id);
      await callback(sub);

      if (this.propagateHalt(sub)) return;

      const subKey = this.counterKey === null
        ? `__substep_${id}`
        : `${this.counterKey}_${id}`;
      this.frame.clearLocalsWithPrefix(subKey);
      this.frame.locals[iterKey] = currentIter + 1;
      currentIter++;
    }

    this.setCounter(id + 1);
  }

  // ── Specialized: branchStep (async calls) ──

  async branchStep(
    branchKey: string,
    callback: (runner: Runner) => Promise<void>,
  ): Promise<void> {
    const id = this.takeId();
    if (this.halted) return;

    // Enter if: counter hasn't passed this OR branch data exists (resuming async)
    const hasExistingBranch = this.frame.branches?.[branchKey];
    if (this.getCounter() > id && !hasExistingBranch) return;

    const sub = this.createSubRunner(id);
    await callback(sub);

    if (this.propagateHalt(sub)) return;
    this.setCounter(id + 1);
  }

  // ── Debug/trace hook ──

  private async debugHook(id: number): Promise<any> {
    // Build stepPath from counter key + id
    const stepPath = this.counterKey === null
      ? `${id}`
      : `${this.counterKey.replace('__substep_', '')}.${id}`;

    return await debugStep(this.ctx, /* state */, {
      moduleId: this.ctx.currentModuleId,
      scopeName: this.ctx.currentScopeName,
      stepPath,
      label: null,
      nodeContext: true,
      isUserAdded: false,
    });
  }
}
```

### 2. Update the TypeScript IR (`lib/ir/tsIR.ts`)

The current 6 step-related IR node types (`TsStepBlock`, `TsIfSteps`, `TsThreadSteps`, `TsHandleSteps`, `TsWhileSteps`, `TsForSteps`) are replaced with a single, simpler set of IR nodes that map directly to Runner method calls. The new IR doesn't need to track step indices, substep paths, condbranch variable names, or iteration variables — the Runner handles all of that.

New IR node types:

```typescript
// Basic step: runner.step(async (runner) => { body })
interface TsRunnerStep {
  kind: "runnerStep";
  body: TsNode[];
}

// Thread: runner.thread(method, async (runner) => { body })
interface TsRunnerThread {
  kind: "runnerThread";
  method: "create" | "createSubthread";
  body: TsNode[];
}

// Handle: runner.handle(handlerFn, async (runner) => { body })
interface TsRunnerHandle {
  kind: "runnerHandle";
  handler: TsNode;       // handler function expression
  body: TsNode[];
}

// IfElse: runner.ifElse([branches], elseBranch?)
interface TsRunnerIfElse {
  kind: "runnerIfElse";
  branches: { condition: TsNode; body: TsNode[] }[];
  elseBranch?: TsNode[];
}

// Loop: runner.loop(items, async (item, index, runner) => { body })
interface TsRunnerLoop {
  kind: "runnerLoop";
  items: TsNode;          // the array expression
  itemVar: string;         // loop variable name
  indexVar?: string;        // optional index variable name
  body: TsNode[];
}

// WhileLoop: runner.whileLoop(() => condition, async (runner) => { body })
interface TsRunnerWhileLoop {
  kind: "runnerWhileLoop";
  condition: TsNode;
  body: TsNode[];
}

// BranchStep: runner.branchStep(branchKey, async (runner) => { body })
interface TsRunnerBranchStep {
  kind: "runnerBranchStep";
  branchKey: string;
  body: TsNode[];
}
```

These are much simpler than the current IR nodes because the Runner handles all the bookkeeping internally. No `subStepPath`, no `stepIndex`, no tracking variable names.

The old IR node types should be removed once the migration is complete. They should not coexist — having two code paths would be confusing and error-prone.

### 3. Update the builder (`lib/backends/typescriptBuilder.ts`)

The builder's methods generate the new IR nodes instead of the old ones.

| Current method | Current IR | New IR |
|---|---|---|
| `processBodyAsParts()` | `TsStepBlock` | `TsRunnerStep` |
| `processIfElseWithSteps()` | `TsIfSteps` | `TsRunnerIfElse` |
| `processForLoopWithSteps()` | `TsForSteps` | `TsRunnerLoop` |
| `processWhileLoopWithSteps()` | `TsWhileSteps` | `TsRunnerWhileLoop` |
| `processMessageThread()` | `TsThreadSteps` | `TsRunnerThread` |
| `processHandleBlockWithSteps()` | `TsHandleSteps` | `TsRunnerHandle` |
| `forkBranchSetup()` | `TsStepBlock` with `branchKey` | `TsRunnerBranchStep` |

The builder no longer needs to:
- Track `subStepPath` or pass it through processing methods
- Calculate step indices
- Generate `__substep_N`, `__condbranch_N`, or `__iteration_N` variable names
- Insert `debuggerStatement` nodes before steps (debugStep is in the Runner now)

**`insertDebugSteps()`** — this method can be removed entirely. The Runner handles debug/trace hooks internally.

**`processBodyAsParts()`** — still groups statements into parts (some statements don't trigger new steps). Each part becomes a `TsRunnerStep` containing the grouped statements.

### 4. Update prettyPrint (`lib/ir/prettyPrint.ts`)

The pretty printer generates Runner method calls from the new IR nodes.

**TsRunnerStep:**
```typescript
await runner.step(async (runner) => {
  {body}
});
```

**TsRunnerThread:**
```typescript
await runner.thread("{method}", async (runner) => {
  {body}
});
```

**TsRunnerHandle:**
```typescript
await runner.handle({handler}, async (runner) => {
  {body}
});
```

**TsRunnerIfElse:**
```typescript
await runner.ifElse([
  {
    condition: () => {condition1},
    body: async (runner) => {
      {body1}
    },
  },
  {
    condition: () => {condition2},
    body: async (runner) => {
      {body2}
    },
  },
], async (runner) => {
  {elseBody}
});
```

**TsRunnerLoop:**
```typescript
await runner.loop({items}, async ({itemVar}, {indexVar}, runner) => {
  {body}
});
```

**TsRunnerWhileLoop:**
```typescript
await runner.whileLoop(() => {condition}, async (runner) => {
  {body}
});
```

**TsRunnerBranchStep:**
```typescript
await runner.branchStep("{branchKey}", async (runner) => {
  {body}
});
```

### 5. Update templates (`lib/templates/backends/`)

Many Mustache templates become unnecessary because the logic moves into the Runner:

| Template | Status |
|---|---|
| `debugger.mustache` | **Remove** — debugStep absorbed into Runner |
| `handleSteps.mustache` | **Remove** — replaced by `runner.handle()` |
| `threadSteps.mustache` | **Remove** — replaced by `runner.thread()` |
| `whileSteps.mustache` | **Remove** — replaced by `runner.whileLoop()` |
| `forSteps.mustache` | **Remove** — replaced by `runner.loop()` |
| `ifStepsCondbranch.mustache` | **Remove** — replaced by `runner.ifElse()` |
| `ifStepsBranchDispatch.mustache` | **Remove** — replaced by `runner.ifElse()` |
| `substepBlock.mustache` | **Remove** — replaced by nested `runner.step()` |
| `interruptReturn.ts` | **Update** — interrupt now calls `runner.halt()` instead of returning |
| `interruptAssignment.ts` | **Update** — same |

### 6. Update runtime entry points

The `setupNode()` and `setupFunction()` functions in `lib/runtime/node.ts` need to create a Runner instance. The Runner should be available to generated code as `runner` (the top-level runner variable).

```typescript
// In setupNode or setupFunction:
const runner = new Runner(ctx, ctx.stateStack.lastFrame());
```

The generated code receives `runner` and uses it directly. Sub-runners are created automatically by the Runner's methods and passed to callbacks.

### 7. Interrupt code generation

Currently, interrupts generate code that checks the result and returns from the function:

```typescript
const __handlerResult = await interruptWithHandlers(data, __ctx);
if (isRejected(__handlerResult)) {
  return { messages: __threads, data: __handlerResult.value };
}
if (!isApproved(__handlerResult)) {
  return { messages: __threads, data: __handlerResult };
}
```

With the Runner, this becomes:

```typescript
const __handlerResult = await interruptWithHandlers(data, __ctx);
if (isRejected(__handlerResult)) {
  runner.halt({ messages: __threads, data: __handlerResult.value });
  return;
}
if (!isApproved(__handlerResult)) {
  runner.halt({ messages: __threads, data: __handlerResult });
  return;
}
```

The `runner.halt()` sets the flag, `return` exits the callback, and the parent Runner propagates the halt. No direct `return` from the outer function needed — halt propagation handles it.

### 8. Node/function wrapper

Each node and function ends with a halt check:

```typescript
// End of generated node/function
if (runner.halted) return runner.haltResult;
return { messages: __threads, data: __stack.locals.result };
```

This is the only place in generated code that checks `runner.halted` — everything else is automatic.

## Example: What generated code looks like

### Agency source:

```
node main(doc: string) {
  let cleaned: string = llm("Clean: ${doc}")

  if len(cleaned) > 100 {
    thread {
      let summary: string = llm("Summarize: ${cleaned}")
      let keywords: string[] = llm("Extract keywords: ${cleaned}")
    }
    print(summary, keywords)
  } else {
    print(cleaned)
  }

  for item in items {
    handle {
      return interrupt("Approve: ${item}")
      process(item)
    } with (data) {
      return approve()
    }
  }
}
```

### Generated TypeScript (simplified):

```typescript
const runner = new Runner(__ctx, __stack);

await runner.step(async (runner) => {
  __stack.locals.cleaned = await runPrompt(__ctx, ...);
});

await runner.ifElse([
  {
    condition: () => __stack.locals.cleaned.length > 100,
    body: async (runner) => {
      await runner.thread("create", async (runner) => {
        await runner.step(async (runner) => {
          __stack.locals.summary = await runPrompt(__ctx, ...);
        });
        await runner.step(async (runner) => {
          __stack.locals.keywords = await runPrompt(__ctx, ...);
        });
      });
      await runner.step(async (runner) => {
        print(__stack.locals.summary, __stack.locals.keywords);
      });
    },
  },
], async (runner) => {
  await runner.step(async (runner) => {
    print(__stack.locals.cleaned);
  });
});

await runner.loop(__stack.locals.items, async (item, i, runner) => {
  await runner.handle(autoApproveHandler, async (runner) => {
    await runner.step(async (runner) => {
      const result = await interruptWithHandlers(item, __ctx);
      if (!isApproved(result)) { runner.halt(result); return; }
    });
    await runner.step(async (runner) => {
      await process(item);
    });
  });
});

if (runner.halted) return runner.haltResult;
return { messages: __threads, data: null };
```

## Edge Cases

### Auto-numbering and resume correctness

The Runner initializes `nextId` from the stored counter on construction. This means on resume, if the counter is at 3 (we've completed steps 0, 1, 2), the Runner's `takeId()` starts at 3 and will correctly skip the first three `step()` calls.

**Critically**, every call to a Runner method (`step`, `ifElse`, `thread`, etc.) must call `takeId()` even if the runner is halted or the step is skipped. This ensures the auto-numbering stays in sync. The current implementation does this — `takeId()` is called at the top of every method, before any early returns except the halt check.

Wait — the halt check returns before `takeId()`. This is fine because once halted, no more steps execute and the counter doesn't matter. But on a fresh run (not halted), every method call takes an ID in sequence, matching the serialized counter exactly.

### Nesting across function boundaries

When a node calls a function, the function gets its own StateStack frame (pushed by `setupFunction`). The function creates its own top-level Runner with `counterKey = null` (using `frame.step`). This is a fresh Runner, independent of the caller's. The nesting within the function is self-contained.

### Thread cleanup on halt

If an interrupt occurs inside a `thread()` block, the thread's `popActive()` must still run. The try/finally in `runner.thread()` handles this — `popActive()` runs regardless of halt state.

Similarly, `runner.handle()` pops the handler in finally, ensuring handlers are never left dangling.

### Loop iteration reset on halt

If an interrupt occurs mid-loop-iteration, the loop halts. The iteration counter and substep state are preserved in locals. On resume, the loop picks up at the right iteration and substep.

The `clearLocalsWithPrefix` call only happens after a successful iteration. If the iteration halts, the substep state is preserved for resume.

### While loop condition re-evaluation

On resume, the while loop condition is re-evaluated. The iteration skip logic (comparing `currentIter` to the saved iteration counter) fast-forwards to the right iteration. The condition must be deterministic given the state — this is already an assumption in the current implementation.

### Match blocks

Match blocks (`match x { case ... }`) are currently converted to if/else by `processMatchBlockWithSteps()`. With the Runner, they become `runner.ifElse()` calls where each case is a branch. No special handling needed.

### Impure call detection

Currently, impure calls set `__retryable = false`. This is separate from step tracking and can stay in generated code as-is. The Runner doesn't need to know about retryability.

### debugStep source location info

The `debugStep()` function needs `moduleId`, `scopeName`, `stepPath`, `label`, `nodeContext`, and `isUserAdded`. The Runner can derive `stepPath` from its counter key + current ID. The other fields need to be provided to the Runner at construction time or via the context.

**`stepPath`**: Derived from the runner hierarchy. Top-level step 3 → `"3"`. Substep 1 inside step 3 → `"3.1"`. The Runner builds this from `counterKey` + `id`.

**`label`**: Currently set by `debugger("label")` statements. These are user-added debug steps. With the Runner, a `debugger("label")` statement in Agency code still compiles to a step. The label needs to be passed to the Runner's debug hook. One approach: the step callback can set `runner.label = "myLabel"` before the debug hook fires. Or: the builder generates `runner.debugger("label")` calls as a separate method.

**`isUserAdded`**: True for `debugger` keyword statements, false for auto-inserted debug steps. With the Runner, all steps go through the same `debugHook`. The Runner defaults to `isUserAdded: false`. For user-added debugger statements, a separate `runner.debugger(label)` method sets `isUserAdded: true`.

### advanceDebugStep compatibility

Currently, `StateStack.advanceDebugStep(stepPath)` is called by `debugStep()` to advance the counter when the debugger pauses. With the Runner, this function may still be needed for the debugger to advance past the current step on resume. The Runner's `setCounter()` does the same thing, but `advanceDebugStep` works from a `stepPath` string. This function should be kept for debugger compatibility but may be called differently.

## Testing Strategy

This is a refactor. **Every existing test must pass without modification** (except fixture regeneration).

1. **Unit tests for Runner class** — new tests in `lib/runtime/runner.test.ts`:
   - `step()` executes callback, advances counter
   - `step()` skips when counter is past
   - Halt propagation: child halts → parent halts → subsequent steps skip
   - `ifElse()` evaluates conditions once, dispatches correctly, resumes to correct branch
   - `loop()` iterates, skips to resume iteration, resets substep state per iteration
   - `whileLoop()` same as loop but with condition re-evaluation
   - `thread()` calls setup/cleanup, cleanup runs on halt
   - `handle()` pushes/pops handler, pop runs on halt
   - `branchStep()` enters when branch data exists
   - Nested runners: step within ifElse within loop within handle
   - Auto-numbering: verify IDs match expected sequence

2. **Regenerate fixtures** — `make fixtures` to regenerate all `.mts` files in:
   - `tests/typescriptGenerator/` — generated code changes
   - `tests/typescriptBuilder/` — IR changes
   - `tests/typescriptPreprocessor/` — may be unaffected

3. **Verify fixture diffs** — manually check a few regenerated fixtures to confirm:
   - If-statement guards replaced with `runner.step()` calls
   - Substep patterns replaced with nested `runner.step()` calls
   - Loop patterns replaced with `runner.loop()` / `runner.whileLoop()`
   - Thread/handle patterns replaced with `runner.thread()` / `runner.handle()`
   - Debug step calls removed from generated code
   - No behavioral changes

4. **Full test suite** — `pnpm test:run` — all tests must pass

5. **End-to-end tests** — `tests/agency/` and `tests/agency-js/` — must pass unchanged

6. **Manual testing**:
   - Debugger: `agency debug examples/simple.agency` — stepping, breakpoints, rewind
   - Traces: `agency run --trace examples/simple.agency` — trace captures correctly
   - Interrupts: run an example with interrupts, verify serialize/deserialize/resume

## Key Risks

- **Auto-numbering drift**: If a Runner method is called conditionally (not always called on every execution), the auto-numbering could drift between runs. This shouldn't happen because the generated code always calls the same methods in the same order. But verify this assumption holds for all edge cases (e.g., early returns, error paths).
- **Performance**: Callback + closure overhead per step. Should be negligible for AI agent workloads where the bottleneck is LLM calls. Verify with benchmarks if concerned.
- **debugStep integration**: The Runner's `debugHook` needs to provide all the metadata that `debugStep()` currently receives. Make sure nothing is lost (especially source location info for the debugger UI).
- **Serialized state compatibility**: The Runner must produce the same variable names (`__substep_N`, `__condbranch_N`, `__iteration_N`) as the current system. Existing serialized interrupt states must deserialize correctly. Write a specific test for this.

## Files to Modify

| File | Change |
|------|--------|
| `lib/runtime/runner.ts` | **New file** — Runner class with all specialized methods |
| `lib/runtime/runner.test.ts` | **New file** — unit tests for Runner |
| `lib/runtime/index.ts` | Export Runner |
| `lib/runtime/state/context.ts` | May need minor updates for Runner integration |
| `lib/runtime/node.ts` | Create Runner in setupNode/setupFunction |
| `lib/runtime/debugger.ts` | Update debugStep to work with Runner's debugHook |
| `lib/ir/tsIR.ts` | Replace 6 step IR types with new Runner IR types |
| `lib/ir/prettyPrint.ts` | Generate Runner method calls from new IR types |
| `lib/ir/audit.ts` | Update audit for new IR node kinds |
| `lib/backends/typescriptBuilder.ts` | Generate new IR types, remove substep path tracking |
| `lib/templates/backends/typescriptGenerator/` | Remove most step templates, update interrupt templates |
| `tests/typescriptGenerator/*.mts` | Regenerate fixtures |
| `tests/typescriptBuilder/*.mts` | Regenerate fixtures |
