# Type Imports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Agency `type` declarations compile to runtime Zod schema values so types can be imported across files.

**Architecture:** Change `processTypeAlias` to emit `const Foo = z.<schema>()` + `type Foo = z.infer<typeof Foo>`, and change `mapTypeToSchema` to reference type alias names directly instead of inlining expanded schemas. No parser, preprocessor, symbol table, or type checker changes needed.

**Tech Stack:** TypeScript, Zod, Vitest

**Spec:** `docs/superpowers/specs/2026-04-23-type-imports-design.md`

---

### Task 1: Change `mapTypeToSchema` to emit type alias names directly

The `typeAliasVariable` case currently looks up the alias in `typeAliases` and recursively expands it into an inline schema. Change it to return the alias name as a direct reference to the Zod schema const.

**Files:**
- Modify: `lib/backends/typescriptGenerator/typeToZodSchema.ts:70-77`

- [ ] **Step 1: Write unit test for the new behavior**

Create a test file `lib/backends/typescriptGenerator/typeToZodSchema.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mapTypeToZodSchema, mapTypeToValidationSchema } from "./typeToZodSchema.js";
import { VariableType } from "../../types.js";

describe("mapTypeToZodSchema", () => {
  it("should return the alias name directly for typeAliasVariable", () => {
    const variableType: VariableType = {
      type: "typeAliasVariable",
      aliasName: "MathResult",
    };
    const typeAliases = {
      MathResult: {
        type: "objectType" as const,
        properties: [{ key: "answer", value: { type: "primitiveType" as const, value: "number" } }],
      },
    };
    const result = mapTypeToZodSchema(variableType, typeAliases);
    expect(result).toBe("MathResult");
  });

  it("should return the alias name in nested contexts", () => {
    const variableType: VariableType = {
      type: "objectType",
      properties: [
        { key: "result", value: { type: "typeAliasVariable" as const, aliasName: "Coords" } },
      ],
    };
    const typeAliases = {
      Coords: {
        type: "objectType" as const,
        properties: [
          { key: "x", value: { type: "primitiveType" as const, value: "number" } },
          { key: "y", value: { type: "primitiveType" as const, value: "number" } },
        ],
      },
    };
    const result = mapTypeToZodSchema(variableType, typeAliases);
    expect(result).toBe(`z.object({ "result": Coords })`);
  });

  it("should return the alias name inside an array type", () => {
    const variableType: VariableType = {
      type: "arrayType",
      elementType: { type: "typeAliasVariable" as const, aliasName: "Item" },
    };
    const typeAliases = {
      Item: {
        type: "objectType" as const,
        properties: [{ key: "name", value: { type: "primitiveType" as const, value: "string" } }],
      },
    };
    const result = mapTypeToZodSchema(variableType, typeAliases);
    expect(result).toBe("z.array(Item)");
  });

  it("should return the alias name inside a union type", () => {
    const variableType: VariableType = {
      type: "unionType",
      types: [
        { type: "typeAliasVariable" as const, aliasName: "Foo" },
        { type: "primitiveType" as const, value: "number" },
      ],
    };
    const typeAliases = {
      Foo: { type: "primitiveType" as const, value: "string" },
    };
    const result = mapTypeToZodSchema(variableType, typeAliases);
    expect(result).toBe("z.union([Foo, z.number()])");
  });
});

describe("mapTypeToValidationSchema", () => {
  it("should return the alias name directly for typeAliasVariable", () => {
    const variableType: VariableType = {
      type: "typeAliasVariable",
      aliasName: "Category",
    };
    const typeAliases = {
      Category: {
        type: "unionType" as const,
        types: [
          { type: "stringLiteralType" as const, value: "bug" },
          { type: "stringLiteralType" as const, value: "feature" },
        ],
      },
    };
    const result = mapTypeToValidationSchema(variableType, typeAliases);
    expect(result).toBe("Category");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run -- lib/backends/typescriptGenerator/typeToZodSchema.test.ts`

Expected: FAIL — the current code expands the alias instead of returning the name.

- [ ] **Step 3: Implement the change**

