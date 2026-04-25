# Type Checker Refactor Design

## Problem

The type checker (`lib/typeChecker.ts`) is a single ~960-line file with one class that mixes multiple concerns. Key readability problems:

1. **`collectVariableTypes` mixes collection with checking** — it collects variable types AND checks assignments AND reports errors in the same pass. You context-switch constantly between "what types exist" and "are these types correct."

2. **Too many responsibilities in one class** — type alias validation, return type inference, scope construction, function call checking, expression synthesis, assignability logic, type resolution, error collection.

3. **Large methods with inlined logic** — `synthType` is a big switch with non-trivial inline logic for arrays, objects, and binary operators. `isAssignable` is a flat chain of special cases with no grouping.

4. **Inconsistent state management** — some methods take `scopeVars` as parameters, others access class properties, others use mutable `currentScopeKey` state via `withScope`.

## Goal

Break the type checker into focused modules where each file has one job and can be understood without reading the others. Separate data collection from error checking. Make the overall flow visible from a single entry point.

## New Structure

```
lib/typeChecker/
├── index.ts              # TypeChecker class (thin orchestrator) + public API
├── types.ts              # Type definitions: TypeCheckError, TypeCheckResult, ScopeInfo, etc.
├── builtins.ts           # BUILTIN_FUNCTION_TYPES constant
├── scopes.ts             # Scope building: variable type collection + assignment checking
├── inference.ts          # Return type inference
├── checker.ts            # Checking mode: check function calls, return types, expressions
├── synthesizer.ts        # Synthesis mode: synthType, synthValueAccess
├── assignability.ts      # isAssignable, resolveType, widenType
├── validate.ts           # validateTypeReferences
└── utils.ts              # Shared helpers: checkType, makeSynthContext
```

## Module Descriptions

### `types.ts` — Type definitions

All type definitions used by the type checker. No logic.

Contains:
- `TypeCheckError`
- `TypeCheckResult`
- `ScopeInfo`
- `BuiltinSignature`
- `TypeCheckerContext` — shared state passed between modules (see Shared State section)

### `builtins.ts` — Built-in function types

The `BUILTIN_FUNCTION_TYPES` constant. Currently ~50 lines of data at the top of the file that is irrelevant to understanding the checker logic.

### `index.ts` — Orchestrator and public API

The `TypeChecker` class becomes a thin orchestrator. Its `check()` method runs the phases in order:

```
check():
  1. validateTypeReferences()     // validate.ts
  2. inferReturnTypes()           // inference.ts
  3. buildScopes()                // scopes.ts
  4. checkScopes()                // checker.ts
```

It holds the shared state (`TypeCheckerContext`) and passes it to each module. This is the only file you need to read to understand the overall flow.

Exports the public API: `TypeChecker`, `typeCheck()`, `formatErrors()`, `deduplicateErrors()`.

Also contains `formatErrors()` (formats errors with terminal colors) and `deduplicateErrors()` (deduplicates by message string) since these are orchestration-level concerns.

### `scopes.ts` — Scope building

Responsible for walking the AST and building `ScopeInfo` objects with variable-to-type maps.

Contains:
- `buildScopes(ctx)` — builds scope list for top-level, functions, and graph nodes
- `collectVariableTypes(nodes, vars, scopeName, ctx)` — walks statements to build the variable type map

This module collects variable types AND checks assignments in a single pass to preserve existing behavior (where synthesis uses a partially-built scope). Specifically:
- For typed assignments: records the declared type and checks value compatibility
- For untyped reassignments: checks the new value against the existing type
- For first assignments without annotations: infers from the initializer via `synthType`
- For imports: records `any`
- For for-loops: infers item type from array element type
- Walks into nested blocks (if/else, while, message threads)

A future improvement could split this into separate collection and checking passes.

### `inference.ts` — Return type inference

Infers return types for functions/nodes that lack explicit return type annotations.

Contains:
- `inferReturnTypes(ctx)` — iterate all function/node definitions without return types
- `inferReturnTypeFor(name, def, ctx)` — collect return statements, synthesize types, pick the inferred type

Handles the recursion guard for mutually recursive functions.

Note: `inferReturnTypeFor` calls `collectVariableTypes` internally to build a partial scope for the function body before synthesizing return types. This means `inference.ts` depends on `scopes.ts`.

### `checker.ts` — Checking mode

All error-reporting logic. Consumes scopes built by `scopes.ts` and uses `synthesizer.ts` and `assignability.ts`.

Contains:
- `checkScopes(scopes, ctx)` — iterate scopes and run all checks
- `checkAssignments(scope, ctx)` — check that assigned values match their type annotations, check reassignment consistency. This is the logic currently interleaved in `collectVariableTypes`.
- `checkFunctionCalls(scope, ctx)` — check arity and argument types for function/builtin calls. Includes helper `checkSingleFunctionCall` which handles individual call checking including builtin vs user-defined dispatch.
- `checkReturnTypes(scope, ctx)` — check return statement values against declared return type
- `checkExpressions(scope, ctx)` — walk expressions to trigger synthesis validation (e.g., property access on wrong type)
- `checkType(expr, expectedType, scopeVars, context, ctx)` — the checking-mode entry point: synthesize a type, verify assignability

### `synthesizer.ts` — Synthesis mode

Pure bottom-up type computation. Given an expression and a scope, return a type.

Contains:
- `synthType(expr, scopeVars, ctx)` — the main synthesis function
- `synthValueAccess(expr, scopeVars, ctx)` — walk access chains to resolve types
- `synthBinOp(expr, scopeVars, ctx)` — binary operator type rules
- `synthArray(expr, scopeVars, ctx)` — array literal type inference
- `synthObject(expr, scopeVars, ctx)` — object literal type inference
- `synthFunctionCall(expr, scopeVars, ctx)` — function call return type lookup

