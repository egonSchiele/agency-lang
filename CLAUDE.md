# Agency Language

## Overview

Agency is a domain-specific language for defining AI agent workflows. It compiles Agency code to executable TypeScript that calls OpenAI's structured output API.

Please read the guide at docs-new/guide/ to get up to speed on the language.

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
See `docs-new/guide/` for the full language reference and design docs.

## Code generation and backends
The code that gets written and executed from an agency program comes from two places.
One is new TypeScript code written for the program. This comes from the builder, which in turn uses a combination of the TypeScript IR and the Mustache templates.
The other is TypeScript libraries and functions that get run by the generated TypeScript code. Much of this is in the runtime directory (`lib/runtime`) or imported from other libraries such as Zod.
As you can imagine, it's much better to have functionality in these shared libraries because then it is easily testable and refactorable, and we get type safety etc. The code for generating new TypeScript code on the other hand is much harder to work with. It's harder to read and reason about, and it doesn't have the same type safety. The TypeScript IR ameliorates some of this pain, but in general, when you are thinking of adding new features or modifying existing features, you should try to push as much of the functionality as you can into the runtime TypeScript libraries. Anything that can't be pushed to this should go in the builder if possible, especially if it is TypeScript code that may need to be manipulated later. For anything that's too complex and can't be put in the runtime libs, consider putting it in a Mustache file instead, so it's easy to read.

## How to debug parser errors
If you're having a hard time debugging a parser error, you can always use Tarsec's built-in debugger functionality. For an agency file, try running

```
DEBUG=1 pnpm run ast foo.agency
```

The "DEBUG=1" will tell Tarsec to print debug information as the parser runs. This output will be very large, so you'll want to redirect it to a file.

```
DEBUG=1 pnpm run ast foo.agency > foo.debuglog
```

Then, you can search through the contents of the file.

The file will have this format:

lines that start with a `🔍` tell you what parser it's going to try.
Lines that start with a tick mark ( ✅) mean the parser succeeded.
Lines with a star (⭐) mean a variable was either captured with "capture" or set with "set."
Lines that start with a cross ( ❌) mean that the parser failed.
You can see that the lines have different levels of indentation. The indentation indicates parsers that were nested within other parsers.

Each line will also contain the name of the parser as well as the full input string being tried. You can use this to narrow down the relevant sections where the parser is trying to parse the input that is failing. Then, look at lines with a cross to figure out which parser is failing.

## Implementation details

## Parsers

Parsers use the **tarsec** parser combinator library. Parser files live in `lib/parsers/` with co-located `.test.ts` files for unit tests.
See Tarsec docs: https://egonschiele.github.io/tarsec/.

If you want to modify parsers, you will first need to do a little bit of research on parser combinators. Tarsec comes with some tutorials:

https://github.com/egonSchiele/tarsec/tree/main/tutorials

## Testing

See `docs/TESTING.md` for the full testing guide.

Agency execution tests (`tests/agency/`) do NOT require LLM calls. They can test pure logic, interrupts, async calls, etc. without any LLM involvement. Use them for any runtime behavior test.


## Typechecker
See docs/dev/typechecker.md and docs/typeChecker.md for more information. Code it at lib/typeChecker.ts.

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

## Common Tasks

### Adding a new AST node type

1. **Define the type** in `lib/types/` (create a new file or add to an existing one). Export it from `lib/types.ts`. Add the new type to the `AgencyNode` union type in `lib/types.ts`.
2. **Add a parser** in `lib/parsers/`. Wire it into the main parser in `lib/parser.ts`. Add unit tests in a co-located `.test.ts` file.
3. **Add code generation** by adding a case to `processNode` in `lib/backends/typescriptBuilder.ts`. You may also need to create new `.mustache` template files in `lib/templates/backends/` and run `pnpm run templates`.
4. **Add audit logging** — if the new node type produces a new TsNode kind in the IR, consider whether it needs a case in `auditNode()` in `lib/ir/audit.ts`. This function inspects processed IR nodes and generates `__ctx.audit(...)` calls. See the "Audit Logging" section below for details.
5. **Add integration test fixtures** — create `.agency` and `.mts` files in `tests/typescriptGenerator/`.

