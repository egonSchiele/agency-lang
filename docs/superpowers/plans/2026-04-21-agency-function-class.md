# AgencyFunction Runtime Class Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace compile-time function parameter resolution with a runtime `AgencyFunction` class, enabling full first-class function support (named args, defaults, variadics, pipe, fork through dynamic variables).

**Architecture:** An `AgencyFunction` class wraps every Agency function with parameter metadata and a `invoke()` method that resolves named args, defaults, and variadics at runtime. The builder changes to emit `foo.invoke(descriptor, __state)` instead of doing compile-time arg resolution. The tool registry simplifies to `Record<string, AgencyFunction>`.

**Tech Stack:** TypeScript, Vitest, Zod (for tool schemas)

**Spec:** `docs/superpowers/specs/2026-04-21-agency-function-class-design.md`

---

### Task 1: Create `AgencyFunction` class with `invoke()` — positional calls

**Files:**
- Create: `lib/runtime/agencyFunction.ts`
- Test: `lib/runtime/agencyFunction.test.ts`

- [ ] **Step 1: Write failing tests for positional calls**

```typescript
// lib/runtime/agencyFunction.test.ts
import { describe, it, expect } from "vitest";
import { AgencyFunction, UNSET } from "./agencyFunction.js";

function makeFunction(
  params: { name: string; hasDefault?: boolean; defaultValue?: unknown; variadic?: boolean }[],
  fn?: Function,
) {
  return new AgencyFunction({
    name: "testFn",
    module: "test.agency",
    fn: fn ?? (async (...args: unknown[]) => args),
    params: params.map((p, i) => ({
      name: p.name,
      position: i,
      hasDefault: p.hasDefault ?? false,
      defaultValue: p.defaultValue,
      variadic: p.variadic ?? false,
    })),
    toolDefinition: null,
  });
}

describe("AgencyFunction", () => {
  describe("positional calls", () => {
    it("passes exact args through", async () => {
      const fn = makeFunction([{ name: "a" }, { name: "b" }]);
      const result = await fn.invoke({ type: "positional", args: [1, 2] });
      expect(result).toEqual([1, 2, undefined]); // args + state
    });

    it("pads missing args with UNSET when defaults exist", async () => {
      const fn = makeFunction([
        { name: "a" },
        { name: "b", hasDefault: true, defaultValue: 10 },
      ]);
      const result = await fn.invoke({ type: "positional", args: [1] });
      expect(result).toEqual([1, UNSET, undefined]);
    });

    it("wraps trailing args into array for variadic param", async () => {
      const fn = makeFunction([
        { name: "prefix" },
        { name: "items", variadic: true },
      ]);
      const result = await fn.invoke({ type: "positional", args: [1, 2, 3, 4] });
      expect(result).toEqual([1, [2, 3, 4], undefined]);
    });

    it("passes state through as last argument", async () => {
      const fn = makeFunction([{ name: "a" }]);
      const mockState = { ctx: "mock" } as any;
      const result = await fn.invoke({ type: "positional", args: [1] }, mockState);
      expect(result).toEqual([1, mockState]);
    });

    it("handles zero params", async () => {
      const fn = makeFunction([]);
      const result = await fn.invoke({ type: "positional", args: [] });
      expect(result).toEqual([undefined]); // just state
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/runtime/agencyFunction.test.ts`
Expected: FAIL — module `./agencyFunction.js` does not exist

- [ ] **Step 3: Implement AgencyFunction class with positional call support**

```typescript
// lib/runtime/agencyFunction.ts
export const UNSET = "UNSET";

export type FuncParam = {
  name: string;
  position: number;
  hasDefault: boolean;
  defaultValue: unknown;
  variadic: boolean;
};

export type CallType =
  | { type: "positional"; args: unknown[] }
  | { type: "named"; positionalArgs: unknown[]; namedArgs: Record<string, unknown> };

export type ToolDefinition = {
  name: string;
  description: string;
  schema: unknown; // ZodObject at runtime
};

export type AgencyFunctionOpts = {
  name: string;
  module: string;
  fn: Function;
  params: FuncParam[];
  toolDefinition: ToolDefinition | null;
};

export class AgencyFunction {
  readonly __agencyFunction = true;
  readonly name: string;
  readonly module: string;
  readonly params: FuncParam[];
  readonly toolDefinition: ToolDefinition | null;
  private readonly _fn: Function;

  constructor(opts: AgencyFunctionOpts) {
    this.name = opts.name;
    this.module = opts.module;
    this._fn = opts.fn;
    this.params = opts.params;
    this.toolDefinition = opts.toolDefinition;
  }

  async invoke(descriptor: CallType, state?: unknown): Promise<unknown> {
    const resolvedArgs = this.resolveArgs(descriptor);
    return this._fn(...resolvedArgs, state);
  }

  private resolveArgs(descriptor: CallType): unknown[] {
    if (descriptor.type === "positional") {
      return this.resolvePositional(descriptor.args);
    }
    return this.resolveNamed(descriptor.positionalArgs, descriptor.namedArgs);
  }

  private resolvePositional(args: unknown[]): unknown[] {
    const nonVariadicParams = this.params.filter(p => !p.variadic);
    const hasVariadic = this.params.length > 0 && this.params[this.params.length - 1].variadic;

    // Pad missing optional args with UNSET
    const result = [...args];
    for (let i = result.length; i < nonVariadicParams.length; i++) {
      if (!nonVariadicParams[i].hasDefault) break;
      result.push(UNSET);
    }

    // Wrap trailing args for variadic param
    if (hasVariadic) {
      const nonVariadicCount = nonVariadicParams.length;
      const regularArgs = result.slice(0, nonVariadicCount);
      const variadicArgs = result.slice(nonVariadicCount);
      regularArgs.push(variadicArgs);
      return regularArgs;
    }

    return result;
  }

  private resolveNamed(positionalArgs: unknown[], namedArgs: Record<string, unknown>): unknown[] {
    // Will be implemented in Task 2
    throw new Error("Named args not yet implemented");
  }

  toJSON(): { name: string; module: string } {
    return { name: this.name, module: this.module };
  }

  static isAgencyFunction(value: unknown): value is AgencyFunction {
    return typeof value === "object" && value !== null
      && (value as any).__agencyFunction === true;
  }

  static create(
    opts: AgencyFunctionOpts,
    registry: Record<string, AgencyFunction>,
  ): AgencyFunction {
    const fn = new AgencyFunction(opts);
    registry[opts.name] = fn;
    return fn;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/runtime/agencyFunction.test.ts`
