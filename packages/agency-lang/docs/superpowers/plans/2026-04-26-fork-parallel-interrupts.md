# Fork Parallel Interrupts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collect all unresolved interrupts from fork threads, return them as an array, and resume all interrupted threads with a single `respondToInterrupts` call.

**Architecture:** Change `Runner.fork()` to collect all interrupts instead of returning the first. Normalize the public API so `result.data` is always an `Interrupt[]`. Replace the five action-based interrupt response functions with two pure response constructors (`approve`/`reject`) and a single `respondToInterrupts` resumption call. Cache completed thread results in `BranchState` to survive multi-cycle interrupt rounds.

**Tech Stack:** TypeScript, vitest

**Spec:** `docs/superpowers/specs/2026-04-26-fork-parallel-interrupts-design.md`

---

### Task 1: Add `interruptId` to the Interrupt type

**Files:**
- Modify: `lib/runtime/interrupts.ts:62-81` (Interrupt type and `interrupt()` factory)

- [ ] **Step 1: Uncomment `interruptId` on the Interrupt type**

In `lib/runtime/interrupts.ts`, change the `Interrupt` type (line 64) and the `interrupt()` factory (line 77):

```typescript
// Type (line 62-72): uncomment interruptId
export type Interrupt<T = any> = {
  type: "interrupt";
  interruptId: string; // nanoid — globally unique
  data: T;
  debugger?: boolean;
  interruptData?: InterruptData;
  checkpointId?: number;
  checkpoint?: Checkpoint;
  state?: InterruptState;
  runId: string;
};

// Factory (line 74-81): uncomment nanoid call
export function interrupt<T = any>(data: T, runId: string): Interrupt<T> {
  return {
    type: "interrupt",
    interruptId: nanoid(),
    data,
    runId,
  };
}
```

You'll need to import `nanoid`. Check what's available — `smoltalk` is already imported on line 1 and `nanoid` is imported in the imports template (line 5 of `imports.mustache`). If `nanoid` is not re-exported from smoltalk, add a direct import: `import { nanoid } from "nanoid";`

- [ ] **Step 2: Also add `interruptId` to `createDebugInterrupt`**

In the same file, `createDebugInterrupt` (lines 83-97) should also get an `interruptId`:

```typescript
export function createDebugInterrupt<T = any>(
  data: T,
  checkpointId: number,
  checkpoint: Checkpoint,
  runId: string,
): Interrupt<T> {
  return {
    type: "interrupt",
    interruptId: nanoid(),
    data,
    debugger: true,
    checkpointId,
    checkpoint,
    runId,
  };
}
```

- [ ] **Step 3: Build and run existing tests**

Run: `pnpm run build && pnpm test:run`

Fix any type errors from the newly-required `interruptId` field (e.g., test code that constructs `Interrupt` objects manually).

- [ ] **Step 4: Commit**

```bash
git commit -m "feat: uncomment interruptId on Interrupt type and factory functions"
```

---

### Task 2: Add `result` field to `BranchState` with serialization

**Files:**
- Modify: `lib/runtime/state/stateStack.ts:4-19` (BranchState, BranchStateJSON types)
- Modify: `lib/runtime/state/stateStack.ts:71-113` (State.toJSON, State.fromJSON)
- Test: `lib/runtime/state/stateStack.test.ts`

- [ ] **Step 1: Write a failing test for BranchState result serialization**

In `lib/runtime/state/stateStack.test.ts`, add:

```typescript
it("serializes and deserializes BranchState.result", () => {
  const stack = new StateStack();
  const frame = stack.getNewState();
  frame.branches = {
    "fork_0_0": {
      stack: new StateStack(),
      result: { result: "hello" },
    },
    "fork_0_1": {
      stack: new StateStack(),
      // no result — thread still interrupted
    },
    "fork_0_2": {
      stack: new StateStack(),
      result: { result: undefined }, // thread returned undefined
    },
  };

  const json = stack.toJSON();
  const restored = StateStack.fromJSON(json);
  const restoredFrame = restored.stack[0];

  expect(restoredFrame.branches!["fork_0_0"].result).toEqual({ result: "hello" });
  expect(restoredFrame.branches!["fork_0_1"].result).toBeUndefined();
  expect(restoredFrame.branches!["fork_0_2"].result).toEqual({ result: undefined });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:run -- lib/runtime/state/stateStack.test.ts`

Expected: FAIL — `result` property not serialized/deserialized.

- [ ] **Step 3: Add `result` field to BranchState and BranchStateJSON**

In `lib/runtime/state/stateStack.ts`, update both types (lines 4-19):

```typescript
export type BranchState = {
  stack: StateStack;
  interruptId?: string;
  interruptData?: any;
  result?: { result: any }; // present = thread completed
};

export type BranchStateJSON = {
  stack: StateStackJSON;
  interruptId?: string;
  interruptData?: any;
  result?: { result: any }; // present = thread completed
};
```

