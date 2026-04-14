# Export Keyword for Functions

## Summary

Add an `export` keyword to Agency function definitions. Only functions explicitly marked with `export` are exported in the generated TypeScript. Functions without `export` are private to their module.

## Current Behavior

All functions are unconditionally exported. A plain `def greet() { ... }` generates `export async function greet(...)`.

## New Behavior

- `def greet() { ... }` generates `async function greet(...)` (not exported)
- `export def greet() { ... }` generates `export async function greet(...)`

## Syntax

`export` is optional and comes before all other modifiers:

```
def greet() { ... }                    # not exported
export def greet() { ... }             # exported
export safe def greet() { ... }        # exported, safe
export safe async def greet() { ... }  # exported, safe, async
export async def greet() { ... }       # exported, async
```

Keyword order: `export` > `safe` > `async`/`sync` > `def`.

## Scope

- **Functions only.** Nodes are unaffected — they retain their existing `public`/`private` visibility system.

## Cross-module imports

Functions that are imported by other `.agency` files (via `import` or `import tool`) must be marked `export`. The symbol table tracks the `exported` flag and validates at import resolution time that imported functions are exported, emitting an error if not.

Tool metadata exports (`__<name>Tool` and `__<name>ToolParams`) are always exported when a function is used as a tool — the `export` keyword only controls the function declaration itself.

## Implementation

### 1. AST (`lib/types/function.ts`)

Add `exported?: boolean` to `FunctionDefinition`.

### 2. Parser (`lib/parsers/function.ts`)

Add an `exportKeywordParser` that optionally parses the `export` keyword. Wire it into `_functionParserInner` before the `safeKeywordParser`, and set the `exported` field on the resulting AST node.

### 3. Symbol Table (`lib/symbolTable.ts`)

Add `exported?: boolean` to `SymbolInfo`. In `classifySymbols`, store the `exported` flag from the function AST node. In `buildSymbolTable`, when processing import statements, validate that the imported function is marked `exported` in the source file's symbols. Emit an error if a non-exported function is imported.

### 5. Code Generation (`lib/backends/typescriptBuilder.ts`)

In `processFunctionDefinition`, change the hardcoded `export: true` to `export: !!funcDef.exported`.

### 6. Agency Formatter (`lib/backends/agencyGenerator.ts`)

Update the function formatting to emit `export` when `exported` is true.

### 7. Test Fixtures

- Update existing function fixtures to add `export` where functions are expected to be exported.
- Add a new fixture with both exported and non-exported functions to verify correct generation.

### 8. Documentation (`DOCS.md`)

Update the function definition syntax section to document the `export` keyword.
