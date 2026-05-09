# Function Identity Tracking in the Type Synthesizer

## Goal

Add a `functionRefType` to the type system so the type checker knows which variables and expressions refer to specific functions. Use this to replace the ad-hoc AST walking in the interrupt analyzer with general-purpose type-level analysis, and introduce a `function` primitive type for user annotations.

## Background

The interrupt analyzer (`interruptAnalyzer.ts`) has ~60 lines of special-case logic to figure out which functions are passed as tools to `llm()` calls. It parses the AST to find patterns like `llm("prompt", { tools: [foo, bar] })` and traces variable assignments. This is brittle and can't handle spreads, conditionals, or other dynamic patterns.

Meanwhile, the type synthesizer already knows how to synthesize types for arrays, objects, spreads, and unions. If it tracked function identity, the interrupt analyzer could ask the type system "what functions are in this tools array?" instead of doing its own AST analysis.

## Design

### 1. New `functionRefType` variant

A new internal `VariableType` variant produced by the synthesizer when it encounters a bare function/node name used as a value (not a call):

```typescript
{
  type: "functionRefType",
  name: string,
  params: FunctionParameter[],
  returnType: VariableType | null,
}
```

`synthType` for `variableName` currently returns `scope.lookup(name) ?? "any"`. It gains fallback checks against `ctx.functionDefs`, `ctx.nodeDefs`, and `ctx.importedFunctions`, returning a `functionRefType` when matched. Precedence: `scope.lookup` wins (a local variable shadows a function name), and `functionRefType` is only synthesized when `scope.lookup` returns nothing.

Note: `synthPipeRhs` already performs this same fallback lookup for pipe RHS expressions. With this change, `synthPipeRhs` can be simplified to just call `synthType` since the fallback is now built in.

**Adding `functionRefType` to the `VariableType` union** (in `lib/types/typeHints.ts`) affects every `switch` on `VariableType.type` across the codebase. Most consumers (formatTypeHint, TypeScript builder, LSP completion) can treat it as a default/`any` case. Explicit handling is needed in:
- `lib/typeChecker/assignability.ts` — the new assignability rules
- `lib/typeChecker/synthesizer.ts` — producing the type
- `lib/utils/formatType.ts` / `lib/cli/util.ts` — formatting for display (e.g. `function deploy(x: number): string`)

This flows through existing type machinery:
- `synthArray([deploy, validate])` → `arrayType<functionRefType>`
- `synthObject({ tools: [deploy] })` → `objectType` with a `tools` property of `arrayType<functionRefType>`
- Spreads, variable references, and conditionals all resolve through normal synthesis

### 2. New `function` primitive type

A user-facing type for annotations, e.g. `def retry(fn: function, times: number)`. Lowercase, consistent with Agency's existing primitives (`string`, `number`, `boolean`, `any`).

The parser currently accepts `def` and `callback` as function definition keywords (not `function`). `function` is already free as a type name — no parser migration needed for function definitions. The type parser gains `function` as a recognized primitive type name.

### 3. Assignability rules

Added to `isAssignable` in `lib/typeChecker/assignability.ts`:

- `functionRefType` is assignable to `any` (existing behavior for all types)
- `functionRefType` is assignable to `function` (the new primitive, represented as `primitiveType({ value: "function" })`)
- Two `functionRefType`s are mutually assignable if their parameter types and return types are compatible (using existing `isAssignable` recursively)
- `function` primitive is assignable to `any`

Note: `callback` functions are not tracked as `functionRefType`. Callbacks have different semantics (block arguments) and are not used as tool references. If a callback is passed in a tools array, it will synthesize as `any` — this is acceptable for the MVP.

### 4. Moving interrupt analysis to the type checker

**Current pipeline:**
```
parse → SymbolTable.build (includes analyzeInterrupts) → buildCompilationUnit → typeCheck
```

**New pipeline:**
```
parse → SymbolTable.build → buildCompilationUnit → typeCheck (includes interrupt analysis)
```

The interrupt analyzer module (`interruptAnalyzer.ts`) is deleted. Its responsibilities move:

