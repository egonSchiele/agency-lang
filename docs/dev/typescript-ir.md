The TypeScript IR is a structured representation of generated TypeScript code. Instead of building output strings directly, code can be constructed as a tree of `TsNode` objects and then printed to a string.

### Files

- **`tsIR.ts`** — Defines ~28 node types using `kind` as the discriminant (not `type`, to avoid collision with Agency AST).
- **`builders.ts`** — Exports a `ts` namespace object with short factory functions: `ts.raw(code)`, `ts.call(callee, args)`, `ts.id(name)`, `ts.obj(entries)`, `ts.arr(items)`, `ts.scopedVar(name, scope)`, etc.
- **`prettyPrint.ts`** — Exports `printTs(node: TsNode, indent?: number): string`. This function recursively prints a `TsNode` tree to a TypeScript code string. It handles indentation and formatting based on node types.

### Key design decisions

- `TsScopedVar` carries scope metadata (`"global"`, `"function"`, `"node"`, `"args"`, `"imported"`, `"shared"`). The builder produces these for variable references, and `printTs` resolves them to runtime prefixes. This keeps the builder decoupled from runtime string conventions.
- `TsRaw` is the escape hatch — any string can be wrapped in it. This is used for template-rendered code that hasn't been ported to structured IR yet.

## Code Generation

The entry point is `generateTypeScript(program)` exported from `typescriptGenerator.ts`, and it uses the **TypeScriptBuilder** (`lib/backends/typescriptBuilder.ts`). Takes a preprocessed Agency AST and produces a `TsNode` tree.
