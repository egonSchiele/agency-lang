# Runtime Call Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace compile-time function call classification with runtime dispatch helpers (`__call` and `__callMethod`) so that Agency and TypeScript functions can be called uniformly regardless of how they're accessed.

**Architecture:** Two runtime helpers check `AgencyFunction.isAgencyFunction(target)` at call time — `__call` for direct calls, `__callMethod` for property/method calls (preserving `this`). The builder stops classifying functions and instead emits these helpers for all non-excluded calls.

**Tech Stack:** TypeScript, Vitest, Mustache templates (typestache)

**Spec:** `docs/superpowers/specs/2026-04-22-runtime-call-dispatch-design.md`

---

### Task 1: Create the `__call` and `__callMethod` runtime helpers

**Files:**
- Create: `lib/runtime/call.ts`
- Modify: `lib/runtime/index.ts`

- [ ] **Step 1: Write failing tests for `__call`**

Create `lib/runtime/call.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { __call, __callMethod } from "./call.js";
import { AgencyFunction } from "./agencyFunction.js";

function makeAgencyFn(fn: Function, name = "testFn") {
  return new AgencyFunction({
    name,
    module: "test.agency",
    fn,
    params: [{ name: "x", hasDefault: false, defaultValue: undefined, variadic: false }],
    toolDefinition: null,
  });
}

describe("__call", () => {
  it("calls AgencyFunction via .invoke() with descriptor and state", async () => {
    const fn = makeAgencyFn(async (x: number, state: any) => ({ x, state }));
    const result = await __call(fn, { type: "positional", args: [42] }, "myState");
    expect(result).toEqual({ x: 42, state: "myState" });
  });

  it("calls plain TS function by spreading positional args", async () => {
    const fn = (a: number, b: number) => a + b;
    const result = await __call(fn, { type: "positional", args: [3, 4] });
    expect(result).toBe(7);
  });

  it("throws on named args to a TS function", async () => {
    const fn = (a: number) => a;
    await expect(
      __call(fn, { type: "named", positionalArgs: [], namedArgs: { a: 1 } }),
    ).rejects.toThrow("Named arguments are not supported");
  });

  it("throws on non-callable target", async () => {
    await expect(
      __call(42, { type: "positional", args: [] }),
    ).rejects.toThrow("Cannot call non-function value");
  });
});
```

- [ ] **Step 2: Write failing tests for `__callMethod`**

Add to the same test file:

```ts
describe("__callMethod", () => {
  it("calls AgencyFunction stored as object property via .invoke()", async () => {
    const fn = makeAgencyFn(async (x: number, state: any) => x * 2);
    const obj = { myFunc: fn };
    const result = await __callMethod(obj, "myFunc", { type: "positional", args: [5] });
    expect(result).toBe(10);
  });

  it("calls TS method preserving this binding", async () => {
    const s = new Set<number>();
    await __callMethod(s, "add", { type: "positional", args: [42] });
    expect(s.has(42)).toBe(true);
  });

  it("calls AgencyFunction stored in array by index", async () => {
    const fn = makeAgencyFn(async (x: number, state: any) => x + 1);
    const arr = [fn];
    const result = await __callMethod(arr, 0, { type: "positional", args: [10] });
    expect(result).toBe(11);
  });

  it("short-circuits to undefined when optional and obj is null", async () => {
    const result = await __callMethod(null, "foo", { type: "positional", args: [] }, undefined, true);
    expect(result).toBeUndefined();
  });

  it("short-circuits to undefined when optional and obj is undefined", async () => {
    const result = await __callMethod(undefined, "foo", { type: "positional", args: [] }, undefined, true);
    expect(result).toBeUndefined();
  });

  it("calls normally when optional and obj is non-nullish", async () => {
    const obj = { greet: (name: string) => `hi ${name}` };
    const result = await __callMethod(obj, "greet", { type: "positional", args: ["Bob"] }, undefined, true);
    expect(result).toBe("hi Bob");
  });

  it("throws on named args to a TS method", async () => {
    const obj = { fn: (a: number) => a };
    await expect(
      __callMethod(obj, "fn", { type: "named", positionalArgs: [], namedArgs: { a: 1 } }),
    ).rejects.toThrow("Named arguments are not supported");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run lib/runtime/call.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 4: Implement `__call` and `__callMethod`**

Create `lib/runtime/call.ts`:

```ts
import { AgencyFunction } from "./agencyFunction.js";
import type { CallType } from "./agencyFunction.js";

