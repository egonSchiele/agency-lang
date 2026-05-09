# Interrupt Kind Tracking

## Problem

Agency has structured interrupts with a `kind` field (e.g. `"myapp::deploy"`, `"std::read"`), but there is no way to programmatically determine what interrupts a function or node might throw. This information is useful for:

- **MCP/HTTP serve**: Clients need to know what interrupts to expect from a tool so they can handle them appropriately.
- **Type checker warnings**: Developers should be warned when calling a function that throws interrupts without a `handle` block.
- **LSP hover**: Showing interrupt kinds on hover helps developers understand function behavior at a glance.

## Design

### Data Model

A new type represents an interrupt kind. It uses an object rather than a plain string so that future fields (e.g. parameter types, data shape) can be added without a breaking change:

```typescript
type InterruptKind = {
  kind: string;  // e.g. "myapp::deploy", "std::read"
}
```

`FunctionSymbol` and `NodeSymbol` in the symbol table each get a new field:

```typescript
interruptKinds: InterruptKind[]
```

This is the **transitive** set: it includes interrupts thrown directly in the function body plus all interrupts reachable through the call graph.

Note: bare interrupts (without a namespace) get kind `"unknown"`. This requires no special treatment in the analyzer — it's just a kind string like any other. Users who haven't adopted structured interrupts will see `unknown` in warnings and hover info.

### New Module: `lib/interruptAnalyzer.ts`

All analysis logic is encapsulated in a new module, separate from the symbol table implementation. It exports a single entry point:

```typescript
function analyzeInterrupts(
  files: Record<string, { symbols: FileSymbols; program: AgencyProgram }>
): Record<string, FileSymbols>
```

It takes the parsed programs and classified symbols for all files, and returns new `FileSymbols` with `interruptKinds` populated on every function and node symbol. The symbol table builder calls this after parsing all files and running `classifySymbols`, then uses the returned symbols.

The symbol table builder needs a small change: it must retain parsed `AgencyProgram` instances (currently discarded after `classifySymbols`) long enough to pass them to the analyzer. After the analyzer returns, the programs can be discarded.

### Analysis Phases

The analyzer runs three phases. Phases 1 and 2 can be performed in a single AST walk for efficiency, since both require walking function/node bodies. They are described separately here for clarity.

#### Phase 1: Direct Collection

Walk each function/node body and collect interrupt kinds that appear directly in the AST:

