# Stage 1: Runner Class — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace if-statement step guards in generated code with a centralized Runner class that handles step counting, halt propagation, and debug/trace hooks.

**Architecture:** The Runner class sits in `lib/runtime/runner.ts` and encapsulates all step execution logic (skip/execute/advance, halt propagation, debug hooks). New IR types in `lib/ir/tsIR.ts` map 1:1 to Runner method calls. The builder emits the new IR types, and prettyPrint generates `runner.step()`, `runner.ifElse()`, etc. Old step-related IR types, templates, and builder logic are removed.

**Tech Stack:** TypeScript, Vitest, Mustache templates (typestache)

**Spec:** `docs/superpowers/plans/2026-04-06-stage1-runner-class.md`

---

## File Structure

### New files
| File | Responsibility |
|------|---------------|
| `lib/runtime/runner.ts` | Runner class with `step()`, `ifElse()`, `loop()`, `whileLoop()`, `thread()`, `handle()`, `branchStep()`, `halt()`, `debugHook()` |
| `lib/runtime/runner.test.ts` | Unit tests for Runner class |

### Modified files
| File | What changes |
|------|-------------|
| `lib/ir/tsIR.ts` | Add 7 new IR types (`TsRunnerStep`, `TsRunnerIfElse`, `TsRunnerLoop`, `TsRunnerWhileLoop`, `TsRunnerThread`, `TsRunnerHandle`, `TsRunnerBranchStep`); remove 6 old types (`TsStepBlock`, `TsIfSteps`, `TsForSteps`, `TsWhileSteps`, `TsThreadSteps`, `TsHandleSteps`) |
| `lib/ir/prettyPrint.ts` | Add print cases for 7 new IR types; remove cases for 6 old types |
| `lib/ir/builders.ts` | Add builder functions for new IR types; remove old ones |
| `lib/backends/typescriptBuilder.ts` | Update `processBodyAsParts()`, `processIfElseWithSteps()`, `processMatchBlockWithSteps()`, `processForLoopWithSteps()`, `processWhileLoopWithSteps()`, `processMessageThread()`, `processHandleBlockWithSteps()`, `forkBranchSetup()` to emit new IR types; remove `insertDebugSteps()`; add Runner import and constructor to generated boilerplate; add halt check to end of generated node/function bodies |
| `lib/runtime/index.ts` | Export Runner |
| `lib/runtime/debugger.ts` | Minor: Runner calls `debugStep()`, may need signature adjustments |
| `lib/templates/backends/typescriptGenerator/interruptReturn.ts` | Change `return { messages, data }` to `runner.halt(...)` + `return` |
| `lib/templates/backends/typescriptGenerator/interruptAssignment.ts` | Same pattern |

### Removed files
| File | Why |
|------|-----|
| `lib/templates/backends/typescriptGenerator/debugger.mustache` + `.ts` | Debug step logic absorbed into Runner |
| `lib/templates/backends/typescriptGenerator/handleSteps.mustache` + `.ts` | Replaced by `runner.handle()` |
| `lib/templates/backends/typescriptGenerator/threadSteps.mustache` + `.ts` | Replaced by `runner.thread()` |
| `lib/templates/backends/typescriptGenerator/whileSteps.mustache` + `.ts` | Replaced by `runner.whileLoop()` |
| `lib/templates/backends/typescriptGenerator/forSteps.mustache` + `.ts` | Replaced by `runner.loop()` |
| `lib/templates/backends/typescriptGenerator/ifStepsCondbranch.mustache` + `.ts` | Replaced by `runner.ifElse()` |
| `lib/templates/backends/typescriptGenerator/ifStepsBranchDispatch.mustache` + `.ts` | Replaced by `runner.ifElse()` |
| `lib/templates/backends/typescriptGenerator/substepBlock.mustache` + `.ts` | Replaced by nested `runner.step()` |

---

## Important context for the implementer

### How the pipeline works
The full pipeline is: `parse → buildSymbolTable → collectProgramInfo → TypescriptPreprocessor → TypeScriptBuilder.build() → printTs()`. This plan modifies the last two stages (builder + printTs) and adds a runtime class.

### Variable naming
The old system wrote `__substep_N`, `__condbranch_N`, `__iteration_N` to `State.locals`. There is **no backward-compatibility requirement** — you can keep these names or change them if something else makes more sense. Existing serialized interrupt state does not need to be preserved.

### Fixture regeneration
After changing code generation, run `make fixtures` to regenerate all `.mjs` files in `tests/typescriptGenerator/` and `tests/typescriptBuilder/`. The generated code will look different (runner calls instead of if-statements) but behavior must be identical.

### What NOT to change
- Parsers — no changes
- Type checker — no changes
- Preprocessor — no changes
- Symbol table / program info — no changes
- Runtime state serialization format (`StateStack`, `GlobalStore`, `State`) — no changes
- Agency code formatter (`agencyGenerator.ts`) — no changes
- Audit logging (`lib/ir/audit.ts`) — no changes needed; `auditNode()` operates on inner statement nodes (`assign`, `varDecl`, `return`, etc.), not step wrappers. Step-related IR nodes are transparent to auditing.

### Step numbering: builder assigns IDs, not the Runner

The builder assigns explicit step IDs and passes them to both the IR nodes (for source map recording) and the generated code (for the Runner). The Runner does **not** auto-number — it receives the ID as a parameter to `step()`, `ifElse()`, etc.

This is simpler than auto-numbering because:
- The builder already tracks step paths for source maps (`_subStepPath`). Keeping explicit IDs means the builder's step path and the Runner's step ID are guaranteed identical — no sync issue.
- The generated code is easier to read and debug when step IDs are visible.
- No need for a `takeId()` auto-increment mechanism or tests to verify it matches.