**Direct interrupt collection** moves to `classifySymbols` in `symbolTable.ts`. `classifySymbols` already iterates nodes via `walkNodes`. For `function` and `graphNode` nodes, it additionally walks the body to find `interrupt` statements and records their kinds on the symbol. No transitive propagation — just direct statements (~10 lines).

**Transitive propagation and call graph building** move to the type checker. The type checker already walks every function body and synthesizes types. During this walk:

1. **Direct interrupts**: Collected from `interrupt` statements
2. **Direct callees**: Collected from `functionCall` nodes
3. **Tool callees via `functionRefType`**: When the checker sees `llm("prompt", { tools: expr })`, it synthesizes `expr`'s type. If it's `arrayType<functionRefType>`, extract the function names from the element type. No special-case AST walking needed — spreads, variables, conditionals all resolve through normal synthesis.
4. **Transitive propagation**: Fixed-point iteration over the call graph, same algorithm as today but in the type checker.

**Cross-file propagation**: The symbol table stores direct interrupt kinds per function (from `interrupt` statements only). `buildCompilationUnit` copies these into the type checker context via `interruptKindsByFunction`, including both local symbols and imported functions/nodes. The type checker then does transitive propagation across local + imported functions together — imported functions' direct kinds are already available from their symbol table entries, so a single unified propagation pass in the type checker resolves everything.

`TypeCheckResult` gains `interruptKindsByFunction` containing the fully-resolved transitive interrupt kinds, so consumers (LSP, serve) can access the results.

### 5. Serve pipeline change

`compileForServe` adds a type checker run. The flow becomes:

```
parse → SymbolTable.build → buildCompilationUnit → typeCheck → compile
```

Type errors are logged as warnings. Transitive `interruptKindsByFunction` from the type check result gets threaded into `discoverExports`, replacing the current symbol-table-based approach.

Both `serveMcp` and `serveHttp` share `compileForServe`, so the change is in one place.

### 6. What gets deleted

- `interruptAnalyzer.ts` — entire module
- `interruptAnalyzer.test.ts` — its tests
- The `analyzeInterrupts` call in `SymbolTable.build`
- `extractToolsFromLlmCall`, `extractFunctionNamesFromArray`, `extractNamesFromArrayItems`, `traceVariableToArray` — all special-case AST walking

### 7. What gets added/modified

- `functionRefType` variant in `VariableType` (types)
- `function` primitive type (type parser, type system)
- Type parser: `function` recognized as a primitive type name
- `synthType` for `variableName`: fallback to function/node defs → `functionRefType`
- Assignability rules for `functionRefType` and `function` primitive (`lib/typeChecker/assignability.ts`)
- `classifySymbols`: direct interrupt collection (~10 lines)
- Type checker: interrupt analysis pass (call graph + transitive propagation)
- `TypeCheckResult`: gains `interruptKindsByFunction`
- Serve pipeline: runs type checker before compile

## Testing

**`functionRefType` unit tests:**
- `synthType` returns `functionRefType` for bare function names (local, imported, nodes)
- `synthArray` with function refs produces `arrayType<functionRefType>`
- Spreads, variable references, conditionals propagate `functionRefType`
- Assignability: `functionRefType` → `any`, `functionRefType` → `function`, compatible signatures are mutually assignable, incompatible are not

**Interrupt analysis tests (migrated from `interruptAnalyzer.test.ts`):**
- Same scenarios tested through the type checker pipeline: direct interrupts, transitive propagation, cycles, cross-file imports, aliases
- New scenarios enabled by `functionRefType`: `llm()` with spread tools arrays, tools via conditionals, dynamically built tools arrays

**Parser tests:**
- `function` parses as a type in annotations (e.g. `fn: function`)

**Serve pipeline tests:**
- Type checker runs during serve, errors reported
- Interrupt kinds flow through to MCP descriptions and HTTP `/list`

**Existing `interruptWarnings.test.ts`:**
- Should continue to pass unchanged (end-to-end pipeline tests)
