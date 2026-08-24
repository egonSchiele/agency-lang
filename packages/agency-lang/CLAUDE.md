# Agency Language (packages/agency-lang)

This package is the language itself: compiler, runtime, standard library, CLI, and the built-in agent. Paths in this file are relative to this directory.

Read the guide at `docs/site/guide/` to get up to speed on the language.

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
pnpm run fmt:ts         # Format TypeScript with prettier (CI fails if you skip this)
```

## The full pipeline

`parse → SymbolTable.build → buildCompilationUnit → TypescriptPreprocessor → TypeScriptBuilder.build() → printTs()`

Parsers use the **tarsec** parser combinator library. Parser files live in `lib/parsers/` with co-located `.test.ts` files. See Tarsec docs: https://egonschiele.github.io/tarsec/. Debug parser errors with `DEBUG=1 pnpm run ast foo.agency > foo.debuglog`.

Templates in `lib/templates/` are compiled via [typestache](https://www.npmjs.com/package/typestache). Run `pnpm run templates` to recompile. Only modify `.mustache` files, not the generated `.ts` files.

The runtime (`lib/runtime/`) is the library that compiled Agency code imports at execution time. Push functionality here whenever possible, because it is testable and type-safe, unlike generated code.

## Testing

See `docs/misc/TESTING.md` for the full testing guide.

Agency execution tests (`tests/agency/`) do NOT require LLM calls. They can test pure logic, interrupts, async calls, etc. without any LLM involvement. Use them for any runtime behavior test.

Agency-js tests (`tests/agency-js/`) are similar, but let you test how agency code interacts with js code.

Note that although agency and agency-js tests don't *require* LLM calls, they can support them if needed. Don't make any extra LLM calls because they are slow and expensive, but if you are writing a test and you *need* to make an LLM call, please feel free to make one.

IMPORTANT! When you run tests, save the output to a file so that if the tests fail, you don't need to rerun them to see what failed. The tests in this repo are very expensive and slow to rerun, so if you keep rerunning tests to see what failed, you're going to waste a lot of time. Just run the test and save the output in a file once so you can examine the output at your leisure.

Note: Do not run the agency test suite locally. It takes a long time to run. When you create a PR, CI will run those tests for you. In the meantime, you're welcome to run specific agency tests locally if they are relevant to your change, but don't run the full test suite.

## Documentation

Standard library reference documentation is generated from Agency source using `agency doc`. When adding or changing stdlib APIs, write module-level doc comments, function doc comments, and docstrings in the `.agency` source files instead of hand-editing generated `docs/site/stdlib/*.md` pages. Docstrings also become tool descriptions for LLM-callable functions, so keep them accurate and user-facing. See `docs/site/cli/doc.md` for the `agency doc` conventions.

## CRITICAL: Handlers are safety infrastructure

Handlers (`handle` blocks) are a crucial part of what makes Agency safe. They must NEVER be accidentally skipped or left unregistered. Any feature that affects execution flow (rewind, interrupts, checkpoints, state restoration) must ensure handlers are correctly registered and invoked. If there is any risk of a handler being skipped, treat it as a critical issue and flag it immediately. Handlers are registered on `__ctx.handlers` via `pushHandler()` in the generated code and are NOT serialized as part of checkpoint state — be aware of this when working on state restoration features.

## VERY IMPORTANT: Agency syntax rules

When writing Agency code (in plans, specs, tests, or examples), you MUST use the correct syntax. Verify against `docs/site/guide/basic-syntax.md` and existing test fixtures when unsure.

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

**When writing plans or specs:** Always verify Agency code snippets by checking `docs/site/guide/basic-syntax.md` and existing test fixtures (`tests/agency/`, `tests/typescriptGenerator/`). If unsure about syntax, run `pnpm run ast` on a test file to confirm it parses.

## Things that often confuse you

Tools and functions are the same thing in the agency. Functions are tools. So there is no point in treating tools and functions separately because they're the same thing.

Please note that you cannot write and run agency files in the `/tmp` directory or any directory outside of the current directory, because certain node modules are needed for the files to run and the `/tmp` directory does not have those node modules.

## Deeper docs

`docs/dev/` holds a doc per feature, recording the key decisions, the architecture, the relevant files, and the subtleties that are easy to miss. Read the one covering an area before changing it.

Read these four before starting work:

- `docs/dev/contributing/coding-standards.md` — Rules for writing code here. Each rule says whether the structural linter enforces it or it is a convention.
- `docs/dev/contributing/anti-patterns.md` — Common mistakes, each with a before/after example.
- `docs/dev/contributing/adding-features.md` — Step-by-step guides for adding an AST node, a CLI command, a type, and similar.
- `docs/dev/contributing/formatting.md` — Prettier for hand-written TypeScript, and the CI check that fails on unformatted files.

The rest are indexed by nine skills, one per area. Invoke the one matching your task and it lists that area's docs: `agency-language-docs`, `agency-compiler-docs`, `agency-runtime-docs`, `agency-agent-docs`, `agency-llm-docs`, `agency-evals-docs`, `agency-cli-docs`, `agency-stdlib-docs`, `agency-hosting-docs`.

Remaining process docs, which no skill covers:

- `docs/dev/contributing/general-writing-tips.md` — How to write prose in this repo. Follow it for docs, comments, and messages to the user.
- `docs/dev/contributing/supply-chain.md` — The dependency hardening that guards against a malicious npm release.
- `docs/dev/contributing/updating-pinned-actions.md` — Refreshing the pinned GitHub Action SHAs that generated workflows use.
- `docs/dev/contributing/untestable-builtins.md` — Stdlib functions CI cannot test, and the cases we want once they can be mocked.
- `docs/dev/contributing/message-thread-tests.md` — An index of message-thread test cases and which file covers each one.

Other references:

- `docs/misc/TESTING.md` — Full testing guide (unit tests, fixtures, execution tests, agency-js tests)
- `docs/misc/config.md` — `agency.json` configuration file
- `docs/misc/lifecycleHooks.md` — Lifecycle hooks and callbacks
- `docs/misc/stateStack.md` — State stack serialization/deserialization for interrupts
- `docs/misc/typeChecker.md` — Type checker usage
- `docs/misc/envFiles.md` — Environment variables and .env files