The `_subStepPath` field stays in the builder (renamed to something clearer if desired) and serves two purposes: (1) providing step IDs to IR nodes, and (2) recording source maps.

### Source maps
The builder records source locations via `this._sourceMapBuilder.record([...this._subStepPath], stmt.loc)` in `SourceMapBuilder` (`lib/backends/sourceMap.ts`). The step path key is `subStepPath.join(".")`, e.g. `"1.0.2"`. This is the same format the debugger uses. Since the builder still tracks step IDs explicitly, source map recording continues to work unchanged.

### debugger keyword
Agency has a `debugger("label")` keyword that compiles to a debug step with `isUserAdded: true`. With the Runner, this should compile to a `runner.debugger(id, "label")` call — a new Runner method that creates a debug checkpoint with the user's label and `isUserAdded: true`. The regular auto-inserted debug hooks in `step()` use `isUserAdded: false`.

### Docs to read before starting
- `docs/superpowers/plans/2026-04-06-stage1-runner-class.md` — the full design spec with all edge cases
- `docs/stateStack.md` — how state stack serialization works
- `docs/TESTING.md` — how to write and run tests
- `docs/dev/interrupts.md` — how step counters and substeps work for interrupt resume

---

## Task 1: Write the Runner class

**Files:**
- Create: `lib/runtime/runner.ts`

This is the core of the whole refactor. The Runner manages step counting, halt propagation, and debug/trace hooks. All step execution logic that was previously in generated code (if-statements, substep tracking, iteration counting, condbranch evaluation) moves into this class.

- [ ] **Step 1: Create `lib/runtime/runner.ts` with imports and the Runner class**

Read these files first to understand the types:
- `lib/runtime/state/stateStack.ts` — the `State` class (lines 22-109), especially `step`, `locals`, `branches`, `clearLocalsWithPrefix()`, `resetLoopIteration()`
- `lib/runtime/state/context.ts` — `RuntimeContext`, especially `handlers`, `pushHandler`, `popHandler`, `debuggerState`, `traceWriter`
- `lib/runtime/debugger.ts` — `debugStep()` function signature and behavior
- `lib/runtime/types.ts` — `HandlerFn` type

Write the Runner class with:
- Constructor taking `ctx: RuntimeContext<any>`, `frame: State`, `counterKey: string | null = null`
- Private counter management: `getCounter()`, `setCounter()`, `createSubRunner(id)`
- Public halt: `halt()`, private `propagateHalt()`
- Core method: `step(id, callback)` — takes explicit step ID from the builder
- Specialized methods: `thread(id, ...)`, `handle(id, ...)`, `ifElse(id, ...)`, `loop(id, ...)`, `whileLoop(id, ...)`, `branchStep(id, ...)`
- Public `debugger(id, label)` method for user-added `debugger("label")` statements — calls `debugHook()` with `isUserAdded: true` and the label
- Private `debugHook(id)` that calls `debugStep()`

See the full class definition in `docs/superpowers/plans/2026-04-06-stage1-runner-class.md`, "Deliverables" section 1 for the overall structure. **Important change from that spec:** all methods take an explicit `id: number` parameter instead of auto-numbering. The builder assigns IDs.

Key implementation notes:
- Every method receives an explicit `id` from the generated code. The builder assigns these sequentially.
- `getCounter()` reads from `frame.step` when `counterKey` is null (top-level), or from `frame.locals[counterKey]` for substeps.
- `createSubRunner(id)` builds the substep key: if counterKey is null, `__substep_${id}`. If counterKey is `__substep_3`, then `__substep_3_${id}`.
- `debugHook(id)` builds `stepPath` from the counter key: null → `"${id}"`, `__substep_3` → `"3.${id}"`, `__substep_3_1` → `"3.1.${id}"`.

- [ ] **Step 2: Export Runner from `lib/runtime/index.ts`**

Add `export { Runner } from "./runner.js";` to `lib/runtime/index.ts`.

- [ ] **Step 3: Build and verify no compilation errors**

Run: `pnpm run build`
Expected: Clean build, no errors.

- [ ] **Step 4: Commit**

```
git add lib/runtime/runner.ts lib/runtime/index.ts
git commit -m "Add Runner class for centralized step execution"
```

---

## Task 2: Write Runner unit tests

**Files:**
- Create: `lib/runtime/runner.test.ts`

- [ ] **Step 1: Write test helpers**

Create a minimal mock of the dependencies the Runner needs:
- A mock `State` (from `lib/runtime/state/stateStack.ts`) with `step`, `locals`, `branches`, `clearLocalsWithPrefix()`
- A mock `RuntimeContext` with enough fields for the Runner (no `debuggerState`, no `traceWriter` — those paths tested separately)

```typescript
import { describe, it, expect } from "vitest";
import { Runner } from "./runner.js";
import { State } from "./state/stateStack.js";

function makeFrame(): State {
  return new State({ args: {}, locals: {}, step: 0 });
}

function makeMockCtx(frame: State): any {
  return {
    stateStack: { lastFrame: () => frame },
    debuggerState: null,
    traceWriter: null,
    handlers: [],
    pushHandler(fn: any) { this.handlers.push(fn); },
    popHandler() { this.handlers.pop(); },
    threads: {
      create: () => "tid-1",
      createSubthread: () => "tid-sub-1",
      pushActive: () => {},
      popActive: () => {},
    },
  };
}
```

- [ ] **Step 2: Write tests for basic step execution**

