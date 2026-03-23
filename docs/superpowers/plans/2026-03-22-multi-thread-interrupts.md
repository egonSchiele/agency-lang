# Multi-Thread Interrupts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow multiple concurrent async threads to each throw interrupts, queue them, and resume all threads with the caller's responses.

**Architecture:** Tree-shaped state stacks. Each async call creates a branch on the parent frame, keyed by step number. Interrupts are collected flat by `awaitAll`, returned as a batch with a shared checkpoint. On resume, re-execution from the root thread restores branches from the serialized tree. Interrupt responses are matched by `interrupt_id` (nanoid) at deserialization time.

**Tech Stack:** TypeScript, Vitest, nanoid

**Spec:** `docs/superpowers/specs/2026-03-22-multi-thread-interrupts-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `lib/runtime/state/stateStack.ts` | Modify | Add `branches` to `State`, `BranchState`/`BranchStateJSON` types, recursive `toJSON`/`fromJSON` |
| `lib/runtime/state/stateStack.test.ts` | Create | Unit tests for tree serialization/deserialization |
| `lib/runtime/state/context.ts` | Modify | Change `forkStack` to create empty `StateStack` |
| `lib/runtime/state/pendingPromiseStore.ts` | Modify | `awaitAll` returns `Interrupt[]` instead of throwing |
| `lib/runtime/state/pendingPromiseStore.test.ts` | Modify | Update tests for new `awaitAll` behavior |
| `lib/runtime/interrupts.ts` | Modify | Add `interrupt_id`, `InterruptBatch`, `respondToInterrupts`; remove old single-interrupt functions |
| `lib/runtime/node.ts` | Modify | `runNode` handles interrupt arrays, returns `InterruptBatch` |
| `lib/runtime/errors.ts` | Modify | Remove `ConcurrentInterruptError` |
| `lib/runtime/index.ts` | Modify | Update exports |
| `lib/backends/typescriptBuilder.ts` | Modify | Async calls attach branches, modified step guard |
| `lib/templates/backends/typescriptGenerator/imports.mustache` | Modify | Export `respondToInterrupts` instead of old functions |
| `tests/typescriptGenerator/multi-thread-interrupt.agency` | Create | Generator fixture for multi-thread interrupt codegen |
| `tests/agency-js/multi-thread-interrupt/` | Create | Integration test directory |

---

## Task 1: Add `branches` to `State` and update serialization

**Context:** The `State` type represents a single stack frame. We add a `branches` field that maps step numbers to child `StateStack`s (one per async call). The tricky part: `toJSON()` currently uses `deepClone` (`JSON.parse(JSON.stringify(...))`), which cannot serialize live `StateStack` instances. We need explicit recursive serialization.

**Files:**
- Modify: `lib/runtime/state/stateStack.ts`
- Create: `lib/runtime/state/stateStack.test.ts`

**Docs to read first:**
- `docs/superpowers/specs/2026-03-22-multi-thread-interrupts-design.md` — Section 1 (tree-shaped state) and Section 2 (serialization)
- `docs/dev/async.md` — background on forked stacks

- [ ] **Step 1: Write failing tests for branch serialization**

In `lib/runtime/state/stateStack.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { StateStack } from "./stateStack.js";

