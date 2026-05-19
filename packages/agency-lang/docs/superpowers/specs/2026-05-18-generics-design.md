# Generic Type Parameters for the Agency Type System

**Date:** 2026-05-18
**Status:** Draft

## Motivation

Agency's type system currently has no support for generic type parameters. The only parameterized types are `Result<T, E>` and `Schema<T>`, both special-cased in the parser and type checker. Users cannot define their own parameterized types, and common patterns like `Record<string, "approve" | "reject">` are not expressible.

This design adds user-defined generic type aliases and a built-in `Record<K, V>` type.

## Goals

- Enable `Record<K, V>` syntax with proper zod codegen (`z.record()`)
- Allow users to define generic type aliases: `type Container<T> = { value: T }`
- Support default type parameters: `type Container<T = any> = { value: T }`
- Keep the implementation simple — no inference, no bounds, no higher-kinded types

## Non-Goals (Explicitly Out of Scope)

- **Generic functions** (`def identity<T>(x: T): T`) — requires call-site type argument inference, which is a significantly more complex addition. Natural follow-up once the foundation here is in place; the substitution mechanism built here would be reused directly.
- **Type parameter bounds/constraints** (`<T extends string>`)
- **Higher-kinded types, conditional types, mapped types**
- **`Partial<T>`** — would require mapped type semantics (iterating over properties and making each optional). Could be added later as a built-in generic with special type checker handling, similar to `Record`.

## Design

### 1. AST Representation

One new variant is added to the `VariableType` union in `lib/types/typeHints.ts` (`TypeAliasVariable` is already in the union):

```typescript
// A concrete generic type usage: Record<string, number>, Container<string>
type GenericType = {
  type: "genericType";
  name: string;              // "Record", "Container", "Schema", "Array", etc.
  typeArgs: VariableType[];
};
```

No separate `TypeParameterRef` node is needed — inside a generic alias body, type parameter references (e.g., `T` in `{ value: T }`) parse as `typeAliasVariable` nodes. The type checker distinguishes them from real aliases during substitution.

**Built-in generics:** `Record`, `Schema`, and `Array` are treated as built-in generics. They parse as `genericType` nodes uniformly, and `resolveType` normalizes them:

- `Array<T>` → `{ type: "arrayType", elementType: T }`
- `Schema<T>` → `{ type: "schemaType", inner: T }` (makes the previously synthesis-only `SchemaType` writable in source)
- `Record<K, V>` → stays as `genericType` (survives to codegen)

Normalizing in `resolveType` (not the parser) keeps policy out of the parser.

`TypeAlias` gains optional type parameters:

```typescript
type TypeParam = {
  name: string;
  default?: VariableType;  // e.g., T = any
};

type TypeAlias = BaseNode & {
  type: "typeAlias";
  aliasName: string;
  aliasedType: VariableType;
  typeParams?: TypeParam[];  // NEW
  exported?: boolean;
  docComment?: AgencyMultiLineComment;
};
```

### 2. Parser Changes

**File: `lib/parsers/parsers.ts`**

#### Generic type parser

A new `genericTypeParser` parses `Identifier<Type, Type, ...>`:

```typescript
export const genericTypeParser: Parser<GenericType> = trace(
  "genericTypeParser",
  seqC(
    set("type", "genericType"),
    capture(many1WithJoin(varNameChar), "name"),
    char("<"),
    optionalSpaces,
    capture(
      sepBy1(
        seqR(optionalSpaces, char(","), optionalSpaces),
        lazy(() => variableTypeParser),
      ),
      "typeArgs",
    ),
    optionalSpaces,
    char(">"),
  ),
);
```

**Ordering in `variableTypeParser`:** `genericTypeParser` is placed after `resultTypeParser` (which keeps its dedicated AST node) and before `primitiveTypeParser` / `typeAliasVariableParser`. Since `typeAliasVariableParser` greedily matches any identifier, `genericTypeParser` must come first to catch `Foo<T>` before it gets consumed as a bare alias.