```typescript
describe("Runner", () => {
  describe("step()", () => {
    it("executes callback and advances counter", async () => {
      const frame = makeFrame();
      const ctx = makeMockCtx(frame);
      const runner = new Runner(ctx, frame);
      let executed = false;

      await runner.step(0, async () => { executed = true; });

      expect(executed).toBe(true);
      expect(frame.step).toBe(1);
    });

    it("skips when counter is past the step", async () => {
      const frame = makeFrame();
      frame.step = 5; // already past step 0
      const ctx = makeMockCtx(frame);
      const runner = new Runner(ctx, frame);
      let executed = false;

      await runner.step(0, async () => { executed = true; });

      expect(executed).toBe(false);
    });

    it("executes multiple steps in sequence", async () => {
      const frame = makeFrame();
      const ctx = makeMockCtx(frame);
      const runner = new Runner(ctx, frame);
      const order: number[] = [];

      await runner.step(0, async () => { order.push(0); });
      await runner.step(1, async () => { order.push(1); });
      await runner.step(2, async () => { order.push(2); });

      expect(order).toEqual([0, 1, 2]);
      expect(frame.step).toBe(3);
    });

    it("resumes from saved step counter", async () => {
      const frame = makeFrame();
      frame.step = 2; // resume from step 2
      const ctx = makeMockCtx(frame);
      const runner = new Runner(ctx, frame);
      const order: number[] = [];

      await runner.step(0, async () => { order.push(0); }); // skipped
      await runner.step(1, async () => { order.push(1); }); // skipped
      await runner.step(2, async () => { order.push(2); }); // executed

      expect(order).toEqual([2]);
      expect(frame.step).toBe(3);
    });
  });
});
```

- [ ] **Step 3: Write tests for halt propagation**

```typescript
describe("halt propagation", () => {
  it("halts runner and skips subsequent steps", async () => {
    const frame = makeFrame();
    const ctx = makeMockCtx(frame);
    const runner = new Runner(ctx, frame);
    const order: number[] = [];

    await runner.step(0, async (runner) => {
      order.push(0);
      runner.halt("interrupt-data");
    });
    await runner.step(1, async () => { order.push(1); }); // skipped

    expect(order).toEqual([0]);
    expect(runner.halted).toBe(true);
    expect(runner.haltResult).toBe("interrupt-data");
    expect(frame.step).toBe(0); // not advanced because step halted
  });

  it("propagates halt from nested step", async () => {
    const frame = makeFrame();
    const ctx = makeMockCtx(frame);
    const runner = new Runner(ctx, frame);

    await runner.step(0, async (sub) => {
      await sub.step(0, async (sub) => {
        sub.halt("deep-halt");
      });
      // This sub.step should be skipped
      await sub.step(1, async () => { throw new Error("should not run"); });
    });

    expect(runner.halted).toBe(true);
    expect(runner.haltResult).toBe("deep-halt");
  });
});
```

- [ ] **Step 4: Write tests for ifElse**

```typescript
describe("ifElse()", () => {
  it("executes matching branch", async () => {
    const frame = makeFrame();
    const ctx = makeMockCtx(frame);
    const runner = new Runner(ctx, frame);
    let result = "";

    await runner.ifElse(0, [
      { condition: () => false, body: async () => { result = "a"; } },
      { condition: () => true, body: async () => { result = "b"; } },
    ]);

    expect(result).toBe("b");
    expect(frame.step).toBe(1);
  });

  it("executes else branch when no conditions match", async () => {
    const frame = makeFrame();
    const ctx = makeMockCtx(frame);
    const runner = new Runner(ctx, frame);
    let result = "";

    await runner.ifElse(0,
      [{ condition: () => false, body: async () => { result = "if"; } }],
      async () => { result = "else"; },
    );

    expect(result).toBe("else");
  });

  it("does not re-evaluate conditions on resume", async () => {
    const frame = makeFrame();
    const ctx = makeMockCtx(frame);
    // Simulate resume: condbranch already set to branch 1
    frame.locals.__condbranch_0 = 1;
    frame.locals.__substep_0 = 0; // resume from start of branch body
    const runner = new Runner(ctx, frame);
    let evalCount = 0;
    let result = "";

    await runner.ifElse(0, [
      { condition: () => { evalCount++; return true; }, body: async () => { result = "a"; } },
      { condition: () => { evalCount++; return true; }, body: async () => { result = "b"; } },
    ]);

    expect(evalCount).toBe(0); // conditions NOT re-evaluated
    expect(result).toBe("b"); // branch 1 executed
  });
});
```

- [ ] **Step 5: Write tests for loop and whileLoop**

```typescript
describe("loop()", () => {
  it("iterates over items", async () => {
    const frame = makeFrame();
    const ctx = makeMockCtx(frame);
    const runner = new Runner(ctx, frame);
    const collected: string[] = [];

    await runner.loop(0, ["a", "b", "c"], async (item, i) => {
      collected.push(item);
    });

    expect(collected).toEqual(["a", "b", "c"]);
    expect(frame.step).toBe(1);
  });

  it("resumes at saved iteration", async () => {
    const frame = makeFrame();
    const ctx = makeMockCtx(frame);
    frame.locals.__iteration_0 = 2; // already completed iterations 0, 1
    const runner = new Runner(ctx, frame);
    const collected: string[] = [];

    await runner.loop(0, ["a", "b", "c"], async (item) => {
      collected.push(item);
    });

    expect(collected).toEqual(["c"]); // only iteration 2
  });

  it("halts mid-iteration and preserves state", async () => {
    const frame = makeFrame();
    const ctx = makeMockCtx(frame);
    const runner = new Runner(ctx, frame);

    await runner.loop(0, ["a", "b", "c"], async (item, i, sub) => {
      if (item === "b") { sub.halt("stopped"); return; }
    });

    expect(runner.halted).toBe(true);
    expect(frame.locals.__iteration_0).toBe(1); // completed iteration 0
  });
});

describe("whileLoop()", () => {
  it("loops while condition is true", async () => {
    const frame = makeFrame();
    const ctx = makeMockCtx(frame);
    const runner = new Runner(ctx, frame);
    let count = 0;

    await runner.whileLoop(0,
      () => count < 3,
      async () => { count++; },
    );

    expect(count).toBe(3);
  });
});
```