export async function __call(
  target: unknown,
  descriptor: CallType,
  state?: unknown,
): Promise<unknown> {
  if (AgencyFunction.isAgencyFunction(target)) {
    return target.invoke(descriptor, state);
  }
  if (typeof target !== "function") {
    throw new Error(`Cannot call non-function value: ${String(target)}`);
  }
  if (descriptor.type === "named") {
    throw new Error(
      `Named arguments are not supported for non-Agency function '${target.name || "(anonymous)"}'`,
    );
  }
  return target(...descriptor.args);
}

export async function __callMethod(
  obj: unknown,
  prop: string | number,
  descriptor: CallType,
  state?: unknown,
  optional?: boolean,
): Promise<unknown> {
  if (optional && (obj === null || obj === undefined)) {
    return undefined;
  }
  const target = (obj as any)[prop];
  if (AgencyFunction.isAgencyFunction(target)) {
    return target.invoke(descriptor, state);
  }
  if (typeof target !== "function") {
    throw new Error(`Cannot call non-function value at property '${String(prop)}': ${String(target)}`);
  }
  if (descriptor.type === "named") {
    throw new Error(
      `Named arguments are not supported for non-Agency function '${String(prop)}'`,
    );
  }
  // Call as obj[prop](...) to preserve `this` binding
  return (obj as any)[prop](...descriptor.args);
}
```

- [ ] **Step 5: Export from `lib/runtime/index.ts`**

Add to `lib/runtime/index.ts`:

```ts
export { __call, __callMethod } from "./call.js";
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run lib/runtime/call.test.ts`
Expected: All PASS

- [ ] **Step 7: Commit**

```bash
git add lib/runtime/call.ts lib/runtime/call.test.ts lib/runtime/index.ts
git commit -m "feat: add __call and __callMethod runtime dispatch helpers"
```

---

### Task 2: Add `__call` and `__callMethod` to the imports template

**Files:**
- Modify: `lib/templates/backends/typescriptGenerator/imports.mustache`
- Modify: `lib/templates/backends/typescriptGenerator/imports.ts` (auto-generated — run `pnpm run templates`)

- [ ] **Step 1: Add imports to the template**

In `lib/templates/backends/typescriptGenerator/imports.mustache`, add `__call` and `__callMethod` to the import from `"agency-lang/runtime"` (line 29, inside the existing import block):

```
  __call, __callMethod,
```

Add it on the line after `__AgencyFunction, UNSET as __UNSET,` (line 29).

- [ ] **Step 2: Recompile templates**

Run: `pnpm run templates`

- [ ] **Step 3: Build to verify no errors**

Run: `pnpm run build`
Expected: Clean build

- [ ] **Step 4: Commit**

```bash
git add lib/templates/backends/typescriptGenerator/imports.mustache lib/templates/backends/typescriptGenerator/imports.ts
git commit -m "feat: add __call and __callMethod to generated imports"
```

---

### Task 3: Refactor builder — replace `generateFunctionCallExpression` with unified dispatch

This is the core task. Replace the `isAgencyFunction` / `isPlainTsImport` branching with a single path that emits `__call` for all non-excluded calls.

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts`

