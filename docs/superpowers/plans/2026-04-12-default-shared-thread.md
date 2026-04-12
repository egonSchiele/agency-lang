# Default Shared Message Thread Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all LLM calls share a common message history by default, as if the entire graph execution were wrapped in a `thread { }` block.

**Architecture:** Persist a single `ThreadStore` with a pre-pushed active thread across all node transitions. Change the builder to always use `getOrCreateActive()` for prompts and always pass the caller's `ThreadStore` to functions. Make `GraphState.messages` optional so interrupt resume paths don't need a throwaway ThreadStore.

**Tech Stack:** TypeScript, vitest

**Spec:** `docs/superpowers/specs/2026-04-12-default-shared-thread-design.md`

---

### Task 1: Make `GraphState.messages` optional

**Files:**
- Modify: `lib/runtime/types.ts:8-14`

- [ ] **Step 1: Update the type**

Change `messages: ThreadStore` to `messages?: ThreadStore` in `GraphState`:

```ts
export type GraphState = {
  messages?: ThreadStore;
  data: any;
  ctx: RuntimeContext<GraphState>;
  isResume?: boolean;
  interruptData?: InterruptData;
};
```

- [ ] **Step 2: Build to check for type errors**

Run: `pnpm run build`
Expected: Should compile. If there are errors from code that assumes `messages` is always present, note them — they'll be fixed in later tasks.

- [ ] **Step 3: Commit**

```bash
git add lib/runtime/types.ts
git commit -m "make GraphState.messages optional"
```

---

### Task 2: Update `setupNode()` to use carried ThreadStore

**Files:**
- Modify: `lib/runtime/node.ts:12-41`

- [ ] **Step 1: Write a test for setupNode using a carried ThreadStore**

Create or find an appropriate test file. The key behavior: when `stack.threads` is null and `state.messages` is a ThreadStore, `setupNode` should use `state.messages` instead of creating a new one.

Look at existing tests in `tests/` for `setupNode` usage patterns. If no unit test file exists, add a test in a new file `lib/runtime/__tests__/node.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { setupNode } from "../node.js";
import { ThreadStore } from "../state/threadStore.js";
import { StateStack } from "../state/stateStack.js";
import { RuntimeContext } from "../state/context.js";

describe("setupNode", () => {
  it("uses state.messages ThreadStore when stack.threads is null", () => {
    const threadStore = new ThreadStore();
    threadStore.getOrCreateActive(); // pre-push active thread
    const ctx = { stateStack: new StateStack() } as any;
    const state = { messages: threadStore, ctx, data: {} } as any;

    const result = setupNode({ state });

    // Should use the passed-in ThreadStore, not create a new one
    expect(result.threads).toBe(threadStore);
    expect(result.threads.activeId()).toBeDefined();
  });

  it("restores from stack.threads when resuming from interrupt", () => {
    const threadStore = new ThreadStore();
    threadStore.getOrCreateActive();
    const stateStack = new StateStack();
    const stack = stateStack.getNewState();
    stack.threads = threadStore.toJSON();

    const ctx = { stateStack } as any;
    const state = { messages: new ThreadStore(), ctx, data: {} } as any;

    const result = setupNode({ state });

    // Should restore from stack.threads, not use state.messages
    expect(result.threads).not.toBe(state.messages);
    expect(result.threads.activeId()).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run lib/runtime/__tests__/node.test.ts`
Expected: FAIL — current code creates `new ThreadStore()` instead of using `state.messages`.

- [ ] **Step 3: Implement the change**

In `lib/runtime/node.ts`, update `setupNode()` (lines 34-38):

```ts
// Before:
const threads = stack.threads
  ? ThreadStore.fromJSON(stack.threads)
  : new ThreadStore();
stack.threads = threads;

// After:
let threads: ThreadStore;
if (stack.threads) {
  threads = ThreadStore.fromJSON(stack.threads);
} else if (state.messages instanceof ThreadStore) {
  threads = state.messages;
} else {
  throw new Error("setupNode: no ThreadStore available. Expected state.messages to be a ThreadStore.");
}
stack.threads = threads;
```

The error should never be hit in practice (the first node always receives a ThreadStore from `runNode()`), but throwing makes bugs visible rather than silently creating an empty thread.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run lib/runtime/__tests__/node.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/node.ts lib/runtime/__tests__/node.test.ts
git commit -m "setupNode: use carried ThreadStore from state.messages"
```

---

### Task 3: Update `runNode()` to create ThreadStore with pre-pushed active thread and handle RestoreSignal

**Files:**
- Modify: `lib/runtime/node.ts:74-162`

- [ ] **Step 1: Update runNode()**

In `runNode()`, move the ThreadStore creation outside the `while(true)` loop and pre-push an active thread. Also reset it on `RestoreSignal`:

```ts
// Before (lines 111-154):
let isResume = false;
try {
  while (true) {
    try {
      const threadStore = new ThreadStore();
      const result = await execCtx.graph.run(nodeName, {
        messages: threadStore,
        // ...
      }, ...);
      // ...
    } catch (e) {
      if (e instanceof RestoreSignal) {
        // ... restore logic ...
        continue;
      }
      throw e;
    }
  }
}