- [ ] **Step 6: Write tests for thread and handle**

```typescript
describe("thread()", () => {
  it("calls setup and cleanup", async () => {
    const frame = makeFrame();
    const ctx = makeMockCtx(frame);
    const runner = new Runner(ctx, frame);
    const calls: string[] = [];

    ctx.threads.create = () => { calls.push("create"); return "tid"; };
    ctx.threads.pushActive = () => { calls.push("push"); };
    ctx.threads.popActive = () => { calls.push("pop"); };

    await runner.thread(0, "create", async (runner) => {
      calls.push("body");
    });

    expect(calls).toEqual(["create", "push", "body", "pop"]);
  });

  it("pops thread even on halt", async () => {
    const frame = makeFrame();
    const ctx = makeMockCtx(frame);
    const runner = new Runner(ctx, frame);
    let popped = false;
    ctx.threads.popActive = () => { popped = true; };

    await runner.thread(0, "create", async (runner) => {
      runner.halt("interrupt");
    });

    expect(popped).toBe(true);
    expect(runner.halted).toBe(true);
  });
});

describe("handle()", () => {
  it("pushes and pops handler", async () => {
    const frame = makeFrame();
    const ctx = makeMockCtx(frame);
    const runner = new Runner(ctx, frame);
    const handler = async () => ({ type: "approved" as const });

    expect(ctx.handlers.length).toBe(0);
    await runner.handle(0, handler, async () => {
      expect(ctx.handlers.length).toBe(1);
    });
    expect(ctx.handlers.length).toBe(0);
  });

  it("pops handler even on halt", async () => {
    const frame = makeFrame();
    const ctx = makeMockCtx(frame);
    const runner = new Runner(ctx, frame);
    const handler = async () => ({ type: "approved" as const });

    await runner.handle(0, handler, async (runner) => {
      runner.halt("interrupt");
    });

    expect(ctx.handlers.length).toBe(0);
    expect(runner.halted).toBe(true);
  });
});
```

- [ ] **Step 7: Write tests for branchStep**

```typescript
describe("branchStep()", () => {
  it("executes when counter not past", async () => {
    const frame = makeFrame();
    const ctx = makeMockCtx(frame);
    const runner = new Runner(ctx, frame);
    let executed = false;

    await runner.branchStep(0, "0_1", async () => { executed = true; });

    expect(executed).toBe(true);
  });

  it("executes when counter past but branch data exists", async () => {
    const frame = makeFrame();
    frame.step = 5;
    frame.branches = { "0_1": { stack: {} as any } };
    const ctx = makeMockCtx(frame);
    const runner = new Runner(ctx, frame);
    let executed = false;

    await runner.branchStep(0, "0_1", async () => { executed = true; });

    expect(executed).toBe(true);
  });

  it("skips when counter past and no branch data", async () => {
    const frame = makeFrame();
    frame.step = 5;
    const ctx = makeMockCtx(frame);
    const runner = new Runner(ctx, frame);
    let executed = false;

    await runner.branchStep(0, "0_1", async () => { executed = true; });

    expect(executed).toBe(false);
  });
});
```

- [ ] **Step 8: Write test for serialized state backward compatibility**

This is critical — the Runner must produce the same variable names as the old system. Simulate a multi-step execution with the Runner, then verify the exact variable names in `frame.locals`:

```typescript
describe("serialized state compatibility", () => {
  it("produces same variable names as old step system", async () => {
    const frame = makeFrame();
    const ctx = makeMockCtx(frame);
    const runner = new Runner(ctx, frame);

    // Step 0: simple step
    await runner.step(0, async () => {});
    // Step 1: ifElse
    await runner.ifElse(1, [
      { condition: () => true, body: async (runner) => {
        await runner.step(0, async () => {});
        await runner.step(1, async () => {});
      }},
    ]);
    // Step 2: loop
    await runner.loop(2, ["a", "b"], async (item, i, runner) => {
      await runner.step(0, async () => {});
    });

    // Verify exact variable names match old system
    expect(frame.step).toBe(3); // 3 top-level steps
    expect(frame.locals.__condbranch_1).toBe(0); // ifElse at step 1, branch 0
    expect(frame.locals.__substep_1).toBe(2); // 2 substeps completed in ifElse
    expect(frame.locals.__iteration_2).toBe(2); // 2 loop iterations completed
  });
});
```

- [ ] **Step 9: Write test for nested composition**

```typescript
describe("nested composition", () => {
  it("step inside ifElse inside loop inside handle", async () => {
    const frame = makeFrame();
    const ctx = makeMockCtx(frame);
    const runner = new Runner(ctx, frame);
    const handler = async () => ({ type: "approved" as const });
    const trace: string[] = [];

    await runner.handle(0, handler, async (runner) => {
      await runner.loop(0, ["a", "b"], async (item, i, runner) => {
        await runner.ifElse(0, [
          {
            condition: () => item === "a",
            body: async (runner) => {
              await runner.step(0, async () => { trace.push(`${item}-if`); });
            },
          },
        ], async (runner) => {
          await runner.step(0, async () => { trace.push(`${item}-else`); });
        });
      });
    });

    expect(trace).toEqual(["a-if", "b-else"]);
    expect(ctx.handlers.length).toBe(0); // handler popped
  });
});
```

- [ ] **Step 10: Run tests**

Run: `pnpm test:run -- lib/runtime/runner.test.ts`
Expected: All tests pass.

- [ ] **Step 11: Commit**

```
git add lib/runtime/runner.test.ts
git commit -m "Add Runner unit tests"
```