**Important context for the implementer:**
- Read the spec at `docs/superpowers/specs/2026-04-22-runtime-call-dispatch-design.md`
- The builder currently has three methods: `generateFunctionCallExpression` (line 1973), `emitAgencyFunctionCall` (line 2000), `emitDirectFunctionCall` (line 2036). These will be unified.
- `isAgencyFunction` (line 350) and `isPlainTsImport` (line 371) will be removed. `_buildImportNameSets`, `_plainTsImportNames`, and `_agencyImportNames` must be kept — they are used by `isImpureImportedFunction` (line 405) for retry-safety (`safe` keyword).
- `TEMPLATE_FUNCTIONS` (line 338) stays but is renamed to `DIRECT_CALL_FUNCTIONS` and its role changes to "does this bypass `__call`?"
- Builder macros (`llm`, `fork`/`race`, `interrupt`, `system`, `throw`, `failure` in function scope, `range` in for loops) continue to be intercepted before reaching call dispatch — do not change these.
- `__`-prefixed internal helpers continue to be emitted as direct calls.

- [ ] **Step 1: Rename `TEMPLATE_FUNCTIONS` to `DIRECT_CALL_FUNCTIONS`**

At line 338, rename the set and update the comment:

```ts
// Plain JS functions that bypass __call dispatch and are called directly.
// These are NOT AgencyFunction instances.
private static DIRECT_CALL_FUNCTIONS = new Set([
  "approve", "reject", "propagate",
  "success", "failure",
  "isInterrupt", "isDebugger", "isRejected", "isApproved",
  "isSuccess", "isFailure", "mcp"
]);
```

Update all references: `TEMPLATE_FUNCTIONS` → `DIRECT_CALL_FUNCTIONS` (at lines 360, 2849).

- [ ] **Step 2: Replace `generateFunctionCallExpression` with unified dispatch**

Replace `generateFunctionCallExpression` (line 1973), `emitAgencyFunctionCall` (line 2000), and `emitDirectFunctionCall` (line 2036) with a single method:

```ts
private generateFunctionCallExpression(
  node: FunctionCall,
  context: "valueAccess" | "functionArg" | "topLevelStatement",
  options?: { stateStack?: TsNode },
): TsNode {
  const functionName =
    context === "valueAccess"
      ? node.functionName
      : mapFunctionName(node.functionName);

  const shouldAwait = !node.async && context !== "valueAccess";

  // system() is a builder macro — not a real function call
  if (node.functionName === "system") {
    const argNodes = node.arguments.map((a) => this.processCallArg(a));
    return $(ts.threads.active())
      .prop("push")
      .call([ts.smoltalkSystemMessage(argNodes)])
      .done();
  }

  // __-prefixed helpers and DIRECT_CALL_FUNCTIONS: emit plain direct call
  if (
    functionName.startsWith("__") ||
    TypeScriptBuilder.DIRECT_CALL_FUNCTIONS.has(node.functionName)
  ) {
    return this.emitDirectFunctionCall(node, functionName, shouldAwait);
  }

  // Everything else goes through __call
  return this.emitRuntimeDispatchCall(node, functionName, shouldAwait, options);
}
```

Where `emitRuntimeDispatchCall` is the new unified method:

```ts
private emitRuntimeDispatchCall(
  node: FunctionCall,
  functionName: string,
  shouldAwait: boolean,
  options?: { stateStack?: TsNode },
): TsNode {
  const descriptor = this.buildCallDescriptor(node);

  const locationOpts = node.functionName === "checkpoint" ? {
    moduleId: ts.str(this.moduleId),
    scopeName: ts.str(this.currentScopeName()),
    stepPath: ts.str(this._subStepPath.join(".")),
  } : {};
  const configObj = this.insideGlobalInit
    ? ts.functionCallConfig({ ctx: ts.runtime.ctx })
    : ts.functionCallConfig({
        ctx: ts.runtime.ctx,
        threads: ts.runtime.threads,
        interruptData: ts.raw("__state?.interruptData"),
        stateStack: options?.stateStack,
        isForked: node.async,
        ...locationOpts,
      });

  const callee = node.scope
    ? ts.scopedVar(functionName, node.scope, this.moduleId)
    : ts.id(functionName);

  const callExpr = ts.call(ts.id("__call"), [callee, descriptor, configObj]);
  return shouldAwait ? ts.await(callExpr) : callExpr;
}
```

Keep `emitDirectFunctionCall` (line 2036) as-is for DIRECT_CALL_FUNCTIONS and `__`-prefixed helpers.