describe("StateStack branches", () => {
  it("toJSON serializes branches recursively", () => {
    const parent = new StateStack();
    const parentFrame = parent.getNewState();
    parentFrame.step = 2;

    // Create a child branch at step 0
    const child = new StateStack();
    const childFrame = child.getNewState();
    childFrame.step = 5;
    childFrame.locals = { x: 42 };

    parentFrame.branches = {
      0: { stack: child },
    };

    const json = parent.toJSON();
    // branches should be serialized as StateStackJSON, not live instances
    expect(json.stack[0].branches).toBeDefined();
    expect(json.stack[0].branches![0].stack.stack[0].step).toBe(5);
    expect(json.stack[0].branches![0].stack.stack[0].locals).toEqual({ x: 42 });
  });

  it("fromJSON deserializes branches into live StateStack instances", () => {
    const json = {
      stack: [{
        args: {}, locals: {}, threads: null, step: 2,
        branches: {
          0: {
            stack: {
              stack: [{ args: {}, locals: { x: 42 }, threads: null, step: 5 }],
              mode: "serialize" as const,
              other: {},
              deserializeStackLength: 0,
              nodesTraversed: [],
            },
          },
        },
      }],
      mode: "serialize" as const,
      other: {},
      deserializeStackLength: 0,
      nodesTraversed: [],
    };

    const restored = StateStack.fromJSON(json);
    const frame = restored.stack[0];
    expect(frame.branches).toBeDefined();
    // The branch stack should be a live StateStack instance
    expect(frame.branches![0].stack).toBeInstanceOf(StateStack);
    expect(frame.branches![0].stack.stack[0].locals).toEqual({ x: 42 });
  });

  it("round-trips nested branches", () => {
    // Parent -> child -> grandchild
    const grandchild = new StateStack();
    grandchild.getNewState().locals = { deep: true };

    const child = new StateStack();
    const childFrame = child.getNewState();
    childFrame.branches = { 1: { stack: grandchild } };

    const parent = new StateStack();
    const parentFrame = parent.getNewState();
    parentFrame.branches = { 0: { stack: child } };

    const json = parent.toJSON();
    const restored = StateStack.fromJSON(json);

    const restoredGrandchild = restored.stack[0].branches![0].stack.stack[0].branches![1].stack;
    expect(restoredGrandchild).toBeInstanceOf(StateStack);
    expect(restoredGrandchild.stack[0].locals).toEqual({ deep: true });
  });

  it("toJSON deep clones branches (no shared references)", () => {
    const child = new StateStack();
    child.getNewState().locals = { val: "original" };

    const parent = new StateStack();
    parent.getNewState().branches = { 0: { stack: child } };

    const json = parent.toJSON();
    // Mutate the live child
    child.stack[0].locals.val = "mutated";
    // Serialized version should still have the original
    expect(json.stack[0].branches![0].stack.stack[0].locals.val).toBe("original");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:run -- lib/runtime/state/stateStack.test.ts`
Expected: FAIL — `branches` doesn't exist on `State` type yet.

- [ ] **Step 3: Add types and update serialization**

In `lib/runtime/state/stateStack.ts`, add the `BranchState` and `BranchStateJSON` types and update `State`:

```typescript
// Add these types before the State type:

export type BranchState = {
  stack: StateStack;
  interrupt_id?: string;
  interruptData?: any;  // InterruptData — imported later to avoid circular deps
};

export type BranchStateJSON = {
  stack: StateStackJSON;
  interrupt_id?: string;
  interruptData?: any;
};

// Update State to add branches:
export type State = {
  args: Record<string, any>;
  locals: Record<string, any>;
  threads: ThreadStoreJSON | null;
  step: number;
  branches?: Record<number, BranchState>;
};
```

Update `toJSON()` to explicitly serialize branches instead of relying on `deepClone`:

```typescript
toJSON(): StateStackJSON {
  // Serialize branches explicitly — deepClone can't handle StateStack instances
  const serializedStack = this.stack.map(frame => {
    const serializedFrame: any = {
      args: deepClone(frame.args),
      locals: deepClone(frame.locals),
      threads: frame.threads ? deepClone(frame.threads) : null,
      step: frame.step,
    };
    if (frame.branches) {
      serializedFrame.branches = {};
      for (const [key, branch] of Object.entries(frame.branches)) {
        serializedFrame.branches[key] = {
          stack: branch.stack.toJSON(),
          ...(branch.interrupt_id ? { interrupt_id: branch.interrupt_id } : {}),
          ...(branch.interruptData ? { interruptData: deepClone(branch.interruptData) } : {}),
        };
      }
    }
    return serializedFrame;
  });

  return {
    stack: serializedStack,
    other: deepClone(this.other),
    mode: this.mode,
    deserializeStackLength: this.deserializeStackLength,
    nodesTraversed: [...this.nodesTraversed],
  };
}
```

Update `fromJSON()` to reconstruct live `StateStack` objects from branches:

```typescript
static fromJSON(json: StateStackJSON): StateStack {
  const stateStack = new StateStack([], "serialize");
  stateStack.stack = (json.stack || []).map(frame => {
    const restoredFrame: State = {
      args: frame.args,
      locals: frame.locals,
      threads: frame.threads,
      step: frame.step,
    };
    if (frame.branches) {
      restoredFrame.branches = {};
      for (const [key, branch] of Object.entries(frame.branches as Record<string, BranchStateJSON>)) {
        restoredFrame.branches[Number(key)] = {
          stack: StateStack.fromJSON(branch.stack),
          ...(branch.interrupt_id ? { interrupt_id: branch.interrupt_id } : {}),
          ...(branch.interruptData ? { interruptData: branch.interruptData } : {}),
        };
      }
    }
    return restoredFrame;
  });
  stateStack.nodesTraversed = json.nodesTraversed || [];
  stateStack.other = json.other || {};
  stateStack.mode = json.mode || "serialize";
  stateStack.deserializeStackLength = json.deserializeStackLength || 0;
  return stateStack;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:run -- lib/runtime/state/stateStack.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite to check for regressions**

Run: `pnpm test:run`
Expected: All existing tests pass.

- [ ] **Step 6: Commit**

```bash
git add lib/runtime/state/stateStack.ts lib/runtime/state/stateStack.test.ts
git commit -m "feat: add branches to State for tree-shaped state stacks"
```

---

## Task 2: Change `forkStack` to create an empty StateStack

**Context:** Currently `forkStack()` deep-clones the entire parent state stack. For the tree design, each branch should only contain its own frames. Change `forkStack` to return an empty `StateStack`.

**Files:**
- Modify: `lib/runtime/state/context.ts:95-97`

**Docs to read first:**
- `docs/superpowers/specs/2026-03-22-multi-thread-interrupts-design.md` — Section 2, `forkStack` changes paragraph

- [ ] **Step 1: Change `forkStack` to return an empty StateStack**

In `lib/runtime/state/context.ts`, replace the `forkStack` method:

```typescript
forkStack(): StateStack {
  return new StateStack();
}
```

- [ ] **Step 2: Run full test suite**

Run: `pnpm test:run`
Expected: All tests pass. The forked stack was already independent of the parent — the async function pushes its own frame via `setupFunction`. If any tests fail, they relied on the forked stack having parent frames, which needs investigation.

- [ ] **Step 3: Commit**

```bash
git add lib/runtime/state/context.ts
git commit -m "feat: forkStack creates empty StateStack for tree branches"
```

---

## Task 3: Update `awaitAll` to return interrupts instead of throwing

**Context:** `PendingPromiseStore.awaitAll()` currently throws `ConcurrentInterruptError` when it finds an interrupt. Change it to collect interrupts and return them as an array. Also remove `ConcurrentInterruptError`.

**Files:**
- Modify: `lib/runtime/state/pendingPromiseStore.ts`
- Modify: `lib/runtime/state/pendingPromiseStore.test.ts`
- Modify: `lib/runtime/errors.ts:27-32`

**Docs to read first:**
- `docs/superpowers/specs/2026-03-22-multi-thread-interrupts-design.md` — Section 4

- [ ] **Step 1: Update tests for new `awaitAll` behavior**

In `lib/runtime/state/pendingPromiseStore.test.ts`:

1. Remove the import of `ConcurrentInterruptError`
2. Replace the test "throws ConcurrentInterruptError when a promise returns an interrupt" with:

```typescript
it("returns interrupts from resolved promises", async () => {
  const store = new PendingPromiseStore();
  const interruptResult = { type: "interrupt", data: "test" };
  store.add(Promise.resolve(interruptResult));
  const interrupts = await store.awaitAll();
  expect(interrupts).toHaveLength(1);
  expect(interrupts[0]).toEqual(interruptResult);
});
```

3. Replace the test "calls setters for non-interrupt results added BEFORE the interrupt entry" with:

```typescript
it("calls setters for non-interrupt results and collects interrupts", async () => {
  const store = new PendingPromiseStore();
  const results: any[] = [];
  store.add(Promise.resolve("before"), (v) => results.push(v));
  const interruptResult = { type: "interrupt", data: "boom" };
  store.add(Promise.resolve(interruptResult));
  store.add(Promise.resolve("after"), (v) => results.push(v));
  const interrupts = await store.awaitAll();
  expect(results).toContain("before");
  expect(results).toContain("after");
  expect(interrupts).toHaveLength(1);
  expect(interrupts[0]).toEqual(interruptResult);
});
```

4. Add a test for multiple interrupts:

```typescript
it("collects multiple interrupts from different promises", async () => {
  const store = new PendingPromiseStore();
  store.add(Promise.resolve({ type: "interrupt", data: "int1" }));
  store.add(Promise.resolve("normal"));
  store.add(Promise.resolve({ type: "interrupt", data: "int2" }));
  const interrupts = await store.awaitAll();
  expect(interrupts).toHaveLength(2);
  expect(interrupts.map(i => i.data)).toContain("int1");
  expect(interrupts.map(i => i.data)).toContain("int2");
});
```

5. Update the "is a no-op when empty" test:

```typescript
it("returns empty array when empty", async () => {
  const store = new PendingPromiseStore();
  const interrupts = await store.awaitAll();
  expect(interrupts).toEqual([]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:run -- lib/runtime/state/pendingPromiseStore.test.ts`
Expected: FAIL — `awaitAll` still throws instead of returning.

- [ ] **Step 3: Update `awaitAll` implementation**

In `lib/runtime/state/pendingPromiseStore.ts`:

1. Remove the import of `ConcurrentInterruptError`
2. Change the `awaitAll` return type and implementation:

```typescript
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

You'll need to import the `Interrupt` type: `import { isInterrupt, Interrupt } from "../interrupts.js";`

- [ ] **Step 4: Remove `ConcurrentInterruptError` from `lib/runtime/errors.ts`**

Delete the `ConcurrentInterruptError` class (lines 27-32). Also remove its export from `lib/runtime/index.ts`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test:run -- lib/runtime/state/pendingPromiseStore.test.ts`
Expected: PASS

- [ ] **Step 6: Run full test suite**

Run: `pnpm test:run`
Expected: All tests pass. Some tests may import `ConcurrentInterruptError` — fix those by removing the import.

- [ ] **Step 7: Commit**

```bash
git add lib/runtime/state/pendingPromiseStore.ts lib/runtime/state/pendingPromiseStore.test.ts lib/runtime/errors.ts lib/runtime/index.ts
git commit -m "feat: awaitAll returns interrupts instead of throwing ConcurrentInterruptError"
```

---

## Task 4: Add `interrupt_id` and `InterruptBatch` types

**Context:** Each interrupt gets a nanoid for matching responses on resume. All interrupts from a single execution are returned as an `InterruptBatch` with a shared checkpoint.

**Files:**
- Modify: `lib/runtime/interrupts.ts`

**Docs to read first:**
- `docs/superpowers/specs/2026-03-22-multi-thread-interrupts-design.md` — Section 5

- [ ] **Step 1: Add `interrupt_id` to interrupt creation and add `InterruptBatch` type**

In `lib/runtime/interrupts.ts`:

1. Add nanoid import at the top:
```typescript
import { nanoid } from "nanoid";
```

2. Add `interrupt_id` to the `Interrupt` type:
```typescript
export type Interrupt<T = any> = {
  type: "interrupt";
  interrupt_id: string;
  data: T;
  interruptData?: InterruptData;
  checkpointId?: number;
  checkpoint?: Checkpoint;
  state?: InterruptState;
};
```

3. Update the `interrupt()` function to generate an ID:
```typescript
export function interrupt<T = any>(data: T): Interrupt<T> {
  return {
    type: "interrupt",
    interrupt_id: nanoid(),
    data,
  };
}
```

4. Add the `InterruptBatch` type:
```typescript
export type InterruptBatch = {
  type: "interrupt_batch";
  interrupts: Interrupt[];
  checkpoint: Checkpoint;
};

export function isInterruptBatch(obj: any): obj is InterruptBatch {
  return obj && obj.type === "interrupt_batch";
}
```

- [ ] **Step 2: Run full test suite**

Run: `pnpm test:run`
Expected: All tests pass. The `interrupt_id` field is additive — existing code doesn't check for it.

- [ ] **Step 3: Commit**

```bash
git add lib/runtime/interrupts.ts
git commit -m "feat: add interrupt_id (nanoid) and InterruptBatch type"
```

---

## Task 5: Update `runNode` to handle interrupt batches

**Context:** `runNode` currently calls `awaitAll()` and ignores the return value. Now `awaitAll` returns `Interrupt[]`. If non-empty, `runNode` must create a checkpoint and return an `InterruptBatch`.

**Files:**
- Modify: `lib/runtime/node.ts:113-133`

**Docs to read first:**
- `docs/superpowers/specs/2026-03-22-multi-thread-interrupts-design.md` — Section 4, `runNode` control flow

- [ ] **Step 1: Update `runNode` to check for interrupts from `awaitAll`**

In `lib/runtime/node.ts`, find the line `await execCtx.pendingPromises.awaitAll();` (line 122) and replace the block from there through `return returnObject` with:

```typescript
const interrupts = await execCtx.pendingPromises.awaitAll();
if (interrupts.length > 0) {
  const checkpoint = execCtx.checkpoints.create(execCtx);
  return {
    type: "interrupt_batch",
    interrupts,
    checkpoint,
  };
}
await execCtx.audit({ type: "nodeExit", nodeName });
const returnObject = createReturnObject({
  result,
  globals: execCtx.globals,
});
```

Import `InterruptBatch` from `./interrupts.js` if not already imported.

Note: the graph.run result may itself be an interrupt (from a sync interrupt in the main thread). That existing path should continue to work as before — only the `awaitAll` path changes.

- [ ] **Step 2: Run full test suite**

Run: `pnpm test:run`
Expected: All tests pass. The `awaitAll` return is now checked, but for non-interrupt cases it returns `[]` which is falsy for `.length > 0`.

- [ ] **Step 3: Commit**

```bash
git add lib/runtime/node.ts
git commit -m "feat: runNode returns InterruptBatch when awaitAll finds interrupts"
```

---

## Task 6: Add `respondToInterrupts`

**Context:** The new function replaces `respondToInterrupt` (singular). It takes a checkpoint and a map of `interrupt_id -> InterruptResponse`, restores state, injects responses, and re-executes. The old single-interrupt functions are removed.

**Files:**
- Modify: `lib/runtime/interrupts.ts`
- Modify: `lib/runtime/index.ts`

**Docs to read first:**
- `docs/superpowers/specs/2026-03-22-multi-thread-interrupts-design.md` — Section 6

- [ ] **Step 1: Add `respondToInterrupts` function**

In `lib/runtime/interrupts.ts`, add the new function. It follows the same pattern as the existing `respondToInterrupt` but takes a checkpoint + responses map instead of a single interrupt + response:

```typescript
export async function respondToInterrupts(args: {
  ctx: RuntimeContext<GraphState>;
  checkpoint: Checkpoint;
  responses: Record<string, InterruptResponse>;
  metadata?: Record<string, any>;
}): Promise<any> {
  const { ctx, metadata = {} } = args;
  const responses = deepClone(args.responses);

  const checkpoint = args.checkpoint;
  if (!checkpoint) {
    throw new Error("No checkpoint provided for respondToInterrupts.");
  }

  const execCtx = ctx.createExecutionContext();
  execCtx.restoreState(checkpoint);

  if (metadata.callbacks) {
    execCtx.callbacks = metadata.callbacks;
  }

  // Store responses on the execution context so deserialization can access them
  (execCtx as any).__interruptResponses = responses;

  let nodeName = checkpoint.nodeId;

  try {
    while (true) {
      try {
        const result = await execCtx.graph.run(nodeName, {
          messages: new ThreadStore(),
          data: {},
          ctx: execCtx,
          isResume: true,
        }, { onNodeEnter: (id) => execCtx.stateStack.nodesTraversed.push(id) });
        const interrupts = await execCtx.pendingPromises.awaitAll();
        if (interrupts.length > 0) {
          const cp = execCtx.checkpoints.create(execCtx);
          return {
            type: "interrupt_batch",
            interrupts,
            checkpoint: cp,
          };
        }
        return createReturnObject({ result, globals: execCtx.globals });
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

Note: the `(execCtx as any).__interruptResponses = responses` is a temporary way to thread the responses through to deserialization. The exact mechanism for how responses reach the interrupt points during deserialization will be refined in Task 8 (builder changes) when we know more about how the generated code accesses them.

- [ ] **Step 2: Remove old single-interrupt functions**

Remove `respondToInterrupt`, `approveInterrupt`, `rejectInterrupt`, `modifyInterrupt`, `resolveInterrupt` from `lib/runtime/interrupts.ts`.

Keep `resumeFromState` for now (it serves a different purpose).

- [ ] **Step 3: Update exports in `lib/runtime/index.ts`**

Replace the old interrupt exports with the new ones:

```typescript
export {
  interrupt,
  isInterrupt,
  isInterruptBatch,
  respondToInterrupts,
  resumeFromState,
} from "./interrupts.js";
```

Also export the new types: `InterruptBatch`.

- [ ] **Step 4: Fix compilation errors**

Run `pnpm run build` and fix any references to the removed functions. Callers in the codebase that used `respondToInterrupt` or `approveInterrupt` need to be updated. Check:
- `lib/runtime/node.ts`
- `lib/cli/` files
- Test files

- [ ] **Step 5: Run full test suite**

Run: `pnpm test:run`
Expected: Some tests will fail because they use old interrupt functions. Fix them. Integration tests in `tests/agency-js/` that use `approveInterrupt` etc. will need updating.

- [ ] **Step 6: Commit**

```bash
git add lib/runtime/interrupts.ts lib/runtime/index.ts
# Also add any files fixed in step 4-5
git commit -m "feat: add respondToInterrupts, remove old single-interrupt functions"
```

---

## Task 7: Update import template for compiled modules

**Context:** Compiled Agency modules export convenience wrappers for interrupt functions. Update the template to export `respondToInterrupts` instead of the old functions.

**Files:**
- Modify: `lib/templates/backends/typescriptGenerator/imports.mustache`

**Docs to read first:**
- `docs/superpowers/specs/2026-03-22-multi-thread-interrupts-design.md` — Section 6, convenience wrapper

- [ ] **Step 1: Update the mustache template**

In `lib/templates/backends/typescriptGenerator/imports.mustache`:

1. Replace the old import aliases (lines 14-18, the `respondToInterrupt as _respondToInterrupt`, etc.) with:
```
respondToInterrupts as _respondToInterrupts,
isInterruptBatch,
```

2. Replace the old re-exports (lines 90-94) with:
```typescript
export { interrupt, isInterrupt, isInterruptBatch };
export const respondToInterrupts = (
  checkpoint: Checkpoint,
  responses: Record<string, InterruptResponse>,
  metadata?: Record<string, any>
) => _respondToInterrupts({ ctx: __globalCtx, checkpoint, responses, metadata });
```

Make sure `Checkpoint` and `InterruptResponse` types are imported.

- [ ] **Step 2: Recompile templates**

Run: `pnpm run templates`

- [ ] **Step 3: Rebuild and run tests**

Run: `make all && pnpm test:run`
Expected: Generator fixture tests will fail because the expected `.mjs` files still have old imports.

- [ ] **Step 4: Regenerate fixtures**

Run: `make fixtures`
Then inspect the changed `.mjs` files to verify the new import/export pattern looks correct.

- [ ] **Step 5: Run full test suite**

Run: `pnpm test:run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/templates/backends/typescriptGenerator/imports.mustache
# Add regenerated template .ts file and fixture .mjs files
git add lib/templates/backends/typescriptGenerator/imports.ts
git add tests/typescriptGenerator/*.mjs
git commit -m "feat: update import template to export respondToInterrupts"
```

---

## Task 8: Update builder to generate branch-aware async calls

**Context:** The builder generates code for async function calls. Currently it calls `__ctx.forkStack()` and registers with `pendingPromises.add()`. Now it must also: (1) store the forked stack on `__stack.branches`, (2) check for saved branches during deserialization, (3) use a modified step guard.

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts:1086-1094` (unassigned async calls)
- Modify: `lib/backends/typescriptBuilder.ts:1470-1488` (assigned async calls)

**Docs to read first:**
- `docs/superpowers/specs/2026-03-22-multi-thread-interrupts-design.md` — Sections 2, 3

- [ ] **Step 1: Update unassigned async agency function calls**

In `lib/backends/typescriptBuilder.ts`, find the block at lines 1086-1091 that handles unassigned async calls to agency functions. Replace it so the generated code:
1. Checks for a saved branch
2. Creates or restores the forked stack
3. Stores the branch on the frame
4. Registers with pendingPromises

The generated code should look approximately like:

```typescript
let __forked;
if (__stack.branches && __stack.branches[__stack.step]) {
  __forked = __stack.branches[__stack.step].stack;
  __forked.deserializeMode();
} else {
  __forked = __ctx.forkStack();
}
__stack.branches = __stack.branches || {};
__stack.branches[__stack.step] = { stack: __forked };
__ctx.pendingPromises.add(funcName({ ctx: __ctx, stateStack: __forked, ... }));
```

Also update the step guard for this statement. Currently async calls use `if (__step <= N)`. Change to: `if (__step <= N || (__stack.branches && __stack.branches[N]))` where N is the step number.

- [ ] **Step 2: Update assigned async agency function calls**

Find the block at lines 1470-1488. Apply the same pattern: check for saved branch, create or restore forked stack, store on frame.

For assigned calls, the pending promise store also tracks a setter for the variable. This should continue to work as before.

- [ ] **Step 3: Rebuild and run tests**

Run: `make all && pnpm test:run`
Expected: Some fixture tests will fail because generated code has changed.

- [ ] **Step 4: Regenerate fixtures**

Run: `make fixtures`
Inspect changed `.mjs` files to verify the new branch-aware code looks correct.

- [ ] **Step 5: Run full test suite**

Run: `pnpm test:run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/backends/typescriptBuilder.ts
git add tests/typescriptGenerator/*.mjs
git commit -m "feat: builder generates branch-aware async calls with deserialization support"
```

---

## Task 9: Add generator fixture for multi-thread interrupt codegen

**Context:** A generator fixture (`.agency` + `.mjs` pair) that verifies the builder produces correct code for the multi-thread interrupt pattern.

**Files:**
- Create: `tests/typescriptGenerator/multi-thread-interrupt.agency`

**Docs to read first:**
- `docs/TESTING.md` — Section 2, TypeScript Generator Fixtures

- [ ] **Step 1: Create the fixture `.agency` file**

Create `tests/typescriptGenerator/multi-thread-interrupt.agency`:

```agency
def a() {
  response = interrupt("approve a?")
}

def b() {
  response = interrupt("approve b?")
}

node main() {
  async a()
  async b()
}
```

- [ ] **Step 2: Generate the fixture**

Run: `make fixtures`

- [ ] **Step 3: Inspect the generated `.mjs` file**

Read `tests/typescriptGenerator/multi-thread-interrupt.mjs` and verify:
- The async calls use the branch-aware pattern (check for saved branch, create/restore forked stack, store on frame)
- The step guard includes the branch check: `if (__step <= N || (__stack.branches && __stack.branches[N]))`

- [ ] **Step 4: Run test suite**

Run: `pnpm test:run`
Expected: PASS — the fixture matches the generated output.

- [ ] **Step 5: Commit**

```bash
git add tests/typescriptGenerator/multi-thread-interrupt.agency tests/typescriptGenerator/multi-thread-interrupt.mjs
git commit -m "test: add generator fixture for multi-thread interrupt codegen"
```

---

## Task 10: Add integration test for multi-thread interrupts

**Context:** An end-to-end test using the `agency-js` pattern. Two async functions each trigger an interrupt. The test verifies both interrupts are returned, responds to both, and checks the final result.

**Files:**
- Create: `tests/agency-js/multi-thread-interrupt/agent.agency`
- Create: `tests/agency-js/multi-thread-interrupt/test.js`

**Docs to read first:**
- `docs/TESTING.md` — Section 5, Multi-Step TypeScript Tests
- `tests/agency-js/concurrent-interrupt-isolation/` — example to follow

- [ ] **Step 1: Create the agent file**

Create `tests/agency-js/multi-thread-interrupt/agent.agency`:

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

- [ ] **Step 2: Create the test file**

Create `tests/agency-js/multi-thread-interrupt/test.js`:

```javascript
import { main, isInterruptBatch, respondToInterrupts } from "./agent.js";
import { writeFileSync } from "fs";

// Run the agent — should get an interrupt batch with 2 interrupts
const result = await main();

if (!isInterruptBatch(result.data)) {
  throw new Error("Expected InterruptBatch, got: " + JSON.stringify(result.data));
}

const batch = result.data;
if (batch.interrupts.length !== 2) {
  throw new Error("Expected 2 interrupts, got " + batch.interrupts.length);
}

// Build responses — approve both
const responses = {};
for (const interrupt of batch.interrupts) {
  responses[interrupt.interrupt_id] = { type: "approve" };
}

// Resume with all responses
const finalResult = await respondToInterrupts(batch.checkpoint, responses);

writeFileSync(
  "__result.json",
  JSON.stringify(finalResult.data, null, 2),
);
```

- [ ] **Step 3: Run the test to generate the fixture**

Run: `pnpm run agency test --js tests/agency-js/multi-thread-interrupt --gen-fixtures`

Verify the generated `fixture.json` contains `{ "x": "a done", "y": "b done" }`.

- [ ] **Step 4: Run the test**

Run: `pnpm run agency test --js tests/agency-js/multi-thread-interrupt`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/agency-js/multi-thread-interrupt/
git commit -m "test: add integration test for multi-thread interrupts"
```

---

## Task 11: Add integration test for nested async interrupts

**Context:** The full running example from the spec: nested async calls with interrupts at different levels.

**Files:**
- Create: `tests/agency-js/nested-async-interrupt/agent.agency`
- Create: `tests/agency-js/nested-async-interrupt/test.js`

- [ ] **Step 1: Create the agent file**

Create `tests/agency-js/nested-async-interrupt/agent.agency`:

```agency
results = []

def a1() {
  results.push("a1 done")
}

def a2(): string {
  age = interrupt("How old are you?")
  return age
}

def a(): string {
  async a1()
  x = async a2()
  return x
}

def b(): string {
  response = interrupt("What's your name?")
  return response
}

def foo() {
  x = async a()
  y = async b()
  return { a_result: x, b_result: y, results: results }
}

node main() {
  return foo()
}
```

- [ ] **Step 2: Create the test file**

Create `tests/agency-js/nested-async-interrupt/test.js`:

```javascript
import { main, isInterruptBatch, respondToInterrupts } from "./agent.js";
import { writeFileSync } from "fs";

const result = await main();

if (!isInterruptBatch(result.data)) {
  throw new Error("Expected InterruptBatch, got: " + JSON.stringify(result.data));
}

const batch = result.data;
if (batch.interrupts.length !== 2) {
  throw new Error("Expected 2 interrupts, got " + batch.interrupts.length);
}

// Find the interrupts by their data
const ageInterrupt = batch.interrupts.find(i => i.data === "How old are you?");
const nameInterrupt = batch.interrupts.find(i => i.data === "What's your name?");

if (!ageInterrupt || !nameInterrupt) {
  throw new Error("Could not find expected interrupts");
}

// Resolve both with values
const responses = {
  [ageInterrupt.interrupt_id]: { type: "resolve", value: "25" },
  [nameInterrupt.interrupt_id]: { type: "resolve", value: "Alice" },
};

const finalResult = await respondToInterrupts(batch.checkpoint, responses);

writeFileSync(
  "__result.json",
  JSON.stringify(finalResult.data, null, 2),
);
```

- [ ] **Step 3: Run the test to generate fixture**

Run: `pnpm run agency test --js tests/agency-js/nested-async-interrupt --gen-fixtures`

Expected fixture: `{ "a_result": "25", "b_result": "Alice", "results": ["a1 done"] }`

- [ ] **Step 4: Run the test**

Run: `pnpm run agency test --js tests/agency-js/nested-async-interrupt`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/agency-js/nested-async-interrupt/
git commit -m "test: add integration test for nested async interrupts"
```

---

## Task 12: Update existing tests that use old interrupt API

**Context:** Several existing integration tests use `approveInterrupt`, `respondToInterrupt`, etc. These were removed in Task 6. Update them to use the new `respondToInterrupts` API.

**Files:**
- Modify: Various files in `tests/agency-js/` that import old interrupt functions

- [ ] **Step 1: Find all files using old interrupt functions**

Run: `grep -rl "approveInterrupt\|rejectInterrupt\|modifyInterrupt\|resolveInterrupt\|respondToInterrupt[^s]" tests/`

- [ ] **Step 2: Update each test file**

For each file found, update to use the new API pattern:

Old:
```javascript
const result = await foo();
await approveInterrupt(result.data);
```

New:
```javascript
const result = await foo();
const batch = result.data; // or wrap single interrupt into batch
const responses = { [batch.interrupts[0].interrupt_id]: { type: "approve" } };
await respondToInterrupts(batch.checkpoint, responses);
```

Note: if the result is a single interrupt (from a sync path, not async), it may still be returned as an `InterruptBatch` with one entry. The test code should handle this uniformly.

- [ ] **Step 3: Run all integration tests**

Run: `pnpm run agency test --js tests/agency-js`
Expected: PASS

- [ ] **Step 4: Run full test suite**

Run: `pnpm test:run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/
git commit -m "test: update existing tests to use new respondToInterrupts API"
```

---

## Task 13: Final verification

- [ ] **Step 1: Full build**

Run: `make all`
Expected: Clean build, no errors.

- [ ] **Step 2: Full test suite**

Run: `pnpm test:run`
Expected: All tests pass.

- [ ] **Step 3: Run integration tests**

Run: `pnpm run agency test --js tests/agency-js`
Expected: All tests pass.

- [ ] **Step 4: Final commit if any loose changes**

```bash
git status
# If there are changes, commit them
```
