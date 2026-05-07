# Agency Language

## Overview

Agency is a domain-specific language for defining AI agent workflows. It compiles Agency code to executable TypeScript that calls OpenAI's structured output API.

Please read the guide at docs-new/guide/ to get up to speed on the language.

NOTE! Most of the file paths you'll see in this CLAUDE.md are relative to the packages/agency-lang directory, as that is the main package and contains all the code for agency lang.

## Key Commands

```bash
make                    # build everything (ALWAYS use this when changing stdlib files)
pnpm test               # Run vitest in watch mode
pnpm test:run           # Run vitest once
pnpm run agency <file>  # Compile and run an .agency file
pnpm run agency test <file>  # Run a single Agency test
pnpm run agency test js <file>  # Run a single Agency js test
pnpm run compile <file> # Compile .agency to .ts
pnpm run ast <file>     # Parse .agency and print AST as JSON
pnpm run preprocess <file>     # Parse .agency, run preprocessor, and print the resulting AST as JSON
pnpm run fmt <file>     # Format .agency file using the AgencyGenerator
make fixtures           # Rebuild all integration test fixtures
pnpm run lint:structure # Run structural linter
```

## The full pipeline

`parse → SymbolTable.build → buildCompilationUnit → TypescriptPreprocessor → TypeScriptBuilder.build() → printTs()`

## Testing

See `docs/TESTING.md` for the full testing guide.

Agency execution tests (`tests/agency/`) do NOT require LLM calls. They can test pure logic, interrupts, async calls, etc. without any LLM involvement. Use them for any runtime behavior test.

Agency-js tests (`tests/agency-js/`) are similar, but let you test how agency code interacts with js code.

Note that although agency and agency-js tests don't *require* LLM calls, they can support them if needed. Don't make any extra LLM calls because they are slow and expensive, but if you are writing a test and you *need* to make an LLM call, please feel free to make one.

IMPORTANT! When you run tests, save the output to a file so that if the tests fail, you don't need to rerun them to see what failed. The tests in this repo are very expensive and slow to rerun, so if you keep rerunning tests to see what failed, you're going to waste a lot of time. So for God's sake, just run the test and save the output in a file once so you can examine the output at your leisure!!

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

## Guidance on writing commit messages and PR descriptions
If you try to write commit messages with apostrophes right on the command line, you will get an error. I'm telling you this now because you do this every time. Same with PR descriptions. Instead you need to write the commit message or PR description in a file, and then pass that in to the git command.

## Deeper docs

Read these before starting work:
- `docs/dev/coding-standards.md` — Banned patterns and style rules. Enforced by the structural linter.
- `docs/dev/anti-patterns.md` — Common mistakes with before/after examples.
- `docs/dev/adding-features.md` — Step-by-step guides for adding AST nodes, CLI commands, etc.

Pipeline and architecture:
- `docs/dev/typescript-ir.md` — Structured TsNode tree representation of generated TypeScript
- `docs/dev/typechecker.md` — Bidirectional type checking
- `docs/dev/interrupts.md` — How interrupts resume inside blocks using step counters (substeps)
- `docs/dev/simplemachine.md` — Graph execution engine that runs compiled Agency programs
- `docs/dev/async.md` — How async function calls work
- `docs/dev/checkpointing.md` — Snapshotting execution state for retry loops and rollback
- `docs/dev/threads.md` — ThreadStore and MessageThread system for LLM conversation history
- `docs/dev/globalstore.md` — Global variable management with module isolation and serialization
- `docs/dev/smoltalk.md` — External LLM client library for structured output requests
- `docs/dev/statelog.md` — Observability and tracing system for execution events
- `docs/dev/config.md` — AgencyConfig options for compiler and runtime configuration
- `docs/dev/debugger.md` — Interactive debugger for stepping through and rewinding execution
- `docs/dev/concurrent-interrupts.md` — Supporting multiple concurrent threads that interrupt simultaneously
- `docs/dev/pkg-imports.md` — Importing Agency code from npm packages using `pkg::` prefix
- `docs/dev/trace.md` — Execution traces capturing checkpoints at every step
- `docs/dev/binop-parser.md` — Binary expression parser using precedence climbing
- `docs/dev/locations.md` — How `loc.line` / `loc.col` / parse-mode template offset interact

Other references:
- `docs/TESTING.md` — Full testing guide (unit tests, fixtures, execution tests, agency-js tests)
- `docs/config.md` — `agency.json` configuration file
- `docs/lifecycleHooks.md` — Lifecycle hooks and callbacks
- `docs/stateStack.md` — State stack serialization/deserialization for interrupts
- `docs/typeChecker.md` — Type checker usage
- `docs/envFiles.md` — Environment variables and .env files

Parsers use the **tarsec** parser combinator library. Parser files live in `lib/parsers/` with co-located `.test.ts` files. See Tarsec docs: https://egonschiele.github.io/tarsec/. Debug parser errors with `DEBUG=1 pnpm run ast foo.agency > foo.debuglog`.

Templates in `lib/templates/` are compiled via [typestache](https://www.npmjs.com/package/typestache). Run `pnpm run templates` to recompile. Only modify `.mustache` files, not the generated `.ts` files.

The runtime (`lib/runtime/`) is the library that compiled Agency code imports at execution time. Push functionality here whenever possible — it's testable and type-safe, unlike generated code.
