# First-Class Functions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable named `def` functions to be assigned to variables, passed as arguments, stored in data structures, and called dynamically — with full interrupt/serialization support.

**Architecture:** Add a `"functionRef"` scope type so the compiler can distinguish function references from regular variables. Build a `FunctionRefReviver` (following the existing BaseReviver pattern) for serialization. Attach `__functionRef` metadata to function objects at registry time so the replacer can serialize them. Modify the builder to pass `__state` when calling function-typed variables.

**Tech Stack:** TypeScript, Vitest, tarsec (parser combinators), Zod

**Spec:** `docs/superpowers/specs/2026-04-21-first-class-functions-design.md`

---

### Task 1: Add `"functionRef"` scope type to type system and IR

**Files:**
- Modify: `lib/types.ts:138` (ScopeType union)
- Modify: `lib/ir/tsIR.ts:280-289` (TsScopedVar scope union)
- Modify: `lib/ir/prettyPrint.ts:11-31` (scopeToPrefix switch)
- Test: `lib/ir/prettyPrint.test.ts:371-399` (scopedVar tests)

- [ ] **Step 1: Write the failing test**

In `lib/ir/prettyPrint.test.ts`, add a test after the existing scopedVar tests (around line 399):

```typescript
it("should print functionRef scoped var as bare name", () => {
  const node = ts.scopedVar("greet", "functionRef");
  expect(printTs(node)).toBe("greet");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run -- lib/ir/prettyPrint.test.ts`
Expected: TypeScript compile error — `"functionRef"` is not assignable to `TsScopedVar["scope"]`

- [ ] **Step 3: Add `"functionRef"` to the type system**

In `lib/types.ts`, update line 138:
```typescript
export type ScopeType = Scope["type"] | "args" | "blockArgs" | "functionRef";
```

In `lib/ir/tsIR.ts`, add `"functionRef"` to the `TsScopedVar` scope union (after line 289):
```typescript
  scope:
  | "global"
  | "shared"
  | "function"
  | "node"
  | "args"
  | "imported"
  | "local"
  | "block"
  | "blockArgs"
  | "functionRef";
```

In `lib/ir/prettyPrint.ts`, add `"functionRef"` to the `scopeToPrefix` switch (around line 28):
```typescript
    case "imported":
    case "shared":
    case "functionRef":
      return "";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run -- lib/ir/prettyPrint.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/types.ts lib/ir/tsIR.ts lib/ir/prettyPrint.ts lib/ir/prettyPrint.test.ts
git commit -m "feat: add functionRef scope type for first-class functions"
```

---

### Task 2: Create FunctionRefReviver

**Files:**
- Create: `lib/runtime/revivers/functionRefReviver.ts`
- Modify: `lib/runtime/revivers/index.ts:1-50` (register reviver, update replacer guard)

Use `lib/runtime/revivers/setReviver.ts` as a template. The key difference: `FunctionRefReviver` needs a mutable `registry` property for looking up functions during `revive()`.

- [ ] **Step 1: Create `functionRefReviver.ts`**

Create `lib/runtime/revivers/functionRefReviver.ts`:

```typescript
import { BaseReviver } from "./baseReviver.js";

type FunctionWithRef = Function & {
  __functionRef?: { name: string; module: string };
};

type ToolRegistry = Record<string, { handler: { execute: Function } }>;

export class FunctionRefReviver implements BaseReviver<FunctionWithRef> {
  registry: ToolRegistry | null = null;

  nativeTypeName(): string {
    return "FunctionRef";
  }

  isInstance(value: unknown): value is FunctionWithRef {
    return typeof value === "function" && "__functionRef" in value;
  }

  serialize(value: FunctionWithRef): Record<string, unknown> {
    const ref = value.__functionRef!;
    return { __nativeType: this.nativeTypeName(), name: ref.name, module: ref.module };
  }

  validate(value: Record<string, unknown>): boolean {
    return typeof value.name === "string" && typeof value.module === "string";
  }

  revive(value: Record<string, unknown>): Function {
    if (!this.registry) {
      throw new Error(
        `FunctionRefReviver: no registry set. Cannot revive function "${value.name}" from module "${value.module}".`
      );
    }
    const name = value.name as string;
    const module = value.module as string;

    // Search registry for a function whose __functionRef matches the original name and module
    for (const [_key, entry] of Object.entries(this.registry)) {
      const fn = entry.handler.execute as FunctionWithRef;
      if (fn.__functionRef && fn.__functionRef.name === name && fn.__functionRef.module === module) {
        return fn;
      }
    }

    throw new Error(
      `FunctionRefReviver: function "${name}" from module "${module}" not found in registry. ` +
      `The function may have been renamed or removed since this state was serialized.`
    );
  }
}
```