Expected: PASS (all 5 positional tests)

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/agencyFunction.ts lib/runtime/agencyFunction.test.ts
git commit -m "feat: add AgencyFunction class with positional call support"
```

---

### Task 2: Add named argument resolution to `AgencyFunction.invoke()`

**Files:**
- Modify: `lib/runtime/agencyFunction.ts`
- Modify: `lib/runtime/agencyFunction.test.ts`

- [ ] **Step 1: Write failing tests for named calls**

Add to `lib/runtime/agencyFunction.test.ts`:

```typescript
describe("named calls", () => {
  it("reorders named args to positional order", async () => {
    const fn = makeFunction([{ name: "a" }, { name: "b" }, { name: "c" }]);
    const result = await fn.invoke({
      type: "named",
      positionalArgs: [],
      namedArgs: { c: 3, a: 1, b: 2 },
    });
    expect(result).toEqual([1, 2, 3, undefined]);
  });

  it("mixes positional and named args", async () => {
    const fn = makeFunction([{ name: "a" }, { name: "b" }, { name: "c" }]);
    const result = await fn.invoke({
      type: "named",
      positionalArgs: [1],
      namedArgs: { c: 3, b: 2 },
    });
    expect(result).toEqual([1, 2, 3, undefined]);
  });

  it("fills skipped optional params with UNSET", async () => {
    const fn = makeFunction([
      { name: "a" },
      { name: "b", hasDefault: true, defaultValue: 10 },
      { name: "c" },
    ]);
    const result = await fn.invoke({
      type: "named",
      positionalArgs: [],
      namedArgs: { a: 1, c: 3 },
    });
    expect(result).toEqual([1, UNSET, 3, undefined]);
  });

  it("throws on unknown named arg", async () => {
    const fn = makeFunction([{ name: "a" }]);
    await expect(
      fn.invoke({ type: "named", positionalArgs: [], namedArgs: { z: 1 } }),
    ).rejects.toThrow("Unknown named argument 'z'");
  });

  it("throws on duplicate named arg targeting positional slot", async () => {
    const fn = makeFunction([{ name: "a" }, { name: "b" }]);
    await expect(
      fn.invoke({ type: "named", positionalArgs: [1], namedArgs: { a: 2 } }),
    ).rejects.toThrow("conflicts with positional argument");
  });

  it("throws on missing required arg", async () => {
    const fn = makeFunction([{ name: "a" }, { name: "b" }]);
    await expect(
      fn.invoke({ type: "named", positionalArgs: [], namedArgs: { a: 1 } }),
    ).rejects.toThrow("Missing required argument 'b'");
  });

  it("pads trailing defaults when named args stop early", async () => {
    const fn = makeFunction([
      { name: "a" },
      { name: "b", hasDefault: true, defaultValue: 10 },
      { name: "c", hasDefault: true, defaultValue: 20 },
    ]);
    const result = await fn.invoke({
      type: "named",
      positionalArgs: [],
      namedArgs: { a: 1 },
    });
    // resolveNamed breaks at b (no later named arg), resolvePositional pads b and c
    expect(result).toEqual([1, UNSET, UNSET, undefined]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/runtime/agencyFunction.test.ts`
Expected: FAIL — "Named args not yet implemented"

- [ ] **Step 3: Implement `resolveNamed()`**

Replace the placeholder `resolveNamed` in `lib/runtime/agencyFunction.ts`:

```typescript
private resolveNamed(positionalArgs: unknown[], namedArgs: Record<string, unknown>): unknown[] {
  const nonVariadicParams = this.params.filter(p => !p.variadic);

  // Validate no unknown named args
  for (const name of Object.keys(namedArgs)) {
    if (!nonVariadicParams.find(p => p.name === name)) {
      throw new Error(
        `Unknown named argument '${name}' in call to '${this.name}'`,
      );
    }
  }

  // Build result: positional args first, then fill from named args
  const result: unknown[] = [];

  // Positional args fill left-to-right
  for (let i = 0; i < positionalArgs.length; i++) {
    result.push(positionalArgs[i]);
  }

  // Validate named args don't conflict with positional
  for (const name of Object.keys(namedArgs)) {
    const paramIdx = nonVariadicParams.findIndex(p => p.name === name);
    if (paramIdx < positionalArgs.length) {
      throw new Error(
        `Named argument '${name}' conflicts with positional argument at position ${paramIdx + 1} in call to '${this.name}'`,
      );
    }
  }

  // Fill remaining slots from named args in parameter order
  for (let i = positionalArgs.length; i < nonVariadicParams.length; i++) {
    const param = nonVariadicParams[i];
    if (param.name in namedArgs) {
      result.push(namedArgs[param.name]);
    } else if (param.hasDefault) {
      // Check if any later param has a named arg
      const hasLaterNamedArg = nonVariadicParams
        .slice(i + 1)
        .some(p => p.name in namedArgs);
      if (hasLaterNamedArg) {
        result.push(UNSET);
      } else {
        // Trailing skipped params — stop here, resolvePositional will pad
        break;
      }
    } else {
      throw new Error(
        `Missing required argument '${param.name}' in call to '${this.name}'`,
      );
    }
  }

  // Apply variadic wrapping via resolvePositional
  return this.resolvePositional(result);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/runtime/agencyFunction.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/agencyFunction.ts lib/runtime/agencyFunction.test.ts
git commit -m "feat: add named argument resolution to AgencyFunction.invoke()"
```

---

### Task 3: Add `toJSON()`, `isAgencyFunction()`, and `create()` tests

**Files:**
- Modify: `lib/runtime/agencyFunction.test.ts`

- [ ] **Step 1: Write tests for utility methods**

Add to `lib/runtime/agencyFunction.test.ts`:

```typescript
describe("toJSON", () => {
  it("returns name and module", () => {
    const fn = makeFunction([{ name: "a" }]);
    expect(fn.toJSON()).toEqual({ name: "testFn", module: "test.agency" });
  });
});

describe("isAgencyFunction", () => {
  it("returns true for AgencyFunction instances", () => {
    const fn = makeFunction([]);
    expect(AgencyFunction.isAgencyFunction(fn)).toBe(true);
  });

  it("returns false for plain objects", () => {
    expect(AgencyFunction.isAgencyFunction({})).toBe(false);
    expect(AgencyFunction.isAgencyFunction(null)).toBe(false);
    expect(AgencyFunction.isAgencyFunction(42)).toBe(false);
    expect(AgencyFunction.isAgencyFunction("hello")).toBe(false);
  });

  it("returns false for objects with __agencyFunction but wrong value", () => {
    expect(AgencyFunction.isAgencyFunction({ __agencyFunction: "yes" })).toBe(false);
  });
});

describe("create", () => {
  it("creates instance and registers it in the registry", () => {
    const registry: Record<string, AgencyFunction> = {};
    const fn = AgencyFunction.create({
      name: "add",
      module: "math.agency",
      fn: async () => {},
      params: [],
      toolDefinition: null,
    }, registry);
    expect(registry["add"]).toBe(fn);
    expect(fn.name).toBe("add");
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `pnpm vitest run lib/runtime/agencyFunction.test.ts`
Expected: PASS (all tests — these methods are already implemented)

- [ ] **Step 3: Commit**

```bash
git add lib/runtime/agencyFunction.test.ts
git commit -m "test: add tests for toJSON, isAgencyFunction, and create"
```

---

### Task 4: Export `AgencyFunction` from runtime and update imports template

**Files:**
- Modify: `lib/runtime/index.ts`
- Modify: `lib/templates/backends/typescriptGenerator/imports.mustache`

- [ ] **Step 1: Add export to runtime index**

Add to `lib/runtime/index.ts`:

```typescript
export { AgencyFunction, UNSET } from "./agencyFunction.js";
```

- [ ] **Step 2: Add import to the mustache template**

In `lib/templates/backends/typescriptGenerator/imports.mustache`, add `AgencyFunction` and `UNSET` to the runtime import block:

```typescript
import {
  // ... existing imports ...
  AgencyFunction as __AgencyFunction,
  UNSET as __UNSET,
  functionRefReviver as __functionRefReviver,
} from "agency-lang/runtime";
```

- [ ] **Step 3: Recompile templates**

Run: `pnpm run templates`

- [ ] **Step 4: Build to verify no compile errors**

Run: `pnpm run build`
Expected: Clean build, no errors

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/index.ts lib/templates/backends/typescriptGenerator/imports.mustache lib/templates/backends/typescriptGenerator/imports.ts
git commit -m "feat: export AgencyFunction from runtime and add to imports template"
```

---

**Note: Tasks 5-9 form an atomic migration.** Between Tasks 5 and 9, some tests will be broken. This is expected — the reviver, builder, prompt runtime, and fixtures all need to change together. Don't try to get a green test suite until Task 9 is complete.

### Task 5: Adapt `FunctionRefReviver` for `AgencyFunction`

**Files:**
- Modify: `lib/runtime/revivers/functionRefReviver.ts`
- Modify: `lib/runtime/revivers/functionRefReviver.test.ts`
- Modify: `lib/runtime/revivers/index.ts`

- [ ] **Step 1: Write failing tests for adapted reviver**

Update `lib/runtime/revivers/functionRefReviver.test.ts`. Replace the existing tests that use bare functions with `__functionRef` to use `AgencyFunction` instances instead:

```typescript
import { describe, it, expect } from "vitest";
import { AgencyFunction } from "../agencyFunction.js";
import { FunctionRefReviver } from "./functionRefReviver.js";
import { functionRefReviver, nativeTypeReplacer, nativeTypeReviver } from "./index.js";

function makeAgencyFunction(name: string, module: string): AgencyFunction {
  return new AgencyFunction({
    name,
    module,
    fn: async () => {},
    params: [],
    toolDefinition: null,
  });
}

describe("FunctionRefReviver with AgencyFunction", () => {
  it("isInstance detects AgencyFunction", () => {
    const reviver = new FunctionRefReviver();
    const fn = makeAgencyFunction("add", "math.agency");
    expect(reviver.isInstance(fn)).toBe(true);
  });

  it("isInstance rejects non-AgencyFunction", () => {
    const reviver = new FunctionRefReviver();
    expect(reviver.isInstance({})).toBe(false);
    expect(reviver.isInstance(() => {})).toBe(false);
    expect(reviver.isInstance(null)).toBe(false);
  });

  it("serialize extracts name and module", () => {
    const reviver = new FunctionRefReviver();
    const fn = makeAgencyFunction("add", "math.agency");
    expect(reviver.serialize(fn)).toEqual({
      __nativeType: "FunctionRef",
      name: "add",
      module: "math.agency",
    });
  });

  it("revive returns AgencyFunction from registry", () => {
    const reviver = new FunctionRefReviver();
    const fn = makeAgencyFunction("add", "math.agency");
    reviver.registry = { add: fn };
    const revived = reviver.revive({ __nativeType: "FunctionRef", name: "add", module: "math.agency" });
    expect(revived).toBe(fn);
  });

  it("revive finds aliased function by name+module scan", () => {
    const reviver = new FunctionRefReviver();
    const fn = makeAgencyFunction("add", "math.agency");
    // Registry key is "plus" (alias), but fn.name is "add"
    reviver.registry = { plus: fn };
    const revived = reviver.revive({ __nativeType: "FunctionRef", name: "add", module: "math.agency" });
    expect(revived).toBe(fn);
  });

  it("round-trips through replacer and reviver", () => {
    const fn = makeAgencyFunction("add", "math.agency");
    functionRefReviver.registry = { add: fn };

    const obj = { myFunc: fn, other: 42 };
    const json = JSON.stringify(obj, nativeTypeReplacer);
    const parsed = JSON.parse(json, nativeTypeReviver);
    expect(parsed.myFunc).toBe(fn);
    expect(parsed.other).toBe(42);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/runtime/revivers/functionRefReviver.test.ts`
Expected: FAIL — reviver still expects bare functions with `__functionRef`

- [ ] **Step 3: Update `FunctionRefReviver` to work with `AgencyFunction`**

Rewrite `lib/runtime/revivers/functionRefReviver.ts`:

```typescript
import { BaseReviver } from "./baseReviver.js";
import { AgencyFunction } from "../agencyFunction.js";

type AgencyFunctionRegistry = Record<string, AgencyFunction>;

export class FunctionRefReviver implements BaseReviver<AgencyFunction> {
  registry: AgencyFunctionRegistry | null = null;

  nativeTypeName(): string {
    return "FunctionRef";
  }

  isInstance(value: unknown): value is AgencyFunction {
    return AgencyFunction.isAgencyFunction(value);
  }

  serialize(value: AgencyFunction): Record<string, unknown> {
    return { __nativeType: this.nativeTypeName(), name: value.name, module: value.module };
  }

  validate(value: Record<string, unknown>): boolean {
    return typeof value.name === "string" && typeof value.module === "string";
  }

  revive(value: Record<string, unknown>): AgencyFunction {
    if (!this.registry) {
      throw new Error(
        `FunctionRefReviver: no registry set. Cannot revive function "${value.name}" from module "${value.module}".`
      );
    }
    const name = value.name as string;
    const module = value.module as string;

    // Fast path: direct lookup by name
    const direct = this.registry[name];
    if (direct && direct.name === name && direct.module === module) {
      return direct;
    }

    // Slow path: linear scan for aliased imports (registry key differs from original name)
    for (const [_key, entry] of Object.entries(this.registry)) {
      if (entry.name === name && entry.module === module) {
        return entry;
      }
    }

    throw new Error(
      `FunctionRefReviver: function "${name}" from module "${module}" not found in registry. ` +
      `The function may have been renamed or removed since this state was serialized.`
    );
  }
}
```

- [ ] **Step 4: Update the replacer guard in `lib/runtime/revivers/index.ts`**

The `nativeTypeReplacer` currently has a `typeof value === "function"` guard for bare function refs. Since `AgencyFunction` instances are objects (not functions), the existing `typeof value === "object"` guard already catches them. Remove the `typeof value === "function"` guard that was added for the old function ref approach:

```typescript
// Before:
if ((typeof value === "object" && value !== null) || typeof value === "function") {
  raw = value;
}

// After:
if (typeof value === "object" && value !== null) {
  raw = value;
}
```

Also update the second guard:

```typescript
// Before:
if (typeof raw !== "object" && typeof raw !== "function") return value;

// After:
if (typeof raw !== "object") return value;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run lib/runtime/revivers/functionRefReviver.test.ts`
Expected: PASS

- [ ] **Step 6: Run full test suite to check nothing is broken**

Run: `pnpm vitest run`
Expected: Existing tests still pass (the builder hasn't changed yet, so generated code still uses the old pattern — the old `FunctionRefReviver` tests may need adjustment since `isInstance` no longer matches bare functions. This is expected; those tests will be removed/replaced.)

- [ ] **Step 7: Commit**

```bash
git add lib/runtime/revivers/functionRefReviver.ts lib/runtime/revivers/functionRefReviver.test.ts lib/runtime/revivers/index.ts
git commit -m "feat: adapt FunctionRefReviver for AgencyFunction instances"
```

---

### Task 6: Update builder — function definitions emit `AgencyFunction.create()`

This is the start of the atomic builder change. From this point until Task 8 is complete, some tests will be broken.

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts`

- [ ] **Step 1: Update `processTool()` to not emit `__tool` and `__toolParams` declarations**

The `processTool()` method (around line 1446) currently emits `__${functionName}Tool` and `__${functionName}ToolParams` as separate exports. Replace it to return an empty statement — the tool definition will now be part of the `AgencyFunction` constructor.

```typescript
private processTool(node: FunctionDefinition): TsNode {
  // Tool definition is now part of the AgencyFunction constructor.
  // The Zod schema and params are emitted there instead.
  return ts.empty();
}
```

- [ ] **Step 2: Update `processFunctionDefinition()` to emit `AgencyFunction.create()`**

After emitting the function implementation (renamed to `__${name}_impl`), emit an `AgencyFunction.create()` call. Modify `processFunctionDefinition()` (around line 1775):

The function declaration name changes from `functionName` to `__${functionName}_impl`. Then add a `const functionName = AgencyFunction.create(...)` after it.

Key changes:
- Rename the emitted function to `__${functionName}_impl`
- Build the `FuncParam[]` array from `parameters`
- Build the `ToolDefinition` object (Zod schema, name, description) — reuse the existing `mapTypeToZodSchema` logic from the old `processTool()`
- Emit `const ${functionName} = __AgencyFunction.create({...}, __toolRegistry)`
- The default value sentinel changes: function bodies need to use `__UNSET` instead of `null` for default checking

- [ ] **Step 3: Update `generateToolRegistry()` to emit empty registry**

The registry is now populated by `AgencyFunction.create()` calls. Change `generateToolRegistry()` (around line 1522):

```typescript
private generateToolRegistry(functionDefs: FunctionDefinition[]): TsNode {
  // Registry starts empty — AgencyFunction.create() populates it.
  // Imported tools and builtins are added separately.
  const stmts: TsNode[] = [
    ts.varDecl("const", "__toolRegistry", ts.raw("{}")),
  ];

  // Add imported tools
  for (const toolImport of this.programInfo.importedTools) {
    for (const namedImport of toolImport.importedTools) {
      for (const originalName of namedImport.importedNames) {
        const localName = namedImport.aliases[originalName] ?? originalName;
        stmts.push(ts.raw(`__toolRegistry[${JSON.stringify(localName)}] = ${localName};`));
      }
    }
  }

  // Add builtin tools
  for (const toolName of BUILTIN_TOOLS) {
    const internalName = BUILTIN_FUNCTIONS[toolName] || toolName;
    stmts.push(ts.raw(`__toolRegistry[${JSON.stringify(toolName)}] = ${internalName};`));
  }

  // Bind reviver registry for serialization
  stmts.push(ts.raw("__functionRefReviver.registry = __toolRegistry;"));

  return ts.statements(stmts);
}
```

- [ ] **Step 4: Delete `generateFunctionRefMetadata()`**

Remove the entire method (around line 1564-1594) — metadata is now in the `AgencyFunction` constructor.

Remove the call to it in `build()` (around line 474-476).

- [ ] **Step 5: Delete `buildToolRegistryEntry()`**

Remove the method (around line 1502-1516) — no longer needed.

- [ ] **Step 6: Delete `_functionRefVars` tracking**

Remove:
- The `_functionRefVars` field declaration
- The save/restore in `processFunctionDefinition()` and `processGraphNode()`
- The tracking in `processAssignment()`

- [ ] **Step 7: Build to check for compile errors (tests will fail, that's expected)**

Run: `pnpm run build`
Expected: Compiles, but tests will fail because call sites still use old convention

- [ ] **Step 8: Commit work-in-progress**

```bash
git add lib/backends/typescriptBuilder.ts
git commit -m "wip: update function definitions to emit AgencyFunction.create()"
```

---

### Task 7: Update builder — function call sites emit `.invoke()`

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts`

- [ ] **Step 1: Rewrite `generateFunctionCallExpression()`**

The method currently has three paths: Agency function, system, and TS function. Simplify to two: Agency function (`.invoke()`) and everything else (direct call).

The key change: instead of resolving named args and adjusting call args at compile time, emit a `CallType` descriptor and call `.invoke()`.

For a positional call like `add(1, 2)`:
```typescript
await add.invoke({ type: "positional", args: [1, 2] }, __state)
```

For a named call like `add(b: 2, a: 1)`:
```typescript
await add.invoke({ type: "named", positionalArgs: [], namedArgs: { b: 2, a: 1 } }, __state)
```

For a mixed call like `add(1, c: 3)`:
```typescript
await add.invoke({ type: "named", positionalArgs: [1], namedArgs: { c: 3 } }, __state)
```

The descriptor construction in the builder:
- Check if any args are `namedArgument` type
- If yes: emit `{ type: "named", positionalArgs: [...], namedArgs: {...} }`
- If no: emit `{ type: "positional", args: [...] }`
- Block params: still appended as args (blocks are runtime values)
- State: pass `__state` as the second argument to `.invoke()`

Remove the calls to `resolveNamedArgs()` and `adjustCallArgs()` — they're no longer needed.

The callee is always just the variable/identifier — no need for `_functionRefVars` tracking.

For `system()` calls: keep the existing special case.
For TS imports: keep direct invocation.
For Agency functions and function-ref variables: emit `.invoke()`.

- [ ] **Step 2: Delete `resolveNamedArgs()`**

Remove the method (around line 597-688).

- [ ] **Step 3: Delete `adjustCallArgs()` and `getCalleeParams()`**

Remove both methods (around lines 725-758).

- [ ] **Step 4: Update `buildPipeLambda()` to use `.invoke()`**

The pipe lambda needs to emit `.invoke()` calls instead of direct calls. For each pipe stage:

- **Bare function name** (`value |> fn`): `fn.invoke({ type: "positional", args: [__pipeArg] }, __state)`
- **Function call with placeholder** (`value |> fn(10, ?)`): `fn.invoke({ type: "positional", args: [10, __pipeArg] }, __state)`

Remove the `getCalleeParams()` calls and `adjustCallArgs()` calls in pipe handling.

- [ ] **Step 5: Update `processForkCall()` if needed**

Fork passes items to a block. Inside the block, the fork item variable is used. The block body is already processed by the builder, so calls to `func(2, 2)` inside the block will go through `generateFunctionCallExpression()` which now emits `.invoke()`. No direct changes needed to `processForkCall()` itself — the block body processing handles it.

Verify this by checking that `func` in the fork block is treated as an Agency function call.

- [ ] **Step 6: Update default value handling in function bodies**

Currently, function bodies use `param ?? defaultValue` to handle defaults. Since we now use `UNSET` instead of `null`, change to `param === __UNSET ? defaultValue : param`. This is in `buildFunctionBody()` or wherever default values are applied in the generated function body.

Search for where `?? ` default handling is emitted and replace with `=== __UNSET` checks.

- [ ] **Step 7: Update `processImportToolStatement()`**

Currently imports `__${toolName}Tool` and `__${toolName}ToolParams` alongside the function. Since those no longer exist, simplify to just import the function (which is now an `AgencyFunction` instance):

```typescript
private processImportToolStatement(node: ImportToolStatement): TsNode {
  const importNames: (string | { name: string; alias: string })[] = [];
  for (const namedImport of node.importedTools) {
    for (const toolName of namedImport.importedNames) {
      const alias = namedImport.aliases[toolName];
      if (alias) {
        importNames.push({ name: toolName, alias });
      } else {
        importNames.push(toolName);
      }
    }
  }
  return ts.importDecl({
    importKind: "named",
    names: importNames,
    from: toCompiledImportPath(node.agencyFile, this.outputFile ?? path.resolve(this.moduleId)),
  });
}
```

- [ ] **Step 8: Update the `tool()` function in imports.mustache**

The `tool()` function in `imports.mustache` looks up tools from `__toolRegistry`. Since the registry is now `Record<string, AgencyFunction>`, update the lookup:

```typescript
function tool(name) {
  const fn = __toolRegistry[name];
  if (!fn) throw new Error(`Tool "${name}" not found`);
  return fn;
}
```

The LLM tool resolution also needs updating — wherever the runtime reads `__toolRegistry[name].definition` and `__toolRegistry[name].handler`, it now reads `__toolRegistry[name].toolDefinition` and calls `__toolRegistry[name].invoke()`.

- [ ] **Step 9: Build to check for compile errors**

Run: `pnpm run build`
Expected: Compiles

- [ ] **Step 10: Commit**

```bash
git add lib/backends/typescriptBuilder.ts lib/templates/backends/typescriptGenerator/imports.mustache lib/templates/backends/typescriptGenerator/imports.ts
git commit -m "feat: update builder to emit .invoke() for all Agency function calls"
```

---

### Task 8: Update LLM tool call path in `prompt.ts` and `builtins.ts`

The runtime code that executes LLM tool calls relies on the old `ToolRegistryEntry` shape (`handler.name`, `handler.params`, `handler.execute()`). This must be updated to work with `AgencyFunction`.

**Files:**
- Modify: `lib/runtime/prompt.ts`
- Modify: `lib/runtime/builtins.ts`
- Modify: `lib/runtime/mcp/toolAdapter.ts` (if it returns `ToolRegistryEntry`)

- [ ] **Step 1: Update `ToolRegistryEntry` type in `builtins.ts`**

The `ToolRegistryEntry` type and `tool()` function in `lib/runtime/builtins.ts` need to change. Since `__toolRegistry` is now `Record<string, AgencyFunction>`, update the `tool()` function:

```typescript
import { AgencyFunction } from "./agencyFunction.js";

export function tool(name: string, registry: Record<string, AgencyFunction>): AgencyFunction {
  if (!registry[name]) throw new Error(`Unknown tool: ${name}`);
  return registry[name];
}
```

Remove or deprecate the `ToolRegistryEntry` type.

- [ ] **Step 2: Update `prompt.ts` tool execution**

In `lib/runtime/prompt.ts`, the `executeToolCalls` function uses `handler.name`, `handler.params`, and `handler.execute()`. Update to use `AgencyFunction`:

Key changes in `executeToolCalls()`:
- `toolHandlers` is now `AgencyFunction[]` (or looked up from `Record<string, AgencyFunction>`)
- `handler.name` → `handler.name` (same)
- `handler.params.map(param => toolCall.arguments[param])` → `handler.params.map(p => toolCall.arguments[p.name])`
- `handler.execute(...params)` → `handler.invoke({ type: "positional", args: params }, state)` where state is `{ ctx, threads: new ThreadStore(), interruptData, isToolCall: true }`
- Remove the manual state push (`params.push({ ctx, threads, ... })`) — `invoke()` handles this
- Interrupt modify path: `handler.params.indexOf(argName)` → `handler.params.findIndex(p => p.name === argName)`
- Tool definitions: `entry.definition` → `entry.toolDefinition`

Also update the `runPrompt` function where it constructs `tools` and `toolHandlers` from `__toolRegistry`:
- `toolEntries.map(e => e.definition)` → `toolEntries.map(e => e.toolDefinition)`
- `toolEntries.map(e => e.handler)` → `toolEntries` (the entries themselves are `AgencyFunction`)

- [ ] **Step 3: Update MCP tool adapter if needed**

Check `lib/runtime/mcp/toolAdapter.ts` — if it returns `ToolRegistryEntry`, it needs to return `AgencyFunction` instances or a compatible interface.

- [ ] **Step 4: Build to verify**

Run: `pnpm run build`
Expected: Compiles

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/prompt.ts lib/runtime/builtins.ts lib/runtime/mcp/toolAdapter.ts
git commit -m "feat: update LLM tool call path for AgencyFunction"
```

---

### Task 9: Update integration test fixtures

All existing `tests/typescriptGenerator/*.mjs` fixtures will have stale expected output since the generated code shape changed. These are snapshot-style fixtures — the `.mjs` file is the expected generated TypeScript.

**Files:**
- Modify: all `tests/typescriptGenerator/*.mjs` files

- [ ] **Step 1: Rebuild all fixtures**

Run: `make fixtures`

This recompiles all `.agency` files and regenerates the expected `.mjs` outputs.

- [ ] **Step 2: Review the diff to verify changes are correct**

Run: `git diff tests/typescriptGenerator/`

Check that:
- Function definitions now have `__${name}_impl` and `AgencyFunction.create()`
- Function calls use `.invoke()` with descriptors
- `__toolRegistry` is an empty object populated by `create()` calls
- No more `__${name}Tool` or `__${name}ToolParams` declarations
- No more `__functionRef` assignments
- Import statements no longer import `__${name}Tool` / `__${name}ToolParams`

- [ ] **Step 3: Run integration tests**

Run: `pnpm vitest run tests/typescriptGenerator`
Expected: PASS — fixtures match regenerated output

- [ ] **Step 4: Commit**

```bash
git add tests/typescriptGenerator/
git commit -m "fix: update all integration test fixtures for AgencyFunction"
```

---

### Task 10: Fix agency execution tests

The agency execution tests in `tests/agency/` compile and run `.agency` files end-to-end. After the builder changes, all of these should work — but some may need fixes.

**Files:**
- Modify: various files as needed based on failures

- [ ] **Step 1: Run all agency execution tests**

Run: `pnpm run agency test tests/agency`

- [ ] **Step 2: Fix any failures**

Common issues to look for:
- Runtime errors about `.invoke()` not being a function — means the function isn't an `AgencyFunction` instance
- Default value handling — `UNSET` vs `null` mismatches
- Interrupt serialization — `FunctionRefReviver` returning wrong type
- Builtin tool calls — `readSkill` may need wrapping

Fix each failure, re-run tests.

- [ ] **Step 3: Run the function-ref specific tests**

Run: `pnpm run agency test tests/agency/function-refs/`
Expected: All 9 existing tests pass

- [ ] **Step 4: Commit fixes**

```bash
git add -A
git commit -m "fix: resolve agency execution test failures after AgencyFunction migration"
```

---

### Task 11: Add new agency tests for dynamic function features

These are the features that were previously broken and now work with `AgencyFunction`.

**Files:**
- Create: `tests/agency/function-refs/functionRef-namedArgs.agency`
- Create: `tests/agency/function-refs/functionRef-namedArgs.test.json`
- Create: `tests/agency/function-refs/functionRef-variadic.agency`
- Create: `tests/agency/function-refs/functionRef-variadic.test.json`
- Create: `tests/agency/function-refs/functionRef-defaults.agency`
- Create: `tests/agency/function-refs/functionRef-defaults.test.json`
- Create: `tests/agency/function-refs/functionRef-fork.agency`
- Create: `tests/agency/function-refs/functionRef-fork.test.json`
- Create: `tests/agency/function-refs/functionRef-pipe.agency`
- Create: `tests/agency/function-refs/functionRef-pipe.test.json`

- [ ] **Step 1: Write named args through dynamic variable test**

```
// tests/agency/function-refs/functionRef-namedArgs.agency
def greet(name: string, greeting: string = "Hello"): string {
  return greeting + " " + name
}

node main() {
  const fn = greet
  const result = fn(name: "world", greeting: "Hi")
  return result
}
```

```json
// tests/agency/function-refs/functionRef-namedArgs.test.json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "Named args work through dynamic function variable",
      "input": "",
      "expectedOutput": "\"Hi world\"",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

- [ ] **Step 2: Write variadic args through dynamic variable test**

```
// tests/agency/function-refs/functionRef-variadic.agency
safe def join(separator: string, ...parts: string[]): string {
  let result = ""
  for (part in parts) {
    if (result != "") {
      result = result + separator
    }
    result = result + part
  }
  return result
}

node main() {
  const fn = join
  const result = fn(", ", "a", "b", "c")
  return result
}
```

```json
// tests/agency/function-refs/functionRef-variadic.test.json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "Variadic args work through dynamic function variable",
      "input": "",
      "expectedOutput": "\"a, b, c\"",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

- [ ] **Step 3: Write defaults through dynamic variable test**

```
// tests/agency/function-refs/functionRef-defaults.agency
def greet(name: string, greeting: string = "Hello"): string {
  return greeting + " " + name
}

node main() {
  const fn = greet
  const result = fn("world")
  return result
}
```

```json
// tests/agency/function-refs/functionRef-defaults.test.json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "Default args work through dynamic function variable",
      "input": "",
      "expectedOutput": "\"Hello world\"",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

- [ ] **Step 4: Write fork with function variables test**

```
// tests/agency/function-refs/functionRef-fork.agency
import { add, subtract } from "std::math"

node main() {
  const fns = [add, subtract]
  const results = fork(fns) as func {
    func(10, 3)
  }
  return results
}
```

```json
// tests/agency/function-refs/functionRef-fork.test.json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "Fork works with dynamic function variables",
      "input": "",
      "expectedOutput": "[13, 7]",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

- [ ] **Step 5: Write pipe with function variable test**

```
// tests/agency/function-refs/functionRef-pipe.agency
def double(x: number): number {
  return x * 2
}

def addTen(x: number): number {
  return x + 10
}

node main() {
  const fn = double
  const fn2 = addTen
  const result = 5 |> fn(?) |> fn2(?)
  return result
}
```

```json
// tests/agency/function-refs/functionRef-pipe.test.json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "Pipe works with dynamic function variables",
      "input": "",
      "expectedOutput": "20",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

- [ ] **Step 6: Run all new tests**

Run: `pnpm run agency test tests/agency/function-refs`
Expected: PASS for all tests including the 5 new ones

- [ ] **Step 7: Commit**

```bash
git add tests/agency/function-refs/
git commit -m "test: add agency tests for dynamic named args, variadics, defaults, fork, and pipe"
```

---

### Task 12: Run full test suite and clean up

**Files:**
- Possibly various files for minor fixes

- [ ] **Step 1: Run full unit test suite**

Run: `pnpm vitest run`
Expected: All tests pass

- [ ] **Step 2: Run full agency execution test suite**

Run: `pnpm run agency test tests/agency/`
Expected: All tests pass

- [ ] **Step 3: Clean up any unused code**

Check for:
- Old `__functionRef`-related code in the runtime
- Unused imports in the builder
- Dead code from deleted methods

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "chore: clean up unused code after AgencyFunction migration"
```
