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
│   ├── backends/
│   │   ├── baseGenerator.ts       # Base class with processNode switch
│   │   ├── typescriptGenerator.ts # TypeScript + graph code generation (extends BaseGenerator)
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
│   └── regenerate-fixtures.ts     # Regenerate TypeScript generator fixtures
├── tests/
│   └── typescriptGenerator/       # Integration test fixtures (.agency + .mts pairs)
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

## Code Generation

The generator class hierarchy is:

```
BaseGenerator
  └── TypeScriptGenerator
```

- **BaseGenerator** (`lib/backends/baseGenerator.ts`): Contains the `processNode` switch that dispatches to handler methods for each AST node type.
- **TypeScriptGenerator** (`lib/backends/typescriptGenerator.ts`): Implements all code generation logic for producing TypeScript output, including graph-specific code generation (graph nodes, edges, state machines).

## Testing

### Unit Tests

Parser and generator unit tests live alongside source files as `.test.ts` files (e.g., `lib/parsers/literals.test.ts`). Run with `pnpm test` or `pnpm test:run`.

### Integration Tests

Integration tests use fixture pairs in the `tests/` directory. Each fixture is a `.agency` file paired with a `.mts` file containing the expected generated output.

- `tests/typescriptGenerator/` — fixtures for the TypeScript generator

The integration test runner is `lib/backends/typescriptGenerator.integration.test.ts`.

To add a new integration test, create a `.agency` file and its expected `.mts` output in `tests/typescriptGenerator/`. Run `make fixtures` to regenerate all `.mts` fixture files from their `.agency` sources.

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