- [ ] **Step 2: Update replacer guard and register reviver in `index.ts`**

In `lib/runtime/revivers/index.ts`, add the import and register the reviver:

```typescript
import { FunctionRefReviver } from "./functionRefReviver.js";

export const functionRefReviver = new FunctionRefReviver();

const revivers: BaseReviver<any>[] = [
  new SetReviver(),
  new MapReviver(),
  new DateReviver(),
  new RegExpReviver(),
  new URLReviver(),
  new ErrorReviver(),
  functionRefReviver,
];
```

Update the `nativeTypeReplacer` guard (lines 27-28):

```typescript
// Before:
const raw = typeof value === "object" && value !== null ? value : (key === "" ? value : this[key]);
if (typeof raw !== "object" || raw === null) return value;

// After:
const raw = typeof value === "object" && value !== null ? value : (typeof value === "function" ? value : (key === "" ? value : this[key]));
if (raw === null) return value;
if (typeof raw !== "object" && typeof raw !== "function") return value;
```

- [ ] **Step 3: Build and verify no compile errors**

Run: `pnpm run build`
Expected: Clean build

- [ ] **Step 4: Commit**

```bash
git add lib/runtime/revivers/functionRefReviver.ts lib/runtime/revivers/index.ts
git commit -m "feat: add FunctionRefReviver for serializing function references"
```

---

### Task 3: Write unit tests for FunctionRefReviver

**Files:**
- Create: `lib/runtime/revivers/functionRefReviver.test.ts`

- [ ] **Step 1: Write tests for serialize/deserialize round-trip**

