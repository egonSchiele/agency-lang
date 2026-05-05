# Nested Functions with Closures — Surprises and Lessons Learned

## 1. The spec underestimated the scope of "scoping"

The design spec's preprocessor section (Phase 3) said:

> The preprocessor already walks up the scope chain for variable resolution (it does this for blocks). The extension: When resolving a variable inside an inner function body, if it resolves to a local/arg in an enclosing FUNCTION scope, mark it as "captured".

This turned out to be wrong. The spec assumed the preprocessor has a scope chain it walks up, like blocks do. But blocks and functions work completely differently in the preprocessor:

**Blocks** share the enclosing function's scope. When a block references a variable, `lookupScope(enclosingFuncName, varName)` is called — the lookup is on the *enclosing function's* name, not the block's. Blocks don't create a new scope entry in `funcArgs`/`localVarsInFunction`. They're transparent.

**Functions** create their own entry. `funcArgs["inner"]` and `localVarsInFunction["inner"]` are separate from the outer function's entries. The `lookupScope` function takes a single `funcName` and checks only that function's args/locals, then falls through to global/imported/static. There is no parent chain.

The spec said "the preprocessor already walks up the scope chain" — it doesn't. The preprocessor's scope resolution is flat: one function name, one lookup. The "walk up" behavior for blocks is an illusion created by the fact that blocks use the enclosing function's name for lookup.

**Time spent:** Understanding this mismatch and designing the `lookupScopeWithCapture`/`effectiveLookup` solution took significant time, mostly because I had to trace through the actual preprocessor code to understand how scope resolution really works, versus how the spec assumed it works.

## 2. `getAllVariablesInBody` and `walkNodes` are coupled in a way that makes filtering hard

This was the biggest surprise and is the current blocker. The spec didn't mention `getAllVariablesInBody` at all — it's an internal utility function that the preprocessor uses to collect all variable references in a function body.

The problem is architectural: `getAllVariablesInBody` uses `walkNodes` as its iteration driver:

```typescript
for (const { node } of walkNodes(body)) {
```

`walkNodes` is a general-purpose AST walker that recurses into *everything* — including nested function bodies. It's designed this way because it's used for many purposes (scope chain tracking, AST traversal, etc.).

Before nested functions existed, this coupling was fine — there were no nested function bodies to worry about. `getAllVariablesInBody` also had its own explicit recursion into function bodies at line 137-142:

```typescript
} else if (node.type === "function") {
  yield { name: node.functionName, node };
  for (const param of node.parameters) {
    yield { name: param.name, node };
  }
  yield* getAllVariablesInBody(node.body);  // explicit recursion
}
```

So it was double-recursing: `walkNodes` recurses into the function body AND `getAllVariablesInBody` explicitly recurses too. This was redundant but harmless when all functions were top-level (the same variables just got yielded twice and scoped the same way).

My first fix removed the explicit recursion (lines 139-142), thinking that would stop `getAllVariablesInBody` from seeing inner function variables. But `walkNodes` is still yielding them! The `for (const { node } of walkNodes(body))` loop gets every node from the entire subtree, including nodes deep inside nested function bodies.

**What the spec should have said:** "The `getAllVariablesInBody` utility needs to be modified to not yield variables from nested function bodies, but this is complicated by the fact that it delegates to `walkNodes` which recurses unconditionally. The fix requires using the `scopes` array from `walkNodes` to filter by function scope depth."

**Time spent:** This consumed the most debugging time. I made the initial change, ran tests (they passed because there were no nested functions in existing tests), wrote new tests, and they failed. Then I had to trace through the execution to understand *why* — the outer function's Phase 2 was scoping inner function variables before the inner function got its own pass. The root cause (walkNodes recursion) wasn't obvious from reading the code because the coupling between `getAllVariablesInBody` and `walkNodes` is implicit.

## 3. The breadth of "top-level function" assumptions was much larger than expected

The spec identified changes needed in the preprocessor, builder, and typechecker, but described them at a high level. During investigation, I found **10 specific locations** across 5 files that assume functions are top-level:

- Preprocessor: `getFunctionDefinitions()`, `containsInterrupt()`, `topologicalSortFunctions()`, three variable resolution lookups
- Compilation unit: `functionDefinitions` collection
- Builder: `isTopLevelDeclaration()`, `processFunctionDefinition()`, three flat lookups
- Type checker: `buildScopes()`

The spec mentioned the preprocessor and builder changes but didn't enumerate the specific locations. Most of these are one-line guard clauses (check if the function is nested and skip it), but knowing the complete list upfront would have avoided potential surprises during Phase 4 and 5.

**What the spec should have said:** Listed every place in the pipeline that references `functionDefinitions` or assumes functions are at the module top level, with the specific fix needed for each.

## 4. The `FunctionRefReviver` needs `closureData` to go through the replacer/reviver pipeline

The spec correctly described the serialization format and the reviver changes. What it didn't call out explicitly is that `closureData` is a plain object that gets serialized as part of the JSON — and since it's embedded in the `FunctionRefReviver.serialize()` output, it goes through `nativeTypeReplacer` automatically when the containing object is stringified.

This means nested `AgencyFunction` instances inside `closureData` (like when an inner function captures another inner function) get recursively serialized by the replacer. And on the revive path, the `nativeTypeReviver` processes the nested objects before the parent — so by the time `FunctionRefReviver.revive()` runs for the outer function, the inner `AgencyFunction` in `closureData` has already been revived.