**Ordering in `unionItemParser`:** `genericTypeParser` must also be added to `unionItemParser` (which has its own `or(...)` chain), so that union types containing generics parse correctly (e.g., `Container<string> | null`, `Record<string, number> | undefined`).

#### `Array<T>` (uppercase) parsing

The existing `angleBracketsArrayTypeParser` only matches lowercase `array<T>`. The new `genericTypeParser` will match uppercase `Array<T>` and produce a `genericType` node. **Normalization happens in `resolveType`, not the parser** — the parser stays generic, and `resolveType` rewrites `genericType { name: "Array" }` to `arrayType`. The same approach applies to `Schema<T>` (rewritten to `schemaType`). This keeps the parser policy-free.

#### Type alias parser extension

The `baseTypeAliasParser` is extended to support optional type parameters after the alias name:

```typescript
// Type param: T  or  T = defaultType
const typeParamParser = seqC(
  capture(many1WithJoin(varNameChar), "name"),
  optional(seqC(
    optionalSpaces,
    char("="),
    optionalSpaces,
    capture(lazy(() => variableTypeParser), "default"),
  )),
);
```

This is added to the type alias parser between the alias name capture and the `=` sign, wrapped in optional angle brackets:

```
type Container<T> = { value: T }
type Pair<A, B> = { first: A, second: B }
type StringMap<V = any> = Record<string, V>
```

#### No `TypeParameterRef` in the parser

Inside generic alias bodies, bare identifiers like `T` parse as `typeAliasVariable` (since `typeAliasVariableParser` matches any identifier). The type checker handles distinguishing type parameters from real aliases during substitution. This keeps the parser stateless.

### 3. Type Checker Changes

**File: `lib/typeChecker/assignability.ts` and related files**

#### Substitution mechanism

A new function performs type parameter substitution:

```typescript
function substituteTypeParams(
  body: VariableType,
  typeParams: string[],
  typeArgs: VariableType[],
): VariableType
```

Recursively walks the type tree. When it encounters a `typeAliasVariable` whose `aliasName` matches a type parameter name, it replaces it with the corresponding type argument. When it encounters a `genericType` node, it first substitutes within the `typeArgs`, then resolves the resulting generic (this handles generic aliases used inside other generic alias bodies). All other nodes are recursively rebuilt with substituted children.

**Recursive generics and cycle detection:** Recursive generic aliases like `type Tree<T> = { value: T, children: Tree<T>[] }` must not cause infinite expansion. The rule is: `substituteTypeParams` substitutes type parameters within the body (so `Tree<T>` in the body becomes `Tree<string>` for `Tree<string>`), but does **not** recursively expand `genericType` nodes whose `name` matches an alias currently being resolved. The self-referential node stays as `genericType { name: "Tree", typeArgs: [<substituted>] }` — preserving the type argument. `resolveType` keeps a set of in-progress alias names to detect this. The resulting type is structurally recursive, mirroring how non-generic recursive aliases (e.g., `type Tree = { children: Tree[] }`) already work.

**Enumerating all `VariableType` variants during substitution:** `substituteTypeParams` must recurse into every variant that can contain a `VariableType`:

- `arrayType.elementType`
- `unionType.types[]`
- `objectType.properties[].value`
- `resultType.successType` and `resultType.failureType`
- `schemaType.inner`
- `blockType.params[].typeAnnotation` and `blockType.returnType`
- `functionRefType.params[]` (typed annotations) and `functionRefType.returnType`
- `genericType.typeArgs[]`

Missing any variant will cause silent bugs where type parameters fail to substitute in nested positions.

**Type parameter shadowing:** Type parameters take precedence over type aliases of the same name. If a generic alias `type Foo<T> = Record<string, T>` is defined and a separate `type T = number` also exists, substitution inside `Foo`'s body treats `T` as the type parameter, not the alias. This is enforced by checking type parameter names before falling through to the alias registry in `substituteTypeParams`.

#### Type alias registry change