Create `lib/runtime/revivers/functionRefReviver.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { FunctionRefReviver } from "./functionRefReviver.js";
import { nativeTypeReplacer, nativeTypeReviver, functionRefReviver } from "./index.js";

function makeRegisteredFunction(name: string, module: string) {
  const fn = function () {} as any;
  fn.__functionRef = { name, module };
  return fn;
}

describe("FunctionRefReviver", () => {
  const reviver = new FunctionRefReviver();

  describe("isInstance", () => {
    it("returns true for functions with __functionRef", () => {
      const fn = makeRegisteredFunction("greet", "test.agency");
      expect(reviver.isInstance(fn)).toBe(true);
    });

    it("returns false for plain functions", () => {
      expect(reviver.isInstance(() => {})).toBe(false);
    });

    it("returns false for non-functions", () => {
      expect(reviver.isInstance("hello")).toBe(false);
      expect(reviver.isInstance(42)).toBe(false);
      expect(reviver.isInstance(null)).toBe(false);
    });
  });

  describe("serialize", () => {
    it("produces correct FunctionRef marker", () => {
      const fn = makeRegisteredFunction("greet", "test.agency");
      const result = reviver.serialize(fn);
      expect(result).toEqual({
        __nativeType: "FunctionRef",
        name: "greet",
        module: "test.agency",
      });
    });
  });

  describe("validate", () => {
    it("accepts valid FunctionRef objects", () => {
      expect(reviver.validate({ name: "greet", module: "test.agency" })).toBe(true);
    });

    it("rejects invalid objects", () => {
      expect(reviver.validate({ name: 123, module: "test.agency" })).toBe(false);
      expect(reviver.validate({ name: "greet" })).toBe(false);
    });
  });

  describe("revive", () => {
    it("looks up function by original name and module", () => {
      const fn = makeRegisteredFunction("greet", "test.agency");
      const registry = {
        greet: { handler: { execute: fn } },
      } as any;

      reviver.registry = registry;
      const result = reviver.revive({ name: "greet", module: "test.agency" });
      expect(result).toBe(fn);
    });

    it("finds aliased function by original name", () => {
      const fn = makeRegisteredFunction("greet", "utils.agency");
      const registry = {
        sayHello: { handler: { execute: fn } },
      } as any;

      reviver.registry = registry;
      const result = reviver.revive({ name: "greet", module: "utils.agency" });
      expect(result).toBe(fn);
    });

    it("throws when registry is not set", () => {
      reviver.registry = null;
      expect(() => reviver.revive({ name: "greet", module: "test.agency" }))
        .toThrow("no registry set");
    });

    it("throws when function is not found", () => {
      reviver.registry = {} as any;
      expect(() => reviver.revive({ name: "missing", module: "test.agency" }))
        .toThrow("not found in registry");
    });
  });
});

describe("nativeTypeReplacer with functions", () => {
  it("serializes function with __functionRef", () => {
    const fn = makeRegisteredFunction("greet", "test.agency");
    const obj = { callback: fn, name: "test" };
    const json = JSON.stringify(obj, nativeTypeReplacer);
    const parsed = JSON.parse(json);
    expect(parsed.callback).toEqual({
      __nativeType: "FunctionRef",
      name: "greet",
      module: "test.agency",
    });
    expect(parsed.name).toBe("test");
  });

  it("handles functions in arrays", () => {
    const fn = makeRegisteredFunction("greet", "test.agency");
    const arr = [1, fn, "hello"];
    const json = JSON.stringify(arr, nativeTypeReplacer);
    const parsed = JSON.parse(json);
    expect(parsed[1]).toEqual({
      __nativeType: "FunctionRef",
      name: "greet",
      module: "test.agency",
    });
  });

  it("handles nested functions in objects", () => {
    const fn = makeRegisteredFunction("greet", "test.agency");
    const obj = { nested: { deep: { callback: fn } } };
    const json = JSON.stringify(obj, nativeTypeReplacer);
    const parsed = JSON.parse(json);
    expect(parsed.nested.deep.callback).toEqual({
      __nativeType: "FunctionRef",
      name: "greet",
      module: "test.agency",
    });
  });
});

describe("full round-trip: serialize then deserialize", () => {
  it("round-trips function reference through JSON", () => {
    const fn = makeRegisteredFunction("greet", "test.agency");
    const registry = { greet: { handler: { execute: fn } } } as any;
    functionRefReviver.registry = registry;

    const obj = { callback: fn, data: "hello" };
    const json = JSON.stringify(obj, nativeTypeReplacer);
    const restored = JSON.parse(json, nativeTypeReviver);

    expect(restored.callback).toBe(fn);
    expect(restored.data).toBe("hello");

    // Clean up
    functionRefReviver.registry = null;
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `pnpm test:run -- lib/runtime/revivers/functionRefReviver.test.ts`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add lib/runtime/revivers/functionRefReviver.test.ts
git commit -m "test: add unit tests for FunctionRefReviver"
```

---

### Task 4: Preprocessor — detect function references and set scope

**Files:**
- Modify: `lib/preprocessors/typescriptPreprocessor.ts:1402-1574` (resolveVariableScopes)

The preprocessor needs to detect when a bare identifier on the right-hand side of an assignment (or as a function argument) is a known function name, and set its scope to `"functionRef"`. It also needs to error if a node name is used as a value.

Consult `lib/programInfo.ts` to see how `programInfo.functionDefinitions` and node names are accessed. The preprocessor already has `this.programInfo` available.

- [ ] **Step 1: Write a failing preprocessor test**

Check the existing preprocessor test patterns. There are preprocessor fixtures in `tests/typescriptPreprocessor/`. Create a new fixture `tests/typescriptPreprocessor/functionRef.agency`:

```
def greet(name: string): string {
  return "hi"
}

node main() {
  const fn = greet
  const result = fn("Bob")
}
```

Run `make fixtures` to generate the expected output, then inspect the generated `.json` to verify the scope. Initially, `greet` on the RHS will NOT have `scope: "functionRef"` — it will likely be `"imported"` or unscoped. This confirms the test is "failing" in the sense that the scope is wrong.

- [ ] **Step 2: Implement function reference detection in the preprocessor**