- [ ] **Step 4: Update `State.toJSON()` to serialize `result`**

In `State.toJSON()` (lines 78-88), add result to the branch serialization:

```typescript
if (this.branches) {
  json.branches = {};
  for (const [key, branch] of Object.entries(this.branches)) {
    json.branches[key] = {
      stack: branch.stack.toJSON(),
      ...(branch.interruptId ? { interruptId: branch.interruptId } : {}),
      ...(branch.interruptData ? { interruptData: branch.interruptData } : {}),
      ...(branch.result !== undefined ? { result: deepClone(branch.result) } : {}),
    };
  }
}
```

- [ ] **Step 5: Update `State.fromJSON()` to deserialize `result`**

In `State.fromJSON()` (lines 100-111), add result to the branch deserialization:

```typescript
if (json.branches) {
  state.branches = {};
  for (const [key, branch] of Object.entries(json.branches)) {
    state.branches[key] = {
      stack: StateStack.fromJSON(branch.stack),
      ...(branch.interruptId ? { interruptId: branch.interruptId } : {}),
      ...(branch.interruptData ? { interruptData: branch.interruptData } : {}),
      ...(branch.result !== undefined ? { result: branch.result } : {}),
    };
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test:run -- lib/runtime/state/stateStack.test.ts`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git commit -m "feat: add result field to BranchState with serialization support"
```

---

### Task 3: Add `hasInterrupts` type guard to runtime

**Files:**
- Modify: `lib/runtime/interrupts.ts` (add `hasInterrupts`)
- Modify: `lib/runtime/index.ts` (export new function)
- Test: `lib/runtime/interrupts.test.ts` (or create if doesn't exist)

- [ ] **Step 1: Write failing tests for `hasInterrupts`**

```typescript
import { interrupt, hasInterrupts } from "./interrupts.js";

