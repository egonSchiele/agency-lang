# Generics for the Agency Type System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add user-defined generic type aliases (`type Container<T> = ...`), a built-in `Record<K, V>` type with proper zod codegen, and treat `Array<T>` / `Schema<T>` as built-in generics. Remove the `object` primitive in favor of `Record<string, any>`.

**Architecture:** A single new AST variant `GenericType` represents any `Name<...>` usage. The parser is policy-free — every `Name<...>` becomes a `genericType`. The type checker is the only place that knows about built-ins: `resolveType` normalizes `Array<T>` to `arrayType`, `Schema<T>` to `schemaType`, and resolves user-defined generics by substituting type parameters into the alias body. `Record<K, V>` survives to codegen and lowers to `z.record(K, V)` / TypeScript `Record<K, V>`.

The type alias registry (`ScopedTypeAliases` in `lib/compilationUnit.ts`) is widened from `Record<string, VariableType>` to `Record<string, TypeAliasEntry>` so it can carry type parameter metadata across module boundaries. This is the biggest mechanical change and touches every type-checker file.

**Tech Stack:** tarsec parser combinators, vitest, structural linter.

**Spec:** `docs/superpowers/specs/2026-05-18-generics-design.md`

---

## Key Risks and Gotchas

1. **`arrayTypeParser` element list is hard-coded.** [parsers.ts:715](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/parsers/parsers.ts#L715) only accepts `or(parenthesizedTypeParser, objectTypeParser, primitiveTypeParser, typeAliasVariableParser)`. Without adding `genericTypeParser` (and `resultTypeParser` / `angleBracketsArrayTypeParser`) here, `Container<T>[]` will not parse correctly.

2. **`typeAliasVariableParser` is greedy.** It matches any identifier, so `genericTypeParser` must precede it in every `or(...)` chain that contains both — `variableTypeParser`, `unionItemParser`, and the updated `arrayTypeParser`.

3. **`resultTypeParser` must stay ahead.** `Result<T, E>` keeps its dedicated AST node. The check at [parsers.ts:1010-1048](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/parsers/parsers.ts#L1010-L1048) must run before `genericTypeParser` would otherwise eat `Result<...>` and produce a `genericType` instead.

4. **Recursive generic aliases must not infinite-loop.** `type Tree<T> = { value: T, children: Tree<T>[] }` requires `substituteTypeParams` to substitute `T` inside the body but *not* recursively expand the self-referential `Tree<T>` (after substitution: `Tree<string>`). `resolveType` tracks an in-progress alias name set; self-referential nodes are returned as `genericType { name: "Tree", typeArgs: [<substituted>] }` and not re-resolved.

5. **`substituteTypeParams` must enumerate every `VariableType` variant.** Missing any (`resultType`, `schemaType`, `blockType`, `functionRefType`, etc.) silently breaks substitution in nested positions. See spec Section 3 for the full enumeration.

6. **`Schema<T>` is now writable in source.** It used to be synthesis-only. After this change, users can write `let s: Schema<Foo>` and it must resolve to the synthesized `schemaType` node, so downstream code paths that previously only saw synthesized schemas now see user-written ones too.

7. **`Record<K, V>` is deliberately covariant.** This is technically unsound for mutable records. Document it in `docs/site/guide/types.md`. Do NOT make it invariant — that would break common user code.

8. **The `object` primitive removal is a breaking change for one fixture.** [tests/agency/classes/set-field-interrupt.agency](file:///Users/adityabhargava/agency-lang/packages/agency-lang/tests/agency/classes/set-field-interrupt.agency) uses `data: object` and must be updated to `data: Record<string, any>`. Verify no other fixtures use `object` before removing it from `primitiveTypeParser`.

9. **`ScopedTypeAliases` value type change is invasive.** Every file in `lib/typeChecker/` that takes `Record<string, VariableType>` for type aliases needs updating. Plan it as one focused refactor task before adding new behavior.

10. **`make` is required after stdlib changes.** No stdlib changes are expected in this plan, but if any creep in, run `make` per CLAUDE.md.

---

## File Structure

**New files:** none. All changes are extensions of existing files.

**Files modified** (see spec Section 9 for full table; ordering reflects task dependency, not alphabetical):

| File | Purpose in this plan |
|------|----------------------|
| `lib/types/typeHints.ts` | New `GenericType`, `TypeParam`, `TypeAliasEntry`; extend `TypeAlias` |
| `lib/compilationUnit.ts` | `ScopedTypeAliases` carries `TypeAliasEntry` |
| `lib/typeChecker/types.ts` | `getTypeAliases()` returns `Record<string, TypeAliasEntry>` |
| `lib/typeChecker/{assignability,inference,utils,validate,scopes,synthesizer,checker,index}.ts` | Update signatures and add `genericType` handling |
| `lib/typeChecker/typeWalker.ts` | `genericType` case in `visitTypes` |
| `lib/parsers/parsers.ts` | New `genericTypeParser`; extend `baseTypeAliasParser`; fix `arrayTypeParser` element list; ordering in `variableTypeParser` and `unionItemParser` |
| `lib/utils/formatType.ts` | `genericType` case |
| `lib/backends/typescriptGenerator/typeToZodSchema.ts` | `Record<K, V>` → `z.record(K, V)` |
| `lib/backends/typescriptGenerator/typeToString.ts` | `genericType` case |
| `lib/backends/agencyGenerator.ts` | Emit type params on alias; emit `genericType` as `Name<...>` |
| `docs/site/guide/types.md` | Document `Record`, generics, variance gotcha; remove `object` primitive |
| `tests/agency/classes/set-field-interrupt.agency` | Migrate `object` → `Record<string, any>` |

---

## Task 1: AST Types

**Files:**
- Modify: `lib/types/typeHints.ts`

- [ ] **Step 1: Add new AST types**

Add to [lib/types/typeHints.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/types/typeHints.ts):

```typescript
export type GenericType = {
  type: "genericType";
  name: string;
  typeArgs: VariableType[];
};

export type TypeParam = {
  name: string;
  default?: VariableType;
};

export type TypeAliasEntry = {
  body: VariableType;
  typeParams?: TypeParam[];
};
```

Add `GenericType` to the `VariableType` union (just one new entry — `TypeAliasVariable` is already in the union).

Extend `TypeAlias`:

```typescript
export type TypeAlias = BaseNode & {
  type: "typeAlias";
  aliasName: string;
  aliasedType: VariableType;
  typeParams?: TypeParam[];   // NEW
  exported?: boolean;
  docComment?: AgencyMultiLineComment;
};
```

- [ ] **Step 2: Verify it builds**

Run: `pnpm tsc --noEmit`
Expected: passes (no usages of `GenericType` yet, so no errors). Optional `typeParams` on `TypeAlias` is back-compatible.

- [ ] **Step 3: Commit**

```bash
git add lib/types/typeHints.ts
git commit -m "feat(types): add GenericType, TypeParam, TypeAliasEntry AST types"
```

---

## Task 2: Refactor `ScopedTypeAliases` to carry `TypeAliasEntry`

This is a mechanical, behavior-preserving refactor. After this task, every type checker file holds `TypeAliasEntry` rather than `VariableType` for aliases, but no new behavior is exposed (all aliases still have `typeParams: undefined`).

**Files:**
- Modify: `lib/compilationUnit.ts`
- Modify: `lib/typeChecker/types.ts`
- Modify: `lib/typeChecker/{assignability,inference,utils,validate,scopes,synthesizer,checker,index}.ts`
- Modify: `lib/backends/typescriptGenerator/typeToZodSchema.ts` (signature only)
- Modify: `lib/backends/typescriptGenerator/typeToString.ts` (signature only)

- [ ] **Step 1: Change `ScopedTypeAliases` storage type**

In [lib/compilationUnit.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/compilationUnit.ts):
- Change the internal `byScope` value type from `Record<string, VariableType>` to `Record<string, TypeAliasEntry>`.
- Add an `add(scopeKey, name, body, typeParams?)` signature that constructs the entry.
- `get()`, `visibleIn()`, `clone()`, `scopes()` all return `Record<string, TypeAliasEntry>` now.

- [ ] **Step 2: Update the three registration call sites in `lib/compilationUnit.ts`**

At lines ~197, ~242, ~319, pass `node.typeParams` as the new argument:

```typescript
unit.typeAliases.add(key, node.aliasName, node.aliasedType, node.typeParams);
```

- [ ] **Step 3: Update `getTypeAliases()` return type in `lib/typeChecker/types.ts`**

```typescript
getTypeAliases(): Record<string, TypeAliasEntry>;
```

- [ ] **Step 4: Update consumers**

In every file that accepts `typeAliases: Record<string, VariableType>`, change the type to `Record<string, TypeAliasEntry>` and update the few call sites that read aliases. The current `resolveType` in [lib/typeChecker/assignability.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/typeChecker/assignability.ts) does:

```typescript
const resolved = typeAliases[vt.aliasName];
if (resolved) return resolveType(resolved, typeAliases);
```

Change to:

```typescript
const entry = typeAliases[vt.aliasName];
if (entry) return resolveType(entry.body, typeAliases);
```

Apply the same pattern to every call site that previously indexed `typeAliases[name]` and treated it as a `VariableType`.

The signature change must be threaded through:
- `lib/typeChecker/assignability.ts` — `resolveType`, `isAssignable`, `widenType`, `isOptionalType`
- `lib/typeChecker/inference.ts`
- `lib/typeChecker/utils.ts`
- `lib/typeChecker/validate.ts`
- `lib/typeChecker/scopes.ts`
- `lib/typeChecker/synthesizer.ts`
- `lib/typeChecker/checker.ts`
- `lib/typeChecker/index.ts`
- `lib/backends/typescriptGenerator/typeToZodSchema.ts`
- `lib/backends/typescriptGenerator/typeToString.ts`

- [ ] **Step 5: Verify**

```bash
pnpm tsc --noEmit
pnpm test:run 2>&1 | tee /tmp/task2-tests.log
```

Expected: TypeScript clean. All tests pass (this is a pure refactor — no behavior changed).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(typeChecker): widen ScopedTypeAliases to TypeAliasEntry"
```

---

## Task 3: `genericTypeParser` and parser integration

**Files:**
- Modify: `lib/parsers/parsers.ts`
- Create: `lib/parsers/genericType.test.ts` (or add to an existing parser test file — check `lib/parsers/` conventions first)

- [ ] **Step 1: Write failing tests**

Add tests covering:

```typescript
// Bare generic
parse("Container<string>") → { type: "genericType", name: "Container", typeArgs: [{ type: "primitiveType", value: "string" }] }

// Two args
parse("Record<string, number>") → { ..., name: "Record", typeArgs: [string, number] }

// Nested
parse("Record<string, Record<string, number>>") → nested genericType

// In union
parse("Container<string> | null") → unionType with genericType as first member

// Array suffix
parse("Container<string>[]") → arrayType wrapping genericType

// Result still wins
parse("Result<string, number>") → resultType (not genericType)
```

Run: tests fail (parser doesn't exist yet).

- [ ] **Step 2: Add `genericTypeParser`**

Insert after `resultTypeParser` in [lib/parsers/parsers.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/parsers/parsers.ts):

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

- [ ] **Step 3: Slot into `variableTypeParser`**

In `variableTypeParser` (parsers.ts:1050), insert `genericTypeParser` after `resultTypeParser` and before `primitiveTypeParser` / `typeAliasVariableParser`:

```typescript
export const variableTypeParser = trace("variableTypeParser", or(
  blockTypeParser,
  unionTypeParser,
  arrayTypeParser,
  objectTypeParser,
  angleBracketsArrayTypeParser,
  resultTypeParser,
  genericTypeParser,   // NEW
  stringLiteralTypeParser,
  numberLiteralTypeParser,
  booleanLiteralTypeParser,
  primitiveTypeParser,
  typeAliasVariableParser,
  parenthesizedTypeParser,
));
```

- [ ] **Step 4: Slot into `unionItemParser`**

Same insertion point — after `resultTypeParser`, before `primitiveTypeParser` / `typeAliasVariableParser`.

- [ ] **Step 5: Fix `arrayTypeParser`'s element list**

In `arrayTypeParser` (parsers.ts:715), expand the `or(...)` chain:

```typescript
or(
  parenthesizedTypeParser,
  objectTypeParser,
  resultTypeParser,            // NEW
  angleBracketsArrayTypeParser, // NEW
  genericTypeParser,            // NEW (must precede typeAliasVariableParser)
  primitiveTypeParser,
  typeAliasVariableParser,
)
```

Also widen the `ArrayType.elementType` element parser result type in this file from `ArrayType` to `VariableType` if the wrapper logic does not already accept it (it should — `elementType` is already typed `VariableType`).

- [ ] **Step 6: Run tests**

```bash
pnpm test:run lib/parsers/ 2>&1 | tee /tmp/task3-tests.log
```

Expected: new tests pass; existing parser tests still pass.

- [ ] **Step 7: Commit**

```bash
git add lib/parsers/parsers.ts lib/parsers/genericType.test.ts
git commit -m "feat(parsers): add genericTypeParser for Name<Args> syntax"
```

---

## Task 4: Type alias parser — accept `<T, U = Default>` after alias name

**Files:**
- Modify: `lib/parsers/parsers.ts`
- Test in same suite as Task 3 (or a `typeAlias.test.ts` if one exists)

- [ ] **Step 1: Failing tests**

```typescript
parse("type Container<T> = { value: T }")
  → { type: "typeAlias", aliasName: "Container", typeParams: [{ name: "T" }], aliasedType: ... }

parse("type Pair<A, B> = { first: A, second: B }")
  → { ..., typeParams: [{ name: "A" }, { name: "B" }] }

parse("type StringMap<V = any> = Record<string, V>")
  → typeParams: [{ name: "V", default: { type: "primitiveType", value: "any" } }]

parse("type Plain = string")  // no params → typeParams undefined
  → { aliasName: "Plain", aliasedType: string }   // typeParams omitted
```

- [ ] **Step 2: Implement `typeParamParser` and wire into `baseTypeAliasParser`**

```typescript
const typeParamParser = trace("typeParamParser", seqC(
  capture(many1WithJoin(varNameChar), "name"),
  optional(seqC(
    optionalSpaces,
    char("="),
    optionalSpaces,
    capture(lazy(() => variableTypeParser), "default"),
  )),
));

const typeParamsParser = optional(seqC(
  char("<"),
  optionalSpaces,
  capture(
    sepBy1(seqR(optionalSpaces, char(","), optionalSpaces), typeParamParser),
    "typeParams",
  ),
  optionalSpaces,
  char(">"),
));
```

Insert `typeParamsParser` in `baseTypeAliasParser` between the alias name capture and the `=` sign. Drop empty `typeParams` (i.e., only set the field when params were actually present).

- [ ] **Step 3: Run parser tests**

```bash
pnpm test:run lib/parsers/ 2>&1 | tee /tmp/task4-tests.log
```

Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add lib/parsers/parsers.ts
git commit -m "feat(parsers): accept type parameters on type aliases"
```

---

## Task 5: Walker / mechanical updates (`visitTypes`, `widenType`, `formatTypeHint`)

These are safe one-liner additions so later tasks can rely on them.

**Files:**
- Modify: `lib/typeChecker/typeWalker.ts`
- Modify: `lib/typeChecker/assignability.ts` (widenType only)
- Modify: `lib/utils/formatType.ts`

- [ ] **Step 1: Add `genericType` to `visitTypes`**

In [typeWalker.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/typeChecker/typeWalker.ts):

```typescript
case "genericType":
  for (const a of t.typeArgs) if (visitTypes(a, visit)) return true;
  return false;
```

- [ ] **Step 2: Add `genericType` to `widenType`**

Widen each type arg, return a new `genericType` with the same name. (If `widenType` doesn't currently handle the variant, this is "widen each child, rebuild node".)

- [ ] **Step 3: Add `genericType` to `formatTypeHint`**

Emit `Name<Arg1, Arg2>`.

- [ ] **Step 4: Verify build**

```bash
pnpm tsc --noEmit
pnpm test:run 2>&1 | tee /tmp/task5-tests.log
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add lib/typeChecker/typeWalker.ts lib/typeChecker/assignability.ts lib/utils/formatType.ts
git commit -m "feat(typeChecker): add genericType case to walker, widener, formatter"
```

---

## Task 6: Add `mapTypes` transformer to `typeWalker.ts`

This is a **declarative interface** task. We need a generic tree-transformer so that `substituteTypeParams` (and any future type transformers) don't each duplicate the enumeration of every `VariableType` variant. Today [visitTypes](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/typeChecker/typeWalker.ts) already lists every variant for *observation*; this task adds the sibling utility for *transformation*. After this, the "what" (replace T with X) is one line; the "how" (walk every variant) lives in one place.

**Files:**
- Modify: `lib/typeChecker/typeWalker.ts`
- Modify: `lib/typeChecker/typeWalker.test.ts` (create if absent)

- [ ] **Step 1: Failing tests**

```typescript
// Identity preserves structure
expect(mapTypes(stringType, t => t)).toEqual(stringType);

// Swap stringType for numberType inside a nested structure
const input = { type: "objectType", properties: [{ key: "v", value: { type: "arrayType", elementType: stringType } }] };
const out = mapTypes(input, t => t.type === "primitiveType" && t.value === "string" ? numberType : t);
// → { v: number[] }

// Walks resultType, schemaType, blockType, functionRefType, genericType, unionType
// One test per variant to ensure enumeration is complete.
```

- [ ] **Step 2: Implement**

```typescript
/**
 * Post-order transform of a VariableType tree. `fn` is invoked on each node
 * AFTER its children have been transformed, so children are already in their
 * new form when `fn` sees the parent. Returns a new tree; the input is not
 * mutated.
 *
 * Sibling of `visitTypes`. Every VariableType variant must be enumerated
 * here — adding a new variant means updating both functions.
 */
export function mapTypes(
  t: VariableType,
  fn: (t: VariableType) => VariableType,
): VariableType {
  switch (t.type) {
    case "arrayType":
      return fn({ ...t, elementType: mapTypes(t.elementType, fn) });
    case "unionType":
      return fn({ ...t, types: t.types.map(m => mapTypes(m, fn)) });
    case "objectType":
      return fn({ ...t, properties: t.properties.map(p => ({ ...p, value: mapTypes(p.value, fn) })) });
    case "resultType":
      return fn({ ...t, successType: mapTypes(t.successType, fn), failureType: mapTypes(t.failureType, fn) });
    case "schemaType":
      return fn({ ...t, inner: mapTypes(t.inner, fn) });
    case "blockType":
      return fn({
        ...t,
        params: t.params.map(p => ({ ...p, typeAnnotation: mapTypes(p.typeAnnotation, fn) })),
        returnType: mapTypes(t.returnType, fn),
      });
    case "functionRefType":
      return fn({
        ...t,
        params: t.params.map(p => p.typeHint ? { ...p, typeHint: mapTypes(p.typeHint, fn) } : p),
        returnType: t.returnType ? mapTypes(t.returnType, fn) : t.returnType,
      });
    case "genericType":
      return fn({ ...t, typeArgs: t.typeArgs.map(a => mapTypes(a, fn)) });
    default:
      // primitives, literals, typeAliasVariable — no children
      return fn(t);
  }
}
```

- [ ] **Step 3: Run, commit**

```bash
pnpm test:run lib/typeChecker/typeWalker 2>&1 | tee /tmp/task6-tests.log
git add lib/typeChecker/typeWalker.ts lib/typeChecker/typeWalker.test.ts
git commit -m "feat(typeChecker): add mapTypes transformer alongside visitTypes"
```

---

## Task 7: `substituteTypeParams` using `mapTypes`

**Files:**
- Create: `lib/typeChecker/substitute.ts` (small, focused — keeps assignability.ts from growing)
- Test: `lib/typeChecker/substitute.test.ts`

- [ ] **Step 1: Failing tests**

```typescript
// Substitute T → string in { value: T }
substituteTypeParams(
  { type: "objectType", properties: [{ key: "value", value: { type: "typeAliasVariable", aliasName: "T" } }] },
  ["T"],
  [{ type: "primitiveType", value: "string" }],
) // → { value: string }

// Nested: substitute T in Array<T>[]
substituteTypeParams(
  { type: "arrayType", elementType: { type: "arrayType", elementType: { type: "typeAliasVariable", aliasName: "T" } } },
  ["T"],
  [stringType],
) // → string[][]

// Union with T
substituteTypeParams(
  { type: "unionType", types: [{ type: "typeAliasVariable", aliasName: "T" }, nullType] },
  ["T"],
  [stringType],
) // → string | null

// genericType containing T (typeArgs substituted, name preserved)
substituteTypeParams(
  { type: "genericType", name: "Wrapper", typeArgs: [{ type: "typeAliasVariable", aliasName: "T" }] },
  ["T"],
  [stringType],
) // → Wrapper<string>

// Multiple params at once
substituteTypeParams(
  { type: "objectType", properties: [{ key: "a", value: tparam("A") }, { key: "b", value: tparam("B") }] },
  ["A", "B"],
  [stringType, numberType],
)

// Unrelated typeAliasVariable is preserved
substituteTypeParams(
  { type: "typeAliasVariable", aliasName: "Other" },
  ["T"],
  [stringType],
) // → { type: "typeAliasVariable", aliasName: "Other" }
```

- [ ] **Step 2: Implement (declarative, using `mapTypes`)**

```typescript
import { mapTypes } from "./typeWalker.js";

export function substituteTypeParams(
  body: VariableType,
  typeParams: string[],
  typeArgs: VariableType[],
): VariableType {
  const map: Record<string, VariableType> = {};
  for (let i = 0; i < typeParams.length; i++) map[typeParams[i]] = typeArgs[i];

  return mapTypes(body, (t) =>
    t.type === "typeAliasVariable" && t.aliasName in map ? map[t.aliasName] : t
  );
}
```

The "what" — replace any `typeAliasVariable` named in the param list with its argument — is now one expression. The "how" — enumerate every variant — lives in `mapTypes`.

- [ ] **Step 3: Run, commit**

```bash
pnpm test:run lib/typeChecker/substitute 2>&1 | tee /tmp/task7-tests.log
git add lib/typeChecker/substitute.ts lib/typeChecker/substitute.test.ts
git commit -m "feat(typeChecker): add substituteTypeParams (uses mapTypes)"
```

---

## Task 8: Extend `resolveType` for built-in generics (`Array`, `Schema`, `Record`)

**Files:**
- Modify: `lib/typeChecker/assignability.ts` (`resolveType`)
- Test: extend `lib/typeChecker/assignability.test.ts` or `substitute.test.ts`

- [ ] **Step 1: Failing tests**

```typescript
resolveType({ type: "genericType", name: "Array", typeArgs: [stringType] }, {})
  → { type: "arrayType", elementType: stringType }

resolveType({ type: "genericType", name: "Schema", typeArgs: [stringType] }, {})
  → { type: "schemaType", inner: stringType }

resolveType({ type: "genericType", name: "Record", typeArgs: [stringType, numberType] }, {})
  → unchanged (survives to codegen)
```

Arity errors:

```typescript
resolveType({ type: "genericType", name: "Array", typeArgs: [] }, {}) → throws/reports
resolveType({ type: "genericType", name: "Schema", typeArgs: [a, b] }, {}) → throws/reports
resolveType({ type: "genericType", name: "Record", typeArgs: [a] }, {}) → throws/reports
```

Record key type validation:

```typescript
// Allowed: string, number, string literal, number literal, union of those
// Rejected: boolean, object, arbitrary aliases
```

- [ ] **Step 2: Introduce the public/private split, implement built-in handling**

The public `resolveType` keeps its existing signature (already widened in Task 2 to take `TypeAliasEntry`). The actual work moves into a private helper that threads the recursion-tracking `inProgress` set used by Task 9. Task 9 just adds the user-defined-generic case to the same private helper — no rewriting Task 8's code later.

```typescript
// Public — signature stays clean
export function resolveType(
  vt: VariableType,
  typeAliases: Record<string, TypeAliasEntry>,
): VariableType {
  return resolveTypeWithGuard(vt, typeAliases, new Set());
}

// Private — recursion-tracking set is an implementation detail
function resolveTypeWithGuard(
  vt: VariableType,
  typeAliases: Record<string, TypeAliasEntry>,
  inProgress: Set<string>,
): VariableType {
  if (vt.type === "typeAliasVariable") {
    const entry = typeAliases[vt.aliasName];
    if (entry) return resolveTypeWithGuard(entry.body, typeAliases, inProgress);
    return vt;
  }
  if (vt.type === "genericType") {
    if (vt.name === "Array") {
      if (vt.typeArgs.length !== 1) throw new TypeError(`Array expects 1 type argument, got ${vt.typeArgs.length}`);
      return { type: "arrayType", elementType: resolveTypeWithGuard(vt.typeArgs[0], typeAliases, inProgress) };
    }
    if (vt.name === "Schema") {
      if (vt.typeArgs.length !== 1) throw new TypeError(`Schema expects 1 type argument, got ${vt.typeArgs.length}`);
      return { type: "schemaType", inner: resolveTypeWithGuard(vt.typeArgs[0], typeAliases, inProgress) };
    }
    if (vt.name === "Record") {
      if (vt.typeArgs.length !== 2) throw new TypeError(`Record expects 2 type arguments, got ${vt.typeArgs.length}`);
      validateRecordKeyType(vt.typeArgs[0], typeAliases);
      // Resolve inside but keep the genericType wrapper (survives to codegen)
      return { ...vt, typeArgs: vt.typeArgs.map(a => resolveTypeWithGuard(a, typeAliases, inProgress)) };
    }
    // User-defined generics handled in Task 9
  }
  return vt;
}
```

`validateRecordKeyType` accepts: `primitiveType("string")`, `primitiveType("number")`, `stringLiteralType`, `numberLiteralType`, or a `unionType` whose members are all the above.

- [ ] **Step 3: Run tests**

```bash
pnpm test:run lib/typeChecker/ 2>&1 | tee /tmp/task8-tests.log
```

- [ ] **Step 4: Commit**

```bash
git add lib/typeChecker/assignability.ts lib/typeChecker/*.test.ts
git commit -m "feat(typeChecker): resolve built-in generics Array/Schema/Record in resolveType"
```

---

## Task 9: Extend `resolveType` for user-defined generic aliases (with recursion tracking)

**Files:**
- Modify: `lib/typeChecker/assignability.ts`
- Test: same test file

- [ ] **Step 1: Failing tests**

```typescript
// Simple user generic
const aliases = {
  Container: {
    body: { type: "objectType", properties: [{ key: "value", value: { type: "typeAliasVariable", aliasName: "T" } }] },
    typeParams: [{ name: "T" }],
  },
};
resolveType({ type: "genericType", name: "Container", typeArgs: [numberType] }, aliases)
  // → { value: number }

// Default
const aliases2 = {
  StringMap: {
    body: { type: "genericType", name: "Record", typeArgs: [stringType, { type: "typeAliasVariable", aliasName: "V" }] },
    typeParams: [{ name: "V", default: anyType }],
  },
};
resolveType({ type: "typeAliasVariable", aliasName: "StringMap" }, aliases2)
  // → Record<string, any>

// Recursive: type Tree<T> = { value: T, children: Tree<T>[] }
// Tree<string> resolves to a recursive structure that does NOT loop forever
```

- [ ] **Step 2: Extend `resolveTypeWithGuard` (introduced in Task 8) with user-defined-generic and bare-alias-with-defaults cases**

Task 8 already established the public/private split. This task just extends the private `resolveTypeWithGuard` with two new cases: (a) bare `typeAliasVariable` referring to a generic alias with all defaults, and (b) `genericType` whose name isn't a built-in.

```typescript
// In resolveTypeWithGuard, EXTEND the typeAliasVariable branch:
if (vt.type === "typeAliasVariable") {
  const entry = typeAliases[vt.aliasName];
  if (!entry) return vt;
  // NEW: bare use of a generic alias requires all params to have defaults
  if (entry.typeParams && entry.typeParams.some(p => !p.default)) {
    throw new TypeError(`${vt.aliasName} requires type arguments`);
  }
  if (inProgress.has(vt.aliasName)) return vt;
  const next = new Set(inProgress).add(vt.aliasName);
  // NEW: if the alias has typeParams (all defaulted), substitute defaults in
  if (entry.typeParams) {
    const args = entry.typeParams.map(p => p.default!);
    const substituted = substituteTypeParams(entry.body, entry.typeParams.map(p => p.name), args);
    return resolveTypeWithGuard(substituted, typeAliases, next);
  }
  return resolveTypeWithGuard(entry.body, typeAliases, next);
}

// In the genericType branch, ADD the fallthrough for user-defined names
// (after the Array/Schema/Record cases from Task 8):
{
  // ... existing built-in cases from Task 8 ...

  // NEW: user-defined generic alias
  const entry = typeAliases[vt.name];
  if (!entry) throw new TypeError(`Unknown generic type ${vt.name}`);
  if (!entry.typeParams) throw new TypeError(`${vt.name} is not a generic type`);

  // Cycle: leave the self-reference structurally, with substituted args
  if (inProgress.has(vt.name)) {
    return { ...vt, typeArgs: vt.typeArgs.map(a => resolveTypeWithGuard(a, typeAliases, inProgress)) };
  }

  const args = fillDefaults(vt.typeArgs, entry.typeParams, vt.name);
  const next = new Set(inProgress).add(vt.name);
  const substituted = substituteTypeParams(entry.body, entry.typeParams.map(p => p.name), args);
  return resolveTypeWithGuard(substituted, typeAliases, next);
}
```

Add helper (file-local):

```typescript
function fillDefaults(args: VariableType[], params: TypeParam[], name: string): VariableType[] {
  if (args.length > params.length) {
    throw new TypeError(`${name} expects at most ${params.length} type arguments, got ${args.length}`);
  }
  const result = [...args];
  for (let i = args.length; i < params.length; i++) {
    const p = params[i];
    if (!p.default) throw new TypeError(`${name} requires at least ${i + 1} type arguments`);
    result.push(p.default);
  }
  return result;
}
```

- [ ] **Step 3: Run tests**

```bash
pnpm test:run lib/typeChecker/ 2>&1 | tee /tmp/task9-tests.log
```

- [ ] **Step 4: Commit**

```bash
git add lib/typeChecker/
git commit -m "feat(typeChecker): resolve user-defined generic aliases with recursion guard"
```

---

## Task 10: `isAssignable` Record cases

**Files:**
- Modify: `lib/typeChecker/assignability.ts`
- Test: `lib/typeChecker/assignability.test.ts`

- [ ] **Step 1: Failing tests**

```typescript
// Record-to-Record (covariant)
isAssignable(
  recordType(stringType, stringLit("approve")),
  recordType(stringType, stringType),
  {}
) === true  // covariant — narrow values assignable to wider

// Object-to-Record (all props must match V)
isAssignable(
  objectType([{ key: "a", value: numberType }, { key: "b", value: numberType }]),
  recordType(stringType, numberType),
  {}
) === true

// Empty object → Record (vacuously true)
isAssignable(objectType([]), recordType(stringType, numberType), {}) === true

// Record-to-empty-object
isAssignable(recordType(stringType, anyType), objectType([]), {}) === true

// Record-to-nonempty-object — rejected
isAssignable(recordType(stringType, anyType), objectType([{ key: "a", value: stringType }]), {}) === false

// Literal key union — all keys required
isAssignable(
  objectType([{ key: "active", value: numberType }, { key: "inactive", value: numberType }]),
  recordType(unionType([stringLit("active"), stringLit("inactive")]), numberType),
  {}
) === true

isAssignable(
  objectType([{ key: "active", value: numberType }]),  // missing "inactive"
  recordType(unionType([stringLit("active"), stringLit("inactive")]), numberType),
  {}
) === false
```

- [ ] **Step 2: Implement**

Add `genericType` cases to `isAssignable`. After `resolveType` on both sides:

```typescript
if (resolvedSource.type === "genericType" && resolvedSource.name === "Record" &&
    resolvedTarget.type === "genericType" && resolvedTarget.name === "Record") {
  // Covariant in both K and V
  return isAssignable(resolvedSource.typeArgs[0], resolvedTarget.typeArgs[0], typeAliases)
      && isAssignable(resolvedSource.typeArgs[1], resolvedTarget.typeArgs[1], typeAliases);
}

if (resolvedSource.type === "objectType" && resolvedTarget.type === "genericType" && resolvedTarget.name === "Record") {
  const keyType = resolvedTarget.typeArgs[0];
  const valueType = resolvedTarget.typeArgs[1];
  // Empty object always assignable
  if (resolvedSource.properties.length === 0) return true;
  // Literal key union — all keys must be present
  const requiredKeys = collectLiteralKeys(keyType); // returns string[] or null if K is open (string/number)
  if (requiredKeys) {
    const sourceKeys = new Set(resolvedSource.properties.map(p => p.key));
    for (const k of requiredKeys) if (!sourceKeys.has(k)) return false;
  }
  // All property values must be assignable to V
  return resolvedSource.properties.every(p => isAssignable(p.value, valueType, typeAliases));
}

if (resolvedSource.type === "genericType" && resolvedSource.name === "Record" && resolvedTarget.type === "objectType") {
  // Only assignable to empty {}
  return resolvedTarget.properties.length === 0;
}
```

- [ ] **Step 3: Run tests**

```bash
pnpm test:run lib/typeChecker/assignability 2>&1 | tee /tmp/task10-tests.log
```

- [ ] **Step 4: Commit**

```bash
git add lib/typeChecker/
git commit -m "feat(typeChecker): isAssignable for Record-to-Record/object covariance"
```

---

## Task 11: Synthesizer — `record["key"]`, `record.foo`, `for (k in record)`

**Files:**
- Modify: `lib/typeChecker/synthesizer.ts`
- Test: integration test fixture under `tests/typescriptGenerator/`

- [ ] **Step 1: Identify the synthesis sites**

In [synthesizer.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/typeChecker/synthesizer.ts) find:
- Property access (e.g., `synthesizeMemberAccess` or `synthesizeProperty`)
- Index access (e.g., `synthesizeIndexAccess`)
- `for...in` loop key type

After resolving the receiver type, add a `genericType` + `Record` branch that returns `V` for property/index access and `K` for the loop key.

- [ ] **Step 2: Write an Agency fixture test**

Create `tests/typescriptGenerator/recordIndex.agency`:

```agency
node main() {
  let votes: Record<string, "approve" | "reject"> = {}
  votes["alice"] = "approve"
  let v = votes["alice"]   // type: "approve" | "reject"
  for (k in votes) {
    log("{k}: {votes[k]}")
  }
}
```

Run `pnpm run agency tests/typescriptGenerator/recordIndex.agency` and verify it type-checks and runs (no LLM call needed).

- [ ] **Step 3: Implement, run, commit**

```bash
pnpm test:run 2>&1 | tee /tmp/task11-tests.log
git add lib/typeChecker/synthesizer.ts tests/typescriptGenerator/recordIndex.*
git commit -m "feat(typeChecker): synthesize Record index/property/loop types"
```

---

## Task 12: Codegen — `Record` in zod and TS string

**Files:**
- Modify: `lib/backends/typescriptGenerator/typeToZodSchema.ts`
- Modify: `lib/backends/typescriptGenerator/typeToString.ts`

- [ ] **Step 1: Failing fixture-style test**

Pick or create a fixture that uses `Record<string, number>` and assert the generated TS contains `Record<string, number>` and the generated zod contains `z.record(z.string(), z.number())`.

- [ ] **Step 2: Implement in `mapTypeToSchema`**

```typescript
} else if (variableType.type === "genericType") {
  if (variableType.name === "Record") {
    const keySchema = recurse(variableType.typeArgs[0]);
    const valueSchema = recurse(variableType.typeArgs[1]);
    return `z.record(${keySchema}, ${valueSchema})`;
  }
  throw new Error(`Unresolved generic type at codegen: ${variableType.name}`);
}
```

- [ ] **Step 3: Implement in `variableTypeToString`**

```typescript
} else if (variableType.type === "genericType") {
  const args = variableType.typeArgs
    .map(a => variableTypeToString(a, typeAliases, forFormatting))
    .join(", ");
  return `${variableType.name}<${args}>`;
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm test:run 2>&1 | tee /tmp/task12-tests.log
```

- [ ] **Step 5: Commit**

```bash
git add lib/backends/typescriptGenerator/
git commit -m "feat(codegen): emit Record<K,V> as z.record and TS Record"
```

---

## Task 13: Formatter — type params on alias + generic in body

**Files:**
- Modify: `lib/backends/agencyGenerator.ts`
- Test: `tests/formatter/` round-trip fixture

- [ ] **Step 1: Add a round-trip fixture**

Create `tests/formatter/generics.agency`:

```agency
type Container<T> = { value: T }
type StringMap<V = any> = Record<string, V>
type Pair<A, B> = { first: A, second: B }

node main() {
  let c: Container<number> = { value: 42 }
  let r: Record<string, "yes" | "no"> = {}
}
```

Run `pnpm run fmt tests/formatter/generics.agency` and snapshot the output. Round-trip: format twice — second output must equal first.

- [ ] **Step 2: Implement type param emission in `processTypeAlias`**

When `node.typeParams` is present, emit `<T1, T2 = Default>` between the name and `=`.

- [ ] **Step 3: Implement `genericType` in formatter's `variableTypeToString`**

Already handled in Task 11 since the formatter shares `typeToString.ts`. If `agencyGenerator.ts` has its own emitter, mirror the change there.

- [ ] **Step 4: Run formatter tests**

```bash
pnpm test:run tests/formatter 2>&1 | tee /tmp/task13-tests.log
```

- [ ] **Step 5: Commit**

```bash
git add lib/backends/agencyGenerator.ts tests/formatter/
git commit -m "feat(formatter): emit type params on aliases and generic types"
```

---

## Task 14: Type alias declaration validation

**Files:**
- Modify: `lib/typeChecker/checker.ts`
- Test: `lib/typeChecker/checker.test.ts` (or wherever alias declarations are validated)

- [ ] **Step 1: Failing tests**

```typescript
// Defaults must come after required
"type Bad<T = any, U> = { a: T, b: U }"  → error "Type parameter with default must come after all required type parameters"

// Type parameter referenced in body must be declared
"type Foo = { value: T }"  → error "Type parameter T is used in body of Foo but not declared in its type parameter list"
// (only fires when the body references an identifier not in scope as an alias AND not in typeParams)
```

The second check is best-effort — Agency currently treats unknown identifiers as bare type aliases that fail to resolve. The new check fires only inside generic aliases where the unresolved identifier looks like a single-uppercase-letter convention for type params, to keep false positives low. (Implementation detail — engineer's judgment.)

- [ ] **Step 2: Implement**

In `checker.ts` where `TypeAlias` nodes are visited, after collecting `typeParams`, validate the ordering and walk the body checking for stray identifiers.

- [ ] **Step 3: Run, commit**

```bash
pnpm test:run 2>&1 | tee /tmp/task14-tests.log
git add lib/typeChecker/checker.ts lib/typeChecker/checker.test.ts
git commit -m "feat(typeChecker): validate type alias type-parameter declarations"
```

---

## Task 15: Remove the `object` primitive

**Files:**
- Modify: `lib/parsers/parsers.ts`
- Modify: `lib/typeChecker/assignability.ts`
- Modify: `lib/backends/typescriptGenerator/typeToZodSchema.ts`
- Modify: `lib/backends/typescriptGenerator/typeToString.ts`
- Modify: `tests/agency/classes/set-field-interrupt.agency`

- [ ] **Step 1: Pre-check — find all uses**

```bash
grep -rn "\"object\"\|: object\b" tests/ lib/ docs/ --include="*.agency" --include="*.ts" --include="*.md"
```

Triage and update any user-facing fixtures to `Record<string, any>` (just `set-field-interrupt.agency` is expected; verify).

- [ ] **Step 2: Update the fixture**

In [tests/agency/classes/set-field-interrupt.agency](file:///Users/adityabhargava/agency-lang/packages/agency-lang/tests/agency/classes/set-field-interrupt.agency), change `data: object` → `data: Record<string, any>`.

- [ ] **Step 3: Remove from `primitiveTypeParser`**

In [parsers.ts:665](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/parsers/parsers.ts#L665-L686), drop the `str("object"),` line.

- [ ] **Step 4: Remove `object` cases from assignability.ts, typeToZodSchema.ts, typeToString.ts**

In each file, delete the special case for `primitiveType("object")`. The Record paths added in earlier tasks cover the semantics.

- [ ] **Step 5: Run full test suite**

```bash
pnpm test:run 2>&1 | tee /tmp/task15-tests.log
```

Expected: pass. If anything fails, it's either (a) a missed `object` reference or (b) the Record path doesn't yet cover a case that `object` did (re-check Task 9 rules).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: remove object primitive in favor of Record<string, any>"
```

---

## Task 16: Documentation

**Files:**
- Modify: `docs/site/guide/types.md`

- [ ] **Step 1: Update types.md**

- Remove `object` from the primitive types list.
- Add a section on `Record<K, V>` with examples (literal key union, mutation, index access).
- Add a section on generic type aliases (`type Container<T>`, defaults, recursive generics).
- Add a "Variance gotcha" subsection explaining that `Record<K, V>` is covariant for ergonomics and showing the unsoundness example.
- Note `Array<T>` and `Schema<T>` are syntactic sugar for built-in types.

- [ ] **Step 2: Verify build of docs (if applicable)**

```bash
# If the docs site has a build step, run it
```

- [ ] **Step 3: Commit**

```bash
git add docs/site/guide/types.md
git commit -m "docs(types): document Record, generics, variance gotcha; remove object"
```

---

## Task 17: Edge-case fixture sweep

Add the test cases from spec Section 12 as Agency fixtures and confirm each compiles + behaves as expected. Most do not require LLM calls.

**Files:**
- Create: `tests/typescriptGenerator/generics-edge-cases.agency` (or split into focused fixtures)

- [ ] **Step 1: Add fixtures**

Cover every example in Section 12 of the spec:
- Recursive generic alias
- Generic alias using another generic
- Nested generics in type args
- Generic + array suffix
- Generic in union
- Record with literal key union (positive + negative)
- Empty object to Record
- Record property/index access
- Type parameter shadowing
- Array<T> uppercase
- Schema<T> writable
- Arity errors (use type-error fixtures if your test harness supports negative cases)
- Defaults-after-required (negative)

- [ ] **Step 2: Rebuild fixtures and run**

```bash
make fixtures
pnpm test:run 2>&1 | tee /tmp/task17-tests.log
```

- [ ] **Step 3: Commit**

```bash
git add tests/
git commit -m "test: edge cases for generics from spec Section 12"
```

---

## Task 18: Cross-module import smoke test

**Files:**
- Create: `tests/pkg-imports/generics/` fixture (or similar two-file setup)

- [ ] **Step 1: Two-file test**

`a.agency`:
```agency
export type Container<T> = { value: T }
```

`b.agency`:
```agency
import { Container } from "./a"
node main() {
  let c: Container<string> = { value: "hello" }
}
```

Confirm `b.agency` type-checks and runs. This validates that `ScopedTypeAliases` correctly propagates `typeParams` across module boundaries (the Task 2 refactor + Task 8 user-defined generic resolution).

- [ ] **Step 2: Run, commit**

```bash
pnpm test:run tests/pkg-imports 2>&1 | tee /tmp/task18-tests.log
git add tests/pkg-imports/
git commit -m "test: cross-module generic type alias import"
```

---

## Final Validation

- [ ] **Run full suite**

```bash
pnpm test:run 2>&1 | tee /tmp/final-tests.log
pnpm run lint:structure
pnpm tsc --noEmit
```

- [ ] **Run a real Agency program that exercises Record + generics end-to-end**

Pick or write one that LLM-validates a `Record<string, "approve" | "reject">` shape via structured output, to confirm the zod schema works.

- [ ] **Update CHANGELOG.md**

Add an entry describing:
- New `Record<K, V>` built-in
- Generic type aliases (`type Foo<T> = ...`, with defaults)
- `Array<T>` and `Schema<T>` now usable in source
- Removal of `object` primitive (with migration note: use `Record<string, any>`)
- Documented variance gotcha for `Record`

---

## Task Ordering Rationale

Tasks 1-2 are foundational (AST + registry). 3-4 unlock parsing. 5 is mechanical infrastructure. 6 adds the declarative `mapTypes` transformer that 7 (substitution) uses. 8-9 build up `resolveType` from built-ins to user-defined. 10 adds assignability. 11-12 wire it into synthesis and codegen. 13 handles the formatter. 14 adds validation. 15 removes `object`. 16 documents. 17-18 sweep edge cases.

Each task is shippable on its own and leaves the repo in a green state. If implementing solo and short on time, the **minimum viable** subset is Tasks 1-2-3-5-6-7-8-10-12 (gets `Record<K, V>` working end-to-end without user-defined generics). User-defined generic aliases need Tasks 4 and 9. The `object` removal (Task 15) is independent and can ship before or after generics.
