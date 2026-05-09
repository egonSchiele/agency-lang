# Partial Application Capability Constraints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `.partial()` and `.describe()` methods to `AgencyFunction`, a Known TypeScript Registry for the builder/typechecker, and update the pipe operator to use `.partial()` instead of `?` placeholders.

**Architecture:** `.partial()` and `.describe()` are runtime methods on `AgencyFunction` that produce new immutable instances. The builder compiles `.partial(name: value)` to `.partial({ name: value })` via a Known TypeScript Registry that tells the builder/typechecker how to handle these methods. The pipe operator is simplified by removing `?` placeholders — each pipe stage is a function expression (including `.partial()` calls).

**Tech Stack:** TypeScript, Vitest, Zod

**Spec:** `docs/superpowers/specs/2026-05-05-partial-application-capability-constraints-design.md`

**Original PFA spec:** `docs/superpowers/specs/2026-05-04-partial-application-design.md`

**Design decision:** The original PFA spec defined a separate `bind()` method that `.partial()` would delegate to. Since the `?` placeholder syntax is removed and `.partial()` is the only entry point, this plan inlines the logic directly into `.partial()` for simplicity. There is no separate `bind()` or `translateIndices()` method. The spec's "Unchanged" section references these methods from the original PFA spec, but they are implemented as private logic within `.partial()` rather than as separate public methods.

---

## File Structure

### New files
- `lib/runtime/stripBoundParams.ts` — `stripBoundParams()` helper function
- `lib/runtime/stripBoundParams.test.ts` — unit tests for stripping
- `lib/knownRegistry.ts` — Known TypeScript Functions/Methods Registry

### Modified files
- `lib/runtime/agencyFunction.ts` — add `.partial()`, `.describe()`, `withToolDefinition()`, `BoundArgs` type
- `lib/runtime/agencyFunction.test.ts` — tests for `.partial()` and `.describe()`
- `lib/runtime/revivers/functionRefReviver.ts` — serialize/deserialize bound functions
- `lib/runtime/call.ts` — handle `.partial()` and `.describe()` as direct method calls
- `lib/backends/typescriptBuilder.ts` — consult registry for method calls, update pipe handling
- `lib/typeChecker/index.ts` — validate `.partial()` and `.describe()` calls
- `lib/typeChecker/builtins.ts` — add AgencyFunction method signatures
- `lib/runtime/result.ts` — update pipe runtime if needed

---

## Task 1: `stripBoundParams()` helper

**Files:**
- Create: `lib/runtime/stripBoundParams.ts`
- Create: `lib/runtime/stripBoundParams.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// lib/runtime/stripBoundParams.test.ts
import { describe, it, expect } from "vitest";
import { stripBoundParams } from "./stripBoundParams";

describe("stripBoundParams", () => {
  it("strips single @param line for bound param", () => {
    const description = `Read a file.
@param dir - The directory
@param filename - The file name`;
    const result = stripBoundParams(description, ["dir"]);
    expect(result).toBe(`Read a file.
@param filename - The file name`);
  });

  it("strips @param line without dash", () => {
    const description = `Do something.
@param dir The directory
@param filename The file`;
    const result = stripBoundParams(description, ["dir"]);
    expect(result).toBe(`Do something.
@param filename The file`);
  });

  it("strips multi-line @param entry until next @param", () => {
    const description = `Read a file.
@param dir - The directory to read from.
    Must be an absolute path.
@param filename - The file name`;
    const result = stripBoundParams(description, ["dir"]);
    expect(result).toBe(`Read a file.
@param filename - The file name`);
  });

  it("strips multi-line @param entry until blank line, preserving the blank line", () => {
    const description = `Read a file.

@param dir - The directory to read from.
    Must be absolute.

See also: writeFile`;
    const result = stripBoundParams(description, ["dir"]);
    expect(result).toBe(`Read a file.

See also: writeFile`);
  });

  it("passes through unchanged when no @param lines exist", () => {
    const description = "Read a file from a directory.";
    const result = stripBoundParams(description, ["dir"]);
    expect(result).toBe("Read a file from a directory.");
  });

  it("strips multiple bound params", () => {
    const description = `Do math.
@param a - First number
@param b - Second number
@param c - Third number`;
    const result = stripBoundParams(description, ["a", "c"]);
    expect(result).toBe(`Do math.
@param b - Second number`);
  });

  it("handles indented @param lines", () => {
    const description = `Read a file.
  @param dir - The directory
  @param filename - The file`;
    const result = stripBoundParams(description, ["dir"]);
    expect(result).toBe(`Read a file.
  @param filename - The file`);
  });

  it("returns empty string for empty input", () => {
    expect(stripBoundParams("", ["dir"])).toBe("");
  });

  it("handles empty boundParamNames array (no-op)", () => {
    const description = `@param dir - The directory`;
    expect(stripBoundParams(description, [])).toBe(description);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/runtime/stripBoundParams.test.ts 2>&1 | tee /tmp/claude/strip-test-1.txt`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `stripBoundParams`**

