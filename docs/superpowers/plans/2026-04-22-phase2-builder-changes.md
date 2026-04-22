# Phase 2 Builder Changes — Detailed Change Map

This document captures the exact changes needed for the AgencyFunction builder migration (Tasks 6-9). Use this to pick up where you left off after context compaction.

## Current branch: `adit/agency-function-phase2` (off main which has Phase 1 merged)

## Status: Tasks 1-5 complete. Tasks 6-9 in progress (not started yet).

---

## Change Overview

The builder currently emits bare functions, `__toolTool`/`__toolToolParams` declarations, a `__toolRegistry` with `{ definition, handler }` entries, and `__functionRef` metadata. This all changes to `AgencyFunction.create()` with embedded metadata, `.invoke()` call sites, and a flat `Record<string, AgencyFunction>` registry.

---

## Exact Changes by File

### `lib/backends/typescriptBuilder.ts`

#### 1. `build()` method (lines 460-582)

**Before:**
```
Pass 5: processTool() for each function → pushes __toolTool and __toolToolParams
generateToolRegistry() → pushes __toolRegistry
generateFunctionRefMetadata() → pushes __functionRef assignments + reviver binding
Pass 7: processNode() for all nodes (incl. function defs)
```

**After:**
```
// Remove Pass 5 tool loop entirely (lines 461-468)
// Replace generateToolRegistry with empty registry + imported/builtin registrations
// Remove generateFunctionRefMetadata call (lines 474-476)
// Pass 7 stays but processFunctionDefinition now emits AgencyFunction.create()
// After Pass 7: emit reviver binding
```

Concrete changes:
- **Delete lines 461-468** (the processTool loop)
- **Replace line 471** `generateToolRegistry(functionDefs)` with `generateToolRegistry()` (no args, emits empty registry + imports + builtins + reviver binding)
- **Delete lines 474-476** (generateFunctionRefMetadata call)

#### 2. `processTool()` (lines 1446-1500) — DELETE or gut

No longer emits `__toolTool` and `__toolToolParams`. The Zod schema and params go into `AgencyFunction.create()` inside `processFunctionDefinition()`.

Option A: Delete entirely and move schema generation to `processFunctionDefinition`.
Option B: Repurpose to return the schema/params as data (not TsNodes) for use by `processFunctionDefinition`.

**Recommend B** — keep the Zod schema generation logic but return structured data instead of TsNodes.

#### 3. `buildToolRegistryEntry()` (lines 1502-1516) — DELETE

No longer needed. Registry entries are `AgencyFunction` instances added by `.create()`.

#### 4. `generateToolRegistry()` (lines 1522-1557) — REWRITE

**After:**
```typescript
private generateToolRegistry(): TsNode {
  const stmts: TsNode[] = [
    ts.varDecl("const", "__toolRegistry", ts.raw("{}")),
  ];

  // Imported tools: register imported AgencyFunction instances
  for (const toolImport of this.programInfo.importedTools) {
    for (const namedImport of toolImport.importedTools) {
      for (const originalName of namedImport.importedNames) {
        const localName = namedImport.aliases[originalName] ?? originalName;
        stmts.push(ts.raw(`__toolRegistry[${JSON.stringify(localName)}] = ${localName};`));
      }
    }
  }

  // Builtin tools
  for (const toolName of BUILTIN_TOOLS) {
    const internalName = BUILTIN_FUNCTIONS[toolName] || toolName;
    stmts.push(ts.raw(`__toolRegistry[${JSON.stringify(toolName)}] = ${internalName};`));
  }

  // Bind reviver
  stmts.push(ts.raw("__functionRefReviver.registry = __toolRegistry;"));

  return ts.statements(stmts);
}
```

#### 5. `generateFunctionRefMetadata()` (lines 1564-1594) — DELETE

Metadata is now in the `AgencyFunction` constructor. Reviver binding moves to `generateToolRegistry()`.

#### 6. `processFunctionDefinition()` (lines 1775-1822) — MAJOR REWRITE

**Before:**
```typescript
async function add(a, b, __state) { ... }
```

**After:**
```typescript
async function __add_impl(a, b, __state) { ... }
const add = __AgencyFunction.create({
  name: "add",
  module: "thisModule.agency",
  fn: __add_impl,
  params: [
    { name: "a", hasDefault: false, defaultValue: undefined, variadic: false },
    { name: "b", hasDefault: true, defaultValue: undefined, variadic: false },
  ],
  toolDefinition: { name: "add", description: "...", schema: z.object({...}) },
}, __toolRegistry);
```

Key changes:
- Function name becomes `__${functionName}_impl`
- Emit `const ${functionName} = __AgencyFunction.create({...}, __toolRegistry)` after
- Export the `const` declaration (not the function)
- Default value handling in params: `defaultValue: ts.id("null")` → `defaultValue: ts.id("__UNSET")`
- Default handling in body: `ts.binOp(ts.id(param.name), "??", defaultNode)` at line 1690 → `ts.ternary(ts.binOp(ts.id(param.name), "===", ts.id("__UNSET")), defaultNode, ts.id(param.name))`

**`_functionRefVars` tracking** — DELETE:
- Remove field declaration (line 167)
- Remove save/restore in processFunctionDefinition (lines 1781, 1783, 1786)
- Remove save/restore in processGraphNode (lines 2178, 2179, 2197)
- Remove tracking in processAssignment (lines 2391, 2393)

#### 7. `generateFunctionCallExpression()` (lines 1989-2089) — MAJOR REWRITE

**Before:** Three branches (Agency func, system, TS func) with compile-time arg resolution.
**After:** Two branches (Agency func → `.invoke()`, everything else → direct call). No arg resolution.