- [ ] **Step 3: Remove `isAgencyFunction` and `isPlainTsImport`**

Delete:
- `isAgencyFunction` method (lines 350-365)
- `isPlainTsImport` method (lines 371-376)

**Do NOT delete** `_buildImportNameSets` (line 378), `_plainTsImportNames` (line 367), or `_agencyImportNames` (line 369) — these are still used by `isImpureImportedFunction` (line 405), which determines retry-safety for the `safe` keyword. That code path is unrelated to call dispatch.

- [ ] **Step 4: Update `processFunctionCallAsStatement` to remove `isAgencyFunction` checks**

At line 1836, `processFunctionCallAsStatement` checks `isAgencyFunction` to decide whether to handle interrupts for the call. Replace the `isAgencyFunction` check with a check against `DIRECT_CALL_FUNCTIONS` and `__`-prefixed names (inverted logic — everything NOT excluded gets interrupt handling):

```ts
private shouldHandleInterrupts(functionName: string): boolean {
  if (functionName.startsWith("__")) return false;
  if (TypeScriptBuilder.DIRECT_CALL_FUNCTIONS.has(functionName)) return false;
  if (this.isGraphNode(functionName)) return false;
  return true;
}
```

Replace the `isAgencyFunction` calls at lines 1837, 1845 with `this.shouldHandleInterrupts(node.functionName)`.

- [ ] **Step 5: Update assignment handler to remove `isAgencyFunction` checks**

At line 2467, the assignment handler checks `isAgencyFunction` for async fork-branch setup. Replace with `this.shouldHandleInterrupts(value.functionName)`.

- [ ] **Step 6: Update `buildHandlerArrow` to use `DIRECT_CALL_FUNCTIONS`**

At line 2849, already references `TEMPLATE_FUNCTIONS` — update to `DIRECT_CALL_FUNCTIONS`. The logic stays the same: if the handler name is a direct-call function, emit a plain call; otherwise emit `__call`.

```ts
private buildHandlerArrow(handlerName: string): TsNode {
  const args = handlerName === "propagate" ? [] : [ts.id("__data")];

  if (TypeScriptBuilder.DIRECT_CALL_FUNCTIONS.has(handlerName)) {
    // Built-in handler (approve/reject/propagate): call directly
    return ts.arrowFn(
      [{ name: "__data", typeAnnotation: "any" }],
      ts.call(ts.id(handlerName), args),
      { async: true },
    );
  }

  // User-defined function handler: use __call
  const descriptor = ts.obj({
    type: ts.str("positional"),
    args: ts.arr(args),
  });
  const stateConfig = ts.functionCallConfig({
    ctx: ts.runtime.ctx,
    threads: ts.runtime.threads,
    interruptData: ts.raw("__state?.interruptData"),
  });
  const callExpr = ts.call(ts.id("__call"), [ts.id(handlerName), descriptor, stateConfig]);
  return ts.arrowFn(
    [{ name: "__data", typeAnnotation: "any" }],
    ts.await(callExpr),
    { async: true },
  );
}
```

- [ ] **Step 7: Build to check for compile errors**

Run: `pnpm run build`
Expected: Clean build (may have some errors to fix — iterate)

- [ ] **Step 8: Commit**

```bash
git add lib/backends/typescriptBuilder.ts
git commit -m "refactor: replace isAgencyFunction with __call runtime dispatch"
```

---

