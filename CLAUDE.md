# Agency Language

## Overview

Agency is a domain-specific language for defining AI agent workflows. It compiles Agency code to executable TypeScript that calls OpenAI's structured output API. See `DOCS.md` for the full language reference.

## Directory Structure

```
agency-lang/
├── lib/
│   ├── types.ts                   # Re-exports all AST node types
│   ├── types/                     # AST node type definitions (one file per node type)
│   ├── parsers/                   # Parsers for Agency code (uses tarsec library)
│   ├── parser.ts                  # Main parser entry point (parseAgency)
│   ├── ir/                        # TypeScript intermediate representation
│   │   ├── tsIR.ts                # IR node type definitions (TsNode union type)
│   │   ├── builders.ts            # Factory functions for creating IR nodes (ts.raw, ts.call, etc.)
│   │   └── prettyPrint.ts         # IR to TypeScript string (printTs)
│   ├── backends/
│   │   ├── baseGenerator.ts       # Base class with processNode switch
│   │   ├── typescriptGenerator.ts # TypeScript + graph code generation (extends BaseGenerator)
│   │   ├── typescriptBuilder.ts   # Agency AST → TsNode IR (standalone, no inheritance)
│   │   └── agencyGenerator.ts     # Agency code formatter (extends BaseGenerator)
│   ├── cli/                       # CLI command implementations
│   │   ├── commands.ts            # Core commands (compile, run, parse, format, etc.)
│   │   ├── evaluate.ts            # Evaluate command
│   │   ├── test.ts                # Test and fixtures commands
│   │   └── util.ts                # Shared CLI utilities (parseTarget, executeNode, etc.)
│   ├── templates/                 # Mustache templates compiled to TypeScript via typestache
│   │   ├── backends/              # Templates used by code generators
│   │   └── cli/                   # Templates used by CLI commands
│   └── preprocessors/             # AST preprocessors (run before code generation)
├── scripts/
│   ├── agency.ts                  # CLI entry point (uses commander)
│   └── regenerate-fixtures.ts     # Regenerate TypeScript generator + builder fixtures
├── tests/
│   ├── typescriptGenerator/       # Integration test fixtures (.agency + .mjs pairs)
│   └── typescriptBuilder/         # Integration test fixtures for the builder
├── examples/                      # Example Agency programs
└── dist/                          # Compiled JavaScript output
```

## Key Commands

```bash
pnpm run build          # Compile TypeScript to dist/ (rm -rf dist/ && tsc && tsc-alias)
pnpm run templates      # Compile mustache templates to TypeScript via typestache
pnpm test               # Run vitest in watch mode
pnpm test:run           # Run vitest once
pnpm run agency <file>  # Compile and run an .agency file
pnpm run compile <file> # Compile .agency to .ts
pnpm run ast <file>     # Parse .agency and print AST as JSON
pnpm run fmt <file>     # Format .agency file
pnpm run eval           # Run evaluation on a node
make all                # Run templates + build
make fixtures           # Rebuild all integration test fixtures
```

## Templates (typestache)