In `lib/backends/typescriptGenerator/typeToZodSchema.ts`, replace the `typeAliasVariable` case (lines 70-77):

```typescript
// Before
} else if (variableType.type === "typeAliasVariable") {
    if (!typeAliases || !typeAliases[variableType.aliasName]) {
      throw new Error(
        `Type alias '${variableType.aliasName}' not found in provided type aliases: ${JSON.stringify(typeAliases)}`,
      );
    }
    return recurse(typeAliases[variableType.aliasName]);
}

// After
} else if (variableType.type === "typeAliasVariable") {
    return variableType.aliasName;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run -- lib/backends/typescriptGenerator/typeToZodSchema.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/backends/typescriptGenerator/typeToZodSchema.ts lib/backends/typescriptGenerator/typeToZodSchema.test.ts
git commit -m "feat: mapTypeToSchema emits type alias name instead of inlining"
```

---

### Task 2: Change `processTypeAlias` to emit Zod schema const + TS type

Currently `processTypeAlias` emits `type Foo = { ... };`. Change it to emit `const Foo = z.object({ ... }); type Foo = z.infer<typeof Foo>;`.

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts:840-845`

- [ ] **Step 1: Update `processTypeAlias`**

In `lib/backends/typescriptBuilder.ts`, replace the `processTypeAlias` method:

```typescript
// Before
private processTypeAlias(node: TypeAlias): TsNode {
    const exportPrefix = node.exported ? "export " : "";
    return ts.raw(
      `${exportPrefix}type ${node.aliasName} = ${formatTypeHint(node.aliasedType)};`,
    );
}

// After
private processTypeAlias(node: TypeAlias): TsNode {
    const exportPrefix = node.exported ? "export " : "";
    const zodSchema = mapTypeToZodSchema(node.aliasedType, this.getVisibleTypeAliases());
    return ts.statements([
      ts.raw(`${exportPrefix}const ${node.aliasName} = ${zodSchema};`),
      ts.raw(`${exportPrefix}type ${node.aliasName} = z.infer<typeof ${node.aliasName}>;`),
    ]);
}
```

Note: `mapTypeToZodSchema` and `ts.statements` are already imported/available in this file.

- [ ] **Step 2: Run unit tests to check for breakage**

Run: `pnpm test:run -- lib/backends/typescriptBuilder`

Expected: Some integration fixture tests may fail because the expected output has changed. That's expected — we'll update fixtures in Task 3.

- [ ] **Step 3: Commit**

```bash
git add lib/backends/typescriptBuilder.ts
git commit -m "feat: processTypeAlias emits const Zod schema + z.infer type"
```

---

### Task 3: Update generator test fixtures

Three fixtures reference type aliases and will have changed output. Regenerate them with `make fixtures` and verify the new output is correct.

**Files:**
- Update: `tests/typescriptGenerator/types/typeAlias.mjs`
- Update: `tests/typescriptGenerator/schemaAccess.mjs`
- Update: `tests/typescriptGenerator/bangValidation.mjs`

- [ ] **Step 1: Regenerate all fixtures**

Run: `make fixtures`

- [ ] **Step 2: Verify `typeAlias.mjs` changes**

Check that:
- Old: `type Coords = { x: number, y: number };`
- New: `const Coords = z.object({ "x": z.number(), "y": z.number() });` and `type Coords = z.infer<typeof Coords>;`
- The LLM call site now uses `Coords` instead of `z.object({ "x": z.number(), "y": z.number() })`

- [ ] **Step 3: Verify `schemaAccess.mjs` changes**

Check that:
- Old: `type Category = "bug" | "feature" | "docs";`
- New: `const Category = z.union([...]);` and `type Category = z.infer<typeof Category>;`
- The `schema()` call site now uses `Category` instead of the inline union

- [ ] **Step 4: Verify `bangValidation.mjs` changes**

Check that:
- Old: `type Category = "bug" | "feature" | "docs";`
- New: `const Category = z.union([...]);` and `type Category = z.infer<typeof Category>;`
- The `__validateType` call site now uses `Category` instead of the inline union

- [ ] **Step 5: Run all integration tests**

Run: `pnpm test:run`

Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add tests/typescriptGenerator/
git commit -m "fix: update generator fixtures for type-as-zod-schema change"
```