Currently, the `typeAliases` map passed through the type checker has type `Record<string, VariableType>` — it stores only the alias body. To support generics, this must be extended to carry type parameter metadata:

```typescript
type TypeAliasEntry = {
  body: VariableType;
  typeParams?: TypeParam[];  // undefined for non-generic aliases
};
```

The `typeAliases` parameter throughout the type checker changes from `Record<string, VariableType>` to `Record<string, TypeAliasEntry>`. This affects the signatures of `resolveType`, `isAssignable`, `widenType`, `mapTypeToZodSchema`, `mapTypeToValidationSchema`, `variableTypeToString`, and their call sites. For non-generic aliases, `typeParams` is simply absent — existing behavior is preserved.

#### `resolveType` extension

Currently `resolveType` looks up `typeAliasVariable` in the alias map. It is extended to handle `genericType` nodes:

1. **Built-in `Record<K, V>`:** validate arity (must be 2), validate key type (must be string, number, or literal/union thereof), and return the `genericType` as-is (it survives to codegen).
2. **Built-in `Array<T>`:** validate arity (must be 1), recursively resolve the type arg, return `{ type: "arrayType", elementType: T }`.
3. **Built-in `Schema<T>`:** validate arity (must be 1), recursively resolve the type arg, return `{ type: "schemaType", inner: T }`.
4. **User-defined alias with `typeParams`:** validate arity (accounting for defaults), fill in defaults for omitted args, then call `substituteTypeParams` on the alias body. Track in-progress alias names to handle recursive generics (see Section 3).
5. Otherwise: report an error (unknown generic type, or non-generic type used with type args).

#### `isAssignable` changes

A new case for `genericType`:

- **Record-to-Record:** Two `Record<K, V>` types are assignable if their key and value types are assignable. **`Record<K, V>` is covariant in both K and V** — see "Variance" below.
- **Record-to-object:** `Record<string, V>` is assignable to an `objectType` only when the target is empty `{}` (no properties to check). For non-empty targets, the value types in the record can't be statically known to match the required properties, so this assignment is rejected. This subsumes the existing "object primitive → empty `{}`" rule.
- **Object-to-Record:** An `objectType` is assignable to `Record<string, V>` if all property values are assignable to `V`. An empty object `{}` is assignable to any `Record<string, V>` (vacuously true — no properties to check).
- **Record with literal key union:** `Record<"a" | "b", V>` requires all keys in the union to be present. An `objectType` is assignable to `Record<"a" | "b", V>` only if it has properties for every member of the key union, each with values assignable to `V`.

User-defined generics will already be resolved to concrete types by `resolveType` before assignability is checked, so no additional handling is needed for them.

**Variance (deliberate decision):** `Record<K, V>` is **covariant in both K and V**, matching TypeScript and Java. This is technically unsound for mutable records — a value of `Record<string, "approve">` can be assigned to `Record<string, string>`, and a write through the wider alias can corrupt the narrower alias. In practice this rarely matters for Agency's use cases (agent workflows, configs, vote tallies), and the ergonomic win of "obvious assignments just work" outweighs the cost. Document this tradeoff in `docs/site/guide/types.md` with an example. If exhaustiveness checking on record values is later added and surfaces real bugs, revisit and tighten to invariance in V.

#### Synthesizer changes for Record

**File: `lib/typeChecker/synthesizer.ts`**

Property access and index access on `Record<K, V>` values return the value type `V`:

- `record.foo` → `V`
- `record["bar"]` → `V`
- `for (key in record)` → key type is `K`

#### Other type checker updates

Each of these gets a `genericType` case:

- **`widenType`** (`assignability.ts`): widen each type arg
- **`visitTypes`** (`typeWalker.ts`): visit each type arg
- **`formatTypeHint`** (`utils/formatType.ts`): emit `Name<Arg1, Arg2>`

### 4. Codegen: TypeScript Builder and Zod Schemas

#### Zod schema generation

**File: `lib/backends/typescriptGenerator/typeToZodSchema.ts`**

A new case in `mapTypeToSchema`:

```typescript
} else if (variableType.type === "genericType") {
  if (variableType.name === "Record") {
    const keySchema = recurse(variableType.typeArgs[0]);
    const valueSchema = recurse(variableType.typeArgs[1]);
    return `z.record(${keySchema}, ${valueSchema})`;
  }
  // User-defined generics are resolved before codegen.
  // Reaching here is a compiler bug.
  throw new Error(`Unresolved generic type: ${variableType.name}`);
}
```

This is consistent with the existing `primitiveType("object")` → `z.record(z.string(), z.any())` mapping.

User-defined generic types are fully substituted to concrete types before codegen, so they never reach the zod mapper. Only built-in generics like `Record` survive to this point.

#### TypeScript type string generation

**File: `lib/backends/typescriptGenerator/typeToString.ts`**

A new case in `variableTypeToString`:

- When `forFormatting` is true (agency formatter): emit `Record<string, "approve" | "reject">` preserving source syntax
- When `forFormatting` is false (TS codegen): emit `Record<string, "approve" | "reject">` (valid TypeScript)

Both paths emit the same thing for `Record`. For user-defined generics, the formatter preserves the generic syntax (`Container<string>`), while codegen never sees them (already substituted).

### 5. Agency Formatter (Agency Generator)

**File: `lib/backends/agencyGenerator.ts`**

The formatter preserves source syntax faithfully:

- `genericType` nodes are round-tripped as `Name<Arg1, Arg2>` via the `variableTypeToString` addition
- `processTypeAlias` is updated to emit type params: `type Container<T> = ...` or `type StringMap<V = any> = ...`

No substitution happens in the formatter path.

### 6. Parser Edge Cases

#### Nested angle brackets

Nested generics like `Record<string, Record<string, number>>` require the parser to correctly match inner `>` to the inner generic, not the outer one. Since `variableTypeParser` is recursive and `genericTypeParser` parses greedily from the inside out (the inner `Record<string, number>` is consumed as a `variableTypeParser` argument before the outer `>` is reached), this should work naturally with tarsec's recursive descent. Must be verified with explicit test cases.

#### Generic + array suffix

`Nullable<string>[]` where `type Nullable<T> = T | null` should parse as an array of `Nullable<string>`, i.e., `(string | null)[]`. The current `arrayTypeParser` (in `lib/parsers/parsers.ts:715`) hard-codes the element parser as `or(parenthesizedTypeParser, objectTypeParser, primitiveTypeParser, typeAliasVariableParser)` — it does **not** accept generic types, result types, or `array<T>`. This is a **required edit**, not just a verification: `genericTypeParser` (and ideally `resultTypeParser` and `angleBracketsArrayTypeParser`) must be added to that `or(...)` list so that `Container<T>[]`, `Record<K, V>[]`, etc. parse correctly. Failing to do this will cause silent parse failures or mis-parses.

#### Exported generic type aliases

`export type Container<T> = { value: T }` — the `TypeAlias` AST node already has `exported?: boolean`. The `ScopedTypeAliases` class in `lib/compilationUnit.ts` is the central registry; it needs to store the full `TypeAliasEntry` (body + `typeParams`), not just the body. The three current registration call sites in `lib/compilationUnit.ts` (around lines 197, 242, 319) must be updated to pass `typeParams`. Without this, `Container<string>` in an importing module would fail to resolve because the import pipeline strips the `typeParams` metadata.

### 7. Error Handling

All errors are type checker errors (not parser errors). The parser accepts any syntactically valid `Name<Type, ...>` and the type checker validates semantics.

| Error | Message |
|-------|---------|
| Arity mismatch | "Container expects 1 type argument, got 2" |
| Non-generic type with type args | "Foo is not a generic type" |
| Unknown generic type | Falls through to existing "unknown type alias" error |
| Invalid Record key type | "Record key type must be string, number, or a literal/union thereof" |
| Missing required type args | "Container requires at least 1 type argument" (allowed if all params have defaults) |
| Defaults after required | "Type parameter with default must come after all required type parameters" |
| Type parameter not declared | "Type parameter T is used in body of Foo but not declared in its type parameter list" (defensive check during type alias validation; helps when parser/checker get out of sync) |
| Schema arity | "Schema expects 1 type argument, got N" |
| Array arity | "Array expects 1 type argument, got N" |

