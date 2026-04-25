# Runtime Promise Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix crashes from unassigned async function calls and ensure all async promises resolve before interrupt state serialization, by centralizing promise tracking in a new `PendingPromiseStore` runtime class.

**Architecture:** A new `PendingPromiseStore` class on `RuntimeContext` tracks all async promises with unique counter-based keys. The builder generates `add()` calls at async call sites and `awaitAll()` at node exit / before interrupt returns. The preprocessor switches from inline `Promise.all` to `awaitPending()` calls.

**Tech Stack:** TypeScript, vitest (unit tests), Agency test fixtures (integration tests)

**Key docs:**
- Spec: `docs/superpowers/specs/2026-03-20-runtime-promise-tracking-design.md`
- Dev doc: `docs/dev/async.md`
- Testing guide: `docs/TESTING.md`

---

### Task 1: Create PendingPromiseStore class

**Files:**
- Create: `lib/runtime/state/pendingPromiseStore.ts`
- Create: `lib/runtime/state/pendingPromiseStore.test.ts`

- [ ] **Step 1: Write failing tests for PendingPromiseStore**

Create `lib/runtime/state/pendingPromiseStore.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { PendingPromiseStore } from "./pendingPromiseStore.js";

describe("PendingPromiseStore", () => {
  it("add() returns a unique key", () => {
    const store = new PendingPromiseStore();
    const key1 = store.add(Promise.resolve(1));
    const key2 = store.add(Promise.resolve(2));
    expect(key1).not.toBe(key2);
    expect(typeof key1).toBe("string");
  });

  it("awaitPending() resolves specific promises and calls setters", async () => {
    const store = new PendingPromiseStore();
    let captured = 0;
    const key = store.add(Promise.resolve(42), (val) => { captured = val; });
    await store.awaitPending([key]);
    expect(captured).toBe(42);
  });

  it("awaitPending() removes awaited entries from the store", async () => {
    const store = new PendingPromiseStore();
    const key = store.add(Promise.resolve(1));
    await store.awaitPending([key]);
    // Second await should be a no-op (key already removed)
    await store.awaitPending([key]);
  });

  it("awaitPending() silently skips missing keys", async () => {
    const store = new PendingPromiseStore();
    // Should not throw
    await store.awaitPending(["nonexistent_key"]);
  });

  it("awaitAll() resolves all pending promises", async () => {
    const store = new PendingPromiseStore();
    let a = 0, b = 0;
    store.add(Promise.resolve(1), (val) => { a = val; });
    store.add(Promise.resolve(2), (val) => { b = val; });
    store.add(Promise.resolve("ignored")); // unassigned, no setter
    await store.awaitAll();
    expect(a).toBe(1);
    expect(b).toBe(2);
  });

  it("awaitAll() is a no-op when empty", async () => {
    const store = new PendingPromiseStore();
    await store.awaitAll(); // should not throw
  });

  it("awaitAll() clears the store after resolving", async () => {
    const store = new PendingPromiseStore();
    store.add(Promise.resolve(1));
    await store.awaitAll();
    // Second awaitAll should be a no-op
    await store.awaitAll();
  });

  it("clear() removes all entries without awaiting", () => {
    const store = new PendingPromiseStore();
    store.add(Promise.resolve(1));
    store.add(Promise.resolve(2));
    store.clear();
    // awaitAll should be a no-op after clear
  });

  it("concurrent adds with same logical variable get unique keys", () => {
    const store = new PendingPromiseStore();
    const key1 = store.add(Promise.resolve("a"));
    const key2 = store.add(Promise.resolve("b"));
    expect(key1).not.toBe(key2);
  });

  it("awaitPending() with multiple keys resolves all and calls all setters", async () => {
    const store = new PendingPromiseStore();
    let x = 0, y = 0;
    const k1 = store.add(Promise.resolve(10), (v) => { x = v; });
    const k2 = store.add(Promise.resolve(20), (v) => { y = v; });
    await store.awaitPending([k1, k2]);
    expect(x).toBe(10);
    expect(y).toBe(20);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:run -- lib/runtime/state/pendingPromiseStore.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement PendingPromiseStore**

Create `lib/runtime/state/pendingPromiseStore.ts`:

```typescript
import { isInterrupt } from "../interrupts.js";
import { ConcurrentInterruptError } from "../errors.js";

type PendingPromiseEntry = {
  promise: Promise<any>;
  resolve?: (value: any) => void;
};

export class PendingPromiseStore {
  private pending: Record<string, PendingPromiseEntry> = {};
  private counter: number = 0;

  add(promise: Promise<any>, resolve?: (value: any) => void): string {
    const key = `__pending_${this.counter++}`;
    this.pending[key] = { promise, resolve };
    return key;
  }