---

## Task 3: Add new IR types and prettyPrint cases

**Files:**
- Modify: `lib/ir/tsIR.ts`
- Modify: `lib/ir/prettyPrint.ts`
- Modify: `lib/ir/builders.ts`

This task adds the new IR types alongside the old ones and adds prettyPrint cases. Nothing changes in the builder yet, so no generated code changes.

- [ ] **Step 1: Read the current IR types and builder functions**

Read:
- `lib/ir/tsIR.ts` — full TsNode union and all step-related types
- `lib/ir/builders.ts` — `ts.*` factory functions
- `lib/ir/prettyPrint.ts` — print cases for step-related types

- [ ] **Step 2: Add new IR types to `lib/ir/tsIR.ts`**

Add these 7 interfaces after the existing step types. Add them to the `TsNode` union type.

```typescript
export interface TsRunnerStep {
  kind: "runnerStep";
  id: number;           // step ID assigned by builder
  body: TsNode[];
}

export interface TsRunnerThread {
  kind: "runnerThread";
  id: number;
  method: "create" | "createSubthread";
  body: TsNode[];
}

export interface TsRunnerHandle {
  kind: "runnerHandle";
  id: number;
  handler: TsNode;
  body: TsNode[];
}

export interface TsRunnerIfElse {
  kind: "runnerIfElse";
  id: number;
  branches: { condition: TsNode; body: TsNode[] }[];
  elseBranch?: TsNode[];
}

export interface TsRunnerLoop {
  kind: "runnerLoop";
  id: number;
  items: TsNode;
  itemVar: string;
  indexVar?: string;  // optional; defaults to "_" in generated code
  body: TsNode[];
}

export interface TsRunnerWhileLoop {
  kind: "runnerWhileLoop";
  id: number;
  condition: TsNode;
  body: TsNode[];
}

export interface TsRunnerBranchStep {
  kind: "runnerBranchStep";
  id: number;
  branchKey: string;
  body: TsNode[];
}
```

- [ ] **Step 3: Add builder functions to `lib/ir/builders.ts`**

Add factory functions following the existing pattern in the file. For example:

Use named parameters (object argument) for all factory functions since they have enough parameters that positional args are hard to read:

```typescript
runnerStep: (opts: { id: number; body: TsNode[] }): TsRunnerStep =>
  ({ kind: "runnerStep", ...opts }),

runnerThread: (opts: { id: number; method: "create" | "createSubthread"; body: TsNode[] }): TsRunnerThread =>
  ({ kind: "runnerThread", ...opts }),

runnerHandle: (opts: { id: number; handler: TsNode; body: TsNode[] }): TsRunnerHandle =>
  ({ kind: "runnerHandle", ...opts }),

runnerIfElse: (opts: { id: number; branches: { condition: TsNode; body: TsNode[] }[]; elseBranch?: TsNode[] }): TsRunnerIfElse =>
  ({ kind: "runnerIfElse", ...opts }),

runnerLoop: (opts: { id: number; items: TsNode; itemVar: string; body: TsNode[]; indexVar?: string }): TsRunnerLoop =>
  ({ kind: "runnerLoop", ...opts }),

runnerWhileLoop: (opts: { id: number; condition: TsNode; body: TsNode[] }): TsRunnerWhileLoop =>
  ({ kind: "runnerWhileLoop", ...opts }),

runnerBranchStep: (opts: { id: number; branchKey: string; body: TsNode[] }): TsRunnerBranchStep =>
  ({ kind: "runnerBranchStep", ...opts }),
```

- [ ] **Step 4: Add prettyPrint cases to `lib/ir/prettyPrint.ts`**

Add cases in the `printTs` switch statement for each new IR type. These generate the Runner method calls.

**TsRunnerStep:**
```typescript
case "runnerStep": {
  const body = node.body.map(n => printTs(n, indent + 1)).join("\n");
  return `await runner.step(${node.id}, async (runner) => {\n${body}\n${ind(indent)}});`;
}
```

**TsRunnerThread:**
```typescript
case "runnerThread": {
  const body = node.body.map(n => printTs(n, indent + 1)).join("\n");
  return `await runner.thread(${node.id}, "${node.method}", async (runner) => {\n${body}\n${ind(indent)}});`;
}
```

**TsRunnerHandle:**
```typescript
case "runnerHandle": {
  const handler = printTs(node.handler, indent);
  const body = node.body.map(n => printTs(n, indent + 1)).join("\n");
  return `await runner.handle(${node.id}, ${handler}, async (runner) => {\n${body}\n${ind(indent)}});`;
}
```