Bare usage of a generic alias (e.g., `let x: Container`) is allowed only if all type params have defaults. Otherwise it is an error.

### 8. Migration Notes

`Result<T, E>`, `Schema<T>`, and `Array<T>` / `T[]` each keep their dedicated AST nodes for now:

- **`Result<T, E>`** (`resultType`): Deeply wired into the type checker — `success()`/`failure()` constructors, `!` validation wrapping, return type merging in inference. Migrating would be high-churn for no functional benefit.
- **`Schema<T>`** (`schemaType`): Synthesized only (no parser surface). Simple enough to leave as-is.
- **`Array<T>`** (`arrayType`): `T[]` and `Array<T>` both produce `arrayType` today. Could be unified under `genericType` later but no benefit now.

**Opportunistic migration:** The simpler visitor functions (`formatTypeHint`, `visitTypes`, `widenType`) could opportunistically handle these via `genericType` if it reduces total code, but this is optional and should only be done where it clearly simplifies. The implementation plan should evaluate this on a case-by-case basis.

### 9. Files to Modify

| File | Change |
|------|--------|
| `lib/types/typeHints.ts` | Add `GenericType` to `VariableType` union, add `TypeParam` type, add `typeParams` to `TypeAlias` |
| `lib/parsers/parsers.ts` | Add `genericTypeParser`; update `variableTypeParser` and `unionItemParser` ordering; **add `genericTypeParser` (and `resultTypeParser`, `angleBracketsArrayTypeParser`) to `arrayTypeParser`'s element `or(...)` list**; extend `baseTypeAliasParser` to accept optional `<T, U = Default>` after the alias name |
| `lib/compilationUnit.ts` | Change `ScopedTypeAliases` value type from `VariableType` to `TypeAliasEntry`; update all `add()` call sites (lines ~197, 242, 319) to pass `typeParams` |
| `lib/typeChecker/types.ts` | Update `getTypeAliases()` return type to `Record<string, TypeAliasEntry>` |
| `lib/typeChecker/assignability.ts` | Add `substituteTypeParams`; extend `resolveType` to handle `genericType` (Record/Schema/Array/user-defined, with recursion tracking); add `genericType` case to `isAssignable` (Record-to-Record, Record-to-object, object-to-Record); add `genericType` case to `widenType`; update `typeAliases` parameter type throughout |
| `lib/typeChecker/typeWalker.ts` | Add `genericType` case to `visitTypes` |
| `lib/utils/formatType.ts` | Add `genericType` case to `formatTypeHint` |
| `lib/backends/typescriptGenerator/typeToZodSchema.ts` | Add `genericType` case to `mapTypeToSchema` (only `Record` reaches here — `Array`/`Schema` are normalized in `resolveType`) |
| `lib/backends/typescriptGenerator/typeToString.ts` | Add `genericType` case to `variableTypeToString` |
| `lib/backends/agencyGenerator.ts` | Update `processTypeAlias` to emit type params; emit `genericType` as `Name<Args>` in `variableTypeToString` (formatter path) |
| `lib/typeChecker/synthesizer.ts` | Handle `genericType` in property/index access (`Record<K, V>` index returns `V`); resolve generic types during synthesis |
| `lib/typeChecker/checker.ts` | Validate type alias declarations (defaults after required, type parameter not declared in body, etc.); update `typeAliases` parameter types |
| `lib/typeChecker/inference.ts`, `lib/typeChecker/utils.ts`, `lib/typeChecker/validate.ts`, `lib/typeChecker/scopes.ts` | Mechanical update to `typeAliases` parameter types |
| `docs/site/guide/types.md` | Remove `object` from primitive types; document `Record<K, V>`, generic type aliases, and the variance gotcha |
| `tests/agency/classes/set-field-interrupt.agency` | Update `data: object` to `data: Record<string, any>` |