### Adding a CLI command

1. Add the command definition in `scripts/agency.ts` using commander (`.command()`, `.argument()`, `.option()`, `.action()`).
2. Implement the command logic in `lib/cli/` (create a new file or add to an existing one). Shared utilities like `parseTarget`, `pickANode`, `executeNode` live in `lib/cli/util.ts`.
3. Optionally add a shortcut script in `package.json` under `"scripts"`.

## Other miscellaneous things to know about

### SimpleMachine (graph execution)
Agency programs compile to graphs executed by `SimpleMachine` (`lib/simplemachine/`). See `docs/dev/simplemachine.md` for details on nodes, edges, conditional transitions, and how compiled Agency code maps to graph operations.

### Smoltalk (LLM client)
All LLM interactions go through the [smoltalk](https://www.npmjs.com/package/smoltalk) library. See `docs/dev/smoltalk.md` for how Agency uses it for structured output requests, message construction, and token tracking.

### Statelog (tracing)
`StatelogClient` (`lib/statelogClient.ts`) provides optional execution tracing — graph topology, node lifecycle, LLM calls, and tool executions. See `docs/dev/statelog.md`.

### Configuration
`AgencyConfig` (`lib/config.ts`) defines all compiler and runtime options. See `docs/dev/config.md` for the full option reference and `docs/config.md` for basic usage.

### Audit Logging
Agency auto-generates structured audit log entries for every operation an agent performs. Entries are emitted via an `onAuditLog` callback — there is no internal storage.

Audit logging has two parts:
1. **Builder-generated calls** — `auditNode()` in `lib/ir/audit.ts` inspects processed IR nodes and produces `__ctx.audit(...)` calls. These are injected in `processBodyAsParts` in the builder. The function handles assignments, variable declarations, function calls, returns, and destructuring (Promise.all). It returns `null` for nodes that shouldn't be audited (control flow, comments, etc.). If you add a new TsNode kind to the IR, consider whether it needs a case in `auditNode()`.
2. **Runtime calls** — manual `ctx.audit()` calls in `lib/runtime/node.ts` (node entry/exit), `lib/runtime/prompt.ts` (LLM calls, tool calls), and `lib/runtime/interrupts.ts` (interrupts). Function call audits are emitted in the generated function setup code alongside `onFunctionStart`.

The `AuditEntry` type is a discriminated union defined in `lib/runtime/audit.ts`. The `makeAuditCall` helper in `lib/ir/audit.ts` is generic over `AuditEntry["type"]`, so adding a field to an audit entry variant will cause a compile error if `auditNode()` doesn't supply it.

Users can also set `audit.logFile` in `agency.json` (or use `agency run -l <file>`) to write audit entries to a JSONL file. See `docs/superpowers/specs/2026-03-20-audit-logs-design.md` for the full design.

## CRITICAL: Handlers are safety infrastructure
Handlers (`handle` blocks) are a crucial part of what makes Agency safe. They must NEVER be accidentally skipped or left unregistered. Any feature that affects execution flow (rewind, interrupts, checkpoints, state restoration) must ensure handlers are correctly registered and invoked. If there is any risk of a handler being skipped, treat it as a critical issue and flag it immediately. Handlers are registered on `__ctx.handlers` via `pushHandler()` in the generated code and are NOT serialized as part of checkpoint state — be aware of this when working on state restoration features.

## VERY IMPORTANT: Agency syntax rules
When writing Agency code (in plans, specs, tests, or examples), you MUST use the correct syntax. Verify against `docs-new/guide/basic-syntax.md` and existing test fixtures when unsure.

**Correct syntax:**
- Functions use `def`, curly braces, and optional `: ReturnType` after params: `def foo(x: number): string { ... }`
- Nodes use `node`, parentheses for params, and curly braces: `node main() { ... }`
- `if`, `while`, and `for` statements REQUIRE parentheses around the condition AND curly braces for the body: `if (x > 5) { ... }`
- Variables must be declared with `let` or `const` before use. Bare assignment (`x = 5`) is NOT allowed without a prior declaration.
- `for` loops use `in`: `for (item in items) { ... }`

**Common mistakes to NEVER make:**
- `function foo() -> ReturnType:` — WRONG. Use `def foo(): ReturnType { ... }`
- `node main -> end:` — WRONG. Use `node main() { ... }`
- `if condition:` / `if condition {` — WRONG. Use `if (condition) { ... }`
- `result = foo()` without `let`/`const` — WRONG unless already declared.
- Using Python-style colon+indentation for blocks — WRONG. Always use `{ ... }`

**When writing plans or specs:** Always verify Agency code snippets by checking docs-new/guide/basic-syntax.md and existing test fixtures (tests/agency/, tests/typescriptGenerator/). If unsure about syntax, run `pnpm run ast` on a test file to confirm it parses.

## General code Guidelines
- NEVER use dynamic imports
- Use objects instead of maps.
- Use arrays instead of sets.
- Use types instead of interfaces.
- NEVER force push or amend commits.

## Things that often confuse you
Tools and functions are the same thing in the agency. Functions are tools. So there is no point in treating tools and functions separately because they're the same thing.

Please note that you cannot write and run agency files in the `/tmp` directory or any directory outside of the current directory, because certain node modules are needed for the files to run and the `/tmp` directory does not have those node modules.

## Other docs and resources:
- `docs/envFiles.md` — documentation on environment variables and .env files
- `docs/config.md` — documentation on the `agency.json` configuration file
- `docs/lifecycleHooks.md` — documentation on lifecycle hooks and callbacks
- `docs/stateStack.md` — documentation on how the state stack works, including serialization and deserialization for interrupts.
- `docs/TESTING.md` — documentation on how to write and run tests in the Agency repo, including unit tests, integration tests, and fixtures.
- `docs/typeChecker.md` — documentation on the type checker, how it works, and how to use it.

## docs/dev/ reference
There are plenty of files that dive into implementation details on specific features:

- `docs/dev/async-info-for-claude.md` — edge cases and test cases for async function behavior
- `docs/dev/async.md` — how async function calls work, problems encountered, and solutions
- `docs/dev/binop-parser.md` — binary expression parser using precedence climbing
- `docs/dev/checkpointing.md` — snapshotting execution state for retry loops and rollback
- `docs/dev/concurrent-interrupts.md` — supporting multiple concurrent threads that interrupt simultaneously
- `docs/dev/config.md` — AgencyConfig options for compiler and runtime configuration
- `docs/dev/debugger.md` — interactive debugger for stepping through and rewinding execution
- `docs/dev/globalstore.md` — global variable management with module isolation and serialization
- `docs/dev/init.md` — issues with global variable initialization outside graph node context
- `docs/dev/interrupts.md` — how interrupts resume inside blocks using step counters (substeps)
- `docs/dev/message-thread-tests.md` — test cases for message threads and thread behavior
- `docs/dev/pkg-imports.md` — importing Agency code from npm packages using `pkg::` prefix
- `docs/dev/rewind.md` — overriding LLM call results and replaying execution from checkpoints
- `docs/dev/simplemachine.md` — graph execution engine that runs compiled Agency programs
- `docs/dev/smoltalk.md` — external LLM client library for structured output requests
- `docs/dev/statelog.md` — observability and tracing system for execution events
- `docs/dev/threads.md` — ThreadStore and MessageThread system for LLM conversation history
- `docs/dev/trace.md` — execution traces capturing checkpoints at every step
- `docs/dev/typechecker.md` — bidirectional type checking to catch errors before compilation
- `docs/dev/typescript-ir.md` — structured TsNode tree representation of generated TypeScript