---

### Task 4: Verify the existing type import test passes

The test at `tests/agency/imports/typeImport.agency` currently fails because the compiled JS tries to import a type that doesn't exist as a JS value. With our changes, `MathResult` is now exported as a `const` from the compiled `agencyHelpers.js`, so the import should resolve.

**Files:**
- Verify: `tests/agency/imports/typeImport.agency`
- Verify: `tests/agency/imports/agencyHelpers.agency`
- Update: `tests/agency/imports/typeImport.js` (compiled output — agency execution tests use pre-compiled `.js` files)
- Update: `tests/agency/imports/agencyHelpers.js` (compiled output for the helper file)

- [ ] **Step 1: Build the compiler**

Run: `make all`

This ensures the compiler itself is up to date with our changes from Tasks 1-2.

- [ ] **Step 2: Recompile both agency files**

Run: `pnpm run compile tests/agency/imports/agencyHelpers.agency`
Run: `pnpm run compile tests/agency/imports/typeImport.agency`

Both `.js` files will be regenerated. The key changes to verify:
- `agencyHelpers.js` now has `export const MathResult = z.object({ "answer": z.number() });` instead of `export type MathResult = ...`
- `typeImport.js` imports `MathResult` and uses it in the response format (not an inline expansion)

- [ ] **Step 3: Run the type import test**

Run: `pnpm run agency test tests/agency/imports/typeImport.test.json`

Expected: PASS — the test should now work end-to-end.

- [ ] **Step 4: Commit the updated compiled output**

```bash
git add tests/agency/imports/
git commit -m "fix: type import test now passes with runtime Zod schema values"
```

---

### Task 5: Add a test for nested type alias references

Verify that a type referencing another type alias emits the correct schema (referencing the other type's const, not inlining it).

**Files:**
- Create: `tests/typescriptGenerator/types/nestedTypeAlias.agency`

- [ ] **Step 1: Create the test fixture**

Create `tests/typescriptGenerator/types/nestedTypeAlias.agency`:

```
type Name = string

type User = {
  name: Name;
  age: number
}

node main() {
  const user: User = llm("give me a user")
  print(user)
}
```

- [ ] **Step 2: Generate the expected output**

Run: `make fixtures`

- [ ] **Step 3: Verify the output**

Check that `nestedTypeAlias.mjs` contains:
- `const Name = z.string();`
- `const User = z.object({ "name": Name, "age": z.number() });`
- The LLM call uses `User` in the response format, not an inline expansion

- [ ] **Step 4: Run tests**

Run: `pnpm test:run`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/typescriptGenerator/types/nestedTypeAlias.agency tests/typescriptGenerator/types/nestedTypeAlias.mjs
git commit -m "test: add fixture for nested type alias references"
```

---

### Task 6: Add a test for exported type imports

Add a generator fixture that verifies exported types emit `export const` + `export type`.

**Files:**
- Create: `tests/typescriptGenerator/types/exportedTypeAlias.agency`

- [ ] **Step 1: Create the test fixture**

Create `tests/typescriptGenerator/types/exportedTypeAlias.agency`:

```
export type Color = "red" | "green" | "blue"

node main() {
  const c: Color = llm("pick a color")
  print(c)
}
```

- [ ] **Step 2: Generate the expected output**

Run: `make fixtures`

- [ ] **Step 3: Verify the output**

Check that `exportedTypeAlias.mjs` contains:
- `export const Color = z.union([z.literal("red"), z.literal("green"), z.literal("blue")]);`
- `export type Color = z.infer<typeof Color>;`

- [ ] **Step 4: Run tests**

Run: `pnpm test:run`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/typescriptGenerator/types/exportedTypeAlias.agency tests/typescriptGenerator/types/exportedTypeAlias.mjs
git commit -m "test: add fixture for exported type alias"
```