```typescript
// lib/runtime/stripBoundParams.ts
export function stripBoundParams(
  description: string,
  boundParamNames: string[]
): string {
  if (!description || boundParamNames.length === 0) return description;

  const lines = description.split("\n");
  const result: string[] = [];
  let stripping = false;

  for (const line of lines) {
    const paramMatch = line.match(/^\s*@param\s+(\w+)/);
    if (paramMatch) {
      if (boundParamNames.includes(paramMatch[1])) {
        stripping = true;
        continue;
      } else {
        stripping = false;
      }
    } else if (stripping) {
      if (line.trim() === "") {
        stripping = false;
        result.push(line);
        continue;
      }
      continue;
    }
    result.push(line);
  }

  return result.join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/runtime/stripBoundParams.test.ts 2>&1 | tee /tmp/claude/strip-test-2.txt`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/stripBoundParams.ts lib/runtime/stripBoundParams.test.ts
git commit -m "feat: add stripBoundParams helper for PFA tool descriptions"
```

---

## Task 2: Add `BoundArgs` type and `withToolDefinition()` to `AgencyFunction`

**Files:**
- Modify: `lib/runtime/agencyFunction.ts`

- [ ] **Step 1: Add `BoundArgs` type and extend `AgencyFunctionOpts`**

Add after the `ToolDefinition` type (after line 18 of `lib/runtime/agencyFunction.ts`):

```typescript
export type BoundArgs = {
  indices: number[];
  values: unknown[];
  originalParamCount: number;
  originalParams: FuncParam[];
};
```

Update `AgencyFunctionOpts` to add optional `boundArgs`:

```typescript
export type AgencyFunctionOpts = {
  name: string;
  module: string;
  fn: Function;
  params: FuncParam[];
  toolDefinition: ToolDefinition | null;
  boundArgs?: BoundArgs | null;
};
```

- [ ] **Step 2: Add `boundArgs` field to the class and update constructor**

Add readonly field to the class:

```typescript
readonly boundArgs: BoundArgs | null;
```

In the constructor, add:

```typescript
this.boundArgs = opts.boundArgs ?? null;
```

- [ ] **Step 3: Add `withToolDefinition()` private helper**

Add after the constructor:

```typescript
withToolDefinition(toolDefinition: ToolDefinition | null): AgencyFunction {
  return new AgencyFunction({
    name: this.name,
    module: this.module,
    fn: this._fn,
    params: this.params,
    toolDefinition,
    boundArgs: this.boundArgs,
  });
}
```

Note: `_fn` is private. You'll need to either make `withToolDefinition` a method that accesses it directly, or expose it through the constructor pattern. Since this is a method on the same class, it can access `this._fn` directly.

- [ ] **Step 4: Add `getOriginalParams()` helper**

```typescript
getOriginalParams(): FuncParam[] {
  return this.boundArgs ? this.boundArgs.originalParams : this.params;
}
```

- [ ] **Step 5: Run existing tests to make sure nothing broke**

Run: `pnpm vitest run lib/runtime/agencyFunction.test.ts 2>&1 | tee /tmp/claude/af-test-1.txt`
Expected: All existing tests PASS

- [ ] **Step 6: Commit**

```bash
git add lib/runtime/agencyFunction.ts
git commit -m "feat: add BoundArgs type and withToolDefinition helper to AgencyFunction"
```

---

## Task 3: Implement `.partial()` method

**Files:**
- Modify: `lib/runtime/agencyFunction.ts`
- Modify: `lib/runtime/agencyFunction.test.ts`

- [ ] **Step 1: Write failing tests for `.partial()`**

Add to `lib/runtime/agencyFunction.test.ts`:

```typescript
import { stripBoundParams } from "./stripBoundParams";