- **`interruptStatement` nodes**: Read the `kind` field directly.
- **Block arguments at call sites**: When a function is called with a trailing `as` block or inline `\` block, walk the block body. Interrupt kinds found in the block are attributed to the *calling* function, not the callee — because the block is defined by the caller. The callee is a generic utility that just invokes whatever block it receives.
- **Function references and partial applications passed as arguments**: Resolve back to the original function definition and include its interrupt kinds at the call site. This includes:
  - Direct references: `higherOrderFn(deploy)`
  - Partial applications: `higherOrderFn(deploy.partial(env: "prod"))`
  - References stored in a variable and then passed: `const fn = deploy.partial(env: "prod"); higherOrderFn(fn)` — trace the variable back to its assignment to resolve the original function.
  - Array literals containing function references: `const tools = [deploy, cleanup]; llm("...", { tools: tools })` — trace the variable back to the array literal and resolve each element.
- **`handle` blocks with function ref handlers**: If a `HandleBlock` uses a function reference handler (not an inline handler), and that handler function itself throws interrupts, those interrupt kinds are attributed to the function containing the `handle` block.

#### Phase 2: Call Graph Construction

For each function/node, record which other functions/nodes it calls by walking the AST for `functionCall` nodes and resolving names to symbols. This includes:

- Direct function calls: `deploy("prod")`
- Node calls: `return checkout(cart)`
- `llm()` calls with a `tools` array: Each function in the `tools` array is treated as a callee. The union of all their interrupt kinds is included. The tools array is resolved using the same variable tracing as Phase 1 — direct array literals at the call site, or variables assigned array literals.

Node-to-node calls (permanent transitions via `return`) are treated identically to function calls for interrupt propagation. Even though execution doesn't return to the caller, the caller is responsible for those interrupts reaching the outside world. An MCP client calling `main` needs to know about all interrupts in the chain.

Cross-file function calls are resolved through the symbol table. When a function call resolves to a function imported from another Agency file, the analyzer looks up that function's symbol in the corresponding file's `FileSymbols` to include its interrupt kinds. This works because the analyzer receives all files and their symbols, and the symbol table has already resolved all imports.

#### Phase 3: Transitive Resolution

Propagate interrupt kinds through the call graph using fixed-point iteration:

1. For each function, union in the interrupt kinds of all its callees.
2. Repeat until no set grows.

This converges because interrupt sets can only grow, and the total number of distinct interrupt kinds is finite. For a DAG (no cycles), this converges in one pass. For cycles, it takes at most N passes where N is the longest cycle. The work per iteration is proportional to the number of call edges.

Deduplication of interrupt kinds uses the `kind` string for equality — two `InterruptKind` objects with the same `kind` value are considered duplicates.

### Symbol Table Integration

`SymbolTable.build()` changes:

1. Parse each file and run `classifySymbols` (as today).
2. Retain the parsed `AgencyProgram` for each file.
3. After all files are processed, call `analyzeInterrupts(files)`.
4. Replace `this.files` with the returned symbols.
5. Discard the parsed programs.

### Type Checker Warning

The type checker gets a new check. When visiting a `functionCall` node:

1. Look up the callee in the symbol table.
2. If the callee has non-empty `interruptKinds`, check whether any ancestor in the current AST walk is a `handleBlock` or a `withModifier` that handles the interrupt (i.e., `handlerName` is `"approve"` or `"reject"`). A `withModifier` with `handlerName: "propagate"` does not count as handling the interrupt — it explicitly re-throws it.
3. If no handler is found among the ancestors, emit a warning listing the unhandled interrupt kinds.

The `walkNodes` utility already provides an `ancestors` array that includes all parent nodes, so checking for an enclosing handler is a simple scan of the ancestors list.

This check does not attempt exhaustiveness checking (verifying that a handler covers all interrupt kinds). Policies are runtime data and make static exhaustiveness impossible to guarantee. The warning simply flags: "this call may throw interrupts and there is no handler around it."

### Serve/MCP Surface

#### Data Flow

The serve system operates at runtime and does not have access to the symbol table. Interrupt kind data must be threaded from the symbol table through the compilation step into the discovery system. The data flow is:

1. `lib/cli/serve.ts` (`compileForServe`): After building the symbol table, extract `interruptKinds` for each exported function and node, alongside the existing `exportedNodeNames` and `exportedConstantNames`.
2. Pass the interrupt kinds into `discoverExports` via a new field on `DiscoverOptions`.
3. `discoverExports` attaches them to `ExportedFunction` and `ExportedNode`.
4. The MCP and HTTP adapters read them from the exported items and include them in list responses.

For standalone server generation (`--standalone`), the interrupt kind data must be embedded as JSON literals in the generated entry point file, since the symbol table is unavailable at runtime.

#### ExportedFunction and ExportedNode

The serve types gain interrupt information:

```typescript
type ExportedFunction = {
  kind: "function";
  name: string;
  description: string;
  agencyFunction: AgencyFunction;
  interruptKinds: InterruptKind[];  // new
};

type ExportedNode = {
  kind: "node";
  name: string;
  parameters: Array<{ name: string }>;
  invoke: (...args: unknown[]) => Promise<unknown>;
  interruptKinds: InterruptKind[];  // new
};
```

#### MCP tools/list

Interrupt information is appended to the tool's `description` string rather than added as a custom MCP field. No MCP client would understand a custom `interrupts` field, but every client displays the description. This makes interrupt information visible to users browsing available tools:

```
Deploy to production.

May interrupt: myapp::deploy, payment::charge
```

If a tool has no interrupt kinds, the description is left unchanged.

#### HTTP /list

Interrupt kinds are included as a structured field on function and node entries in the manifest response. Unlike MCP, the HTTP API is Agency-specific, so clients are expected to understand the field:

```json
{
  "functions": [
    {
      "name": "deploy",
      "description": "Deploy to production.",
      "safe": false,
      "interruptKinds": [
        { "kind": "myapp::deploy" },
        { "kind": "payment::charge" }
      ]
    }
  ]
}
```

### LSP Hover

When hovering over a function call whose callee has non-empty `interruptKinds`, append the interrupt information to the hover content:

```
def deploy(env: string, action: string): string