### Task 4: Update value access chain handling to use `__callMethod`

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts` — `processValueAccess` (line 949) and `buildAccessChain` (line 2534)

There are **two** methods that handle method calls in value access chains:
1. `processValueAccess` (line 949) — the main value access chain processor
2. `buildAccessChain` (line 2534) — used for assignment LHS access chains

Both have a `methodCall` case that needs updating.

- [ ] **Step 1: Modify `processValueAccess` method call handling**

In `processValueAccess` (line 949), the `methodCall` case (line 978) currently builds a direct call like `result.method(args)`. Replace it to emit `__callMethod(result, "method", descriptor, state, optional)`.

The key change in the `methodCall` case:

```ts
case "methodCall": {
  const isLastInChain = element === node.chain[node.chain.length - 1];
  const fnCall = element.functionCall;

  // Build descriptor from the method call's arguments
  const descriptor = this.buildCallDescriptor(fnCall);
  const configObj = this.insideGlobalInit
    ? ts.functionCallConfig({ ctx: ts.runtime.ctx })
    : ts.functionCallConfig({
        ctx: ts.runtime.ctx,
        threads: ts.runtime.threads,
        interruptData: ts.raw("__state?.interruptData"),
      });

  const propArg = ts.str(fnCall.functionName);
  const callArgs: TsNode[] = [result, propArg, descriptor, configObj];
  if (element.optional) {
    callArgs.push(ts.bool(true));
  }
  const callExpr = ts.call(ts.id("__callMethod"), callArgs);

  result = isLastInChain
    ? ts.await(callExpr)
    : ts.raw(`(${this.str(ts.await(callExpr))})`);
  break;
}
```

Note: This also removes the `isKnownClassMethod` check (line 989), since `__callMethod` handles both Agency and TS methods at runtime. This is fine because class tests are currently skipped.

- [ ] **Step 2: Modify `buildAccessChain` method call handling**

In `buildAccessChain` (line 2534), the `methodCall` case (line 2545) also has dispatch logic with `isKnownClassMethod`. Update it to use `__callMethod` with the same pattern:

```ts
case "methodCall": {
  const fnCall = el.functionCall;
  const descriptor = this.buildCallDescriptor(fnCall);
  const configObj = this.insideGlobalInit
    ? ts.functionCallConfig({ ctx: ts.runtime.ctx })
    : ts.functionCallConfig({
        ctx: ts.runtime.ctx,
        threads: ts.runtime.threads,
        interruptData: ts.raw("__state?.interruptData"),
      });

  const callExpr = ts.call(
    ts.id("__callMethod"),
    [result, ts.str(fnCall.functionName), descriptor, configObj],
  );
  result = ts.await(callExpr);
  break;
}
```

- [ ] **Step 3: Build to check for compile errors**

Run: `pnpm run build`

- [ ] **Step 4: Commit**

```bash
git add lib/backends/typescriptBuilder.ts
git commit -m "feat: emit __callMethod for value access chain calls"
```

---

### Task 5: Update pipe operator to use `__call` / `__callMethod`

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts` — `buildPipeLambda` method (around line 3020)

- [ ] **Step 1: Simplify the `variableName` pipe stage (line 3067)**

Remove the `isAgency` branch. All variable pipe stages go through `__call`:

```ts
if (stage.type === "variableName") {
  const callee = this.processNode(stage);
  const descriptor = ts.obj({
    type: ts.str("positional"),
    args: ts.arr([pipeArg]),
  });
  const stateConfig = ts.functionCallConfig({
    ctx: ts.runtime.ctx,
    threads: ts.runtime.threads,
    interruptData: ts.raw("__state?.interruptData"),
  });
  const callExpr = ts.call(ts.id("__call"), [callee, descriptor, stateConfig]);
  return ts.arrowFn([{ name: "__pipeArg" }], ts.await(callExpr), { async: true });
}
```

- [ ] **Step 2: Simplify the `functionCall` pipe stage with placeholder (line 3093)**

Remove the `isAgency` branch. All function call pipe stages go through `__call`:

```ts
if (stage.type === "functionCall") {
  const placeholderCount = stage.arguments.filter((a) => a.type === "placeholder").length;
  if (placeholderCount !== 1) {
    throw new Error(
      `Function call on right side of |> must contain exactly one ? placeholder, got ${placeholderCount}`,
    );
  }

  const argNodes = stage.arguments.map((a) =>
    a.type === "placeholder" ? pipeArg : this.processNode(a as AgencyNode),
  );
  const callee = stage.scope
    ? ts.scopedVar(mapFunctionName(stage.functionName), stage.scope, this.moduleId)
    : ts.raw(mapFunctionName(stage.functionName));
  const descriptor = ts.obj({
    type: ts.str("positional"),
    args: ts.arr(argNodes),
  });
  const stateConfig = ts.functionCallConfig({
    ctx: ts.runtime.ctx,
    threads: ts.runtime.threads,
    interruptData: ts.raw("__state?.interruptData"),
  });
  const callExpr = ts.call(ts.id("__call"), [callee, descriptor, stateConfig]);
  return ts.arrowFn([{ name: "__pipeArg" }], ts.await(callExpr), { async: true });
}
```