// After:
let isResume = false;
let threadStore = new ThreadStore();
threadStore.getOrCreateActive();
try {
  while (true) {
    try {
      const result = await execCtx.graph.run(nodeName, {
        messages: threadStore,
        // ...
      }, ...);
      // ...
    } catch (e) {
      if (e instanceof RestoreSignal) {
        // ... existing restore logic ...
        // Reset ThreadStore for the restored execution
        threadStore = new ThreadStore();
        threadStore.getOrCreateActive();
        continue;
      }
      throw e;
    }
  }
}
```

- [ ] **Step 2: Run existing tests**

Run: `pnpm vitest run`
Expected: Some tests may fail due to fixture mismatches (generated code will change). Note failures but don't fix yet — fixtures will be regenerated in Task 8.

- [ ] **Step 3: Commit**

```bash
git add lib/runtime/node.ts
git commit -m "runNode: pre-push active thread, handle RestoreSignal"
```

---

### Task 4: Remove throwaway ThreadStore from interrupt resume paths

**Files:**
- Modify: `lib/runtime/interrupts.ts:227-239` (respondToInterrupt)
- Modify: `lib/runtime/interrupts.ts:372-383` (resumeFromState)

- [ ] **Step 1: Update respondToInterrupt()**

Remove `messages: new ThreadStore()` from the graph.run call (lines 227-239):

```ts
// Before:
const result = await execCtx.graph.run(
  nodeName,
  {
    messages: new ThreadStore(),
    data: {},
    ctx: execCtx,
    isResume: true,
    interruptData,
  },
  { onNodeEnter: (id) => execCtx.stateStack.nodesTraversed.push(id) },
);

// After:
const result = await execCtx.graph.run(
  nodeName,
  {
    data: {},
    ctx: execCtx,
    isResume: true,
    interruptData,
  },
  { onNodeEnter: (id) => execCtx.stateStack.nodesTraversed.push(id) },
);
```

- [ ] **Step 2: Update resumeFromState()**

Same change for the graph.run call (lines 372-383):

```ts
// Before:
const result = await execCtx.graph.run(
  nodeName,
  {
    messages: new ThreadStore(),
    ctx: execCtx,
    isResume: true,
    data: {},
  },
  { onNodeEnter: (id) => execCtx.stateStack.nodesTraversed.push(id) },
);

// After:
const result = await execCtx.graph.run(
  nodeName,
  {
    ctx: execCtx,
    isResume: true,
    data: {},
  },
  { onNodeEnter: (id) => execCtx.stateStack.nodesTraversed.push(id) },
);
```

- [ ] **Step 3: Build to check for type errors**

Run: `pnpm run build`
Expected: Should compile since `messages` is now optional on `GraphState`.

- [ ] **Step 4: Commit**

```bash
git add lib/runtime/interrupts.ts
git commit -m "remove throwaway ThreadStore from interrupt resume paths"
```

---

### Task 5: Builder — always use `getOrCreateActive()` for prompts

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts:2025-2032`

- [ ] **Step 1: Update prompt thread expression**

Change lines 2025-2032:

```ts
// Before:
let threadExpr: TsNode;
const isInFunction = this.getCurrentScope().type === "function";
if (this.insideMessageThread || isInFunction) {
  threadExpr = ts.threads.getOrCreateActive();
} else {
  threadExpr = ts.threads.createAndReturnThread();
}

// After:
const threadExpr = ts.threads.getOrCreateActive();
```

- [ ] **Step 2: Build**

Run: `pnpm run build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add lib/backends/typescriptBuilder.ts
git commit -m "builder: always use getOrCreateActive for prompts"
```

---

### Task 6: Builder — always pass caller's ThreadStore to functions and pipes

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts:1500-1514` (function calls)
- Modify: `lib/backends/typescriptBuilder.ts:2457-2467` (pipe state args)

- [ ] **Step 1: Update function call threads**

Change lines 1503-1505:

```ts
// Before:
const threadsExpr = this.insideMessageThread
  ? ts.runtime.threads
  : ts.newThreadStore();

// After:
const threadsExpr = ts.runtime.threads;
```

- [ ] **Step 2: Update pipe state args**

Change lines 2459-2461 in `buildPipeStateArgs`:

```ts
// Before:
const threadsExpr = this.insideMessageThread
  ? ts.runtime.threads
  : ts.newThreadStore();

