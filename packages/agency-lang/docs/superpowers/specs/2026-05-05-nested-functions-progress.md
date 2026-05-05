# Nested Functions with Closures — Implementation Progress

## Branch

`feature/nested-functions-closures` — pushed to remote.

Design spec: `docs/superpowers/specs/2026-05-04-nested-functions-with-closures-design.md`

## What's Done

### Phase 1: Runtime changes (complete, all tests pass)

**Files changed:**
- `lib/runtime/closureRegistry.ts` (new) — global registry mapping closure keys to hoisted implementation functions. Populated at module load time, read-only after that. Also exports `CLOSURE_SELF_SENTINEL` for recursive inner function handling.
- `lib/runtime/agencyFunction.ts` — added `closureData` and `closureKey` fields to `AgencyFunction`. Updated `invoke()` to inject `closure` and `self` into the state object when `closureData` is present.
- `lib/runtime/revivers/functionRefReviver.ts` — updated `serialize()` to include `closureKey`, `closureData`, `toolDefinition`, and `params` for closure functions. Updated `revive()` to look up the implementation via `lookupClosure()` from the global registry and replace `__self__` sentinels for recursive inner functions.
- `lib/runtime/index.ts` — exported `registerClosure`, `lookupClosure`, `CLOSURE_SELF_SENTINEL`, and `ClosureRegistryEntry`.

**Tests:** 47 pass (21 AgencyFunction + 26 FunctionRefReviver, including new closure-specific tests).

### Phase 2: Parser changes (complete, all tests pass)

**Files changed:**
- `lib/parsers/parsers.ts` — added `functionParser` to the `bodyNodeParser` list inside `bodyParser`, allowing `def` statements inside function/node bodies.

**Tests:** 231 pass (9 body + 222 function parser tests, including new nested def tests).

### Phase 3: Preprocessor — closure analysis (partial)

**Files changed:**
- `lib/types.ts` — added `"captured"` to the `ScopeType` union.
- `lib/types/function.ts` — added `CapturedVariable` type and `capturedVariables`/`selfReferencing` fields to `FunctionDefinition`.
- `lib/preprocessors/typescriptPreprocessor.ts` — added `lookupScopeWithCapture()` and `getCaptureInfo()` helpers. Modified `resolveVariableScopes()` to detect nested functions via the `scopes` chain, and use capture-aware lookup (`effectiveLookup`) that checks enclosing function scopes and marks matches as `"captured"`. At the end of processing a nested function, captured variables are attached to the AST node.
- `lib/utils/node.ts` — modified `getAllVariablesInBody()` to not explicitly recurse into nested function params/body (yields the function name only).

**Tests:** Existing tests (73 preprocessor, 148 builder) all pass. New closure analysis tests are written but 3 of 5 are failing due to the blocker below.

## The Blocker

### `getAllVariablesInBody` and `walkNodes` double-recursion

`getAllVariablesInBody()` iterates using `walkNodes()` at its core (line 133 of `lib/utils/node.ts`):

```typescript
for (const { node } of walkNodes(body)) {
```

`walkNodes()` recurses into nested function bodies automatically (line 275-280 of `lib/utils/node.ts`):

```typescript
if (node.type === "function") {
  yield* walkNodes(node.body, [...ancestors, node], [...scopes, functionScope(node.functionName)]);
}
```

So even though I stopped `getAllVariablesInBody` from explicitly recursing into nested function bodies, `walkNodes` still yields those inner body nodes as part of its depth-first traversal.

**The effect:** When the preprocessor processes the outer function's body in Phase 2:
1. `getAllVariablesInBodyArray(outer.body)` is called
2. `walkNodes` yields nodes from both the outer and inner function bodies
3. The outer function's Phase 2 scopes the inner function's variables (`x`, `y`, `z`) using the outer function's lookup — giving them `"args"`, `"local"`, `"imported"` respectively
4. When the inner function later gets its own processing pass, those variables already have `scope` set, so `if (varNode.scope) continue` skips them
5. The capture logic never fires