  async awaitPending(keys: string[]): Promise<void> {
    const entries = keys
      .map((k) => ({ key: k, entry: this.pending[k] }))
      .filter((e) => e.entry !== undefined);

    if (entries.length === 0) return;

    const results = await Promise.all(entries.map((e) => e.entry!.promise));

    for (let i = 0; i < entries.length; i++) {
      const { key, entry } = entries[i];
      if (entry!.resolve) {
        entry!.resolve(results[i]);
      }
      delete this.pending[key];
    }
  }

  async awaitAll(): Promise<void> {
    const keys = Object.keys(this.pending);
    if (keys.length === 0) return;

    const entries = keys.map((k) => ({ key: k, entry: this.pending[k] }));
    this.pending = {};

    const results = await Promise.all(entries.map((e) => e.entry.promise));

    for (let i = 0; i < entries.length; i++) {
      const { entry } = entries[i];
      const result = results[i];

      if (isInterrupt(result)) {
        throw new ConcurrentInterruptError(
          "An async function returned an interrupt while another interrupt was pending. " +
          "Concurrent interrupts are not yet supported. Assign the async call to a " +
          "variable if it may trigger an interrupt.",
        );
      }

      if (entry.resolve) {
        entry.resolve(result);
      }
    }
  }

  clear(): void {
    this.pending = {};
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:run -- lib/runtime/state/pendingPromiseStore.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Add ConcurrentInterruptError to errors.ts**

In `lib/runtime/errors.ts`, add after the `ToolCallError` class:

```typescript
export class ConcurrentInterruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConcurrentInterruptError";
  }
}
```

- [ ] **Step 6: Add ConcurrentInterruptError tests**

Add to the test file:

```typescript
import { ConcurrentInterruptError } from "../errors.js";

it("awaitAll() throws ConcurrentInterruptError when a promise returns an interrupt", async () => {
  const store = new PendingPromiseStore();
  store.add(Promise.resolve({ type: "interrupt", data: "test" }));
  await expect(store.awaitAll()).rejects.toThrow(ConcurrentInterruptError);
});

// Note: this test relies on insertion order — the setter promise is added first,
// so it fires before the interrupt is encountered during iteration.
it("awaitAll() calls setters for non-interrupt results before throwing", async () => {
  const store = new PendingPromiseStore();
  let captured = 0;
  store.add(Promise.resolve(42), (val) => { captured = val; });
  store.add(Promise.resolve({ type: "interrupt", data: "test" }));
  await expect(store.awaitAll()).rejects.toThrow(ConcurrentInterruptError);
  expect(captured).toBe(42);
});
```

- [ ] **Step 7: Run tests, verify pass**

Run: `pnpm test:run -- lib/runtime/state/pendingPromiseStore.test.ts`
Expected: All tests PASS

- [ ] **Step 8: Commit**

```bash
git add lib/runtime/state/pendingPromiseStore.ts lib/runtime/state/pendingPromiseStore.test.ts lib/runtime/errors.ts
git commit -m "feat: add PendingPromiseStore class for async promise tracking"
```

---

### Task 2: Wire PendingPromiseStore into RuntimeContext

**Files:**
- Modify: `lib/runtime/state/context.ts`
- Modify: `lib/runtime/index.ts`

- [ ] **Step 1: Add PendingPromiseStore to RuntimeContext**

In `lib/runtime/state/context.ts`:

1. Add import at top:
```typescript
import { PendingPromiseStore } from "./pendingPromiseStore.js";
```

2. Add field to `RuntimeContext` class (after line 20, alongside other fields):
```typescript
pendingPromises: PendingPromiseStore;
```

3. Initialize in constructor (after line 49, `this.onStreamLock = false;`):
```typescript
this.pendingPromises = new PendingPromiseStore();
```

4. Initialize in `createExecutionContext()` (after line 74, `execCtx.onStreamLock = false;`):
```typescript
execCtx.pendingPromises = new PendingPromiseStore();
```

5. Update `cleanup()` — add as first line of method body (before line 84):
```typescript
this.pendingPromises.clear();
```

- [ ] **Step 2: Export PendingPromiseStore from runtime index**

In `lib/runtime/index.ts`, add after the ThreadStore export (line 8):
```typescript
export { PendingPromiseStore } from "./state/pendingPromiseStore.js";
```

And after the ToolCallError export (line 91):
```typescript
export { ConcurrentInterruptError } from "./errors.js";
```

- [ ] **Step 3: Build and verify no compile errors**

Run: `pnpm run build`
Expected: Clean build, no errors

- [ ] **Step 4: Run all tests to verify nothing is broken**

Run: `pnpm test:run`
Expected: All existing tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/state/context.ts lib/runtime/index.ts
git commit -m "feat: wire PendingPromiseStore into RuntimeContext"
```

---

### Task 3: Fix respondToInterrupt and resumeFromState missing cleanup

**Files:**
- Modify: `lib/runtime/interrupts.ts:74-121` (respondToInterrupt)
- Modify: `lib/runtime/interrupts.ts:195-224` (resumeFromState)

This is a pre-existing bug: `respondToInterrupt` and `resumeFromState` don't call `execCtx.cleanup()` in a finally block, unlike `runNode` (which does at `lib/runtime/node.ts:129-131`). Fix both now so `PendingPromiseStore.clear()` runs on error paths.

- [ ] **Step 1: Wrap the graph.run call in respondToInterrupt with try/finally**

In `lib/runtime/interrupts.ts`, change `respondToInterrupt` (lines 110-120). Replace:

```typescript
  const result = await execCtx.graph.run(nodeName, {
    ...
  }, { onNodeEnter: (id) => execCtx.stateStack.nodesTraversed.push(id) });
  return createReturnObject({ result, globals: execCtx.globals });
```

With:

```typescript
  try {
    const result = await execCtx.graph.run(nodeName, {
      ...
    }, { onNodeEnter: (id) => execCtx.stateStack.nodesTraversed.push(id) });
    return createReturnObject({ result, globals: execCtx.globals });
  } finally {
    execCtx.cleanup();
  }
```

- [ ] **Step 2: Wrap the graph.run call in resumeFromState with try/finally**

In `lib/runtime/interrupts.ts`, change `resumeFromState` (lines 214-223). Apply the same pattern:

```typescript
  try {
    const result = await execCtx.graph.run(nodeName, {
      ...
    }, { onNodeEnter: (id) => execCtx.stateStack.nodesTraversed.push(id) });
    return createReturnObject({ result, globals: execCtx.globals });
  } finally {
    execCtx.cleanup();
  }
```

- [ ] **Step 3: Build and run all tests**

Run: `pnpm run build && pnpm test:run`
Expected: Clean build, all tests PASS

- [ ] **Step 4: Commit**

```bash
git add lib/runtime/interrupts.ts
git commit -m "fix: add missing cleanup to respondToInterrupt and resumeFromState"
```

---

### Task 4: Builder — unassigned async calls

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts:1066-1093` (processFunctionCallAsStatement)
- Modify: `lib/backends/typescriptBuilder.ts:1095-1133` (processFunctionCall)

This changes unassigned `async func()` from generating a broken unawaited call to generating `__ctx.pendingPromises.add(func(...))`.

- [ ] **Step 1: Create a generator fixture for unassigned async calls**

Create `tests/typescriptGenerator/asyncUnassigned.agency`:

```agency
def append(sleepTime: number, value: any) {
  sleep(sleepTime)
}

node main() {
  async append(1, "hello")
  async append(0.5, "world")
  return "done"
}
```

- [ ] **Step 2: Modify processFunctionCallAsStatement to handle async**

In `lib/backends/typescriptBuilder.ts`, update `processFunctionCallAsStatement` (starting at line 1066). The method currently always wraps the call in `const __funcResult = callNode; if (isInterrupt(...)) return ...`. For async calls, we need to instead generate `__ctx.pendingPromises.add(callNode)`.

Replace the method:

```typescript
private processFunctionCallAsStatement(node: FunctionCall): TsNode {
  const callNode = this.processFunctionCall(node);
  const scope = this.getCurrentScope();

  if (
    this.isAgencyFunction(node.functionName, "topLevelStatement") &&
    !this.isGraphNode(node.functionName) &&
    scope.type !== "global"
  ) {
    // Async unassigned calls: register with pending promise store, no interrupt check
    if (node.async) {
      return ts.raw(
        `__ctx.pendingPromises.add(${this.str(callNode)})`,
      );
    }

    // Sync calls: check for interrupt result
    const tempVar = "__funcResult";
    const nodeContext = scope.type === "node";
    const returnBody = nodeContext
      ? ts.obj([
          ts.setSpread(ts.runtime.state),
          ts.set("data", ts.id(tempVar)),
        ])
      : ts.obj({ data: ts.id(tempVar) });
    return ts.statements([
      ts.constDecl(tempVar, callNode),
      ts.if(
        ts.call(ts.id("isInterrupt"), [ts.id(tempVar)]),
        ts.statements([
          ts.raw("await __ctx.pendingPromises.awaitAll()"),
          ts.return(returnBody),
        ]),
      ),
    ]);
  }

  return callNode;
}
```

Note two changes:
1. Async calls get `__ctx.pendingPromises.add(callNode)` instead of the interrupt check pattern.
2. Sync calls get `await __ctx.pendingPromises.awaitAll()` inserted before the interrupt return.

- [ ] **Step 3: Build and regenerate fixtures**

Run: `make fixtures`

This rebuilds and regenerates the `.mjs` fixture for `asyncUnassigned.agency`. Inspect the generated `tests/typescriptGenerator/asyncUnassigned.mjs` to verify it contains `__ctx.pendingPromises.add(append(...))` and does NOT contain `isInterrupt`.

- [ ] **Step 4: Run tests**

Run: `pnpm test:run`
Expected: All tests PASS (existing fixtures may need regeneration — check diffs)

- [ ] **Step 5: Commit**

```bash
git add lib/backends/typescriptBuilder.ts tests/typescriptGenerator/asyncUnassigned.agency tests/typescriptGenerator/asyncUnassigned.mjs
git commit -m "feat: builder generates pendingPromises.add for unassigned async calls"
```

---

### Task 5: Builder — assigned async calls

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts:1381-1452` (processAssignment)

For `x = async func(...)`, generate the `add()` call with a setter and store the key in `__self.__pendingKey_x`. Skip the `isInterrupt` check for async.

- [ ] **Step 1: Create a generator fixture for assigned async calls**

Create `tests/typescriptGenerator/asyncAssigned.agency`:

```agency
def compute(val: number): number {
  sleep(0.1)
  return val * 2
}

node main() {
  x = async compute(5)
  y = async compute(10)
  return [x, y]
}
```

- [ ] **Step 2: Modify processAssignment for async function calls**

In `lib/backends/typescriptBuilder.ts`, in `processAssignment` at the `} else if (value.type === "functionCall") {` branch (line 1413), update to handle async:

```typescript
} else if (value.type === "functionCall") {
  const varRef = this.buildAssignmentLhs(
    node.scope!,
    variableName,
    node.accessChain,
  );
  const stmts: TsNode[] = [
    this.scopedAssign(
      node.scope!,
      variableName,
      this.processNode(value),
      node.accessChain,
    ),
  ];

  if (value.async) {
    // Async: register with pending promise store, store the key, skip interrupt check
    const pendingKeyVar = `__pendingKey_${variableName}`;
    stmts.push(
      ts.assign(
        ts.self(pendingKeyVar),
        ts.raw(`__ctx.pendingPromises.add(${this.str(varRef)}, (val) => { ${this.str(varRef)} = val; })`),
      ),
    );
  } else if (this.getCurrentScope().type !== "global") {
    // Sync: interrupt check with awaitAll before return
    const returnObj =
      this.getCurrentScope().type === "node"
        ? ts.obj([ts.setSpread(ts.runtime.state), ts.set("data", varRef)])
        : ts.obj({ data: varRef });
    stmts.push(
      ts.if(
        $(ts.id("isInterrupt")).call([varRef]).done(),
        ts.statements([
          ts.raw("await __ctx.pendingPromises.awaitAll()"),
          ts.return(returnObj),
        ]),
      ),
    );
  }
  return ts.statements(stmts);
```

- [ ] **Step 3: Build and regenerate fixtures**

Run: `make fixtures`

Inspect `tests/typescriptGenerator/asyncAssigned.mjs` to verify it contains:
- `__self.__pendingKey_x = __ctx.pendingPromises.add(__self.x, ...)`
- NO `isInterrupt` check after the async assignments

Also inspect `tests/typescriptGenerator/asyncKeyword.mjs` — the existing async fixture should now also have `pendingPromises.add` calls.

- [ ] **Step 4: Run tests**

Run: `pnpm test:run`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/backends/typescriptBuilder.ts tests/typescriptGenerator/asyncAssigned.agency tests/typescriptGenerator/asyncAssigned.mjs
git commit -m "feat: builder generates pendingPromises.add for assigned async calls"
```

---

### Task 6: Builder — awaitAll at node exit

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts:1223-1302` (processGraphNode)

Insert `await __ctx.pendingPromises.awaitAll()` before the onNodeEnd hook and return in every node body.

- [ ] **Step 1: Add awaitAll before node exit**

In `lib/backends/typescriptBuilder.ts`, in `processGraphNode`, insert before line 1280 (the onNodeEnd hook):

```typescript
// Await all pending async promises before node exits
stmts.push(ts.raw("await __ctx.pendingPromises.awaitAll()"));
```

So the end of the method becomes:
```typescript
// Body
stmts.push(...bodyCode);

// Await all pending async promises before node exits
stmts.push(ts.raw("await __ctx.pendingPromises.awaitAll()"));

// onNodeEnd hook + return
stmts.push(
  ts.callHook("onNodeEnd", { ... }),
);
stmts.push(ts.return(...));
```

- [ ] **Step 2: Build and regenerate fixtures**

Run: `make fixtures`

Inspect any generated `.mjs` fixture to verify `await __ctx.pendingPromises.awaitAll()` appears before the `onNodeEnd` hook in node bodies.

- [ ] **Step 3: Run tests**

Run: `pnpm test:run`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add lib/backends/typescriptBuilder.ts
git commit -m "feat: insert awaitAll at node exit"
```

---

### Task 7: Builder — awaitAll before interrupt return in processLlmCall

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts:1640-1657` (processLlmCall async/sync branch)

The sync branch of `processLlmCall` generates an `isInterrupt` check and return. Insert `awaitAll` before the return.

- [ ] **Step 1: Add awaitAll before interrupt return in processLlmCall**

In `lib/backends/typescriptBuilder.ts`, in the `else` (sync) branch of `processLlmCall` (around line 1643-1657), the interrupt return is built with `ts.if(isInterrupt, returnExpr)`. Change the interrupt body to include `awaitAll`:

```typescript
stmts.push(
  ts.if(
    $(ts.id("isInterrupt")).call([varRef]).done(),
    ts.statements([
      ts.raw("await __ctx.pendingPromises.awaitAll()"),
      returnExpr,
    ]),
  ),
);
```

- [ ] **Step 2: Build and regenerate fixtures**

Run: `make fixtures`

- [ ] **Step 3: Run tests**

Run: `pnpm test:run`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add lib/backends/typescriptBuilder.ts
git commit -m "feat: insert awaitAll before interrupt return in processLlmCall"
```

---

### Task 8: Builder — async LLM calls in processLlmCall

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts:1640-1657` (processLlmCall async branch)

The `processAssignment` method at line 1384 routes `llm()` calls to `processLlmCall` before reaching the generic function call branch. So the async `pendingPromises.add` logic in Task 5 never runs for `x = async llm("prompt")`. We need to handle this in `processLlmCall`'s async branch directly.

- [ ] **Step 1: Create a generator fixture for async LLM calls**

Create `tests/typescriptGenerator/asyncLlm.agency`:

```agency
node main() {
  x = async llm("What is 2+2?")
  y = async llm("What is 3+3?")
  return [x, y]
}
```

- [ ] **Step 2: Add pendingPromises.add to the async branch of processLlmCall**

In `lib/backends/typescriptBuilder.ts`, in `processLlmCall`, the async branch (around line 1640) currently does:

```typescript
if (node.async) {
  // Async: no await, no interrupt check
  stmts.push(ts.assign(varRef, runPromptCall));
}
```

Change to:

```typescript
if (node.async) {
  // Async: no await, no interrupt check. Register with pending promise store.
  stmts.push(ts.assign(varRef, runPromptCall));
  const pendingKeyVar = `__pendingKey_${variableName}`;
  stmts.push(
    ts.assign(
      ts.self(pendingKeyVar),
      ts.raw(`__ctx.pendingPromises.add(${this.str(varRef)}, (val) => { ${this.str(varRef)} = val; })`),
    ),
  );
}
```

- [ ] **Step 3: Build and regenerate fixtures**

Run: `make fixtures`

Inspect `tests/typescriptGenerator/asyncLlm.mjs` to verify it contains `__self.__pendingKey_x = __ctx.pendingPromises.add(...)` after the async LLM assignment.

- [ ] **Step 4: Run tests**

Run: `pnpm test:run`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/backends/typescriptBuilder.ts tests/typescriptGenerator/asyncLlm.agency tests/typescriptGenerator/asyncLlm.mjs
git commit -m "feat: builder generates pendingPromises.add for async LLM calls"
```

---

### Task 9: Preprocessor — replace Promise.all with awaitPending

**Files:**
- Modify: `lib/preprocessors/typescriptPreprocessor.ts:807-855` (_insertPromiseAllCalls)

Replace the generated `[__self.x] = await Promise.all([__self.x])` raw code with `await __ctx.pendingPromises.awaitPending([__self.__pendingKey_x])`.

- [ ] **Step 1: Update _insertPromiseAllCalls to generate awaitPending calls**

In `lib/preprocessors/typescriptPreprocessor.ts`, in `_insertPromiseAllCalls`:

**At lines 819-826** (the usage-based Promise.all insertion), replace:
```typescript
const varArray = `[${vars.map((v) => `__self.${v}`).join(", ")}]`;
const promiseAllCode: RawCode = {
  type: "rawCode",
  value: `${varArray} = await Promise.all(${varArray});`,
};
```

With:
```typescript
const keyArray = vars.map((v) => `__self.__pendingKey_${v}`).join(", ");
const promiseAllCode: RawCode = {
  type: "rawCode",
  value: `await __ctx.pendingPromises.awaitPending([${keyArray}]);`,
};
```

**At lines 846-853** (the parallel block Promise.all insertion), replace:
```typescript
const varArray = parallelAsyncVars
  .map((v) => `__self.${v}`)
  .join(", ");
node.body.push({
  type: "rawCode",
  value: `[${varArray}] = await Promise.all([${varArray}]);`,
});
```

With:
```typescript
const keyArray = parallelAsyncVars
  .map((v) => `__self.__pendingKey_${v}`)
  .join(", ");
node.body.push({
  type: "rawCode",
  value: `await __ctx.pendingPromises.awaitPending([${keyArray}]);`,
});
```

- [ ] **Step 2: Build and regenerate fixtures**

Run: `make fixtures`

Inspect the regenerated fixtures — especially `tests/typescriptGenerator/asyncKeyword.mjs` and `tests/typescriptGenerator/parallelThread.mjs` — to verify they now use `awaitPending` instead of `Promise.all`.

- [ ] **Step 3: Run all tests**

Run: `pnpm test:run`
Expected: All tests PASS. Some preprocessor unit tests in `lib/preprocessors/typescriptPreprocessor.test.ts` and `lib/preprocessors/typescriptPreprocessor.core.test.ts` reference `Promise.all` in assertions — these will need updating.

- [ ] **Step 4: Update preprocessor unit tests**

In `lib/preprocessors/typescriptPreprocessor.test.ts` and `lib/preprocessors/typescriptPreprocessor.core.test.ts`, update all assertions that check for `Promise.all` to check for `awaitPending` instead. For example:

- `expect(promiseAllNode.value).toContain("Promise.all")` → `expect(promiseAllNode.value).toContain("awaitPending")`
- `expect(promiseAllNode.value).toContain("__self.story")` → `expect(promiseAllNode.value).toContain("__self.__pendingKey_story")`

Search for all occurrences of `Promise.all` in these test files and update each one.

- [ ] **Step 5: Run tests again**

Run: `pnpm test:run`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add lib/preprocessors/typescriptPreprocessor.ts lib/preprocessors/typescriptPreprocessor.test.ts lib/preprocessors/typescriptPreprocessor.core.test.ts
git commit -m "feat: preprocessor generates awaitPending instead of Promise.all"
```

---

### Task 10: Agency integration tests — basic async behavior

**Files:**
- Create: `tests/agency-js/async-unassigned/agent.agency`
- Create: `tests/agency-js/async-unassigned/test.js`
- Create: `tests/agency-js/async-assigned/agent.agency`
- Create: `tests/agency-js/async-assigned/test.js`
- Create: `tests/agency-js/async-mixed/agent.agency`
- Create: `tests/agency-js/async-mixed/test.js`

These are runtime integration tests that compile and execute Agency code, verifying the actual behavior (not just generated code). They use the `tests/agency-js/` format: an `agent.agency` file, a `test.js` that imports the compiled agent and writes `__result.json`, and a `fixture.json` with expected output.

- [ ] **Step 1: Create unassigned async call test (test cases 1, 11 from docs/dev/async.md)**

Create `tests/agency-js/async-unassigned/agent.agency`:
```agency
arr = []

def append(sleepTime: number, value: any) {
  sleep(sleepTime)
  arr.push(value)
}

node main() {
  async append(0.1, "hello")
  async append(0.05, "world")
  return arr
}
```

Create `tests/agency-js/async-unassigned/test.js`:
```javascript
import { main } from "./agent.js";
import { writeFileSync } from "fs";

const result = await main();
// Both calls should have completed. Order may vary due to different sleep times.
const data = result.data.sort();
writeFileSync("__result.json", JSON.stringify({ data }, null, 2));
```

- [ ] **Step 2: Create assigned async call test (test cases 2, 3 from docs/dev/async.md)**

Create `tests/agency-js/async-assigned/agent.agency`:
```agency
def double(val: number): number {
  sleep(0.05)
  return val * 2
}

node main() {
  x = async double(5)
  y = async double(10)
  return [x, y]
}
```

Create `tests/agency-js/async-assigned/test.js`:
```javascript
import { main } from "./agent.js";
import { writeFileSync } from "fs";

const result = await main();
writeFileSync("__result.json", JSON.stringify({ data: result.data }, null, 2));
```

- [ ] **Step 3: Create mixed async test (test case 4 from docs/dev/async.md)**

Create `tests/agency-js/async-mixed/agent.agency`:
```agency
log = []

def sideEffect(val: string) {
  sleep(0.05)
  log.push(val)
}

def compute(val: number): number {
  sleep(0.05)
  return val * 2
}

node main() {
  x = async compute(5)
  async sideEffect("side")
  return { x: x, log: log }
}
```

Create `tests/agency-js/async-mixed/test.js`:
```javascript
import { main } from "./agent.js";
import { writeFileSync } from "fs";

const result = await main();
writeFileSync("__result.json", JSON.stringify({ data: result.data }, null, 2));
```

- [ ] **Step 4: Build, generate fixtures, and run tests**

Run:
```bash
pnpm run build
pnpm run agency test --js tests/agency-js/async-unassigned --gen-fixtures
pnpm run agency test --js tests/agency-js/async-assigned --gen-fixtures
pnpm run agency test --js tests/agency-js/async-mixed --gen-fixtures
```

Inspect each `fixture.json` to verify correctness:
- `async-unassigned`: `data` should be `["hello", "world"]` (sorted)
- `async-assigned`: `data` should be `[10, 20]`
- `async-mixed`: `data` should be `{ "x": 10, "log": ["side"] }`

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm run agency test --js tests/agency-js/async-unassigned && pnpm run agency test --js tests/agency-js/async-assigned && pnpm run agency test --js tests/agency-js/async-mixed`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add tests/agency-js/async-unassigned tests/agency-js/async-assigned tests/agency-js/async-mixed
git commit -m "test: add integration tests for basic async behavior"
```

---

### Task 11: Agency integration tests — loops and functions

**Files:**
- Create: `tests/agency-js/async-loop/agent.agency`
- Create: `tests/agency-js/async-loop/test.js`
- Create: `tests/agency-js/async-nested-function/agent.agency`
- Create: `tests/agency-js/async-nested-function/test.js`

- [ ] **Step 1: Create loop test (test cases 6, 8 from docs/dev/async.md)**

Create `tests/agency-js/async-loop/agent.agency`:
```agency
log = []

def record(val: number) {
  sleep(0.01)
  log.push(val)
}

def compute(val: number): number {
  sleep(0.01)
  return val * 2
}

node main() {
  results = []
  i = 0
  while (i < 3) {
    x = async compute(i)
    results.push(x)
    async record(i)
    i = i + 1
  }
  return { results: results, log: log }
}
```

Create `tests/agency-js/async-loop/test.js`:
```javascript
import { main } from "./agent.js";
import { writeFileSync } from "fs";

const result = await main();
const data = {
  results: result.data.results,
  logSorted: result.data.log.sort((a, b) => a - b),
};
writeFileSync("__result.json", JSON.stringify({ data }, null, 2));
```

- [ ] **Step 2: Create nested function test (test cases 12, 13 from docs/dev/async.md)**

Create `tests/agency-js/async-nested-function/agent.agency`:
```agency
log = []

def record(val: string) {
  sleep(0.01)
  log.push(val)
}

def inner() {
  async record("inner")
}

def outer() {
  inner()
  async record("outer")
}

node main() {
  outer()
  return log
}
```

Create `tests/agency-js/async-nested-function/test.js`:
```javascript
import { main } from "./agent.js";
import { writeFileSync } from "fs";

const result = await main();
const data = result.data.sort();
writeFileSync("__result.json", JSON.stringify({ data }, null, 2));
```

- [ ] **Step 3: Build, generate fixtures, and run**

Run:
```bash
pnpm run build
pnpm run agency test --js tests/agency-js/async-loop --gen-fixtures
pnpm run agency test --js tests/agency-js/async-nested-function --gen-fixtures
```

Verify fixtures:
- `async-loop`: `results` should be `[0, 2, 4]`, `logSorted` should be `[0, 1, 2]`
- `async-nested-function`: `data` should be `["inner", "outer"]` (sorted)

- [ ] **Step 4: Run tests**

Run: `pnpm run agency test --js tests/agency-js/async-loop && pnpm run agency test --js tests/agency-js/async-nested-function`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add tests/agency-js/async-loop tests/agency-js/async-nested-function
git commit -m "test: add integration tests for async in loops and nested functions"
```

---

### Task 12: Agency integration tests — concurrent function calls

**Files:**
- Create: `tests/agency-js/async-concurrent-functions/agent.agency`
- Create: `tests/agency-js/async-concurrent-functions/test.js`

This tests test case 10 from `docs/dev/async.md` — the key collision scenario that unique keys solve.

- [ ] **Step 1: Create concurrent function test**

Create `tests/agency-js/async-concurrent-functions/agent.agency`:
```agency
def transform(val: string): string {
  sleep(0.05)
  return "transformed: ${val}"
}

def helper(val: string): string {
  x = async transform(val)
  return x
}

node main() {
  a = async helper("first")
  b = async helper("second")
  return [a, b]
}
```

Create `tests/agency-js/async-concurrent-functions/test.js`:
```javascript
import { main } from "./agent.js";
import { writeFileSync } from "fs";

const result = await main();
writeFileSync("__result.json", JSON.stringify({ data: result.data }, null, 2));
```

- [ ] **Step 2: Build, generate fixture, run**

Run:
```bash
pnpm run build
pnpm run agency test --js tests/agency-js/async-concurrent-functions --gen-fixtures
```

Verify fixture: `data` should be `["transformed: first", "transformed: second"]`

- [ ] **Step 3: Run test**

Run: `pnpm run agency test --js tests/agency-js/async-concurrent-functions`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add tests/agency-js/async-concurrent-functions
git commit -m "test: add integration test for concurrent async function calls"
```

---

### Task 13: Agency integration tests — async error handling

**Files:**
- Create: `tests/agency-js/async-error/agent.agency`
- Create: `tests/agency-js/async-error/test.js`

Tests test case 22 from `docs/dev/async.md` — an async call that throws should propagate the error.

- [ ] **Step 1: Create error handling test**

Create `tests/agency-js/async-error/agent.agency`:
```agency
def failing() {
  sleep(0.01)
  throw("async error")
}

node main() {
  async failing()
  return "should not reach"
}
```

Create `tests/agency-js/async-error/test.js`:
```javascript
import { main } from "./agent.js";
import { writeFileSync } from "fs";

let result;
try {
  result = await main();
  result = { error: false, data: result.data };
} catch (e) {
  result = { error: true, message: e.message };
}
writeFileSync("__result.json", JSON.stringify(result, null, 2));
```

- [ ] **Step 2: Build, generate fixture, run**

Run:
```bash
pnpm run build
pnpm run agency test --js tests/agency-js/async-error --gen-fixtures
```

Verify fixture: `error` should be `true`, `message` should contain "async error"

- [ ] **Step 3: Run test**

Run: `pnpm run agency test --js tests/agency-js/async-error`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add tests/agency-js/async-error
git commit -m "test: add integration test for async error propagation"
```

---

### Task 14: Regenerate all fixtures and run full test suite

**Files:**
- Modify: Various `.mjs` and `.json` fixtures in `tests/`

The builder and preprocessor changes affect generated code for ALL existing fixtures, not just the new ones. Regenerate everything and verify.

- [ ] **Step 1: Regenerate all fixtures**

Run: `make fixtures`

This rebuilds the project and regenerates all `.mjs` and `.json` fixtures.

- [ ] **Step 2: Review the diffs**

Run: `git diff tests/`

Review the changes. Expected changes:
- All node bodies now end with `await __ctx.pendingPromises.awaitAll()` before `onNodeEnd`
- All `isInterrupt` checks now include `await __ctx.pendingPromises.awaitAll()` before the return
- `asyncKeyword.mjs` uses `pendingPromises.add` instead of bare unawaited calls
- `parallelThread.mjs` uses `awaitPending` instead of `Promise.all`
- Preprocessor `.json` fixtures reference `awaitPending` instead of `Promise.all`

- [ ] **Step 3: Run full test suite**

Run: `pnpm test:run`
Expected: All tests PASS

- [ ] **Step 4: Run all agency-js integration tests**

Run: `pnpm run agency test --js tests/agency-js`
Expected: All tests PASS

- [ ] **Step 5: Verify the original bug is fixed**

Run the original reproducer:
```bash
pnpm run agency foo.agency
```
Expected: No crash. Should print the array with both values.

- [ ] **Step 6: Commit all fixture changes**

```bash
git add tests/
git commit -m "chore: regenerate all fixtures for pendingPromises changes"
```

---

### Task 15: Clean up foo.agency

**Files:**
- Delete: `foo.agency`
- Delete: `foo.js` (generated)

The reproducer file is no longer needed — the bug is fixed and covered by integration tests.

- [ ] **Step 1: Remove reproducer files**

```bash
rm -f foo.agency foo.js
git add -u foo.agency foo.js
git commit -m "chore: remove async bug reproducer"
```

---

## Edge case test coverage mapping

The following maps each test case from `docs/dev/async.md` to where it's tested:

| # | Edge case | Tested in |
|---|-----------|-----------|
| 1 | Unassigned async calls complete before node returns | Task 10: async-unassigned |
| 2 | Assigned async vars resolve before usage | Task 10: async-assigned |
| 3 | Multiple assigned async vars | Task 10: async-assigned |
| 4 | Mixed assigned and unassigned | Task 10: async-mixed |
| 5 | No async calls (no-op) | All existing tests (they don't use async) |
| 6 | Async in while loop, used inside body | Task 11: async-loop |
| 7 | Async in while loop, used after loop | Task 11: async-loop (partially) |
| 8 | Unassigned async in while loop | Task 11: async-loop |
| 9 | Async in for loop | Covered by while loop tests (same mechanism) |
| 10 | Concurrent function calls with internal async | Task 12: async-concurrent-functions |
| 11 | Multiple unassigned async to same function | Task 10: async-unassigned |
| 12 | Async inside sync function called from node | Task 11: async-nested-function |
| 13 | Nested function calls with async | Task 11: async-nested-function |
| 14 | Async in conditional (branch taken) | Covered by type checker; add if needed |
| 15 | Async in conditional (branch not taken) | awaitPending skips missing keys (unit test Task 1) |
| 16 | Assigned async resolves before interrupt | Future: requires interrupt test infrastructure |
| 17 | Unassigned async completes before interrupt | Future: requires interrupt test infrastructure |
| 18 | Concurrent interrupt error | Unit test in Task 1 (ConcurrentInterruptError) |
| 19 | Interrupt resume after async | Future: requires interrupt test infrastructure |
| 20 | Async in global variable init | Covered by existing global init behavior |
| 21 | Async with shared variables | Covered by shared-variables test |
| 22 | Async call that throws | Task 13: async-error |
| 23 | Multiple async with one throwing | Covered by Promise.all fail-fast (unit test) |
| 24-28 | Code generation verification | Generator fixture tests (Tasks 4-8) |
| 29 | respondToInterrupt/resumeFromState cleanup | Task 3 |

Note: Interrupt-specific integration tests (cases 16, 17, 19) require the interrupt test infrastructure described in `docs/INTERRUPT_TESTING.md`. These should be added as follow-up work once this plan is complete.