// After:
const threadsExpr = ts.runtime.threads;
```

- [ ] **Step 3: Build**

Run: `pnpm run build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add lib/backends/typescriptBuilder.ts
git commit -m "builder: always pass caller ThreadStore to functions and pipes"
```

---

### Task 7: Builder — GoToNode, handler, CLI initialState, and cleanup

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts:1608-1612` (GoToNode)
- Modify: `lib/backends/typescriptBuilder.ts:2333-2335` (handler function refs)
- Modify: `lib/backends/typescriptBuilder.ts:2729-2735` (CLI initialState)

- [ ] **Step 1: Fix GoToNode to pass actual ThreadStore**

Change lines 1608-1612:

```ts
// Before:
const goToArgs = ts.obj({
  messages: ts.stack("messages"),
  ctx: ts.runtime.ctx,
  data: dataNode,
});

// After:
const goToArgs = ts.obj({
  messages: ts.runtime.threads,
  ctx: ts.runtime.ctx,
  data: dataNode,
});
```

- [ ] **Step 2: Update handler function refs to share thread**

Change line 2335:

```ts
// Before:
threads: ts.newThreadStore(),

// After:
threads: ts.runtime.threads,
```

- [ ] **Step 3: Verify CLI initialState**

Check the CLI entry point at line 2729-2735. It currently creates `messages: ts.newThreadStore()`. Since `setupNode()` will use this ThreadStore via `state.messages`, it will work — `setupNode` will use it directly. However, if the generated code for the CLI entry point calls `setupNode` differently (e.g., the main node is called directly without going through `runNode()`), the ThreadStore may need a pre-pushed active thread here too.

Check by reading the generated output for a simple `.agency` file with an LLM call. If the CLI path goes through `setupNode`, the ThreadStore will get used as-is. If not, consider adding `getOrCreateActive()` to the generated initialState.

- [ ] **Step 4: Clean up `insideMessageThread` usage**

The `insideMessageThread` flag is no longer used for thread expression decisions (Tasks 5-7 removed all conditional branches that depended on it). However, it is still set in `processMessageThread()` (lines 2181-2184) for body processing. Check whether any remaining code reads `insideMessageThread`. If the only remaining uses are the set/restore in `processMessageThread`, and nothing else reads it, remove the flag entirely. If something still reads it, leave it but add a comment noting the reduced scope.

- [ ] **Step 5: Build**

Run: `pnpm run build`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/backends/typescriptBuilder.ts
git commit -m "builder: GoToNode passes ThreadStore, handlers share thread, cleanup"
```

---

### Task 8: Regenerate all test fixtures

**Files:**
- Modify: All `.mjs` files in `tests/typescriptGenerator/` and `tests/typescriptBuilder/`

- [ ] **Step 1: Regenerate fixtures**

Run: `make fixtures`
Expected: Many fixture files will be updated — `createAndReturnThread()` calls become `getOrCreateActive()`, `new ThreadStore()` calls in function configs become `__threads`, etc.

- [ ] **Step 2: Review the diff**

Run: `git diff` and review the changes. Check that:
- Prompts now use `__threads.getOrCreateActive()` instead of `__threads.createAndReturnThread()`
- Internal function calls pass `__threads` instead of `new ThreadStore()`
- GoToNode calls pass `__threads` instead of `__stack.messages`
- Handler function refs pass `__threads` instead of `new ThreadStore()`
- Tool-invoked function calls in `lib/runtime/prompt.ts` are NOT changed (still `new ThreadStore()`)

- [ ] **Step 3: Run all tests**

Run: `pnpm vitest run`
Expected: All fixture-comparison tests should PASS now that fixtures match the new generated output.

- [ ] **Step 4: Commit**

```bash
git add tests/
git commit -m "regenerate test fixtures for default shared thread"
```

---

### Task 9: Review and fix agency execution tests

**Files:**
- Review: `tests/agency/` — all test files
- Possibly modify: tests that depend on LLM call isolation

- [ ] **Step 1: Run agency execution tests**

Run: `pnpm vitest run tests/agency/`
Expected: Most should pass. Note any failures.

- [ ] **Step 2: Review thread-specific tests**

Run: `pnpm vitest run tests/agency/threads/`
Expected: PASS — `thread { }` and `subthread { }` still create nested threads on the active stack.

- [ ] **Step 3: Fix any failing tests**

If tests fail because they depended on LLM call isolation:
- If the test expects isolated calls, wrap the relevant calls in `thread { }` blocks
- If the test expectations just need updating (e.g., message counts), update them

- [ ] **Step 4: Run full test suite**

Run: `pnpm vitest run`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add tests/
git commit -m "fix agency tests for default shared thread behavior"
```

---

### Task 10: Add new tests for default shared thread behavior