In `lib/preprocessors/typescriptPreprocessor.ts`, in the `resolveVariableScopes` method, add logic to detect function references. The key change is in the Phase 2 walk (around lines 1537-1558) where variable nodes in function/node bodies are resolved.

When processing a `variableName` node that is used as a **value** (not a call — i.e., it's the value of an assignment, a function argument, or an array/object literal element), check if the name matches a known function definition:

```typescript
// Inside the variable scope resolution walk, when processing value positions:
const funcDefs = this.programInfo.functionDefinitions;
const nodeNames = this.programInfo.graphNodes; // or however node names are accessed

if (nodeNames.includes(varNode.value || varNode.variableName)) {
  // Error: nodes cannot be used as values
  this.addError(varNode, `Cannot use node "${varNode.value || varNode.variableName}" as a value. Nodes are graph transitions, not functions.`);
} else if (funcDefs[varNode.value || varNode.variableName]) {
  varNode.scope = "functionRef";
}
```

The exact insertion point depends on where value-position variables are processed. Look for where `varNode.scope = lookupScope(...) || "imported"` is set (around line 1556) — this is where bare identifiers that aren't local/args get their scope. Add the function reference check before the fallback to `"imported"`.

- [ ] **Step 3: Rebuild fixtures and verify**

Run: `make fixtures` to regenerate the preprocessor fixture.
Run: `pnpm test:run` to verify all tests pass.

Inspect `tests/typescriptPreprocessor/functionRef.json` to verify that the `greet` identifier on the RHS has `scope: "functionRef"`.

- [ ] **Step 4: Commit**

```bash
git add lib/preprocessors/typescriptPreprocessor.ts tests/typescriptPreprocessor/functionRef.agency tests/typescriptPreprocessor/functionRef.json
git commit -m "feat: preprocessor detects function references and sets functionRef scope"
```

---

### Task 5: Builder — emit code for function reference assignment

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts` (processNode for assignments with functionRef scope)
- Create: `tests/typescriptGenerator/functionRef.agency`

- [ ] **Step 1: Create the integration test fixture**

Create `tests/typescriptGenerator/functionRef.agency`:

```
def greet(name: string): string {
  return "hi ${name}"
}

def double(x: number): number {
  return x * 2
}

def applyToAll(items: number[], transform: (number) => number): number[] {
  const result: number[] = []
  for (item in items) {
    result.push(transform(item))
  }
  return result
}

node main() {
  const fn = greet
  const result = fn("Bob")
  const doubled = applyToAll([1, 2, 3], double)
}
```

- [ ] **Step 2: Implement builder support for function references**

In `lib/backends/typescriptBuilder.ts`, the assignment processing needs to handle values with `scope === "functionRef"`. When the builder encounters a variable reference (identifier) with `"functionRef"` scope, it should emit the bare function name.

This may already work if the builder uses `ts.scopedVar(name, scope, moduleId)` for the value side and the prettyPrint `scopeToPrefix` correctly returns `""` for `"functionRef"`. Verify by running `make fixtures` and inspecting the generated `.mjs`.

If it doesn't work, find where the builder processes the RHS of assignments (likely in `processExpression` or `processAssignment`) and ensure it respects the `"functionRef"` scope.

- [ ] **Step 3: Generate fixture and verify**

Run: `make fixtures`
Inspect `tests/typescriptGenerator/functionRef.mjs` to verify the generated code includes:
- `__stack.locals.fn = greet;` (function reference assignment)
- `double` is passed as an argument to `applyToAll`

Note: `fn("Bob")` will not yet pass `__state` — that's Task 6.

- [ ] **Step 4: Run tests**

Run: `pnpm test:run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/backends/typescriptBuilder.ts tests/typescriptGenerator/functionRef.agency tests/typescriptGenerator/functionRef.mjs
git commit -m "feat: builder emits code for function reference assignments"
```

---

### Task 6: Builder — pass `__state` when calling function-typed variables

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts:1872-1931` (processFunctionCall) and/or `lib/backends/typescriptBuilder.ts:348-360` (isAgencyFunction)

When a variable with a function type is called (e.g., `fn("Bob")`), the builder must pass `{ ctx: __ctx, threads: __threads, interruptData: __state?.interruptData }` as the last argument — the same calling convention used for all Agency function calls.

Currently, `isAgencyFunction(name)` checks if the name is in `programInfo.functionDefinitions`. For a variable like `fn`, it won't be there. The builder needs to also check if the call target is a variable with a function type.

- [ ] **Step 1: Identify where the calling convention decision is made**

Read `lib/backends/typescriptBuilder.ts` around `processFunctionCall` (lines 1872-1931). Find where `isAgencyFunction` is called and where the `__state` argument is appended. The fix needs to add an additional check: if the function name is a variable known to have a function type (from type annotations or from being assigned a `"functionRef"` value), also pass `__state`.

One approach: track variables assigned from function references during assignment processing, then check that set in `processFunctionCall`. Alternatively, check if the variable's type annotation is a function type (BlockType in the AST).

- [ ] **Step 2: Implement the additional check**

Add logic so that when the call target is not recognized by `isAgencyFunction` but IS a known function-typed variable, `__state` is still passed. The details depend on what's most natural in the builder — either extend `isAgencyFunction` to also check tracked function-typed variables, or add a separate check at the call site.

- [ ] **Step 3: Rebuild fixtures and verify**

Run: `make fixtures`
Inspect `tests/typescriptGenerator/functionRef.mjs` to confirm that `fn("Bob", { ctx: __ctx, threads: __threads, ... })` includes the state argument.

- [ ] **Step 4: Run tests**

Run: `pnpm test:run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/backends/typescriptBuilder.ts tests/typescriptGenerator/functionRef.mjs
git commit -m "feat: pass __state when calling function-typed variables"
```

---

### Task 7: Builder — attach `__functionRef` metadata in generated code

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts:1515-1550` (generateToolRegistry)

After the tool registry is generated, emit code that attaches `__functionRef` metadata to every registered function. Also set `functionRefReviver.registry = __toolRegistry`.

- [ ] **Step 1: Add `__functionRef` metadata assignments**

In `generateToolRegistry` (or in a new method called immediately after), emit code like:

```javascript
// For local functions:
greet.__functionRef = { name: "greet", module: "foo.agency" };
// For imported functions (aliased):
sayHello.__functionRef = { name: "greet", module: "utils.agency" };  // original name, not alias
```

Also emit:
```javascript
import { functionRefReviver } from "agency-lang/runtime";
// ... after __toolRegistry is defined:
functionRefReviver.registry = __toolRegistry;
```

The exact mechanism depends on how the builder emits top-level code. Look at how the tool registry declaration is emitted and add the metadata assignments after it.

For imported functions with aliases, use the original name from the import info (available via `programInfo` import data), not the local alias.

- [ ] **Step 2: Export `functionRefReviver` from runtime**

Check `lib/runtime/index.ts` — add an export for `functionRefReviver` from `./revivers/index.js` so generated code can import it.

- [ ] **Step 3: Rebuild fixtures and verify**

Run: `make fixtures`
Inspect generated `.mjs` files to confirm `__functionRef` metadata and `functionRefReviver.registry` assignments appear.

- [ ] **Step 4: Run tests**

Run: `pnpm test:run`
Expected: PASS

- [ ] **Step 5: Commit**

Note: this change modifies generated code, so many existing `.mjs` fixtures will change. Include them in the commit.

```bash
git add lib/backends/typescriptBuilder.ts lib/runtime/index.ts tests/
git commit -m "feat: attach __functionRef metadata to functions for serialization"
```

---

### Task 8: Agency execution test — function reference basics (no interrupts)

**Files:**
- Create: `tests/agency/functionRef-basic.agency`
- Create: `tests/agency/functionRef-basic.test.json`

This tests that function references work at runtime without any interrupt/serialization concerns.

- [ ] **Step 1: Create the test file**

Create `tests/agency/functionRef-basic.agency`:

```
def double(x: number): number {
  return x * 2
}

def applyToAll(items: number[], transform: (number) => number): number[] {
  const result: number[] = []
  for (item in items) {
    result.push(transform(item))
  }
  return result
}

node main() {
  const fn = double
  const result = fn(5)
  const items = applyToAll([1, 2, 3], double)
  return result + items[0] + items[1] + items[2]
}
```

- [ ] **Step 2: Create the test JSON**

Create `tests/agency/functionRef-basic.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "Function reference: assign to variable and call, pass as argument",
      "input": "",
      "expectedOutput": "22",
      "evaluationCriteria": [
        {
          "type": "exact"
        }
      ]
    }
  ]
}
```

(10 + 2 + 4 + 6 = 22... wait, `double` returns `x * 2`. So `fn(5) = 10`, `items = [2, 4, 6]`. Sum = 10 + 2 + 4 + 6 = 22.)

**Note:** Verify the expected output by running the test. If Agency's string interpolation or number addition produces a different result, adjust accordingly.

- [ ] **Step 3: Compile and run the test**

Run: `pnpm run compile tests/agency/functionRef-basic.agency` to verify it compiles.
Run: `pnpm test:run` to verify the test passes.

- [ ] **Step 4: Commit**

```bash
git add tests/agency/functionRef-basic.agency tests/agency/functionRef-basic.test.json
git commit -m "test: agency execution test for basic function references"
```

---

### Task 9: Agency execution test — function reference survives interrupt

**Files:**
- Create: `tests/agency/functionRef-interrupt.agency`
- Create: `tests/agency/functionRef-interrupt.test.json`

This is the critical test: a function reference stored in a local variable must survive serialization through an interrupt.

- [ ] **Step 1: Create the test file**

Create `tests/agency/functionRef-interrupt.agency`:

```
def double(x: number): number {
  return x * 2
}