describe("hasInterrupts", () => {
  it("returns true for an array of interrupts", () => {
    const interrupts = [
      interrupt("test1", "run1"),
      interrupt("test2", "run1"),
    ];
    expect(hasInterrupts(interrupts)).toBe(true);
  });

  it("returns false for null/undefined", () => {
    expect(hasInterrupts(null)).toBe(false);
    expect(hasInterrupts(undefined)).toBe(false);
  });

  it("returns false for a non-array", () => {
    expect(hasInterrupts("hello")).toBe(false);
    expect(hasInterrupts({ type: "interrupt" })).toBe(false);
  });

  it("returns false for an empty array", () => {
    expect(hasInterrupts([])).toBe(false);
  });

  it("returns false for an array of non-interrupts", () => {
    expect(hasInterrupts([1, 2, 3])).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run -- lib/runtime/interrupts.test.ts`

- [ ] **Step 3: Implement `hasInterrupts`**

In `lib/runtime/interrupts.ts`, add:

```typescript
export function hasInterrupts(data: any): data is Interrupt[] {
  return Array.isArray(data) && data.length > 0 && isInterrupt(data[0]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run -- lib/runtime/interrupts.test.ts`

- [ ] **Step 5: Export from runtime index**

In `lib/runtime/index.ts`, add `hasInterrupts` to the exports from `"./interrupts.js"` (line 47-59).

- [ ] **Step 6: Build to verify no type errors**

Run: `pnpm run build`

- [ ] **Step 7: Commit**

```bash
git commit -m "feat: add hasInterrupts type guard"
```

---

### Task 4: Add `interruptResponses` to RuntimeContext

**Files:**
- Modify: `lib/runtime/state/context.ts:23-72` (RuntimeContext class)

- [ ] **Step 1: Add private field and public accessors**

In the `RuntimeContext` class (around line 48, near the other private fields), add:

```typescript
private interruptResponses: Record<string, InterruptResponse> = {};
```

Add public accessor methods:

```typescript
setInterruptResponses(responses: Record<string, InterruptResponse>): void {
  this.interruptResponses = responses;
}

getInterruptResponse(interruptId: string): InterruptResponse | undefined {
  return this.interruptResponses[interruptId];
}
```

Import `InterruptResponse` at the top of the file from `"../interrupts.js"`.

Note: `interruptResponses` is NOT serialized — it is set fresh on each resume by `respondToInterrupts`.

- [ ] **Step 2: Build to verify no type errors**

Run: `pnpm run build`

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: add private interruptResponses to RuntimeContext"
```

---

### Task 5: Modify `Runner.fork()` to collect all interrupts and cache completed results

**Files:**
- Modify: `lib/runtime/runner.ts:561-579` (the interrupt collection loop in fork)

- [ ] **Step 1: Modify `Runner.fork()` to collect all interrupts**

In `lib/runtime/runner.ts`, replace the interrupt collection logic in the "all" mode branch (lines 561-575):

```typescript
if (mode === "all") {
  const settled = await Promise.allSettled(promises);
  const interrupts: any[] = [];

  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    const branchKey = this.forkBranchKey(id, i);
    if (s.status === "fulfilled" && isInterrupt(s.value)) {
      interrupts.push(s.value);
    } else if (s.status === "fulfilled") {
      // Cache the completed result on the branch so it survives interrupt cycles
      if (this.frame.branches![branchKey]) {
        this.frame.branches![branchKey].result = { result: s.value };
      }
    } else {
      throw s.reason;
    }
  }

  if (interrupts.length > 0) {
    // Create a shared checkpoint capturing full state tree (including cached results)
    const cpId = this.ctx.checkpoints.add({
      stateStack: this.ctx.stateStack.toJSON(),
      globals: this.ctx.globals.toJSON(),
      nodeId: this.ctx.stateStack.nodesTraversed[this.ctx.stateStack.nodesTraversed.length - 1] || "",
    });
    const cp = this.ctx.checkpoints.get(cpId);
    for (const intr of interrupts) {
      intr.checkpoint = cp;
      intr.checkpointId = cpId;
    }
    return interrupts;
  }

  result = settled.map((s) => (s as PromiseFulfilledResult<any>).value);
}
```

Note: Check how checkpoints are created elsewhere in the codebase (e.g., in `checkpoint()` builtin or debug step) and follow the same pattern.

You'll need to import `isInterrupt` if not already imported in runner.ts. Check the existing imports.

- [ ] **Step 2: Add result caching check at branch setup**

Earlier in the fork method (around lines 545-558), when creating branch stacks and promises, add a check for cached results so completed threads skip re-execution on resume:

```typescript
const branchStacks = items.map((_item, i) => {
  const branchKey = this.forkBranchKey(id, i);
  const existing = this.frame.branches![branchKey];
  if (existing) {
    // If this thread already completed, return null — we'll use cached result
    if (existing.result !== undefined) {
      return null;
    }
    existing.stack.deserializeMode();
    return existing.stack;
  }
  const stack = new StateStack();
  this.frame.branches![branchKey] = { stack };
  return stack;
});

const promises = items.map((item, i) => {
  const branchKey = this.forkBranchKey(id, i);
  const existing = this.frame.branches![branchKey];
  // Skip re-execution for completed threads
  if (existing?.result !== undefined) {
    return Promise.resolve(existing.result.result);
  }
  return blockFn(item, i, branchStacks[i]!);
});
```

- [ ] **Step 3: Update race mode to wrap interrupt in array**

In the race mode branch (lines 576-579), wrap the interrupt in an array:

```typescript
} else {
  result = await Promise.race(promises);
  if (isInterrupt(result)) return [result];
}
```

- [ ] **Step 4: Build to verify no type errors**

Run: `pnpm run build`

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: fork collects all interrupts, caches completed results, attaches shared checkpoint"
```

---

### Task 6: Rename internal handler builtins to avoid naming collision

**Files:**
- Modify: `lib/templates/backends/typescriptGenerator/imports.mustache` (rename internal `approve`/`reject`/`propagate`)
- Modify: `lib/backends/typescriptBuilder.ts` (update generated handler return references)

The imports template (line 47-49) defines local functions `approve`, `reject`, `propagate` that return `{ type: "approved" }`, `{ type: "rejected" }`, `{ type: "propagated" }`. These are used in generated `with` blocks for handler results. We need the names `approve` and `reject` free for the public interrupt response API.

- [ ] **Step 1: Rename handler builtins in the imports template**

In `lib/templates/backends/typescriptGenerator/imports.mustache` (lines 47-49), rename:

```typescript
// Handler result builtins (used in generated 'with' blocks)
function __handlerApprove(value?: any) { return { type: "approved" as const, value }; }
function __handlerReject(value?: any) { return { type: "rejected" as const, value }; }
function __handlerPropagate() { return { type: "propagated" as const }; }
```

- [ ] **Step 2: Update the builder to generate the new names**

Search the builder (`lib/backends/typescriptBuilder.ts`) for where it generates `approve(`, `reject(`, `propagate(` in handler/with block code. Update these to use `__handlerApprove`, `__handlerReject`, `__handlerPropagate`.

Also check any shorthand handler generation (the `with approve` / `with reject` syntax from the docs).

- [ ] **Step 3: Add the public interrupt response constructors**

In the imports template, add the public-facing response constructors:

```typescript
// Interrupt response constructors (exported for TypeScript callers)
export function approve(value?: any) { return { type: "approve" as const, value }; }
export function reject(value?: any) { return { type: "reject" as const, value }; }
```

Note the difference: handler builtins return `"approved"`/`"rejected"` (past tense), response constructors return `"approve"`/`"reject"` (matching the `InterruptResponse` type).

- [ ] **Step 4: Rebuild fixtures, build, and run tests**

Run: `pnpm run templates && make fixtures && make all && pnpm test:run`

All existing tests should pass — handler behavior is unchanged, just renamed internally.

- [ ] **Step 5: Commit**

```bash
git commit -m "refactor: rename internal handler builtins to free approve/reject for public API"
```

---

### Task 7: Update generated code to use `hasInterrupts` for fork results

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts` (the code generated after a fork call)
- Modify: `lib/templates/backends/typescriptGenerator/imports.mustache` (import `hasInterrupts`)

- [ ] **Step 1: Find where post-fork interrupt check is generated**

Search the builder for `isInterrupt` usage in the context of fork. The generated code after a fork call checks `if (isInterrupt(__stack.locals.results))`. Find the builder method that generates this check — likely in or near `processForkCall` in `lib/backends/typescriptBuilder.ts`.

- [ ] **Step 2: Change the generated check to `hasInterrupts`**

Replace the generated `isInterrupt(...)` check with `hasInterrupts(...)` for fork results. The exact change depends on how the builder generates this code — it may be in a template or inline in the builder.

- [ ] **Step 3: Add `hasInterrupts` to the imports template**

In `lib/templates/backends/typescriptGenerator/imports.mustache`, add `hasInterrupts` to the import from `"agency-lang/runtime"` (line 13):

```
  interrupt, isInterrupt, isDebugger, isRejected, isApproved, interruptWithHandlers, hasInterrupts, debugStep,
```

Also add a re-export:

```typescript
export { hasInterrupts };
```

- [ ] **Step 4: Rebuild fixtures, build, and run tests**

Run: `pnpm run templates && make fixtures && make all && pnpm test:run`

Fix any failures caused by the changed generated code.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: generated fork code uses hasInterrupts instead of isInterrupt"
```

---

### Task 8: Normalize `runNode` to always return interrupt array and update test runner

This task combines the `runNode` normalization with the test runner update to avoid committing deliberately broken tests.

**Files:**
- Modify: `lib/runtime/node.ts:152-172` (where runNode packages the return value)
- Modify: `lib/templates/cli/evaluate.mustache` (interrupt handling loop)
- Modify: `lib/templates/cli/judgeEvaluate.mustache` (same change)

- [ ] **Step 1: Update runNode to wrap single interrupts in an array**

In `lib/runtime/node.ts`, find where `isInterrupt(returnObject.data)` is checked (around line 157). Change to handle both single interrupts and interrupt arrays:

```typescript
const returnObject = createReturnObject({
  result,
  globals: execCtx.globals,
});

// Normalize: always return interrupt array
if (isInterrupt(returnObject.data)) {
  returnObject.data = [returnObject.data];
}

if (hasInterrupts(returnObject.data)) {
  if (execCtx.runId) {
    for (const intr of returnObject.data) {
      intr.runId = execCtx.runId;
    }
  }
  await execCtx.pauseTraceWriter();
} else {
  await callHook({
    callbacks: execCtx.callbacks,
    name: "onAgentEnd",
    data: { nodeName, result: returnObject },
  });
  await execCtx.closeTraceWriter();
}
return returnObject;
```

Import `hasInterrupts` from `"./interrupts.js"`.

- [ ] **Step 2: Update evaluate.mustache**

In `lib/templates/cli/evaluate.mustache`, find the interrupt handling section (around lines 12-55). Change from single-interrupt loop to batch-aware. Also update the import line at the top if it references old function names.

```mustache
{{#hasInterruptHandlers}}
const interruptHandlers = {{{interruptHandlersJSON?:string}}};
let handlerIndex = 0;

while (hasInterrupts(result.data)) {
  const interrupts = result.data;
  const responses = [];

  for (const interruptItem of interrupts) {
    if (handlerIndex >= interruptHandlers.length) {
      throw new Error("Unexpected interrupt #" + (handlerIndex + 1) + ": \\"" + interruptItem.data + "\\". No handler provided.");
    }

    const handler = interruptHandlers[handlerIndex];

    if (handler.expectedMessage !== undefined && interruptItem.data !== handler.expectedMessage) {
      throw new Error(
        "Interrupt #" + (handlerIndex + 1) + " expected message \\"" + handler.expectedMessage + "\\" but got \\"" + interruptItem.data + "\\""
      );
    }

    if (handler.action === "approve") {
      responses.push(approve(handler.value));
    } else if (handler.action === "reject") {
      responses.push(reject(handler.value));
    } else {
      throw new Error("Unknown interrupt handler action: " + handler.action);
    }

    handlerIndex++;
  }

  result = await respondToInterrupts(interrupts, responses);
}

if (handlerIndex < interruptHandlers.length) {
  throw new Error(
    "Expected " + interruptHandlers.length + " interrupts but only " + handlerIndex + " occurred."
  );
}
{{/hasInterruptHandlers}}
```

Note: `approve`, `reject`, `hasInterrupts`, and `respondToInterrupts` must be available in the template scope. They should come from the imports template. The evaluate template has its own import line — update it to import the new functions.

- [ ] **Step 3: Apply the same change to `judgeEvaluate.mustache`**

Make the same interrupt handling update in `lib/templates/cli/judgeEvaluate.mustache`. Also update its import line.

- [ ] **Step 4: Rebuild everything and run tests**

Run: `pnpm run templates && make fixtures && make all && pnpm test:run`

Fix any failures. All existing interrupt tests should pass because the evaluate templates now handle arrays.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: runNode always returns interrupt array, update test runner templates"
```

---

### Task 9: Implement `respondToInterrupts` and update the public API

**Files:**
- Modify: `lib/runtime/interrupts.ts` (add `respondToInterrupts`, keep old functions temporarily)
- Modify: `lib/runtime/index.ts` (export new function)
- Modify: `lib/templates/backends/typescriptGenerator/imports.mustache` (update exports)
- Test: `lib/runtime/interrupts.test.ts`

- [ ] **Step 1: Write failing test for `respondToInterrupts` length mismatch**

In `lib/runtime/interrupts.test.ts`, add:

```typescript
describe("respondToInterrupts", () => {
  it("throws if responses length does not match interrupts length", async () => {
    const interrupts = [
      interrupt("test1", "run1"),
      interrupt("test2", "run1"),
    ];
    await expect(
      respondToInterrupts({
        ctx: {} as any,
        interrupts,
        responses: [{ type: "approve" }],
      })
    ).rejects.toThrow("expected 2 responses but got 1");
  });
});
```

- [ ] **Step 2: Implement `respondToInterrupts`**

In `lib/runtime/interrupts.ts`, add the new function:

```typescript
export async function respondToInterrupts(args: {
  ctx: RuntimeContext<GraphState>;
  interrupts: Interrupt[];
  responses: InterruptResponse[];
  overrides?: Record<string, unknown>;
  metadata?: Record<string, any>;
}): Promise<any> {
  const { ctx, interrupts, responses, metadata = {} } = args;

  if (responses.length !== interrupts.length) {
    throw new Error(
      `respondToInterrupts: expected ${interrupts.length} responses but got ${responses.length}`
    );
  }

  // Build ID-keyed response map
  const responseMap: Record<string, InterruptResponse> = {};
  for (let i = 0; i < interrupts.length; i++) {
    responseMap[interrupts[i].interruptId] = deepClone(responses[i]);
  }

  // All interrupts share the same checkpoint — grab from first
  const interrupt = deepClone(interrupts[0]);
  const checkpoint =
    interrupt.checkpoint ??
    (interrupt.checkpointId !== undefined
      ? ctx.checkpoints?.get(interrupt.checkpointId)
      : undefined);
  if (!checkpoint) {
    throw new Error(
      "No checkpoint found for interrupt. The interrupt may have been created with an older format.",
    );
  }

  if (args.overrides) {
    applyOverrides(checkpoint, args.overrides);
  }

  const execCtx = await ctx.createExecutionContext(interrupt.runId);
  execCtx.restoreState(checkpoint);
  execCtx.setInterruptResponses(responseMap);

  execCtx.installRegisteredCallbacks(ctx);
  if (metadata.callbacks) {
    Object.assign(execCtx.callbacks, metadata.callbacks);
  }

  if (metadata.debugger) {
    execCtx.debuggerState = metadata.debugger;
  }

  let nodeName = checkpoint.nodeId;
  try {
    while (true) {
      try {
        const result = await execCtx.graph.run(
          nodeName,
          {
            data: {},
            ctx: execCtx,
            isResume: true,
          },
          { onNodeEnter: (id) => execCtx.stateStack.nodesTraversed.push(id) },
        );
        await execCtx.pendingPromises.awaitAll();
        const returnObject = createReturnObject({
          result,
          globals: execCtx.globals,
        });

        // Normalize single interrupts to array
        if (isInterrupt(returnObject.data)) {
          returnObject.data = [returnObject.data];
        }

        if (hasInterrupts(returnObject.data)) {
          await execCtx.pauseTraceWriter();
        } else {
          await execCtx.closeTraceWriter();
        }
        return returnObject;
      } catch (e) {
        if (e instanceof RestoreSignal) {
          const cp = e.checkpoint;
          execCtx.restoreState(cp);
          nodeName = cp.nodeId;
          execCtx.stateStack.nodesTraversed = [cp.nodeId];
          continue;
        }
        throw e;
      }
    }
  } finally {
    execCtx.cleanup();
  }
}
```

- [ ] **Step 3: Run the length-mismatch test**

Run: `pnpm test:run -- lib/runtime/interrupts.test.ts`

Expected: PASS for the mismatch test.

- [ ] **Step 4: Export from runtime index**

In `lib/runtime/index.ts`, add `respondToInterrupts` to the exports from `"./interrupts.js"`.

- [ ] **Step 5: Update the imports template**

In `lib/templates/backends/typescriptGenerator/imports.mustache`:

Add the import for `respondToInterrupts`:
```
  respondToInterrupts as _respondToInterrupts,
```

Add the new public-facing export:
```typescript
export const respondToInterrupts = (interrupts: Interrupt[], responses: InterruptResponse[], opts?: { overrides?: Record<string, unknown>; metadata?: Record<string, any> }) => _respondToInterrupts({ ctx: __globalCtx, interrupts, responses, overrides: opts?.overrides, metadata: opts?.metadata });
```

Keep the old exports (`approveInterrupt`, `rejectInterrupt`, etc.) for now — we'll remove them in Task 11.

- [ ] **Step 6: Run `pnpm run templates && make all && pnpm test:run`**

- [ ] **Step 7: Commit**

```bash
git commit -m "feat: add respondToInterrupts function and update exports"
```

---

### Task 10: Update generated interrupt template to use unified `ctx.getInterruptResponse()`

**Files:**
- Modify: `lib/templates/backends/typescriptGenerator/interruptReturn.mustache` (or the equivalent interrupt template)
- Modify: `lib/templates/backends/typescriptGenerator/interruptAssignment.mustache`
- Modify: `lib/backends/typescriptBuilder.ts` (generate `interruptId` storage on frame)

Currently, when a function resumes from an interrupt, the generated code reads the response from `interruptData.interruptResponse` — a single object passed to `graph.run()`. We are replacing this entirely with `ctx.getInterruptResponse(interruptId)`. There is no backward compat fallback — all interrupt responses go through the `interruptResponses` map on context, keyed by `interruptId`. This unifies single-interrupt and multi-interrupt code paths.

- [ ] **Step 1: Find the interrupt resume templates**

Search for `interruptResponse` in the templates directory. The key templates are:
- `interruptReturn.mustache` — for `return interrupt(...)` (interrupt without capturing result)
- `interruptAssignment.mustache` — for `x = interrupt(...)` (interrupt that captures a resolved value)

These templates generate the code that checks `interruptData.interruptResponse` on resume and decides whether to approve, reject, or resolve.

- [ ] **Step 2: Update the builder to store `interruptId` on the frame**

In `lib/backends/typescriptBuilder.ts`, find where interrupt calls are processed. After the interrupt object is created in generated code, store its `interruptId` on the frame locals:

```typescript
__self.__interruptId_N = __interrupt.interruptId;
```

Where `N` is the step index, ensuring uniqueness per interrupt site.

- [ ] **Step 3: Replace `interruptData.interruptResponse` with `ctx.getInterruptResponse()`**

In the interrupt templates, replace the existing response lookup:

```typescript
// Old:
if (__state?.interruptData?.interruptResponse) {
  const response = __state.interruptData.interruptResponse;
  // handle approve/reject/resolve
}

// New:
const __response = __ctx.getInterruptResponse(__self.__interruptId_N);
if (__response) {
  // handle approve/reject based on __response.type
}
```

Since `modify` and `resolve` response types are being removed, the handler logic simplifies to just `approve` (continue execution, optionally with a value) and `reject` (return failure).

- [ ] **Step 4: Remove `interruptData` from `respondToInterrupts` and `graph.run()` calls**

In `respondToInterrupts` (Task 9), we already removed the `interruptData` parameter from the `graph.run()` call. Verify that the old `interruptData.interruptResponse` code path is fully removed — no remaining references in templates or runtime.

Note: `interruptData` still has a role for tool call resume (carrying `messages` and `toolCall` data for `runPrompt`). That part stays — only the `interruptResponse` field on `interruptData` is removed. The tool call data can also be stored on `ctx` keyed by `interruptId` if needed, but that can be deferred.

- [ ] **Step 5: Rebuild fixtures, build, and run tests**

Run: `pnpm run templates && make fixtures && make all && pnpm test:run`

- [ ] **Step 6: Commit**

```bash
git commit -m "feat: unified interrupt response lookup via ctx.getInterruptResponse(interruptId)"
```

---

### Task 11: Remove old interrupt API functions

**Files:**
- Modify: `lib/runtime/interrupts.ts` (remove `approveInterrupt`, `rejectInterrupt`, `modifyInterrupt`, `resolveInterrupt`, `respondToInterrupt`)
- Modify: `lib/runtime/index.ts` (remove exports)
- Modify: `lib/templates/backends/typescriptGenerator/imports.mustache` (remove imports and re-exports)
- Modify: `lib/debugger/driver.ts` (update debugger to use new API)

- [ ] **Step 1: Remove old functions from `interrupts.ts`**

Remove these functions from `lib/runtime/interrupts.ts`:
- `approveInterrupt` (lines 288-306)
- `modifyInterrupt` (lines 308-328)
- `rejectInterrupt` (lines 330-348)
- `resolveInterrupt` (lines 350-370)
- `respondToInterrupt` (lines 191-286)

Remove the `InterruptModify` and `InterruptResolve` types (lines 22-37). Update the `InterruptResponse` type:

```typescript
export type InterruptResponse =
  | { type: "approve"; value?: any }
  | { type: "reject"; value?: any };
```

- [ ] **Step 2: Remove from runtime index**

In `lib/runtime/index.ts`, remove the old exports: `respondToInterrupt`, `approveInterrupt`, `rejectInterrupt`, `modifyInterrupt`, `resolveInterrupt`.

- [ ] **Step 3: Remove from imports template**

In `lib/templates/backends/typescriptGenerator/imports.mustache`:
- Remove the imports of `_respondToInterrupt`, `_approveInterrupt`, `_rejectInterrupt`, `_modifyInterrupt`, `_resolveInterrupt` (lines 14-18)
- Remove the export lines for `respondToInterrupt`, `approveInterrupt`, `rejectInterrupt`, `modifyInterrupt`, `resolveInterrupt` (lines 53-57)
- Update the `InterruptResponse` type import (line 8) if needed

- [ ] **Step 4: Update the debugger driver**

The debugger driver (`lib/debugger/driver.ts`) uses the old single-interrupt API extensively (~11 call sites). It needs to be updated to use `respondToInterrupts`. Key changes:

- `this.mod.approveInterrupt(interrupt, opts)` → `this.mod.respondToInterrupts([interrupt], [{ type: "approve" }], opts)`
- `this.mod.rejectInterrupt(interrupt, opts)` → `this.mod.respondToInterrupts([interrupt], [{ type: "reject" }], opts)`
- `this.mod.resolveInterrupt(interrupt, value, opts)` → `this.mod.respondToInterrupts([interrupt], [{ type: "approve", value }], opts)`
- `this.mod.modifyInterrupt(interrupt, args, opts)` → `this.mod.respondToInterrupts([interrupt], [{ type: "approve", value: args }], opts)` (or remove modify support entirely since it's being dropped from the public API)

Search `lib/debugger/driver.ts` for all references and update each one. The debugger always handles one interrupt at a time (it presents a single interrupt to the user), so wrapping in a single-element array is the right approach.

- [ ] **Step 5: Search for any remaining references**

Search the entire codebase for `approveInterrupt`, `rejectInterrupt`, `modifyInterrupt`, `resolveInterrupt`, `respondToInterrupt` (singular). Fix any remaining callers.

- [ ] **Step 6: Run `pnpm run templates && make all && pnpm test:run`**

Fix any remaining failures.

- [ ] **Step 7: Commit**

```bash
git commit -m "feat: remove old single-interrupt API functions, update debugger"
```

---

### Task 12: End-to-end integration tests

**Files:**
- Create: `tests/agency/fork/fork-multi-interrupt.agency` and `.test.json`
- Create: `tests/agency/fork/fork-partial-interrupt.agency` and `.test.json`
- Create: `tests/agency/fork/fork-multi-cycle-interrupt.agency` and `.test.json`
- Create: `tests/agency/fork/fork-handler-resolve.agency` and `.test.json`
- Create: `tests/agency/fork/fork-mixed-response.agency` and `.test.json`

- [ ] **Step 1: Test — all threads interrupt**

Create `tests/agency/fork/fork-multi-interrupt.agency`:

```
def confirmItem(item: string): string {
  interrupt("approve ${item}?")
  return "confirmed: ${item}"
}

node main() {
  let results = fork(["a", "b", "c"]) as item {
    return confirmItem(item)
  }
  return results
}
```

Create `tests/agency/fork/fork-multi-interrupt.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "Fork with multiple interrupts — all are collected and approved in batch",
      "input": "",
      "expectedOutput": "[\"confirmed: a\",\"confirmed: b\",\"confirmed: c\"]",
      "evaluationCriteria": [{ "type": "exact" }],
      "interruptHandlers": [
        { "action": "approve" },
        { "action": "approve" },
        { "action": "approve" }
      ]
    }
  ]
}
```

- [ ] **Step 2: Test — some threads complete, some interrupt**

Create `tests/agency/fork/fork-partial-interrupt.agency`:

```
def maybeInterrupt(item: string): string {
  if (item == "b") {
    interrupt("approve ${item}?")
  }
  return "done: ${item}"
}

node main() {
  let results = fork(["a", "b", "c"]) as item {
    return maybeInterrupt(item)
  }
  return results
}
```

Create `tests/agency/fork/fork-partial-interrupt.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "Fork where only one thread interrupts — completed threads cached, interrupted thread resumes",
      "input": "",
      "expectedOutput": "[\"done: a\",\"done: b\",\"done: c\"]",
      "evaluationCriteria": [{ "type": "exact" }],
      "interruptHandlers": [
        { "action": "approve" }
      ]
    }
  ]
}
```

- [ ] **Step 3: Test — multi-cycle interrupts (thread interrupts twice)**

Create `tests/agency/fork/fork-multi-cycle-interrupt.agency`:

```
def twoInterrupts(item: string): string {
  interrupt("first approve ${item}?")
  interrupt("second approve ${item}?")
  return "done: ${item}"
}

node main() {
  let results = fork(["a", "b"]) as item {
    return twoInterrupts(item)
  }
  return results
}
```

Create `tests/agency/fork/fork-multi-cycle-interrupt.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "Fork with multiple interrupt cycles — threads interrupt twice, cached results survive across cycles",
      "input": "",
      "expectedOutput": "[\"done: a\",\"done: b\"]",
      "evaluationCriteria": [{ "type": "exact" }],
      "interruptHandlers": [
        { "action": "approve" },
        { "action": "approve" },
        { "action": "approve" },
        { "action": "approve" }
      ]
    }
  ]
}
```

- [ ] **Step 4: Test — handler resolves interrupt before it reaches the batch**

Create `tests/agency/fork/fork-handler-resolve.agency`:

```
def confirmItem(item: string): string {
  interrupt("approve ${item}?")
  return "confirmed: ${item}"
}

node main() {
  handle {
    let results = fork(["a", "b"]) as item {
      return confirmItem(item)
    }
    return results
  } with (data) {
    return approve()
  }
}
```

Create `tests/agency/fork/fork-handler-resolve.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "Fork with handler that auto-approves — no interrupts reach the caller",
      "input": "",
      "expectedOutput": "[\"confirmed: a\",\"confirmed: b\"]",
      "evaluationCriteria": [{ "type": "exact" }],
      "interruptHandlers": []
    }
  ]
}
```

Note: `approve()` inside the handler here refers to the handler builtin (now `__handlerApprove` internally), not the interrupt response constructor. The generated code should use the correct internal name.

- [ ] **Step 5: Test — mixed approve/reject responses**

Create `tests/agency/fork/fork-mixed-response.agency`:

```
def confirmItem(item: string): string {
  const response = interrupt("approve ${item}?")
  return "confirmed: ${item}"
}

node main() {
  let results = fork(["a", "b"]) as item {
    return confirmItem(item)
  }
  return results
}
```

Create `tests/agency/fork/fork-mixed-response.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "Fork with mixed responses — one approved, one rejected",
      "input": "",
      "expectedOutput": "the first item is confirmed and the second returns a failure",
      "evaluationCriteria": [{ "type": "llm" }],
      "interruptHandlers": [
        { "action": "approve" },
        { "action": "reject" }
      ]
    }
  ]
}
```

- [ ] **Step 6: Rebuild fixtures and run all fork tests**

Run: `make fixtures && pnpm test:run -- tests/agency/fork/`

- [ ] **Step 7: Run the full test suite**

Run: `pnpm test:run`

Fix any remaining failures.

- [ ] **Step 8: Commit**

```bash
git commit -m "test: add integration tests for fork parallel interrupts"
```

---

### Task 13: Update existing fork-interrupt test for new semantics

**Files:**
- Modify: `tests/agency/fork/fork-interrupt.test.json`

- [ ] **Step 1: Review the existing test**

The existing `fork-interrupt.test.json` has two `interruptHandlers` (approve, approve). With the new batch semantics, both interrupts from threads "a" and "b" will arrive in a single batch, so only one round of response is needed (with two responses). The test runner now handles batches — the first batch has 2 interrupts consuming 2 handlers.

Verify the test passes as-is. If it does, no change needed. If handler counts don't match, update accordingly.

- [ ] **Step 2: Run the test**

Run: `pnpm test:run -- tests/agency/fork/fork-interrupt`

- [ ] **Step 3: Fix if needed and commit**

```bash
git commit -m "test: update fork-interrupt test for batch interrupt semantics"
```

---

### Task 14: Final cleanup and full test run

- [ ] **Step 1: Search for any remaining references to removed functions**

Search for: `approveInterrupt`, `rejectInterrupt`, `modifyInterrupt`, `resolveInterrupt`, `respondToInterrupt` (singular), `isInterrupt(result.data)` (in non-internal code).

- [ ] **Step 2: Run full build**

Run: `make all`

- [ ] **Step 3: Run full test suite**

Run: `pnpm test:run`

- [ ] **Step 4: Fix any remaining failures**

- [ ] **Step 5: Final commit**

```bash
git commit -m "chore: final cleanup for fork parallel interrupts"
```