This "just works" because of how `JSON.parse` with a reviver processes bottom-up. But it's subtle and I only confirmed it worked correctly by writing an explicit test (`"round-trips closure containing another AgencyFunction"`).

**Not really a gap in the spec** — the spec said "closureData goes through the same nativeTypeReplacer/reviver pipeline as any other value." But it's the kind of thing you need to verify with a test because the ordering is non-obvious.

## 5. The `__self__` sentinel approach required changes in more places than expected

The spec described the sentinel pattern clearly for recursive inner functions. But implementing it required touching four places, not just two:

1. **Builder** (creation point): emit `closureData: { fib: "__self__" }` instead of a circular reference
2. **`AgencyFunction.invoke()`**: inject `self: this` alongside `closure` so the hoisted impl can resolve the sentinel
3. **`FunctionRefReviver.serialize()`**: detect `value === value` (self-reference) and replace with sentinel
4. **`FunctionRefReviver.revive()`**: detect sentinel string and replace with the reconstructed `AgencyFunction`

The spec described all four but framed them as small additions. In practice, the `serialize()` change required iterating over `closureData` entries and comparing each value against the parent `AgencyFunction` instance — a pattern that's a bit unusual in a serializer. And the `revive()` change mutates `closureData` after constructing the `AgencyFunction`, which means `closureData` can't be truly `readonly` at the TypeScript level (the field is declared `readonly` but we cast to mutate it).

**Time spent:** Not much — the implementation was straightforward once I understood all four touch points.

## 6. Lambda implications were not in the spec at all

During review, the user asked about how lambdas (the next feature after nested functions) would interact with this design. This surfaced several assumptions baked into the spec that won't hold for lambdas:

- **Inner functions have names.** The closure key, hoisted impl name, and registry key all depend on the function name. Lambdas are anonymous.
- **Inner functions are statements.** The parser change adds `functionParser` to `bodyParser` — statement position only. Lambdas are expressions.
- **Inner functions are always inside a `def` or `node`.** The closure analysis assumes an enclosing function scope. Lambdas at global scope wouldn't have one.

The decision was to accept some rework later rather than over-engineer now, but documenting these assumptions explicitly in the spec would help future work.

## 7. The execution isolation model needed careful thought for the global closure registry

The initial plan proposed a per-module `__closureRegistry` object that would be passed to the `FunctionRefReviver`. During review, the user pointed out that this breaks Agency's execution isolation guarantee — each concurrent agent invocation should get isolated state.

After analysis, we determined that a global registry is actually safe because it only stores static code (hoisted implementation functions and parameter metadata), not per-invocation data. The per-invocation data (closureData) travels on the `AgencyFunction` instance in the isolated state stack.

But this required careful reasoning. The key insight: the global registry is analogous to the compiled JavaScript module's exported functions — shared code, not shared state. Multiple concurrent invocations of `greet("Alice")` and `greet("Bob")` each create their own `AgencyFunction` with different `closureData`, but they all reference the same hoisted implementation function from the registry. This is safe because the implementation is pure code.

**What the spec should have said:** Explicitly called out the execution isolation concern and explained why the global registry doesn't violate it. The updated spec now includes a "Registry design: why a global registry is safe" section.

## 8. Cross-module closure resolution was completely missing from the original spec

The original spec defined `__closureRegistry` as a per-module object with no discussion of what happens when an inner function crosses module boundaries. If module A creates an inner function and passes it to module B, and an interrupt fires in module B, the reviver needs to find module A's closure implementation.

This was caught during review and addressed by making the registry global with module-prefixed keys (e.g., `"main.agency:outer::inner"`). The fix was straightforward but the gap was significant — without it, any cross-module usage of inner functions would fail silently on interrupt resume.

## 9. Parser change was trivially easy — a single line

The spec estimated Phase 2 as a meaningful chunk of work. In practice, it was adding one line to `bodyParser`:

```typescript
functionParser,
```

The existing `functionParser` already handles `export`, `safe`, `callback` modifiers, parameter parsing, body parsing, and docstrings. Since `bodyParser` uses `or()` to try each parser in order, and `functionParser` is positioned before `assignmentParser` and `binOpParser`, it just works. The parser is already recursive (function bodies use `bodyParser`, which now includes `functionParser`), and JavaScript's evaluation-time resolution of `const` references handles the circular dependency.

**Time spent:** About 5 minutes including tests.

## Summary: where the time went

1. **~40% — Understanding the preprocessor's scope resolution.** Reading `resolveVariableScopes()`, tracing through `lookupScope`, `getAllVariablesInBody`, `walkNodes`, understanding how blocks vs functions handle scope differently, and discovering the `walkNodes` recursion issue.

2. **~25% — Investigating the full pipeline for top-level assumptions.** Searching through the symbol table, compilation unit, preprocessor, builder, and type checker for every place that references `functionDefinitions` or assumes functions are at module scope.

3. **~20% — Runtime implementation and tests.** The actual `AgencyFunction`, `FunctionRefReviver`, and `closureRegistry` changes, plus comprehensive tests including round-trip serialization tests.

4. **~10% — Design review and spec updates.** Identifying the circular reference issue, cross-module registry gap, lambda implications, and updating the spec.

5. **~5% — Parser change.** One line of code plus tests.
