The TypeScript IR is a structured representation of generated TypeScript code. Instead of building output strings directly, code can be constructed as a tree of `TsNode` objects and then printed to a string.

### Files

All three live in `lib/ir/`.

- **`tsIR.ts`** — Defines the `TsNode` union, currently around 55 node types. They use `kind` as the discriminant, not `type`, to avoid colliding with the Agency AST.
- **`builders.ts`** — Exports a `ts` namespace object with short factory functions: `ts.raw(code)`, `ts.call(callee, args)`, `ts.id(name)`, `ts.obj(entries)`, `ts.arr(items)`, `ts.scopedVar(name, scope)`, and many more.
- **`fluent.ts`** — Exports `$` and `TsChain`, a wrapper that reads left to right instead of inside out: `$(ts.id("foo")).prop("bar").call([arg]).await().done()`. `builders.ts` re-exports both.
- **`prettyPrint.ts`** — Exports `printTs(node: TsNode, indent?: number): string`. This function recursively prints a `TsNode` tree to a TypeScript code string. It handles indentation and formatting based on node types.

### Key design decisions

- `TsScopedVar` carries scope metadata. The scope is one of `"global"`, `"static"`, `"function"`, `"node"`, `"args"`, `"imported"`, `"local"`, `"block"`, `"blockArgs"`, or `"functionRef"`. The builder produces these for variable references, and `printTs` resolves them to runtime prefixes. This keeps the builder decoupled from runtime string conventions.
- A `block` or `blockArgs` scoped var may also carry `blockFrameVar`, the frame binding to read through when an ancestor block owns the variable. Without it the printer falls back to `__bstack`, the innermost block.
- `TsRaw` is the escape hatch. Any string can be wrapped in it. This is used for template-rendered code that hasn't been ported to structured IR yet.

## Code Generation

The entry point is `generateTypeScript(program)` exported from `lib/backends/typescriptGenerator.ts`. It calls `TypeScriptBuilder.build()` (`lib/backends/typescriptBuilder.ts`), which takes a preprocessed Agency AST and produces a `TsNode` tree.