def check() {
  return interrupt("confirm")
  return "ok"
}

node main() {
  const fn = double
  const before = fn(5)
  const r = check()
  const after = fn(10)
  return "${before},${after}"
}
```

- [ ] **Step 2: Create the test JSON**

Create `tests/agency/functionRef-interrupt.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "Function reference survives serialization through an interrupt",
      "input": "",
      "expectedOutput": "10,20",
      "evaluationCriteria": [
        {
          "type": "exact"
        }
      ],
      "interruptHandlers": [
        {
          "action": "approve",
          "expectedMessage": "confirm"
        }
      ]
    }
  ]
}
```

- [ ] **Step 3: Run the test**

Run: `pnpm test:run`
Expected: PASS — the `fn` variable holding `double` survives the interrupt's serialize/deserialize cycle.

- [ ] **Step 4: Commit**

```bash
git add tests/agency/functionRef-interrupt.agency tests/agency/functionRef-interrupt.test.json
git commit -m "test: function reference survives interrupt serialization"
```

---

### Task 10: Agency execution test — function in data structure survives interrupt

**Files:**
- Create: `tests/agency/functionRef-object-interrupt.agency`
- Create: `tests/agency/functionRef-object-interrupt.test.json`

**Note:** This test calls functions via property access (`transforms.a(5)`). This is a different code path from calling a local variable — the builder handles method-style calls via access chains. Verify the builder passes `__state` for property-access calls on objects containing function references. If this requires additional builder work, implement it as part of this task.

- [ ] **Step 1: Create the test file**

Create `tests/agency/functionRef-object-interrupt.agency`:

```
def double(x: number): number {
  return x * 2
}