describe("partial()", () => {
  it("binds a single param by name", () => {
    const fn = makeFunction("add", [
      { name: "a", hasDefault: false, defaultValue: undefined, variadic: false },
      { name: "b", hasDefault: false, defaultValue: undefined, variadic: false },
    ]);
    const bound = fn.partial({ a: 5 });
    expect(bound.params).toHaveLength(1);
    expect(bound.params[0].name).toBe("b");
  });

  it("binds multiple params", () => {
    const fn = makeFunction("add3", [
      { name: "a", hasDefault: false, defaultValue: undefined, variadic: false },
      { name: "b", hasDefault: false, defaultValue: undefined, variadic: false },
      { name: "c", hasDefault: false, defaultValue: undefined, variadic: false },
    ]);
    const bound = fn.partial({ a: 1, c: 3 });
    expect(bound.params).toHaveLength(1);
    expect(bound.params[0].name).toBe("b");
  });

  it("empty partial returns clone with same signature", () => {
    const fn = makeFunction("add", [
      { name: "a", hasDefault: false, defaultValue: undefined, variadic: false },
      { name: "b", hasDefault: false, defaultValue: undefined, variadic: false },
    ]);
    const clone = fn.partial({});
    expect(clone.params).toHaveLength(2);
    expect(clone).not.toBe(fn);
  });

  it("throws on unknown param name", () => {
    const fn = makeFunction("add", [
      { name: "a", hasDefault: false, defaultValue: undefined, variadic: false },
    ]);
    expect(() => fn.partial({ z: 5 })).toThrow("Unknown parameter 'z'");
  });

  it("chained partial binds remaining params", () => {
    const fn = makeFunction("add3", [
      { name: "a", hasDefault: false, defaultValue: undefined, variadic: false },
      { name: "b", hasDefault: false, defaultValue: undefined, variadic: false },
      { name: "c", hasDefault: false, defaultValue: undefined, variadic: false },
    ]);
    const bound1 = fn.partial({ a: 1 });
    const bound2 = bound1.partial({ c: 3 });
    expect(bound2.params).toHaveLength(1);
    expect(bound2.params[0].name).toBe("b");
  });

  it("throws when re-binding an already-bound param", () => {
    const fn = makeFunction("add", [
      { name: "a", hasDefault: false, defaultValue: undefined, variadic: false },
      { name: "b", hasDefault: false, defaultValue: undefined, variadic: false },
    ]);
    const bound = fn.partial({ a: 5 });
    expect(() => bound.partial({ a: 10 })).toThrow("already bound");
  });

  it("throws when binding a variadic param", () => {
    const fn = makeFunction("print", [
      { name: "messages", hasDefault: false, defaultValue: undefined, variadic: true },
    ]);
    expect(() => fn.partial({ messages: ["hi"] })).toThrow("Variadic parameter");
  });

  it("invoke on bound function merges args correctly", async () => {
    const impl = (a: number, b: number, c: number) => a + b + c;
    const fn = AgencyFunction.create({
      name: "add3",
      module: "test",
      fn: impl,
      params: [
        { name: "a", hasDefault: false, defaultValue: undefined, variadic: false },
        { name: "b", hasDefault: false, defaultValue: undefined, variadic: false },
        { name: "c", hasDefault: false, defaultValue: undefined, variadic: false },
      ],
      toolDefinition: null,
    }, {});
    const bound = fn.partial({ a: 10 });
    const result = await bound.invoke({ type: "positional", args: [20, 30] });
    expect(result).toBe(60);
  });

  it("strips @param lines from tool description", () => {
    const fn = AgencyFunction.create({
      name: "readFile",
      module: "test",
      fn: () => {},
      params: [
        { name: "dir", hasDefault: false, defaultValue: undefined, variadic: false },
        { name: "filename", hasDefault: false, defaultValue: undefined, variadic: false },
      ],
      toolDefinition: {
        name: "readFile",
        description: "Read a file.\n@param dir - The directory\n@param filename - The file",
        schema: {},
      },
    }, {});
    const bound = fn.partial({ dir: "/foo" });
    expect(bound.toolDefinition!.description).toBe("Read a file.\n@param filename - The file");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/runtime/agencyFunction.test.ts 2>&1 | tee /tmp/claude/af-partial-1.txt`
Expected: FAIL — `.partial()` not defined

- [ ] **Step 3: Implement `.partial()` method**

Add to `AgencyFunction` class in `lib/runtime/agencyFunction.ts`:

```typescript
partial(bindings: Record<string, unknown>): AgencyFunction {
  const originalParams = this.getOriginalParams();
  const boundNames = Object.keys(bindings);

  // Validate: no unknown param names
  for (const name of boundNames) {
    const index = originalParams.findIndex(p => p.name === name);
    if (index === -1) {
      throw new Error(`Unknown parameter '${name}' in .partial() call`);
    }
  }

  // Validate: no re-binding of already-bound params
  if (this.boundArgs) {
    for (const name of boundNames) {
      const origIndex = originalParams.findIndex(p => p.name === name);
      if (this.boundArgs.indices.includes(origIndex)) {
        throw new Error(`Parameter '${name}' is already bound`);
      }
    }
  }

  // Validate: variadic params cannot be bound
  for (const name of boundNames) {
    const param = originalParams.find(p => p.name === name);
    if (param?.variadic) {
      throw new Error(`Variadic parameter '${name}' cannot be bound`);
    }
  }

  // Map param names to indices
  const boundIndices: number[] = [];
  const boundValues: unknown[] = [];
  for (const [name, value] of Object.entries(bindings)) {
    const index = originalParams.findIndex(p => p.name === name);
    boundIndices.push(index);
    boundValues.push(value);
  }

  // Compute cumulative bound state
  const allBoundIndices = this.boundArgs
    ? [...this.boundArgs.indices, ...boundIndices]
    : boundIndices;
  const allBoundValues = this.boundArgs
    ? [...this.boundArgs.values, ...boundValues]
    : boundValues;

  const originalParamCount = this.boundArgs
    ? this.boundArgs.originalParamCount
    : this.params.length;

  // Compute remaining unbound params
  const unboundParams = originalParams.filter(
    (_, i) => !allBoundIndices.includes(i)
  );

  // Build reduced schema if tool definition exists
  const newToolDef = this.toolDefinition
    ? {
        ...this.toolDefinition,
        description: stripBoundParams(this.toolDefinition.description, boundNames),
        schema: buildReducedSchema(this.toolDefinition.schema, unboundParams),
      }
    : null;

  return new AgencyFunction({
    name: this.name,
    module: this.module,
    fn: this._fn,
    params: unboundParams,
    toolDefinition: newToolDef,
    boundArgs: {
      indices: allBoundIndices,
      values: allBoundValues,
      originalParamCount,
      originalParams,
    },
  });
}
```

Also add a `buildReducedSchema` helper (can be a standalone function in the same file or imported). Add `import { z } from "zod"` at the top of the file:

```typescript
function buildReducedSchema(
  originalSchema: any,
  unboundParams: FuncParam[]
): any {
  if (!originalSchema || !originalSchema.shape) return originalSchema;
  const unboundNames = new Set(unboundParams.map(p => p.name));
  const shape = originalSchema.shape;
  const reducedShape: Record<string, any> = {};
  for (const [key, value] of Object.entries(shape)) {
    if (unboundNames.has(key)) {
      reducedShape[key] = value;
    }
  }
  return z.object(reducedShape);
}
```

Also update `invoke()` to handle bound args:

```typescript
async invoke(descriptor: CallType, state?: unknown): Promise<unknown> {
  if (this.boundArgs) {
    const callArgs = this.resolveArgs(descriptor);
    const fullArgs = this.mergeWithBound(callArgs);
    return this._fn(...fullArgs, state);
  }
  const args = this.resolveArgs(descriptor);
  return this._fn(...args, state);
}

private mergeWithBound(unboundArgs: unknown[]): unknown[] {
  const totalParams = this.boundArgs!.originalParamCount;
  const fullArgs: unknown[] = new Array(totalParams);
  let unboundIdx = 0;

  for (let i = 0; i < totalParams; i++) {
    const boundPos = this.boundArgs!.indices.indexOf(i);
    if (boundPos !== -1) {
      fullArgs[i] = this.boundArgs!.values[boundPos];
    } else {
      fullArgs[i] = unboundArgs[unboundIdx++];
    }
  }
  return fullArgs;
}
```

Don't forget to import `stripBoundParams` at the top:

```typescript
import { stripBoundParams } from "./stripBoundParams";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/runtime/agencyFunction.test.ts 2>&1 | tee /tmp/claude/af-partial-2.txt`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/agencyFunction.ts lib/runtime/agencyFunction.test.ts
git commit -m "feat: implement .partial() method on AgencyFunction"
```

---

## Task 4: Implement `.describe()` method

**Files:**
- Modify: `lib/runtime/agencyFunction.ts`
- Modify: `lib/runtime/agencyFunction.test.ts`

- [ ] **Step 1: Write failing tests for `.describe()`**

Add to `lib/runtime/agencyFunction.test.ts`:

```typescript
describe("describe()", () => {
  it("returns new AgencyFunction with updated description", () => {
    const fn = AgencyFunction.create({
      name: "readFile",
      module: "test",
      fn: () => {},
      params: [
        { name: "filename", hasDefault: false, defaultValue: undefined, variadic: false },
      ],
      toolDefinition: {
        name: "readFile",
        description: "Original description",
        schema: {},
      },
    }, {});
    const described = fn.describe("New description");
    expect(described.toolDefinition!.description).toBe("New description");
    expect(fn.toolDefinition!.description).toBe("Original description");
  });

  it("works on function without toolDefinition", () => {
    const fn = AgencyFunction.create({
      name: "readFile",
      module: "test",
      fn: () => {},
      params: [],
      toolDefinition: null,
    }, {});
    const described = fn.describe("New description");
    expect(described.toolDefinition!.description).toBe("New description");
    expect(described.toolDefinition!.name).toBe("readFile");
  });

  it("does not mutate original", () => {
    const fn = AgencyFunction.create({
      name: "foo",
      module: "test",
      fn: () => {},
      params: [],
      toolDefinition: { name: "foo", description: "old", schema: {} },
    }, {});
    fn.describe("new");
    expect(fn.toolDefinition!.description).toBe("old");
  });

  it("empty string clears description", () => {
    const fn = AgencyFunction.create({
      name: "foo",
      module: "test",
      fn: () => {},
      params: [],
      toolDefinition: { name: "foo", description: "old", schema: {} },
    }, {});
    const described = fn.describe("");
    expect(described.toolDefinition!.description).toBe("");
  });

  it("preserves boundArgs when describing a partial function", () => {
    const fn = AgencyFunction.create({
      name: "add",
      module: "test",
      fn: (a: number, b: number) => a + b,
      params: [
        { name: "a", hasDefault: false, defaultValue: undefined, variadic: false },
        { name: "b", hasDefault: false, defaultValue: undefined, variadic: false },
      ],
      toolDefinition: { name: "add", description: "Add numbers.\n@param a - First\n@param b - Second", schema: {} },
    }, {});
    const bound = fn.partial({ a: 5 });
    const described = bound.describe("Adds 5 to a number");
    expect(described.boundArgs).not.toBeNull();
    expect(described.params).toHaveLength(1);
    expect(described.toolDefinition!.description).toBe("Adds 5 to a number");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/runtime/agencyFunction.test.ts 2>&1 | tee /tmp/claude/af-describe-1.txt`
Expected: FAIL — `.describe()` not defined

- [ ] **Step 3: Implement `.describe()` method**

Add to `AgencyFunction` class:

```typescript
describe(description: string): AgencyFunction {
  const newToolDef = this.toolDefinition
    ? { ...this.toolDefinition, description }
    : { name: this.name, description, schema: null };
  return this.withToolDefinition(newToolDef);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/runtime/agencyFunction.test.ts 2>&1 | tee /tmp/claude/af-describe-2.txt`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/agencyFunction.ts lib/runtime/agencyFunction.test.ts
git commit -m "feat: implement .describe() method on AgencyFunction"
```

---

## Task 5: Update `FunctionRefReviver` for bound functions

**Files:**
- Modify: `lib/runtime/revivers/functionRefReviver.ts`
- Create or modify: test file for functionRefReviver (check if one exists; if not, add tests to `agencyFunction.test.ts`)

- [ ] **Step 1: Write failing tests for serialization round-trip**

Add to `lib/runtime/agencyFunction.test.ts`:

```typescript
import { FunctionRefReviver } from "./revivers/functionRefReviver";

describe("FunctionRefReviver with bound functions", () => {
  it("serializes bound function with boundArgs", () => {
    const registry: Record<string, AgencyFunction> = {};
    const fn = AgencyFunction.create({
      name: "add",
      module: "test",
      fn: (a: number, b: number) => a + b,
      params: [
        { name: "a", hasDefault: false, defaultValue: undefined, variadic: false },
        { name: "b", hasDefault: false, defaultValue: undefined, variadic: false },
      ],
      toolDefinition: null,
    }, registry);
    const bound = fn.partial({ a: 5 });
    const reviver = new FunctionRefReviver();
    reviver.registry = registry;

    const serialized = reviver.serialize(bound);
    expect(serialized.name).toBe("add");
    expect(serialized.module).toBe("test");
    expect(serialized.boundArgs).toBeDefined();
    expect(serialized.boundArgs.indices).toEqual([0]);
    expect(serialized.boundArgs.values).toEqual([5]);
  });

  it("revives bound function from serialized data", () => {
    const registry: Record<string, AgencyFunction> = {};
    const fn = AgencyFunction.create({
      name: "add",
      module: "test",
      fn: (a: number, b: number) => a + b,
      params: [
        { name: "a", hasDefault: false, defaultValue: undefined, variadic: false },
        { name: "b", hasDefault: false, defaultValue: undefined, variadic: false },
      ],
      toolDefinition: null,
    }, registry);
    const reviver = new FunctionRefReviver();
    reviver.registry = registry;

    const serialized = {
      name: "add",
      module: "test",
      boundArgs: {
        indices: [0],
        values: [5],
        originalParamCount: 2,
        originalParams: fn.params,
      },
    };
    const revived = reviver.revive(serialized);
    expect(revived.params).toHaveLength(1);
    expect(revived.params[0].name).toBe("b");
    expect(revived.boundArgs).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/runtime/agencyFunction.test.ts 2>&1 | tee /tmp/claude/reviver-1.txt`
Expected: FAIL

- [ ] **Step 3: Update FunctionRefReviver**

Modify `lib/runtime/revivers/functionRefReviver.ts`:

**`serialize()`**: Include `boundArgs` if present:

```typescript
serialize(value: AgencyFunction) {
  const result: any = { name: value.name, module: value.module };
  if (value.boundArgs) {
    result.boundArgs = value.boundArgs;
  }
  return result;
}
```

**`validate()`**: Accept records with or without `boundArgs`:

```typescript
validate(data: unknown): data is { name: string; module: string; boundArgs?: BoundArgs } {
  if (typeof data !== "object" || data === null) return false;
  const d = data as any;
  return typeof d.name === "string" && typeof d.module === "string";
}
```

**`revive()`**: Look up original function, then apply `.partial()` if `boundArgs` present:

```typescript
revive(data: { name: string; module: string; boundArgs?: any }): AgencyFunction {
  const key = `${data.module}::${data.name}`;
  const original = this.registry[key] ?? this.registry[data.name];
  if (!original) {
    throw new Error(`Cannot revive function ref: ${key} not found in registry`);
  }
  if (data.boundArgs) {
    // Rebuild bindings from stored indices and values
    const bindings: Record<string, unknown> = {};
    const originalParams = data.boundArgs.originalParams;
    for (let i = 0; i < data.boundArgs.indices.length; i++) {
      const paramIndex = data.boundArgs.indices[i];
      const paramName = originalParams[paramIndex].name;
      bindings[paramName] = data.boundArgs.values[i];
    }
    return original.partial(bindings);
  }
  return original;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/runtime/agencyFunction.test.ts 2>&1 | tee /tmp/claude/reviver-2.txt`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/revivers/functionRefReviver.ts lib/runtime/agencyFunction.test.ts
git commit -m "feat: support bound function serialization in FunctionRefReviver"
```

---

## Task 6: Known TypeScript Registry

**Files:**
- Create: `lib/knownRegistry.ts`
- Modify: `lib/backends/typescriptBuilder.ts` — consult registry for method calls

- [ ] **Step 1: Create the registry data structure**

```typescript
// lib/knownRegistry.ts
export type ParamDef = {
  name: string;
  type: string;
};

export type KnownSignature = {
  params: ParamDef[];
  returnType: string;
};

export type KnownRegistry = {
  functions: Record<string, KnownSignature>;
  methods: Record<string, Record<string, KnownSignature>>;
};

export const knownRegistry: KnownRegistry = {
  functions: {},
  methods: {
    AgencyFunction: {
      partial: {
        params: [{ name: "bindings", type: "Record<string, any>" }],
        returnType: "AgencyFunction",
      },
      describe: {
        params: [{ name: "description", type: "string" }],
        returnType: "AgencyFunction",
      },
    },
  },
};

/**
 * Check if a method call on a given type should be compiled as a direct method call.
 */
export function isRegisteredMethod(typeName: string, methodName: string): boolean {
  return !!knownRegistry.methods[typeName]?.[methodName];
}

/**
 * Check if a function is registered as a known function.
 */
export function isRegisteredFunction(name: string): boolean {
  return !!knownRegistry.functions[name];
}
```

- [ ] **Step 2: Update builder to consult registry for method calls**

In `lib/backends/typescriptBuilder.ts`, find where method calls are processed (the section that emits `__callMethod`). When processing a method call expression like `foo.partial(...)` or `foo.describe(...)`:

1. Check if the method name is in the registry for `AgencyFunction` type
2. If yes, emit a direct method call with named args compiled to object literal
3. If no, fall through to existing `__callMethod` behavior

The exact location and code depends on how method calls are currently handled in the builder. Look at how `__callMethod` is emitted and add a check before it:

```typescript
// Pseudocode for the builder change:
if (isMethodCall && isRegisteredMethod("AgencyFunction", methodName)) {
  // Compile named args to object literal
  // Emit: receiver.methodName({ key1: val1, key2: val2 })
  // instead of: __callMethod(receiver, "methodName", args)
}
```

Note: The implementer will need to read the builder code around `__callMethod` usage to find the exact insertion point. Search for `__callMethod` in typescriptBuilder.ts.

- [ ] **Step 3: Run existing tests to verify nothing broke**

Run: `pnpm vitest run 2>&1 | tee /tmp/claude/registry-1.txt`
Expected: All existing tests PASS

- [ ] **Step 4: Commit**

```bash
git add lib/knownRegistry.ts lib/backends/typescriptBuilder.ts
git commit -m "feat: add Known TypeScript Registry, compile .partial/.describe as direct method calls"
```

---

## Task 7: Typechecker — validate `.partial()` and `.describe()`

**Files:**
- Modify: `lib/typeChecker/index.ts`
- Modify: `lib/typeChecker/builtins.ts` (or create a new file for registry-based validation)

Note: Per the spec, typechecker work must come BEFORE pipe operator changes so that pipe stages with wrong number of unbound params are caught immediately when `?` is removed.

- [ ] **Step 1: Understand how the typechecker tracks function types**

Read `lib/typeChecker/index.ts`. The typechecker needs to know when a variable holds an `AgencyFunction`. This happens when:
- A variable is assigned from a function definition (e.g., `const fn = add`)
- A variable is assigned from an import of an Agency function
- A variable is assigned from a `.partial()` or `.describe()` call (returns `AgencyFunction`)

Find where method calls / property access (`valueAccess` nodes with method calls) are typechecked. Check how the typechecker resolves the type of the receiver expression.

- [ ] **Step 2: Add typechecker validation for registered methods**

When the typechecker encounters a method call:

1. If the receiver is known to be an `AgencyFunction` (function definition, import, or result of another `.partial()` call) and the method is in the registry → valid
2. If the receiver is not an `AgencyFunction` and the method is `.partial()` or `.describe()` → type error
3. For `.partial()` specifically:
   - Validate that the named arg keys are valid param names on the receiver function
   - Validate that variadic params are not being bound
   - Validate that `.partial()` is not being called on an imported TypeScript function
   - The return type is an `AgencyFunction` with reduced params (track this for chained calls)

Import and use `isRegisteredMethod` from `lib/knownRegistry.ts`.

- [ ] **Step 3: Add pipe stage validation**

The typechecker should verify that each pipe stage resolves to a function with exactly one unbound parameter. If a stage is a `.partial()` call, count the remaining unbound params and error if != 1. If a stage is a bare function reference, verify it has exactly one param.

- [ ] **Step 4: Run typechecker tests**

Run: `pnpm vitest run lib/typeChecker/ 2>&1 | tee /tmp/claude/tc-1.txt`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add lib/typeChecker/
git commit -m "feat: typechecker validation for .partial() and .describe() methods"
```

---

## Task 8: Update builder for `.partial()` in pipe expressions

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts` (around lines 3047-3183)
- Modify: pipe-related test fixtures in `tests/typescriptGenerator/`

- [ ] **Step 1: Understand current pipe implementation**

Read `lib/backends/typescriptBuilder.ts` lines 3047-3183 (`buildPipeBind`, `buildPipeLambda`, `buildPipeStageBody`). Currently, pipe stages with `?` are handled by `buildPipeLambda` which creates a lambda wrapping the call with the placeholder replaced by the piped value.

With the new design, pipe stages can be:
- A bare function reference: `success(10) |> half` — already works, the builder emits a reference and `__pipeBind` calls it
- A `.partial()` call: `success(10) |> divide.partial(b: 3)` — the builder emits the `.partial()` call (producing an `AgencyFunction`), and `__pipeBind` invokes the result

Key implementation note: The current pipe builder detects placeholder nodes (`stage.type === "placeholder"`) in function call arguments to build lambdas. For `.partial()` stages, the AST will be a `valueAccess` node (property access + method call). The builder should:
1. Check if the pipe stage is a registered method call (`.partial()`) on a `valueAccess` node
2. If so, emit the `.partial()` call directly — the result is an `AgencyFunction` that `__pipeBind` can invoke with the piped value
3. The `__pipeBind` runtime function (in `lib/runtime/result.ts`) already calls functions with a single argument — it should also handle `AgencyFunction.invoke()`. Update `__pipeBind` to detect `AgencyFunction` instances and call `.invoke()` instead of calling directly.

- [ ] **Step 2: Update `__pipeBind` runtime to handle AgencyFunction**

In `lib/runtime/result.ts`, update `__pipeBind` (line 81-94) to detect when the function is an `AgencyFunction` and invoke it correctly:

```typescript
// In __pipeBind, when calling the function:
if (AgencyFunction.isAgencyFunction(fn)) {
  return fn.invoke({ type: "positional", args: [value] });
} else {
  return fn(value);
}
```

- [ ] **Step 3: Remove `?` placeholder support in pipe stages**

Update `buildPipeLambda()` to:
1. Keep support for bare function references (`half`)
2. Add support for `.partial()` calls as pipe stages (emit the method call directly)
3. Remove the `?` placeholder handling branch — when a `placeholder` node is found in a pipe stage function call, emit an error or fall through to the registered method call path

Also add an error in the builder (around line 886 where the existing placeholder validation error lives) for any remaining `?` usage in pipe expressions, directing users to use `.partial()` instead.

- [ ] **Step 4: Update pipe fixture tests**

Update `tests/typescriptGenerator/pipe-operator.agency` to use `.partial()` instead of `?`:

```
// Old: success(5) |> multiply(10, ?)
// New: success(5) |> multiply.partial(a: 10)
```

Also create a new fixture `tests/typescriptGenerator/partial-in-pipe.agency` showing:
- `.partial()` as pipe stage
- Chained pipes with `.partial()` stages
- Bare function + `.partial()` mixed

- [ ] **Step 5: Rebuild fixtures and run tests**

Run: `make fixtures 2>&1 | tee /tmp/claude/pipe-fixtures.txt && pnpm vitest run 2>&1 | tee /tmp/claude/pipe-tests.txt`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add lib/backends/typescriptBuilder.ts lib/runtime/result.ts tests/typescriptGenerator/
git commit -m "feat: update pipe operator to use .partial() instead of ? placeholders"
```

---

## Task 9: Integration tests

**Files:**
- Create: `tests/agency/partial-application.agency`
- Create: `tests/agency/partial-application-interrupt.agency`
- Create: `tests/agency/partial-application-pipe.agency`
- Create: `tests/typescriptGenerator/partial-application.agency` + `.mts` fixture

- [ ] **Step 1: Write basic agency execution tests**

Create `tests/agency/partial-application.agency`:

```
def add(a: number, b: number): number {
  return a + b
}

def add3(a: number, b: number, c: number): number {
  return a + b + c
}

// Test 1: basic partial application
node testBasic() {
  const add5 = add.partial(a: 5)
  return add5(7)
}
// Expected: 12

// Test 2: chain two .partial() calls
node testChained() {
  const add5 = add3.partial(a: 5)
  const add5and2 = add5.partial(b: 2)
  return add5and2(10)
}
// Expected: 17

// Test 3: .partial() then .describe()
node testDescribe() {
  const tool = add.partial(a: 5).describe("Adds 5 to a number")
  return tool(3)
}
// Expected: 8

// Test 4: .partial() in global scope
const globalAdd5 = add.partial(a: 5)

node testGlobal() {
  return globalAdd5(10)
}
// Expected: 15
```

- [ ] **Step 2: Write interrupt survival test**

Create `tests/agency/partial-application-interrupt.agency`:

```
def guardedAction(dir: string, filename: string): string {
  return interrupt("Are you sure you want to read ${dir}/${filename}?")
  return "${dir}/${filename}"
}

node main() {
  const tool = guardedAction.partial(dir: "/safe")
  handle {
    return tool("secret.txt")
  } with (data) {
    return approve()
  }
}
// Expected: "/safe/secret.txt"
```

This tests that a partially applied function survives serialization/deserialization through an interrupt.

- [ ] **Step 3: Write pipe integration test**

Create `tests/agency/partial-application-pipe.agency`:

```
def multiply(a: number, b: number): Result {
  return success(a * b)
}

def half(x: number): Result {
  return success(x / 2)
}

node main() {
  const result = success(10) |> half |> multiply.partial(a: 3)
  return result
}
// Expected: success(15)
```

- [ ] **Step 4: Write fixture test for generated code**

Create `tests/typescriptGenerator/partial-application.agency`:

```
def add(a: number, b: number): number {
  return a + b
}

node main() {
  const add5 = add.partial(a: 5)
  const described = add5.describe("Adds 5")
  return described(3)
}
```

The corresponding `.mts` fixture will verify the generated TypeScript contains:
- `add.partial({ a: 5 })` (direct method call with object literal)
- `.describe("Adds 5")` (direct method call)

- [ ] **Step 5: Run all integration tests**

Run: `pnpm run agency test tests/agency/partial-application.agency 2>&1 | tee /tmp/claude/integration-1.txt`
Run: `pnpm run agency test tests/agency/partial-application-interrupt.agency 2>&1 | tee /tmp/claude/integration-2.txt`
Run: `pnpm run agency test tests/agency/partial-application-pipe.agency 2>&1 | tee /tmp/claude/integration-3.txt`
Expected: All PASS

- [ ] **Step 6: Rebuild fixtures and verify**

Run: `make fixtures 2>&1 | tee /tmp/claude/fixtures.txt`
Verify that `tests/typescriptGenerator/partial-application.mts` contains the expected generated code.

- [ ] **Step 7: Commit**

```bash
git add tests/agency/ tests/typescriptGenerator/
git commit -m "test: integration tests for partial application, interrupts, pipes, and fixtures"
```

---

## Task 10: Update existing docs and pipe examples

**Files:**
- Modify: `docs-new/guide/error-handling.md` — update pipe examples from `?` to `.partial()`
- Modify: `docs/superpowers/specs/2026-05-04-partial-application-design.md` — add note that this spec is superseded
- Modify: any other docs referencing pipe `?` syntax

- [ ] **Step 1: Update error-handling.md pipe examples**

Replace all `divide(?, 3)` style pipe syntax with `divide.partial(b: 3)` style. The `success(10) |> half |> half |> half` examples don't use `?` so they stay as-is. Only update the `divide(?, 3)` example:

```
// Old:
const result = success(10) |> half |> divide(?, 3)

// New:
const result = success(10) |> half |> divide.partial(b: 3)
```

- [ ] **Step 2: Add superseded note to original spec**

Add to the top of `docs/superpowers/specs/2026-05-04-partial-application-design.md`:

```markdown
> **Note:** This spec has been superseded by `2026-05-05-partial-application-capability-constraints-design.md`, which replaces the `?` placeholder syntax with `.partial()` method syntax.
```

- [ ] **Step 3: Commit**

```bash
git add docs-new/guide/error-handling.md docs/superpowers/specs/2026-05-04-partial-application-design.md
git commit -m "docs: update pipe examples to .partial() syntax, mark old spec as superseded"
```

---

## Summary of implementation order

1. **Task 1**: `stripBoundParams()` — standalone, no dependencies
2. **Task 2**: `BoundArgs` type + `withToolDefinition()` — extends AgencyFunction
3. **Task 3**: `.partial()` method — depends on Tasks 1 and 2
4. **Task 4**: `.describe()` method — depends on Task 2
5. **Task 5**: Serialization — depends on Task 3
6. **Task 6**: Known TypeScript Registry + builder — depends on Tasks 3 and 4
7. **Task 7**: Typechecker — depends on Task 6 (must come before pipe changes per spec)
8. **Task 8**: Pipe operator update — depends on Tasks 6 and 7
9. **Task 9**: Integration tests — depends on Tasks 8
10. **Task 10**: Doc updates — can happen anytime after Task 8