Mustache templates in `lib/templates/` are compiled to TypeScript files using [typestache](https://www.npmjs.com/package/typestache). Run `pnpm run templates` to recompile them. The generated `.ts` files export a default render function you can import and call to produce a string from template data. If you create or modify a `.mustache` file, you must run `pnpm run templates` before building.

## Parsers

Parsers use the **tarsec** parser combinator library. Parser files live in `lib/parsers/` with co-located `.test.ts` files for unit tests.

**IMPORTANT:** If there is a bug in a parser, do NOT attempt to fix it. Instead, prompt the user to fix it.

## TypeScript IR (`lib/ir/`)

The TypeScript IR is a structured representation of generated TypeScript code. Instead of building output strings directly, code can be constructed as a tree of `TsNode` objects and then printed to a string.

### Files

- **`tsIR.ts`** — Defines ~28 node types using `kind` as the discriminant (not `type`, to avoid collision with Agency AST). The `TsNode` union includes: `TsRaw` (verbatim string escape hatch), `TsStatements`, `TsImport`, `TsVarDecl`, `TsAssign`, `TsFunctionDecl`, `TsArrowFn`, `TsCall`, `TsAwait`, `TsReturn`, `TsObjectLiteral`, `TsArrayLiteral`, `TsTemplateLit`, `TsIf`, `TsFor`, `TsWhile`, `TsSwitch`, `TsTryCatch`, `TsBinOp`, `TsPropertyAccess`, `TsSpread`, `TsIdentifier`, `TsStringLiteral`, `TsNumericLiteral`, `TsBooleanLiteral`, `TsComment`, `TsExport`, `TsNewExpr`, and `TsScopedVar`.
- **`builders.ts`** — Exports a `ts` namespace object with short factory functions: `ts.raw(code)`, `ts.call(callee, args)`, `ts.id(name)`, `ts.obj(entries)`, `ts.arr(items)`, `ts.scopedVar(name, scope)`, etc.
- **`prettyPrint.ts`** — Exports `printTs(node: TsNode, indent?: number): string`. Recursive switch on `node.kind` with 2-space indentation. `TsRaw` emits its string verbatim. `TsScopedVar` is resolved to runtime-specific prefixes here (`"global"` → `__globalCtx.stateStack.globals`, `"function"`/`"node"` → `__stack.locals`, `"args"` → `__stack.args`, `"imported"` → no prefix).

### Key design decisions

- `TsScopedVar` carries scope metadata (`"global"`, `"function"`, `"node"`, `"args"`, `"imported"`). The builder produces these for variable references, and `printTs` resolves them to runtime prefixes. This keeps the builder decoupled from runtime string conventions.
- `TsRaw` is the escape hatch — any string can be wrapped in it. This is used for template-rendered code that hasn't been ported to structured IR yet.

## Code Generation

There are two compilation paths from Agency AST to TypeScript:

### Legacy path: BaseGenerator → TypeScriptGenerator

```
BaseGenerator
  └── TypeScriptGenerator
```

- **BaseGenerator** (`lib/backends/baseGenerator.ts`): Contains the `processNode` switch that dispatches to handler methods for each AST node type.
- **TypeScriptGenerator** (`lib/backends/typescriptGenerator.ts`): Implements all code generation logic for producing TypeScript output, including graph-specific code generation (graph nodes, edges, state machines).

The entry point is `generateTypeScript(program)` exported from `typescriptGenerator.ts`.

### New path: TypeScriptBuilder → printTs

- **TypeScriptBuilder** (`lib/backends/typescriptBuilder.ts`): Standalone class (no inheritance from BaseGenerator). Takes a preprocessed Agency AST and produces a `TsNode` tree. The full pipeline is: `parse → TypescriptPreprocessor → TypeScriptBuilder.build() → printTs()`.

The builder has its own `processNode` dispatch switch and duplicates the state management from BaseGenerator/TypeScriptGenerator (scope stack, type hints, graph topology, etc.). Each handler method returns `TsNode`. Methods that are straightforward to port return proper IR nodes (e.g., `TsArrayLiteral`, `TsScopedVar`, `TsTemplateLit`). Template-heavy methods wrap their output in `TsRaw` for now.

The builder uses the same Mustache templates as TypeScriptGenerator for complex nodes (prompts, function definitions, graph nodes, etc.). When a raw method needs a sub-expression result as a string, it calls `printTs(this.processNode(subExpr))`.

## Testing

### Unit Tests

Parser and generator unit tests live alongside source files as `.test.ts` files (e.g., `lib/parsers/literals.test.ts`). Run with `pnpm test` or `pnpm test:run`.

### Integration Tests

Integration tests use fixture pairs in the `tests/` directory. Each fixture is a `.agency` file paired with a `.mjs` file containing the expected generated output.

- `tests/typescriptGenerator/` — fixtures for the TypeScript generator (runner: `lib/backends/typescriptGenerator.integration.test.ts`)
- `tests/typescriptBuilder/` — fixtures for the TypeScript builder (runner: `lib/backends/typescriptBuilder.integration.test.ts`)

To add a new integration test, create a `.agency` file in the appropriate directory and run `make fixtures` to generate the corresponding `.mjs` file. The regeneration script (`scripts/regenerate-fixtures.ts`) handles both generator and builder fixtures.

### Agency integration tests
This is a new way to write integration tests. There are a bunch of `.agency` test files in the `tests/agency` directory. These files are run with a test harness, and the output is compared using either exact match or an LLM as a judge. You can check out some of these `.agency` files to see what they look like. Also check out some of the `.test.json` files to see what the expected output and evaluation criteria look like.

As you can imagine, this is a much better way to write integration tests, because we're not just checking the generated code; we are actually running it and checking the result itself.

Feel free to write agency integration tests.

## Common Tasks

### Adding a new AST node type

1. **Define the type** in `lib/types/` (create a new file or add to an existing one). Export it from `lib/types.ts`. Add the new type to the `AgencyNode` union type in `lib/types.ts`.
2. **Add a parser** in `lib/parsers/`. Wire it into the main parser in `lib/parser.ts`. Add unit tests in a co-located `.test.ts` file.
3. **Add code generation** by adding a case to `processNode` in `lib/backends/baseGenerator.ts` that calls a new handler method. Implement the handler in `TypeScriptGenerator`. You may also need to create new `.mustache` template files in `lib/templates/backends/` and run `pnpm run templates`.
4. **Add integration test fixtures** — create `.agency` and `.mts` files in `tests/typescriptGenerator/`.

### Adding a CLI command

1. Add the command definition in `scripts/agency.ts` using commander (`.command()`, `.argument()`, `.option()`, `.action()`).
2. Implement the command logic in `lib/cli/` (create a new file or add to an existing one). Shared utilities like `parseTarget`, `pickANode`, `executeNode` live in `lib/cli/util.ts`.
3. Optionally add a shortcut script in `package.json` under `"scripts"`.

## Code Guidelines
- NEVER use dynamic imports
- Use objects instead of maps.
- Use arrays instead of sets.

## Other docs and resources:
- `DOCS.md` — language reference and design docs
- `docs/INTERRUPT_TESTING.md` — documentation on the new interrupt testing framework