For Agency functions:
```typescript
// Positional: add(1, 2)
await add.invoke({ type: "positional", args: [1, 2] }, __state)

// Named: add(b: 2, a: 1)
await add.invoke({ type: "named", positionalArgs: [], namedArgs: { b: 2, a: 1 } }, __state)
```

The builder constructs the CallType descriptor:
- Check if any args are `namedArgument` type
- If yes: emit `{ type: "named", positionalArgs: [...], namedArgs: {...} }`
- If no: emit `{ type: "positional", args: [...] }`

Remove calls to `resolveNamedArgs()`, `adjustCallArgs()`.
Remove `_functionRefVars` checks.
The callee is always just the identifier — `.invoke()` is called on it.

For `__state`: pass `__state` directly (already in scope in function/node bodies).

#### 8. `resolveNamedArgs()` (lines 597-692) — DELETE
#### 9. `adjustCallArgs()` (lines 734-759) — DELETE
#### 10. `getCalleeParams()` (lines 725-732) — DELETE

#### 11. `buildPipeLambda()` (lines 3102-3178) — REWRITE pipe stages

Pipe stages now use `.invoke()`:
```typescript
// value |> fn(10, ?)
async (__pipeArg) => fn.invoke({ type: "positional", args: [10, __pipeArg] }, __state)
```

Remove `getCalleeParams()` and `adjustCallArgs()` calls.
Remove `buildPipeStateArgs()` calls — state is passed to `.invoke()`.

#### 12. `buildPipeStateArgs()` (lines 3229-3238) — DELETE

#### 13. `processImportToolStatement()` (lines 1406-1427) — SIMPLIFY

Only import the function itself (which is now an `AgencyFunction` instance). Remove `__toolTool` and `__toolToolParams` imports.

#### 14. `processLlmCall()` (lines 2592-2775) — REWRITE tool resolution

Tools are now `AgencyFunction` instances passed directly:
- `uses add` → `[add]` (bare identifiers)
- `llm("...", { tools: myArray })` → pass through as-is
- Remove `tool("name")` lookup calls

#### 15. Default value sentinel change

In `buildFunctionBody()` at line 1690:
```typescript
// Before:
ts.binOp(ts.id(param.name), "??", defaultNode)

// After:
// param === __UNSET ? defaultNode : param
```

In `processFunctionDefinition()` at line 1796:
```typescript
// Before:
defaultValue: ts.id("null")

// After:
defaultValue: ts.id("__UNSET")
```

### `lib/templates/backends/typescriptGenerator/imports.mustache`

- Add `AgencyFunction as __AgencyFunction` and `UNSET as __UNSET` back to imports
- Delete `tool()` function (lines 46-49)
- Delete `_builtinTool as __builtinTool` import (no longer needed)

### `lib/runtime/builtins.ts`

- Delete `ToolRegistryEntry` type
- Delete `tool()` function

### `lib/runtime/prompt.ts`

- Update `executeToolCalls()` to work with `AgencyFunction` instances
- `handler.name` → same
- `handler.params` → `handler.params.map(p => p.name)`
- `handler.execute(...params)` → `handler.invoke({ type: "named", positionalArgs: [], namedArgs: toolCall.arguments }, state)`
- Remove manual state push
- Update tool definition extraction: `.definition` → `.toolDefinition`

### `lib/runtime/mcp/toolAdapter.ts`

- Wrap MCP tools in `AgencyFunction` instances

### `lib/runtime/revivers/functionRefReviver.ts`

- Remove legacy support (bare functions, old registry shape)
- Remove `typeof "function"` guard from `nativeTypeReplacer` in `index.ts`

### `lib/runtime/index.ts`

- Remove `ToolRegistryEntry` export
- Remove `tool as _builtinTool` export

---

## Order of Changes (within the atomic migration)

1. Update imports.mustache (add __AgencyFunction/__UNSET, delete tool())
2. Rewrite processFunctionDefinition + processTool → emit AgencyFunction.create()
3. Rewrite generateToolRegistry → empty + imports + builtins + reviver
4. Delete generateFunctionRefMetadata, buildToolRegistryEntry
5. Rewrite generateFunctionCallExpression → .invoke() with descriptors
6. Delete resolveNamedArgs, adjustCallArgs, getCalleeParams, _functionRefVars
7. Rewrite buildPipeLambda, delete buildPipeStateArgs
8. Simplify processImportToolStatement
9. Rewrite processLlmCall tool resolution
10. Update default sentinel (null → UNSET) in buildFunctionBody + processFunctionDefinition
11. Update prompt.ts for AgencyFunction
12. Delete ToolRegistryEntry, tool() from builtins.ts
13. Update MCP adapter
14. Remove legacy support from reviver
15. Rebuild all fixtures

## Confirmed: IR helpers available

- `ts.ternary(condition, trueExpr, falseExpr)` — exists at `lib/ir/builders.ts:655`
- `ts.prop(obj, propName)` — for property access like `foo.invoke`
- `$(callee).prop("invoke").call([...args]).done()` — chain builder pattern for `foo.invoke(...)`
- `ts.binOp(left, "===", right)` — for equality checks

## Calling convention for .invoke()

```typescript
// Pattern for emitting: await add.invoke({ type: "positional", args: [1, 2] }, __state)
const invokeCall = $(callee).prop("invoke").call([descriptor, ts.id("__state")]).done();
return ts.await(invokeCall);
```

Where `descriptor` is built as:
```typescript
// Positional:
ts.obj({ type: ts.str("positional"), args: ts.arr(argNodes) })

// Named:
ts.obj({
  type: ts.str("named"),
  positionalArgs: ts.arr(positionalNodes),
  namedArgs: ts.obj(namedEntries),
})
```