def triple(x: number): number {
  return x * 3
}

def check() {
  return interrupt("confirm")
  return "ok"
}

node main() {
  const transforms: { a: (number) => number, b: (number) => number } = { a: double, b: triple }
  const before = transforms.a(5)
  const r = check()
  const after = transforms.b(5)
  return "${before},${after}"
}
```

- [ ] **Step 2: Create the test JSON**

Create `tests/agency/functionRef-object-interrupt.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "Function references in objects survive serialization through an interrupt",
      "input": "",
      "expectedOutput": "10,15",
      "evaluationCriteria": [
        {
          "type": "exact"
        }
      ],
      "interruptHandlers": [
        {
          "action": "approve",
          "expectedMessage": "confirm"
        }
      ]
    }
  ]
}
```

- [ ] **Step 3: Run the test**

Run: `pnpm test:run`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add tests/agency/functionRef-object-interrupt.agency tests/agency/functionRef-object-interrupt.test.json
git commit -m "test: function references in objects survive interrupt serialization"
```

---

### Task 11: Agency execution test — imported function reference with alias

**Files:**
- Create: `tests/agency/imports/functionRef-alias.agency`
- Create: `tests/agency/imports/functionRef-alias.test.json`
- Reuse: `tests/agency/imports/agencyHelpers.agency` (already has `add` and `multiply` functions)