Interrupts: myapp::deploy, payment::charge
```

The data path is: symbol table -> semantic index (via `runDiagnostics`) -> `SemanticSymbol` (needs a new `interruptKinds` field) -> `formatSemanticHover` in `lib/lsp/semantics.ts` (where the hover text is built).

This is the lowest priority item and is trivial once the symbol table has the data.

## Edge Cases

- **Bare interrupts**: Get kind `"unknown"`. No special treatment — `"unknown"` is just a kind string like any other.
- **Imported TypeScript functions**: Cannot throw Agency interrupts, so they are ignored by the analysis.
- **Imported Agency functions**: Resolved through the symbol table to the source file's symbols. Cross-file transitive resolution works because the analyzer operates on all files simultaneously.
- **Dynamic interrupt kinds**: All interrupt kinds are static strings in the parser. There are no dynamically computed kinds.
- **`llm()` tools**: The tools array is analyzed statically. Direct array literals and variables assigned array literals are resolved. Dynamically computed arrays (e.g. `tools: getTools()`) cannot be analyzed and their interrupts are not tracked.
- **Blocks passed as function references**: A function reference or partial application passed as an argument is resolved back to its original definition. If the resolution fails (e.g. the value comes from a dynamic expression), its interrupts are not tracked.
- **`handle` blocks with function ref handlers**: If the handler is a function reference (not inline), the handler function's own interrupt kinds are attributed to the function containing the `handle` block.
- **Variable tracing**: The analyzer traces variables one level back to their assignment. `const fn = deploy; foo(fn)` resolves `fn` to `deploy`. `const tools = [deploy, cleanup]; llm("...", { tools: tools })` resolves the array elements. Arrays built up dynamically (e.g. `tools.push(fn)`, spread into new arrays, indexed access like `fns[0]()`, or object property access like `handlers.onDeploy`) are not tracked (see Future Work).

## Future Work

- **Dynamic array/object tracking**: Track functions through `push`, spread, object property access, and indexed access. This would cover patterns like `tools.push(deploy)`, `const allTools = [...tools1, ...tools2]`, `handlers.onDeploy()`, and `fns[0]()`. This requires more sophisticated data flow analysis.
- **Interrupt data shapes**: Track the parameter types of each interrupt kind (message type, data shape) in addition to just the kind string. The `InterruptKind` type is already an object to support this extension.
- **Exhaustiveness checking**: If a standard pattern emerges for handling interrupt kinds (e.g. match blocks on `interrupt.kind`), consider checking that all kinds are covered.

## Test Strategy

The `interruptAnalyzer.test.ts` file should cover:

- Direct interrupt collection from `interruptStatement` nodes
- Bare interrupts (kind `"unknown"`)
- Transitive propagation through function calls
- Transitive propagation through node calls
- Cycle handling (mutual recursion)
- Block arguments with interrupts (attributed to caller)
- Inline blocks with interrupts (attributed to caller)
- `llm()` with `tools` array (direct literal)
- `llm()` with `tools` variable (traced to array literal)
- Cross-file imports
- Function references passed as arguments
- Partial applications passed as arguments
- Variable tracing: `const fn = deploy; foo(fn)`
- Array variable tracing: `const tools = [deploy]; llm("...", { tools: tools })`
- `handle` block with function ref handler
- Functions with no interrupts (empty result)

The type checker warning should be tested through the existing type checker test infrastructure:

- Warning emitted when calling a function with interrupts outside a handler
- No warning when call is inside a `handleBlock`
- No warning when call is inside a `withModifier` with `approve` or `reject`
- Warning still emitted when call is inside a `withModifier` with `propagate`

## Priority Order

1. Core analysis module (`interruptAnalyzer.ts`) + symbol table integration
2. Type checker warnings (easiest to test, validates the analysis is correct)
3. Serve/MCP metadata
4. LSP hover

## Files Changed

| File | Change |
|---|---|
| `lib/interruptAnalyzer.ts` | New — all analysis logic |
| `lib/interruptAnalyzer.test.ts` | New — unit tests for the analyzer |
| `lib/symbolTable.ts` | Retain programs, call analyzer, use returned symbols |
| `lib/typeChecker/checker.ts` | New warning for unhandled interrupt calls |
| `lib/cli/serve.ts` | Extract interrupt kinds from symbol table, pass to discovery |
| `lib/serve/types.ts` | Add `interruptKinds` to `ExportedFunction` and `ExportedNode` |
| `lib/serve/discovery.ts` | Accept and attach interrupt kinds from options |
| `lib/serve/mcp/adapter.ts` | Append interrupt info to tool descriptions |
| `lib/serve/http/adapter.ts` | Include `interruptKinds` in `/list` response |
| `lib/lsp/semantics.ts` | Add `interruptKinds` to `SemanticSymbol`, include in hover text |
| `TODO.md` | Add future work item for dynamic array/object tracking |