- [ ] **Step 3: Update the `valueAccess` pipe stage (line 3032) to use `__callMethod`**

For method calls with placeholder in a value access pipe stage, emit `__callMethod`:

```ts
if (stage.type === "valueAccess") {
  const lastElement = stage.chain[stage.chain.length - 1];
  if (lastElement?.kind === "methodCall") {
    const methodArgs = lastElement.functionCall.arguments;
    const placeholderCount = methodArgs.filter((a) => a.type === "placeholder").length;

    if (placeholderCount > 0) {
      if (placeholderCount !== 1) {
        throw new Error(
          `Method call on right side of |> must contain exactly one ? placeholder, got ${placeholderCount}`,
        );
      }
      const receiver = this.processValueAccessPartial(stage);
      const argNodes = methodArgs.map((a) =>
        a.type === "placeholder" ? pipeArg : this.processNode(a as AgencyNode),
      );
      const methodName = lastElement.functionCall.functionName;
      const descriptor = ts.obj({
        type: ts.str("positional"),
        args: ts.arr(argNodes),
      });
      const stateConfig = ts.functionCallConfig({
        ctx: ts.runtime.ctx,
        threads: ts.runtime.threads,
        interruptData: ts.raw("__state?.interruptData"),
      });
      const callExpr = ts.call(
        ts.id("__callMethod"),
        [receiver, ts.str(methodName), descriptor, stateConfig],
      );
      return ts.arrowFn([{ name: "__pipeArg" }], ts.await(callExpr), { async: true });
    }
  }

  // No placeholder: bare method/property reference — use __call
  const callee = this.processNode(stage);
  const descriptor = ts.obj({
    type: ts.str("positional"),
    args: ts.arr([pipeArg]),
  });
  const stateConfig = ts.functionCallConfig({
    ctx: ts.runtime.ctx,
    threads: ts.runtime.threads,
    interruptData: ts.raw("__state?.interruptData"),
  });
  const callExpr = ts.call(ts.id("__call"), [callee, descriptor, stateConfig]);
  return ts.arrowFn([{ name: "__pipeArg" }], ts.await(callExpr), { async: true });
}
```

- [ ] **Step 4: Build and run existing pipe tests**

Run: `pnpm run build && pnpm vitest run --reporter=verbose 2>&1 | grep -i pipe`

- [ ] **Step 5: Commit**

```bash
git add lib/backends/typescriptBuilder.ts
git commit -m "refactor: update pipe operator to use __call/__callMethod dispatch"
```

---

### Task 6: Rebuild fixtures and run full test suite

**Files:**
- Modify: All `.mjs` fixtures in `tests/typescriptGenerator/` (auto-regenerated)

The generated code for every fixture will change (`.invoke()` → `__call()`), so all `.mjs` fixture files need to be regenerated.

- [ ] **Step 1: Rebuild all fixtures**

Run: `make fixtures`
Expected: All fixtures regenerated successfully

- [ ] **Step 2: Run the full test suite**

Run: `pnpm test:run`
Expected: All non-skipped tests pass. Fix any failures before proceeding.

- [ ] **Step 3: Commit updated fixtures**

```bash
git add tests/typescriptGenerator/
git commit -m "chore: regenerate fixtures for __call dispatch"
```

---

### Task 7: Add Agency execution tests for new dispatch patterns