**TsRunnerIfElse:**
```typescript
case "runnerIfElse": {
  const branches = node.branches.map(b => {
    const cond = printTs(b.condition, indent + 2);
    const body = b.body.map(n => printTs(n, indent + 3)).join("\n");
    return `{\n${ind(indent + 2)}condition: () => ${cond},\n${ind(indent + 2)}body: async (runner) => {\n${body}\n${ind(indent + 2)}},\n${ind(indent + 1)}}`;
  }).join(",\n" + ind(indent + 1));

  let result = `await runner.ifElse(${node.id}, [\n${ind(indent + 1)}${branches}\n${ind(indent)}]`;
  if (node.elseBranch) {
    const elsBody = node.elseBranch.map(n => printTs(n, indent + 2)).join("\n");
    result += `, async (runner) => {\n${elsBody}\n${ind(indent)}}`;
  }
  result += ");";
  return result;
}
```

**TsRunnerLoop:**
```typescript
case "runnerLoop": {
  const items = printTs(node.items, indent);
  const body = node.body.map(n => printTs(n, indent + 1)).join("\n");
  const idxVar = node.indexVar ?? "_";
  return `await runner.loop(${node.id}, ${items}, async (${node.itemVar}, ${idxVar}, runner) => {\n${body}\n${ind(indent)}});`;
}
```

**TsRunnerWhileLoop:**
```typescript
case "runnerWhileLoop": {
  const cond = printTs(node.condition, indent + 1);
  const body = node.body.map(n => printTs(n, indent + 1)).join("\n");
  return `await runner.whileLoop(${node.id}, () => ${cond}, async (runner) => {\n${body}\n${ind(indent)}});`;
}
```

**TsRunnerBranchStep:**
```typescript
case "runnerBranchStep": {
  const body = node.body.map(n => printTs(n, indent + 1)).join("\n");
  return `await runner.branchStep(${node.id}, "${node.branchKey}", async (runner) => {\n${body}\n${ind(indent)}});`;
}
```

Note: these printed formats will need to be refined during integration to match exact indentation expectations. The patterns above are starting points — verify against fixture diffs.

- [ ] **Step 5: Build and verify no errors**

Run: `pnpm run build`
Expected: Clean build. No tests break because nothing uses the new IR types yet.

- [ ] **Step 6: Run existing tests to confirm no regression**

Run: `pnpm test:run`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```
git add lib/ir/tsIR.ts lib/ir/builders.ts lib/ir/prettyPrint.ts
git commit -m "Add Runner IR types and prettyPrint cases"
```

---

## Task 4: Understand runtime entry points (reading task, preparation for Task 5)

**Files:**
- Read: `lib/runtime/node.ts`
- Read: `lib/templates/backends/` — node/function boilerplate templates

Each node and function needs its own Runner because each has its own step counter (its own `State` frame via `ctx.stateStack.getNewState()`). The Runner is created in **generated code** at the top of each node/function body — not in `setupNode()`/`setupFunction()`. The builder emits:

```typescript
const runner = new Runner(__ctx, __stack);
```

...right after the existing `const { __stack, __step, ... } = setupNode(...)` boilerplate. `setupNode()` and `setupFunction()` themselves do not change.

- [ ] **Step 1: Read `lib/runtime/node.ts`**

Read `setupNode()` (lines 12-41), `setupFunction()` (lines 43-73), and `runNode()` (lines 75-152). Understand what they return and how generated code uses the returned values (`__stack`, `__step`, `__ctx`, etc.). Confirm that each call creates a fresh `State` frame — this is what the Runner wraps.

- [ ] **Step 2: Read the node/function boilerplate templates**

Look at how the Mustache templates in `lib/templates/backends/` set up the boilerplate for generated node and function code. Understand where imports are added and where the setup code runs. Identify exactly where `const runner = new Runner(__ctx, __stack)` should be inserted — it goes right after the `setupNode()`/`setupFunction()` call that creates `__stack`.

Also note: `import { Runner } from "agency-lang/runtime"` needs to be added to the top of each generated file.

- [ ] **Step 3: Read interrupt templates**

Read `lib/templates/backends/typescriptGenerator/interruptReturn.ts` and `interruptAssignment.ts`. Understand all the early-return paths — every `return { messages, data }` in node context and every `return` in function context needs to change to `runner.halt(...); return;`. Enumerate all return sites so Task 5 Step 14 doesn't miss any.

---

## Task 5: Update the builder to emit new IR types

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts`

This is the largest task. Every method that produces step-related IR types must be updated to produce the new Runner-based types instead. This must be done atomically — all methods change together because the generated code must be internally consistent.

- [ ] **Step 1: Read and understand all builder methods that need to change**

Read these methods carefully in `lib/backends/typescriptBuilder.ts`:
- `processBodyAsParts()` (lines ~2341-2382)
- `processIfElseWithSteps()` (lines ~806-857)
- `processForLoopWithSteps()` (lines ~859-946)
- `processWhileLoopWithSteps()` (lines ~948-965)
- `processMessageThread()` (lines ~2106-2156)
- `processHandleBlockWithSteps()` (lines ~2246-2317)
- `forkBranchSetup()` (lines ~258-282)
- `insertDebugSteps()` (lines ~2322-2339)

Also read how `_subStepPath` is tracked (line ~149 and all push/pop sites).

- [ ] **Step 2: Update `processBodyAsParts()`**

This is the main method that wraps statements in step blocks. Currently returns `TsStepBlock[]`. Change it to return `TsRunnerStep[]` (or just `TsNode[]`).

Key changes:
- Remove the call to `insertDebugSteps()` — the Runner handles debug hooks internally
- Keep `_subStepPath` push/pop for source map recording (the builder still assigns step IDs explicitly). The step IDs assigned by the builder are the same ones passed to Runner methods in the generated code.
- Remove `branchKeys` tracking — async calls will use `TsRunnerBranchStep` instead
- Each "part" (group of statements) becomes a `ts.runnerStep(stmtNodes)`
- If a statement needs a branchKey (async call), wrap it in `ts.runnerBranchStep(key, stmtNodes)` instead of `ts.runnerStep()`

Note: the statement grouping logic (which statements trigger a new step) stays the same. Only the wrapping changes.

- [ ] **Step 3: Update `processIfElseWithSteps()` and `processMatchBlockWithSteps()`**

Change `processIfElseWithSteps()` to return `TsRunnerIfElse` instead of `TsIfSteps`.

Key changes:
- Remove `_subStepPath` tracking (replace with `_sourceMapPath`)
- Remove `insertDebugSteps()` calls on branch bodies
- Each branch body: process statements and wrap each in `ts.runnerStep()`
- Return `ts.runnerIfElse(branches, elseBranch)`

Also check `processMatchBlockWithSteps()` — match blocks are converted to if/else, so they should delegate to `processIfElseWithSteps()` and may need no changes. Verify this.

- [ ] **Step 4: Update `processForLoopWithSteps()`**

Change to return `TsRunnerLoop` instead of `TsForSteps`.

Key changes:
- Remove `_subStepPath` tracking and loop variable registration in `loopVars` (if possible; check if still needed)
- Remove `insertDebugSteps()` calls
- The `items` expression, `itemVar`, and `indexVar` are extracted from the for loop AST node
- Body statements are processed and wrapped in `ts.runnerStep()` each
- Return `ts.runnerLoop(items, itemVar, indexVar, bodyNodes)`
- Handle the three loop forms (range, indexed, basic) — the `items` node varies

- [ ] **Step 5: Update `processWhileLoopWithSteps()`**

Change to return `TsRunnerWhileLoop` instead of `TsWhileSteps`.

Key changes:
- Remove `_subStepPath` tracking
- Remove `insertDebugSteps()`
- Process condition and body
- Return `ts.runnerWhileLoop(condition, bodyNodes)`

- [ ] **Step 6: Update `processMessageThread()`**

Change to return `TsRunnerThread` instead of `TsThreadSteps`.

Key changes:
- Remove `_subStepPath` tracking
- Remove `insertDebugSteps()`
- Remove explicit setup/cleanup code — the Runner's `thread()` method handles setup and cleanup
- Body statements are processed and wrapped in `ts.runnerStep()` each
- Return `ts.runnerThread(method, bodyNodes)`

Note: the cleanup currently assigns cloned messages to a variable. This assignment code needs to be placed AFTER the `runner.thread()` call in the generated output, or the thread method needs to return the messages. Check how the assignment is used and decide the approach.

- [ ] **Step 7: Update `processHandleBlockWithSteps()`**

Change to return `TsRunnerHandle` instead of `TsHandleSteps`.

Key changes:
- Keep handler construction (inline, builtin, function ref) — the handler is still an arrow function
- Remove `_subStepPath` tracking
- Remove `insertDebugSteps()`
- Body statements processed and wrapped in `ts.runnerStep()` each
- Return `ts.runnerHandle(handler, bodyNodes)`

- [ ] **Step 8: Update async branch handling**

Where `forkBranchSetup()` is called and branchKey is used (in `processBodyAsParts`), change to emit `TsRunnerBranchStep` instead of `TsStepBlock` with branchKey.

- [ ] **Step 9: Remove `insertDebugSteps()` method**

This method is no longer needed. The Runner handles debug/trace hooks internally.

- [ ] **Step 10: Keep `_subStepPath` for source map recording**

Since the builder assigns explicit step IDs, `_subStepPath` continues to work for source map recording. The builder pushes/pops step indices as before, and the same indices are passed to the Runner IR nodes. No replacement or sync mechanism needed — the builder is the single source of truth for step IDs.

Clean up any parts of `_subStepPath` that were only needed for the old IR types (e.g., generating `__substep_N` variable names) but keep the push/pop pattern and `_sourceMapBuilder.record()` calls.

- [ ] **Step 11: Update `debugger` keyword code generation**

Agency's `debugger("label")` keyword currently compiles to a `debuggerStatement` AST node, which `insertDebugSteps()` turns into a `debugStep()` call. With the Runner, this should compile to `await runner.debugger("label");` — the Runner's `debugger()` method handles the rest. Update the builder's processing of `debuggerStatement` nodes to emit this call.

- [ ] **Step 12: Add Runner import to generated code**

The builder needs to emit an import for the Runner class at the top of each generated file:
```typescript
import { Runner } from "agency-lang/runtime";
```

And create the runner instance at the start of each node/function body:
```typescript
const runner = new Runner(__ctx, __stack);
```

Check the existing templates for how imports and boilerplate are added to generated code. The builder likely adds imports via the IR. Add the Runner import and constructor call.

- [ ] **Step 13: Add halt check at end of generated node/function bodies**

After all runner steps, add:
```typescript
if (runner.halted) return runner.haltResult;
```

Check how the current node/function return statement is generated and add the halt check before it.

- [ ] **Step 14: Update interrupt templates**

Read and update `lib/templates/backends/typescriptGenerator/interruptReturn.ts` and `interruptAssignment.ts`. Where they currently do:
```typescript
return { messages: __threads, data: ... };
```

Change to:
```typescript
runner.halt({ messages: __threads, data: ... });
return;
```

These templates use Mustache for conditional sections (`nodeContext` vs function context). Make sure both contexts use `runner.halt()`. Enumerate ALL early-return sites in both templates — the `interruptReturn.ts` template has returns for approve, reject, modify, resolve, and unhandled cases. The `interruptAssignment.ts` template has similar paths. Every `return { messages, data }` must become `runner.halt(...); return;`.

- [ ] **Step 15: Build**

Run: `pnpm run build`
Fix any compilation errors.

- [ ] **Step 16: Commit**

```
git add lib/backends/typescriptBuilder.ts lib/templates/
git commit -m "Update builder to emit Runner-based IR types"
```

---

## Task 6: Remove old IR types and templates

**Files:**
- Modify: `lib/ir/tsIR.ts`
- Modify: `lib/ir/prettyPrint.ts`
- Modify: `lib/ir/builders.ts`
- Delete: Multiple template files

- [ ] **Step 1: Remove old IR types from `lib/ir/tsIR.ts`**

Remove `TsStepBlock`, `TsIfSteps`, `TsThreadSteps`, `TsWhileSteps`, `TsForSteps`, `TsHandleSteps`, `TsIfStepsBranch` and their entries in the `TsNode` union.

- [ ] **Step 2: Remove old prettyPrint cases from `lib/ir/prettyPrint.ts`**

Remove the `case "stepBlock":`, `case "ifSteps":`, `case "threadSteps":`, `case "whileSteps":`, `case "forSteps":`, `case "handleSteps":` cases and all associated template imports.

- [ ] **Step 3: Remove old builder functions from `lib/ir/builders.ts`**

Remove `stepBlock`, `ifSteps`, `threadSteps`, `whileSteps`, `forSteps`, `handleSteps` and related functions.

- [ ] **Step 4: Delete removed template files**

Delete these files (both `.mustache` and compiled `.ts`):
- `lib/templates/backends/typescriptGenerator/debugger.mustache` + `.ts`
- `lib/templates/backends/typescriptGenerator/handleSteps.mustache` + `.ts`
- `lib/templates/backends/typescriptGenerator/threadSteps.mustache` + `.ts`
- `lib/templates/backends/typescriptGenerator/whileSteps.mustache` + `.ts`
- `lib/templates/backends/typescriptGenerator/forSteps.mustache` + `.ts`
- `lib/templates/backends/typescriptGenerator/ifStepsCondbranch.mustache` + `.ts`
- `lib/templates/backends/typescriptGenerator/ifStepsBranchDispatch.mustache` + `.ts`
- `lib/templates/backends/typescriptGenerator/substepBlock.mustache` + `.ts`

- [ ] **Step 5: Build and check for missing references**

Run: `pnpm run build`
Expected: Clean build. Any remaining references to removed types/templates will cause compile errors — fix them.

- [ ] **Step 6: Commit**

```
git add lib/ir/tsIR.ts lib/ir/prettyPrint.ts lib/ir/builders.ts
git rm lib/templates/backends/typescriptGenerator/debugger.mustache lib/templates/backends/typescriptGenerator/debugger.ts
git rm lib/templates/backends/typescriptGenerator/handleSteps.mustache lib/templates/backends/typescriptGenerator/handleSteps.ts
git rm lib/templates/backends/typescriptGenerator/threadSteps.mustache lib/templates/backends/typescriptGenerator/threadSteps.ts
git rm lib/templates/backends/typescriptGenerator/whileSteps.mustache lib/templates/backends/typescriptGenerator/whileSteps.ts
git rm lib/templates/backends/typescriptGenerator/forSteps.mustache lib/templates/backends/typescriptGenerator/forSteps.ts
git rm lib/templates/backends/typescriptGenerator/ifStepsCondbranch.mustache lib/templates/backends/typescriptGenerator/ifStepsCondbranch.ts
git rm lib/templates/backends/typescriptGenerator/ifStepsBranchDispatch.mustache lib/templates/backends/typescriptGenerator/ifStepsBranchDispatch.ts
git rm lib/templates/backends/typescriptGenerator/substepBlock.mustache lib/templates/backends/typescriptGenerator/substepBlock.ts
git commit -m "Remove old step IR types and templates"
```

---

## Task 7: Regenerate fixtures and verify

**Files:**
- Regenerate: `tests/typescriptGenerator/*.mts`
- Regenerate: `tests/typescriptBuilder/*.mts`

- [ ] **Step 1: Rebuild templates and project**

Run: `make all` (which runs `pnpm run templates && pnpm run build`)

- [ ] **Step 2: Regenerate fixtures**

Run: `make fixtures`

This runs `scripts/regenerate-fixtures.ts` which re-compiles all `.agency` files and overwrites the `.mts` files with new generated code.

- [ ] **Step 3: Inspect fixture diffs**

Run: `git diff tests/`

Verify the changes make sense:
- If-statement step guards (`if (__step <= N) { ... __stack.step++; }`) replaced with `runner.step(async (runner) => { ... })`
- Substep patterns replaced with nested `runner.step()` calls
- `__condbranch`, `__substep`, `__iteration` variables no longer in generated code (managed by Runner internally)
- `debugStep()` calls no longer in generated code
- `runner.ifElse()`, `runner.loop()`, `runner.whileLoop()`, `runner.thread()`, `runner.handle()` appear where appropriate
- Interrupt code uses `runner.halt()` instead of direct `return`
- Runner import and constructor at the top of each file
- `if (runner.halted) return runner.haltResult;` at the end of each node/function

- [ ] **Step 4: Run unit tests**

Run: `pnpm test:run`
Expected: All tests pass, including fixture comparison tests.

- [ ] **Step 5: Run e2e tests**

Run: `pnpm run build && pnpm run test:agency`
Expected: All agency tests pass (these actually execute compiled code).

Run: `pnpm run test:agency-js`
Expected: All JS interop tests pass.

- [ ] **Step 6: Commit fixtures**

```
git add tests/
git commit -m "Regenerate fixtures for Runner-based code generation"
```

---

## Task 8: Manual testing and final verification

- [ ] **Step 1: Test the debugger**

Run: `pnpm run agency debug examples/simple.agency` (or any example with multiple steps)

Verify:
- Stepping works (step, next, stepOut, continue)
- Variables are visible
- Breakpoints work
- Rewind works

If the debugger doesn't work, check:
- Does `debugStep()` receive the correct `stepPath`?
- Does `advanceDebugStep()` still work with the Runner's counter updates?
- Is the Runner creating checkpoints at the right moments?

- [ ] **Step 2: Test traces**

Run: `pnpm run agency run --trace examples/simple.agency`

Verify a trace file is created and contains checkpoints.

- [ ] **Step 3: Test interrupts**

Find an example with interrupts (check `tests/agency/` or `examples/`) and run it. Verify:
- Interrupt pauses execution correctly
- State serializes correctly
- Resume picks up at the right step
- Handler approve/reject/propagate work

- [ ] **Step 4: Final full test run**

Run: `pnpm test:run && pnpm run test:agency && pnpm run test:agency-js`
Expected: All tests pass.

- [ ] **Step 5: Commit any fixes**

If any fixes were needed during manual testing, commit them.