### 10. Removal of the `object` Primitive Type

The built-in `object` primitive type is removed in favor of `Record<string, any>`. With `Record<K, V>` available, `object` is redundant — it was already emitted as `Record<string, any>` in TypeScript codegen and `z.record(z.string(), z.any())` in zod.

**Changes:**
- Remove `"object"` from `primitiveTypeParser` in `lib/parsers/parsers.ts`
- Remove `object` cases from `assignability.ts` (object-to-objectType, objectType-to-object)
- Remove `object` case from `typeToZodSchema.ts` (`primitiveType("object")` → `z.record(...)`)
- Remove `object` case from `typeToString.ts` (`primitiveType("object")` → `Record<string, any>`)
- Update docs (`docs/site/guide/types.md`) to remove `object` from the primitive types list
- Update any test fixtures that use `object` to use `Record<string, any>` instead

**Existing code using `object`:** The only Agency source file using it is `tests/agency/classes/set-field-interrupt.agency` (`data: object`). This should be updated to `data: Record<string, any>`.

### 11. Example Usage

```agency
// Built-in Record
let votes: Record<string, "approve" | "reject"> = {}

// User-defined generic alias
type Container<T> = {
  value: T
  label: string
}

let box: Container<number> = { value: 42, label: "answer" }

// Generic alias with default
type StringMap<V = any> = Record<string, V>

let m: StringMap<number> = {}
let flexible: StringMap = {}  // V defaults to any

// Composing generics
type Pair<A, B> = { first: A, second: B }
let p: Pair<string, number> = { first: "hello", second: 42 }

// Schema<T> writable in source
type UserSchema = Schema<{ name: string, age: number }>
```

### 12. Edge Cases and Required Test Cases

These must be covered by tests during implementation:

```agency
// --- Recursive generic alias ---
type Tree<T> = { value: T, children: Tree<T>[] }
let t: Tree<string> = { value: "root", children: [] }

// --- Generic alias using another generic alias in body ---
type Wrapper<T> = { inner: Container<T> }
let w: Wrapper<number> = { inner: { value: 42, label: "x" } }

// --- Nested generics in type arguments ---
let nested: Record<string, Record<string, number>> = {}
let deep: Record<string, Container<number>> = {}

// --- Generic + array suffix ---
type Nullable<T> = T | null
let arr: Nullable<string>[] = ["hello", null]  // (string | null)[]

// --- Generic in union ---
let x: Container<string> | null = null

// --- Record with literal key union (all keys required) ---
type Status = "active" | "inactive"
let r: Record<Status, number> = { active: 1, inactive: 2 }
// ERROR: let bad: Record<Status, number> = { active: 1 }  // missing "inactive"

// --- Empty object to Record ---
let empty: Record<string, number> = {}

// --- Record property/index access ---
let rec: Record<string, number> = {}
let v = rec["key"]   // type: number
let v2 = rec.foo     // type: number

// --- Type parameter shadowing ---
type T = number
type Foo<T> = Record<string, T>
let f: Foo<string> = {}  // T is string (param), not number (alias)

// --- Exported generic alias (cross-module) ---
// module a.agency:
//   export type Container<T> = { value: T }
// module b.agency:
//   import { Container } from "a"
//   let c: Container<string> = { value: "hello" }

// --- Array<T> uppercase normalizes to arrayType ---
let a: Array<string> = []  // same as string[]

// --- Arity errors ---
// ERROR: let bad: Container<string, number> = {}  // too many args
// ERROR: let bad: Container = {}                   // missing required arg
// ERROR: let bad: Pair<string> = {}                // too few args

// --- Non-generic used with type args ---
type Simple = string
// ERROR: let bad: Simple<number> = ""

// --- Defaults after required ---
// ERROR: type Bad<T = any, U> = { a: T, b: U }  // default before required
```