- [ ] **Step 1: Check existing import helpers**

Read `tests/agency/imports/agencyHelpers.agency` to see what functions are available. If `add` is defined there, use it. Otherwise create a helper.

- [ ] **Step 2: Create the test file**

Create `tests/agency/imports/functionRef-alias.agency`:

```
import { add as plus } from "./agencyHelpers.agency"

def check() {
  return interrupt("confirm")
  return "ok"
}

node main() {
  const fn = plus
  const before = fn(2, 3)
  const r = check()
  const after = fn(10, 20)
  return "${before},${after}"
}
```

- [ ] **Step 3: Create the test JSON**

Create `tests/agency/imports/functionRef-alias.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "Aliased imported function reference survives interrupt serialization",
      "input": "",
      "expectedOutput": "5,30",
      "evaluationCriteria": [
        {
          "type": "exact"
        }
      ],
      "interruptHandlers": [
        {
          "action": "approve",
          "expectedMessage": "confirm"
        }
      ]
    }
  ]
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm test:run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/agency/imports/functionRef-alias.agency tests/agency/imports/functionRef-alias.test.json
git commit -m "test: aliased imported function reference survives interrupt"
```

---

### Task 12: Agency execution test — passing a def function where a block is expected

**Files:**
- Create: `tests/agency/functionRef-as-block.agency`
- Create: `tests/agency/functionRef-as-block.test.json`

This tests that a `def` function can be passed where a block parameter is expected, since both are async functions that receive `__state`.

- [ ] **Step 1: Create the test file**

Create `tests/agency/functionRef-as-block.agency`:

```
def double(x: number): number {
  return x * 2
}

node main() {
  const result = map([1, 2, 3], double)
  return result[0] + result[1] + result[2]
}
```

- [ ] **Step 2: Create the test JSON**

Create `tests/agency/functionRef-as-block.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "A def function can be passed where a block is expected",
      "input": "",
      "expectedOutput": "12",
      "evaluationCriteria": [
        {
          "type": "exact"
        }
      ]
    }
  ]
}
```

(2 + 4 + 6 = 12)

- [ ] **Step 3: Run the test**

Run: `pnpm test:run`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add tests/agency/functionRef-as-block.agency tests/agency/functionRef-as-block.test.json
git commit -m "test: def function used where block is expected"
```

---

### Task 13: Preprocessor test — node-as-value compile error

**Files:**
- Create: `tests/typescriptPreprocessor/functionRef-node-error.agency` (or add to an existing error test pattern)

The spec requires that using a node name as a value expression produces a compile error.

- [ ] **Step 1: Determine how compile errors are tested**

Check existing tests for compile error assertions. Look for patterns in `tests/` that verify error messages are emitted during compilation. If there's an existing error-testing pattern (e.g., `.error` files or test harness assertions), follow that pattern.

- [ ] **Step 2: Create the test**

Create a test that attempts to assign a node to a variable:

```
node someNode() {
  return 1
}

node main() {
  const fn = someNode
}
```

This should produce a compile error like: `Cannot use node "someNode" as a value. Nodes are graph transitions, not functions.`

- [ ] **Step 3: Run the test and verify the error**

Verify the compilation emits the expected error message. The exact command depends on the error testing pattern discovered in step 1.

- [ ] **Step 4: Commit**

```bash
git add tests/
git commit -m "test: compile error when using node name as value expression"
```

---

### Task 14: Rebuild all fixtures and run full test suite

**Files:** None (verification only)

- [ ] **Step 1: Rebuild all fixtures**

Run: `make fixtures`
Expected: Clean generation, no errors.

- [ ] **Step 2: Run full test suite**

Run: `pnpm test:run`
Expected: All tests PASS, including all new tests and all existing tests.

- [ ] **Step 3: Build the project**

Run: `pnpm run build`
Expected: Clean build.

- [ ] **Step 4: Commit any remaining fixture changes**

```bash
git add -A tests/
git commit -m "chore: rebuild fixtures for first-class functions"
```