The main `synthType` switch becomes a clean dispatch, with each case being one call to a helper.

Note: `synthValueAccess` reports property-access-on-wrong-type errors, since these are inherent to synthesis (you can't return a type if the access is invalid).

### `assignability.ts` — Type algebra

Pure type-level operations with no dependency on the AST or scopes. Can be tested in isolation with just type values.

Contains:
- `isAssignable(source, target, typeAliases)` — the core subtyping check
- `resolveType(vt, typeAliases)` — resolve type alias variables. Note: `typeAliases` is scope-dependent — the caller must pass the correct scope's aliases via `ctx.getTypeAliases()`.
- `widenType(vt)` — widen literal types to base primitives

`isAssignable` is restructured with helper functions for clarity:

```typescript
isAssignable(source, target, ctx):
  // Early exits: any, unknown
  if (isAnyOrUnknown(source, target)) return ...

  // Structural cases
  if (isUnionAssignable(source, target, ctx)) return ...
  if (isLiteralAssignableToBase(source, target)) return ...
  if (isObjectAssignableToObjectPrimitive(source, target)) return ...

  // Same-kind matching
  return isSameKindAssignable(source, target, ctx)
```

### `validate.ts` — Type reference validation

A simple recursive walker that checks all type alias references exist.

Contains:
- `validateTypeReferences(vt, context, ctx)` — recurse through type structures, push errors for unresolved aliases

## Shared State

Currently the `TypeChecker` class holds all state as instance properties. After extraction, modules need access to shared state. Rather than passing many individual arguments, define a `TypeCheckerContext` object:

```typescript
type TypeCheckerContext = {
  programNodes: AgencyNode[];
  scopedTypeAliases: Record<string, Record<string, VariableType>>;
  currentScopeKey: string;
  functionDefs: Record<string, FunctionDefinition>;
  nodeDefs: Record<string, GraphNodeDefinition>;
  errors: TypeCheckError[];
  inferredReturnTypes: Record<string, VariableType | "any">;
  inferringReturnType: Set<string>;
  config: AgencyConfig;
  // Helper to get visible type aliases for current scope.
  // NOTE: depends on currentScopeKey — callers must ensure they are
  // inside a withScope() call for the correct scope.
  getTypeAliases(): Record<string, VariableType>;
  // Helper to run a callback with a different scope key
  withScope<T>(key: string, fn: () => T): T;
};
```

The `TypeChecker` class in `index.ts` creates this context and passes it to each module's functions.

## Key Refactoring Principle

**Separate collection from checking.** The single biggest readability win is splitting what is currently `collectVariableTypes` into two phases:

- **Phase 1 (`scopes.ts`):** Walk the AST and build variable-to-type maps. No errors.
- **Phase 2 (`checker.ts`):** Walk the AST again with completed scopes, check assignments and expressions. Errors reported here.

Currently these are interleaved, which makes the code hard to follow.

## Migration Approach

This is a pure refactor — no behavioral changes. Every error the type checker currently reports should still be reported, with the same messages.

**Test considerations:** Most tests should pass unchanged. However, tests that directly call `checker.isAssignable()` on a `TypeChecker` instance (the "literal type assignable to base primitive" describe block in `typeChecker.test.ts`) will need their imports and calling conventions updated since `isAssignable` moves to a standalone function in `assignability.ts`. The `TypeChecker` class should re-export `isAssignable` as a method that delegates to the standalone function, preserving the existing test interface.

Suggested order:

1. Extract `types.ts` and `builtins.ts` — zero-risk, just moving definitions
2. Extract `assignability.ts` — pure functions, easy to test in isolation
3. Extract `validate.ts` — simple recursive walker
4. Extract `synthesizer.ts` — pull out `synthType` and helpers
5. Extract `inference.ts` — pull out return type inference
6. Split `collectVariableTypes` into collection (`scopes.ts`) and checking (`checker.ts`) — this is the hardest step
7. Slim down `index.ts` to orchestrator

Each step should leave tests passing. The risky step is #6 since it changes the control flow from single-pass to two-pass.

## Risks

**Two-pass vs single-pass for variable collection.** Currently `collectVariableTypes` collects types AND checks them in one walk. Splitting into two passes means the second pass re-walks the same nodes. This is negligible for Agency program sizes but worth noting.

**Circular dependencies between modules.** `checker.ts` calls `synthType`, `synthType` calls `isAssignable`, `inference.ts` calls both. The `TypeCheckerContext` object avoids circular imports by passing capabilities through the context rather than importing across modules.

**`synthValueAccess` reports errors.** This breaks the clean "synthesizer doesn't report errors" rule. This is inherent to synthesis — you can't synthesize a type for `foo.bar` if `foo` has no property `bar`. The alternative (returning `any` silently) loses useful error messages. Accept this exception.

**Two-pass split may change partial-scope behavior.** Currently `collectVariableTypes` synthesizes types using a partially-built variable map — a variable declared on line 5 is available when checking line 10, but not vice versa. The two-pass version gives the checking pass the complete variable map, which could cause previously-`any` expressions to now resolve to concrete types, potentially surfacing new errors. This is likely rare but must be verified by running the full test suite after step 6. If any tests break, it indicates the ordering matters and the implementer should investigate whether the new behavior is actually more correct (it likely is).

**`buildScopes` is a new extraction, not a rename.** Step 3 in the `check()` flow (`buildScopes`) does not exist as a separate method today. Currently scope building is the first half of `checkScopes`. The implementer must extract it.
