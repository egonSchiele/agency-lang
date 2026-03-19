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
│   ├── symbolTable.ts             # Symbol table builder (buildSymbolTable)
│   ├── programInfo.ts             # Program info collector (collectProgramInfo)
│   ├── typeChecker.ts             # Type checker
│   ├── config.ts                  # Configuration handling
│   ├── index.ts                   # Main library entry point
│   ├── utils.ts                   # Shared utilities
│   ├── statelogClient.ts          # Statelog integration for tracing
│   ├── ir/                        # TypeScript intermediate representation
│   │   ├── tsIR.ts                # IR node type definitions (TsNode union type)
│   │   ├── builders.ts            # Factory functions for creating IR nodes (ts.raw, ts.call, etc.)
│   │   ├── fluent.ts              # Fluent API for building IR nodes
│   │   └── prettyPrint.ts         # IR to TypeScript string (printTs)
│   ├── backends/
│   │   ├── typescriptGenerator.ts # Simple TypeScript code generation function, uses the builder and pretty printer
│   │   ├── typescriptBuilder.ts   # Agency AST → TsNode IR
│   │   ├── typescriptGenerator/   # Generator helper modules (builtins, typeToString, typeToZodSchema)
│   │   ├── agencyGenerator.ts     # Agency code formatter
│   │   ├── utils.ts               # Shared backend utilities
│   │   └── index.ts               # Backend exports
│   ├── cli/                       # CLI command implementations
│   │   ├── commands.ts            # Core commands (compile, run, parse, format, etc.)
│   │   ├── evaluate.ts            # Evaluate command
│   │   ├── test.ts                # Test and fixtures commands
│   │   ├── agent.ts               # Agent-related CLI commands
│   │   ├── help.ts                # Help command
│   │   ├── remoteRun.ts           # Remote run command
│   │   ├── upload.ts              # Upload command
│   │   └── util.ts                # Shared CLI utilities (parseTarget, pickANode, executeNode, etc.)
│   ├── runtime/                   # Runtime library used by compiled Agency code
│   │   ├── index.ts               # Runtime exports
│   │   ├── node.ts                # Node setup and execution (setupNode, setupFunction, runNode)
│   │   ├── prompt.ts              # LLM prompt execution (runPrompt)
│   │   ├── interrupts.ts          # Interrupt handling and state resumption
│   │   ├── hooks.ts               # Lifecycle hook/callback execution
│   │   ├── builtins.ts            # Built-in function implementations
│   │   ├── builtinTools.ts        # Built-in tool definitions for LLM tool use
│   │   ├── streaming.ts           # Streaming response handling
│   │   ├── errors.ts              # Runtime error types
│   │   ├── types.ts               # Runtime type definitions (GraphState, InternalFunctionState)
│   │   ├── utils.ts               # Runtime utilities (deepClone, extractResponse, etc.)
│   │   └── state/                 # State management
│   │       ├── context.ts         # RuntimeContext class (shared context for all nodes/functions)
│   │       ├── stateStack.ts      # StateStack class (call stack serialization/deserialization)
│   │       ├── globalStore.ts     # GlobalStore class (cross-module global variable storage)
│   │       ├── messageThread.ts   # MessageThread class
│   │       └── threadStore.ts     # ThreadStore class
│   ├── simplemachine/             # Graph execution engine
│   │   ├── index.ts               # SimpleMachine class
│   │   ├── graph.ts               # Graph definition and traversal
│   │   ├── types.ts               # Graph types
│   │   ├── error.ts               # Graph error types
│   │   └── util.ts                # Graph utilities
│   ├── agents/                    # Built-in Agency agents
│   │   └── agency-agent/          # Self-referential Agency agent
│   ├── templates/                 # Mustache templates compiled to TypeScript via typestache
│   │   ├── backends/              # Templates used by code generators
│   │   ├── cli/                   # Templates used by CLI commands
│   │   └── prompts/               # Prompt templates
│   ├── preprocessors/             # AST preprocessors (run before code generation)
│   │   ├── typescriptPreprocessor.ts  # Main preprocessor
│   │   └── importResolver.ts      # Import resolution
│   └── utils/                     # Additional utilities
│       ├── agentUtils.ts          # Agent utilities
│       ├── envfile.ts             # .env file handling
│       ├── node.ts                # Node utilities
│       └── termcolors.ts          # Terminal color helpers
├── scripts/
│   ├── agency.ts                  # CLI entry point (uses commander)
│   ├── regenerate-fixtures.ts     # Regenerate TypeScript generator + builder fixtures
│   └── hooks/                     # Install hooks (e.g. postinstall)
├── tests/
│   ├── typescriptGenerator/       # Integration test fixtures (.agency + .mjs pairs)
│   ├── typescriptBuilder/         # Integration test fixtures for the builder
│   ├── typescriptPreprocessor/    # Preprocessor test fixtures
│   ├── agency/                    # End-to-end Agency test fixtures
│   └── agency-js/                 # JavaScript interop test fixtures
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
pnpm run preprocess <file>     # Parse .agency, run preprocessor, and print the resulting AST as JSON
pnpm run fmt <file>     # Format .agency file using the AgencyGenerator
make all                # Run templates + build
make fixtures           # Rebuild all integration test fixtures
```

## The full pipeline
The full pipeline is: `parse → buildSymbolTable → collectProgramInfo → TypescriptPreprocessor → TypeScriptBuilder.build() → printTs()`.

### Parse
Parses the code into an AST. Uses parsers in `lib/parser.ts` and `lib/parsers/`. The main entry point is the `parseAgency()` function in `lib/parser.ts`, which returns an Agency AST.

All the types for the AST nodes are defined in `lib/types/` and `lib/types.ts`.

### buildSymbolTable
Collects symbols from across all the files that are going to be compiled. For each symbol, it stores its type: is it a node, a function, a type, etc. This is then used in the preprocessor to transform import statements into import statements of a specific type; for example, if a node is being imported, an import statement will be transformed into an import node statement. See `lib/symbolTable.ts` for more.

### collectProgramInfo
Collects all sorts of other program info: information about function definitions, type aliases, graph nodes, imports, etc. See the `lib/programInfo.ts` class for full information.

### preprocessor
Runs several transforms on the agency AST before it is sent to the builder. The preprocessor marks certain LLM calls as asynchronous, removes unused LLM code, and resolves variable scopes; that is, for each variable used, it identifies whether it is a global variable, local variable, imported variable, shared variable, etc. See `lib/preprocessors/typescriptPreprocessor.ts`.

### build
Transforms the agency AST into the TypeScript IR, which is one step above simple strings of TypeScript code. The TypeScript IR was introduced because it was a useful way to modify and transform TypeScript code. Without the TypeScript IR, we'd be running modifications on strings directly, which is extremely buggy and error-prone. See `lib/backends/typescriptBuilder.ts`.

### Generate TypeScript code
We use the `printTs()` function in `lib/ir/prettyPrint.ts` to convert the TypeScript IR AST into TypeScript code. See `lib/backends/typescriptGenerator.ts` and `lib/ir/prettyPrint.ts`.

## Language design and features
See `DOCS.md` for the full language reference and design docs.

## Parsers

Parsers use the **tarsec** parser combinator library. Parser files live in `lib/parsers/` with co-located `.test.ts` files for unit tests.
See Tarsec docs: https://egonschiele.github.io/tarsec/.

If you want to modify parsers, you will first need to do a little bit of research on parser combinators. Tarsec comes with some tutorials:

https://github.com/egonSchiele/tarsec/tree/main/tutorials

## Testing

See `docs/TESTING.md` for the full testing guide.

## Common Tasks

### Adding a new AST node type

1. **Define the type** in `lib/types/` (create a new file or add to an existing one). Export it from `lib/types.ts`. Add the new type to the `AgencyNode` union type in `lib/types.ts`.
2. **Add a parser** in `lib/parsers/`. Wire it into the main parser in `lib/parser.ts`. Add unit tests in a co-located `.test.ts` file.
3. **Add code generation** by adding a case to `processNode` in `lib/backends/typescriptBuilder.ts`. You may also need to create new `.mustache` template files in `lib/templates/backends/` and run `pnpm run templates`.
4. **Add integration test fixtures** — create `.agency` and `.mts` files in `tests/typescriptGenerator/`.

### Adding a CLI command

1. Add the command definition in `scripts/agency.ts` using commander (`.command()`, `.argument()`, `.option()`, `.action()`).
2. Implement the command logic in `lib/cli/` (create a new file or add to an existing one). Shared utilities like `parseTarget`, `pickANode`, `executeNode` live in `lib/cli/util.ts`.
3. Optionally add a shortcut script in `package.json` under `"scripts"`.

## Code Guidelines
- NEVER use dynamic imports
- Use objects instead of maps.
- Use arrays instead of sets.
- Use types instead of interfaces.

## Typechecker
See docs/dev/typechecker.md and docs/typeChecker.md for more information. Code it at lib/typeChecker.ts.

## Message threads
Message threads are a core feature of Agency, and it's how we store and use message history. By default, every LLM call in Agency is isolated, but message threads can combine them. For usage, see DOCS.md. For implementation notes, see docs/dev/threads.md.
Message threads are quite complicated, and agency includes tests for a lot of different test cases. See docs/dev/message-thread-tests.md for a full list of test cases.

## Interrupts and state serialization
Interrupts allow an Agency program to pause execution, return control to the caller, and resume later. This enables human-in-the-loop workflows where a user can approve, reject, modify, or resolve an interrupted operation.

When an interrupt is triggered, the runtime serializes the full execution state — the `StateStack` (call stack frames with local variables, arguments, and step counters) and the `GlobalStore` (cross-module global variables) — into a JSON-serializable `InterruptState`. This state is returned to the caller along with the interrupt data.

To resume, the caller passes the serialized state and an `InterruptResponse` (one of `approve`, `reject`, `modify`, or `resolve`) back to one of the response functions (`approveInterrupt`, `rejectInterrupt`, `modifyInterrupt`, `resolveInterrupt`). The runtime deserializes the state, puts the `StateStack` into deserialize mode, and re-runs from the last graph node visited. As each function/node is re-entered, its frame is shifted off the front of the stack and pushed to the back, restoring local state without re-executing side effects.

See `lib/runtime/interrupts.ts` for the implementation, `docs/stateStack.md` for how the state stack serialization/deserialization works, and `docs/INTERRUPT_TESTING.md` for interrupt test cases.

## TypeScript IR
The TypeScript IR was introduced because it was a useful way to modify and transform TypeScript code. Without the TypeScript IR, we'd be running modifications on strings directly, which is extremely buggy and error-prone.
See docs/dev/typescript-ir.md and lib/ir/ for more information.

## Templates (typestache)

Mustache templates in `lib/templates/` are compiled to TypeScript files using [typestache](https://www.npmjs.com/package/typestache). Run `pnpm run templates` to recompile them. The generated `.ts` files export a default render function you can import and call to produce a string from template data. If you create or modify a `.mustache` file, you must run `pnpm run templates` before building. Do not modify the TypeScript files directly; only modify the Mustache files.

## Runtime

The runtime (`lib/runtime/`) is the library that compiled Agency code imports and uses at execution time. It was created to separate the execution concerns from the code generation concerns — compiled `.ts` files import runtime functions rather than inlining all execution logic.

Key components:
- **`RuntimeContext`** (`lib/runtime/state/context.ts`) — A shared context object passed through all nodes and functions during execution. Holds the `StateStack`, `GlobalStore`, graph instance (`SimpleMachine`), lifecycle callbacks, the statelog client for tracing, and the working directory. Avoids threading many individual arguments through every function call.
- **`GlobalStore`** (`lib/runtime/state/globalStore.ts`) — Stores global variables keyed by module ID, so each compiled Agency file gets its own namespace. Also tracks which modules have been initialized and stores internal data like token usage stats.
- **`StateStack`** (`lib/runtime/state/stateStack.ts`) — Manages the call stack for serialization/deserialization (see Interrupts section above).
- **`runPrompt`** (`lib/runtime/prompt.ts`) — Executes LLM calls via smoltalk.
- **`setupNode` / `setupFunction` / `runNode`** (`lib/runtime/node.ts`) — Entry points for executing compiled nodes and functions.

## Other docs and resources:
- `DOCS.md` — language reference and design docs
- `docs/envFiles.md` — documentation on environment variables and .env files
- `docs/config.md` — documentation on the `agency.json` configuration file
- `docs/lifecycleHooks.md` — documentation on lifecycle hooks and callbacks
- `docs/stateStack.md` — documentation on how the state stack works, including serialization and deserialization for interrupts.
- `docs/TESTING.md` — documentation on how to write and run tests in the Agency repo, including unit tests, integration tests, and fixtures.
- `docs/typeChecker.md` — documentation on the type checker, how it works, and how to use it.