**The fix needed:** `getAllVariablesInBody` needs to skip nodes that `walkNodes` yields from inside a deeper function scope. The `walkNodes` generator already provides `scopes` alongside each node — `getAllVariablesInBody` currently destructures only `{ node }` and ignores `scopes`. By also checking `scopes`, it can filter out nodes whose function scope depth exceeds the starting depth.

Concretely, change the iteration from:
```typescript
for (const { node } of walkNodes(body)) {
```
to:
```typescript
let initialFuncDepth: number | null = null;
for (const { node, scopes } of walkNodes(body)) {
  const funcDepth = scopes.filter(s => s.type === "function" || s.type === "node").length;
  if (initialFuncDepth === null) initialFuncDepth = funcDepth;
  if (funcDepth > initialFuncDepth) continue;
```

This is a safe change because `getAllVariablesInBody` is only used for variable scope resolution, and nested function bodies get their own scope processing pass via `walkNodesArray` in `resolveVariableScopes`.

However, `getAllVariablesInBody` is used broadly (preprocessor, builder lookups), so the change needs careful testing to make sure it doesn't break anything. The existing 148 builder integration tests and 73 preprocessor tests should be sufficient to validate this.

## What's Left

### Phase 3 completion
- Apply the `getAllVariablesInBody` scope-depth fix
- Verify the 3 failing closure analysis tests pass
- Run full test suite

### Phase 4: Builder — code generation
- Detect nested vs top-level functions in `processFunctionDefinition()`
- Prevent `isTopLevelDeclaration()` from returning true for nested functions
- Hoist inner function implementations to module level with namespaced names
- Generate `registerClosure()` calls at module level
- Generate `closureData` snapshot at the creation point
- Generate `__closureInit` block in hoisted implementations
- Rewrite captured variable references to `__self.__c_varName`
- Handle self-referencing inner functions (sentinel pattern)
- Use `new AgencyFunction()` instead of `AgencyFunction.create()` (no auto-registration in `__toolRegistry`)
- Fixture tests

### Phase 5: Typechecker
- Build scopes for nested functions (currently `buildScopes()` only handles top-level)
- Type-check inner function bodies with captured variable types in scope
- Reject `export` on inner function definitions
- Allow `safe` on inner function definitions
- Reject same-name inner functions in same outer function

### Phase 6: Formatter and debugger
- Update formatter for nested `def` indentation/blank lines
- Source maps for hoisted implementations
- `scopeName` for debugger display

### Phase 7: Integration tests and documentation
- End-to-end Agency tests (basic closure, interrupt survival, fork, cross-module)
- `docs/dev/closures.md` documenting the mental model and naming conventions
- Language guide updates

## Scoping Issues Inventory

During investigation, I found all places in the pipeline that assume functions are top-level. These need guard clauses (most are one-line changes) across Phases 3-5:

| File | Location | Issue |
|------|----------|-------|
| Preprocessor `getFunctionDefinitions()` | line 385-391 | Only collects from `program.nodes` |
| Preprocessor `containsInterrupt()` | line 564 | Flat lookup in `functionDefinitions` |
| Preprocessor `topologicalSortFunctions()` | lines 700-710 | Iterates `functionDefinitions` keys |
| Preprocessor variable resolution | lines 1539, 1551, 1576 | Flat `this.functionDefinitions[name]` lookups |
| Compilation unit | lines 136-141 | Only collects top-level functions |
| Builder `isTopLevelDeclaration()` | lines 402-405 | Returns true for any `function` node |
| Builder `processFunctionDefinition()` | lines 1792-1871 | Auto-registers in `__toolRegistry` |
| Builder flat lookups | lines 436-437, 461-462, 1485-1486 | `compilationUnit.functionDefinitions[name]` |
| Type checker `buildScopes()` | lines 36-41 in `scopes.ts` | Only iterates top-level function defs |