**Files:**
- Create: `tests/agency/threads/default-shared-thread.agency`
- Create: `tests/agency/threads/default-shared-thread.test.json`
- Create: `tests/agency/threads/default-shared-cross-node.agency`
- Create: `tests/agency/threads/default-shared-cross-node.test.json`

- [ ] **Step 1: Create test for default shared thread within a single node**

This tests the core new behavior: multiple LLM calls in a single node share message history by default (no `thread { }` needed).

`tests/agency/threads/default-shared-thread.agency`:
```
node main() {
  const res1: number[] = llm("What are the first 5 prime numbers?")
  const res2: number = llm("And what is the sum of those numbers?")
  return {
    res1: res1,
    res2: res2
  }
}
```

`tests/agency/threads/default-shared-thread.test.json`:
```json
{
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "{\"res1\":[2,3,5,7,11],\"res2\":28}",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "LLM calls share history by default — res2 should know about res1"
    }
  ]
}
```

Note: This is the same code as the existing `simple.agency` test but WITHOUT the `thread { }` wrapper. It should produce the same result now that sharing is the default.

- [ ] **Step 2: Create test for cross-node thread persistence**

This tests that message history persists when transitioning between nodes.

`tests/agency/threads/default-shared-cross-node.agency`:
```
node setup() {
  const res1: number[] = llm("What are the first 5 prime numbers?")
  return process(res1)
}

node process(nums: number[]) {
  const res2: number = llm("And what is the sum of those numbers?")
  return {
    nums: nums,
    sum: res2
  }
}

node main() {
  return setup()
}
```

`tests/agency/threads/default-shared-cross-node.test.json`:
```json
{
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "{\"nums\":[2,3,5,7,11],\"sum\":28}",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "Message history persists across node transitions — process node sees setup node history"
    }
  ]
}
```

- [ ] **Step 3: Run the new tests**

Run: `pnpm run agency test tests/agency/threads/default-shared-thread.test.json`
Run: `pnpm run agency test tests/agency/threads/default-shared-cross-node.test.json`
Expected: PASS for both.

- [ ] **Step 4: Verify existing thread isolation test still works**

Run: `pnpm run agency test tests/agency/threads/simple.test.json`
Run: `pnpm run agency test tests/agency/threads/nested-threads.test.json`
Run: `pnpm run agency test tests/agency/threads/subthreads.test.json`
Expected: PASS — explicit `thread { }` and `subthread { }` still work as before.

- [ ] **Step 5: Commit**

```bash
git add tests/agency/threads/default-shared-thread.agency tests/agency/threads/default-shared-thread.test.json tests/agency/threads/default-shared-cross-node.agency tests/agency/threads/default-shared-cross-node.test.json
git commit -m "add tests for default shared thread behavior"
```

---

### Task 11: Async prompts — fork via subthread (nice-to-have)

Skip this task if it adds significant complexity. Instead, add a note to `docs/dev/async.md`.

**Files:**
- Modify: `lib/runtime/state/threadStore.ts`
- Modify: `lib/backends/typescriptBuilder.ts` (async prompt thread expression)

- [ ] **Step 1: Add `createAndReturnSubthread()` to ThreadStore**

In `lib/runtime/state/threadStore.ts`, add after `createSubthread()` (line 40):

```ts
createAndReturnSubthread(): MessageThread {
  const id = this.createSubthread();
  return this.get(id);
}
```

- [ ] **Step 2: Update async prompt thread expression in builder**

In `lib/backends/typescriptBuilder.ts`, find where async prompts get their thread expression. Currently async prompts go through the same `threadExpr` logic and then are used without await. After the `threadExpr` assignment (now just `ts.threads.getOrCreateActive()`), add a check: if `node.async`, override to use `ts.threads.createAndReturnSubthread()`.

Look at `processPrompt` — the thread expression is set before the async check at line 2088. Add after the thread expression block:

```ts
// For async prompts, fork the current thread so they get context
// but don't write back to the shared thread
if (node.async) {
  threadExpr = ts.threads.createAndReturnSubthread();
}
```

Note: You'll also need to add `createAndReturnSubthread()` to the `ts.threads` builder helpers in `lib/ir/builders.ts`.

- [ ] **Step 3: If this is too complex, skip and document**

Add a note to `docs/dev/async.md`:

```
## TODO: Async prompts should fork the shared thread

With the default shared thread change, async prompts currently use
`getOrCreateActive()` which gives them a reference to the shared mutable
thread. This is not safe for concurrent use. Async prompts should instead
fork via `createAndReturnSubthread()` so they get a snapshot of the current
history without writing back to it.
```

- [ ] **Step 4: Regenerate fixtures if changes were made**

Run: `make fixtures`

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "async prompts: fork shared thread via createAndReturnSubthread"
```