**Files:**
- Create: `tests/agency/dynamic-functions/call-from-object.agency`
- Create: `tests/agency/dynamic-functions/call-from-object.test.json`
- Create: `tests/agency/dynamic-functions/method-this-binding.agency`
- Create: `tests/agency/dynamic-functions/method-this-binding.test.json`
- Create: `tests/agency/dynamic-functions/pass-print-dynamically.agency`
- Create: `tests/agency/dynamic-functions/pass-print-dynamically.test.json`

- [ ] **Step 1: Test calling an Agency function stored in an object**

Create `tests/agency/dynamic-functions/call-from-object.agency`:

```
def greet(name: string): string {
  return "hello ${name}"
}

node main() {
  const handlers = { onGreet: greet }
  const result = handlers.onGreet("Alice")
  return result
}
```

Create `tests/agency/dynamic-functions/call-from-object.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "Agency function stored in object property, called via value access",
      "input": "",
      "expectedOutput": "\"hello Alice\"",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

- [ ] **Step 2: Test `this` binding with built-in Set**

Create `tests/agency/dynamic-functions/method-this-binding.agency`:

```
import { Set } from "std::object"

node main() {
  const s = new Set()
  s.add(1)
  s.add(2)
  s.add(1)
  return s.size
}
```

Note: If `Set` is not importable from stdlib, use a simpler test that verifies `this` binding works with a plain JS object method. Check whether `new Set()` works in Agency first — if not, skip this test and add a TODO.

- [ ] **Step 3: Test passing `print` dynamically**

Create `tests/agency/dynamic-functions/pass-print-dynamically.agency`:

```
import { print } from "std::io"

def callWith(fn: (string) => void, val: string): string {
  fn(val)
  return "called"
}

node main() {
  const result = callWith(print, "hello from dynamic print")
  return result
}
```

Create `tests/agency/dynamic-functions/pass-print-dynamically.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "Stdlib print passed as argument and called dynamically",
      "input": "",
      "expectedOutput": "\"called\"",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

- [ ] **Step 4: Compile and run the new tests**

Run:
```bash
pnpm run compile tests/agency/dynamic-functions/call-from-object.agency
pnpm run compile tests/agency/dynamic-functions/pass-print-dynamically.agency
pnpm test:run -- tests/agency/
```

Fix any failures.

- [ ] **Step 5: Commit**

```bash
git add tests/agency/dynamic-functions/
git commit -m "test: add execution tests for runtime call dispatch"
```

---

### Task 8: Clean up and verify

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts`

- [ ] **Step 1: Verify `isAgencyFunction` and `isPlainTsImport` are fully removed**

Search for any remaining references:

```bash
grep -n "isAgencyFunction\|isPlainTsImport" lib/backends/typescriptBuilder.ts
```

Expected: No matches. If any remain, remove them.

Note: `_buildImportNameSets`, `_plainTsImportNames`, and `_agencyImportNames` should still exist — they are used by `isImpureImportedFunction` for retry-safety.

- [ ] **Step 2: Check for any remaining references to `TEMPLATE_FUNCTIONS`**

```bash
grep -rn "TEMPLATE_FUNCTIONS" lib/
```

Expected: No matches. All should be `DIRECT_CALL_FUNCTIONS`.

- [ ] **Step 3: Inspect 2-3 representative fixture diffs**

After rebuilding fixtures in Task 6, verify the generated code looks correct:

```bash
git diff tests/typescriptGenerator/assignment.mjs
git diff tests/typescriptGenerator/blockBasic.mjs
git diff tests/typescriptGenerator/valueAccess.mjs
```

Check that:
- `.invoke(descriptor, config)` calls are replaced with `__call(target, descriptor, config)`
- Value access method calls use `__callMethod(obj, "method", descriptor, config)`
- `DIRECT_CALL_FUNCTIONS` (`approve`, `reject`, `success`, etc.) are still emitted as direct calls
- `__`-prefixed helpers are still direct calls

- [ ] **Step 4: Run the full test suite one final time**

Run: `pnpm test:run`
Expected: All non-skipped tests pass.

- [ ] **Step 5: Commit any remaining cleanup**

```bash
git add lib/backends/typescriptBuilder.ts
git commit -m "chore: final cleanup for runtime call dispatch"
```
