# Type Imports: Types as Runtime Zod Schema Values

## Problem

Agency type aliases (`type Foo = { ... }`) currently compile to TypeScript type declarations, which are erased at JavaScript runtime. This means:

- Importing a type from another `.agency` file generates a JS import for a value that doesn't exist, crashing at runtime
- Zod schemas are inlined at every call site by resolving the type's AST at compile time
- Types can't be passed around as runtime values

## Solution

Every Agency `type` declaration emits both a runtime Zod schema value and a TypeScript type:

```typescript
// Agency source
type MathResult = {
  answer: number
}

// Generated TypeScript
const MathResult = z.object({ answer: z.number() });
type MathResult = z.infer<typeof MathResult>;
```

For exported types, both get `export`:

```typescript
export const MathResult = z.object({ answer: z.number() });
export type MathResult = z.infer<typeof MathResult>;
```

This is valid TypeScript because a `const` and a `type` can share the same name (they exist in different namespaces).

## Design

### 1. Code Generation for Type Aliases

**File:** `lib/backends/typescriptBuilder.ts` — `processTypeAlias`

Change from emitting `type Foo = ...` to emitting `const Foo = z.<schema>(...)` + `type Foo = z.infer<typeof Foo>`.

Uses `mapTypeToZodSchema` from `lib/backends/typescriptGenerator/typeToZodSchema.ts` to generate the Zod schema string.

### 2. Schema Reference at Call Sites

**File:** `lib/backends/typescriptGenerator/typeToZodSchema.ts`

When `mapTypeToSchema` encounters a `typeAliasVariable`, instead of recursively expanding the type's structure into an inline schema, it emits the variable name directly.

The core change is in the `typeAliasVariable` case in `mapTypeToSchema` (line ~70):

```typescript
// Before: recursively expands the type
} else if (variableType.type === "typeAliasVariable") {
    if (!typeAliases || !typeAliases[variableType.aliasName]) {
      throw new Error(...);
    }
    return recurse(typeAliases[variableType.aliasName]);
}

// After: emits the variable name as a reference to the Zod schema const
} else if (variableType.type === "typeAliasVariable") {
    return variableType.aliasName;
}
```

The `typeAliases` map is no longer needed in `mapTypeToZodSchema` for expansion. It is still needed by the type checker (via `collectProgramInfo`).

Before:
```typescript
responseFormat: z.object({ response: z.object({ "answer": z.number() }) })
```

After:
```typescript
responseFormat: z.object({ response: MathResult })
```

This works because `MathResult` is now a real Zod schema value in scope, whether defined locally or imported.

The same applies to all validation sites (`Type!`, `schema(Type)`, function parameter validation) — anywhere that calls `mapTypeToZodSchema` or `mapTypeToValidationSchema`.

**Nested type aliases work transitively.** For example:

```
type Name = string
type User = { name: Name; age: number }
```

Generates:

```typescript
const Name = z.string();
const User = z.object({ name: Name, age: z.number() });
```

`User`'s schema references the `Name` const directly.

### 3. Declaration Ordering

Type alias `const` declarations are emitted at the point in the file where the `type` statement appears, which is at the top level of the module. Graph node callbacks and function definitions are registered (not executed) at module load time, so they execute after all top-level statements have run. This means type schema consts are always initialized before any node or function references them at runtime. No reordering is needed.

### 4. Imports

No changes needed to import handling. The compiler already generates `import { MathResult } from "./agencyHelpers.js"` for types imported from other Agency files. This currently crashes because `MathResult` doesn't exist as a JS value. After this change, the compiled file exports `const MathResult = z.object(...)`, so the import resolves correctly.

`collectProgramInfo` currently copies the full `VariableType` AST from imported types into the local `typeAliases` map. This is no longer needed for code generation (schemas are referenced by name), but is kept because the type checker still needs it for cross-file type checking.

### 5. What Doesn't Change

- **Parser** — no syntax changes
- **Symbol table** — already tracks types correctly
- **Type checker** — works from the `VariableType` AST, not generated code
- **Preprocessor** — no changes
- **`collectProgramInfo`** — keep the cross-file type copy for the type checker

## Future Work

- **Self-recursive types** — types that reference themselves (e.g., `type Tree = { value: number; children: Tree[] }`) would need `z.lazy()` wrapping for the self-reference and a `z.ZodType<T>` annotation on the const. Deferred for now.
- **Mutual recursion** — types that reference each other in cycles. Deferred.
