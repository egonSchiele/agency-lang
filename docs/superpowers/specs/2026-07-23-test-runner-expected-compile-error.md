# Test runner: expected compile errors

**Goal:** Let an Agency execution test assert "this file fails to compile, and the failure says X." Needed by the code-templates plan (`AG8001`/`AG8002` — running a template with unfilled holes must refuse), but useful for any compile-time diagnostic.

All line references are to files under `packages/agency-lang`.

## Background: three obstacles, not one

### The runner has no vocabulary for failure

The runner's model of a test is: compile the `.agency` file, run a node, compare the returned value against `expectedOutput` (`TestCase`, `lib/cli/test.ts:36-78`). Nothing in that shape can say "I expect no value, I expect a refusal."

The existing negative-test pattern gets around this by pushing the expectation into the program. `tests/agency/validation/validateAnnotationFail.test.json` runs a program that catches its own runtime error and returns the string `"failed-as-expected"`. That works for runtime failures and is unavailable here, because the thing that fails is compiling the test file itself. The program never starts, so it can't report on itself.

### A non-compiling fixture kills the whole run

Compilation no longer happens per test case. `precompileTestSources` compiles every collected source up front, and a failure there ends the process before any test executes (`lib/cli/test.ts:979-987`). So a fixture that intentionally doesn't compile doesn't just fail its own test — it takes the suite with it.

There is precedent for carving files out of that pass: `isFileLevelSkipped` (`lib/cli/precompile.ts:36-43`) already excludes `skip: true` files, and its comment gives exactly this reason — a skipped file "may intentionally not compile."

### `compile()` usually doesn't throw; it exits

This is the obstacle that decides the design, and it's easy to miss because the js-test path *looks* like it catches compile failures (`lib/cli/test.ts:1106-1111` wraps `compile()` in a try/catch).

For most failures there is nothing to catch. Inside `compileEntry`:

- **Parse failure** → `parseFileOrExit` prints `Failed to parse Agency program: …` and calls `process.exit(1)` (`lib/compiler/buildSession.ts:571-587`).
- **Type error with `typechecker.strict`** → `runTypecheck` prints `formatErrors(...)` and calls `process.exit(1)` (`lib/compiler/buildSession.ts:645-655`).
- **Type error without strict** → `console.warn`, and the compile *succeeds*. The repo's `agency.json` sets `"typechecker": { "enabled": true }` with no `strict`, so this is the default in every test.
- **Import-closure failure** → `CompileClosureError` is caught and converted to `process.exit(1)` (`lib/compiler/buildSession.ts:339-346`).

`compileMany`'s own doc comment states the contract: "Parse/typecheck failures inside per-file `compile()` keep their existing exit behavior" (`lib/cli/commands.ts:263-266`).

Only one kind of failure actually throws out of `compile()`: an exception raised during code generation, because nothing wraps `generateTypeScript` (`lib/compiler/buildSession.ts:520-530`). That happens to be how the code-templates plan raises `AG8001` — a throw from `typescriptBuilder.processNode`.

So an in-process `try { compile(...) } catch` would cover exactly one of the four failure modes, and the other three would call `process.exit(1)` *from inside the test runner*, mid-run, with worker files still in flight and no summary printed. That is the same suite-death the precompile carve-out exists to prevent, reintroduced one phase later where it looks like a hang rather than a failure.

### A fourth thing: diagnostic codes are not in the message

A natural expectation is that matching the substring `"AG8001"` against the error text works. It doesn't, in-process. `diagnostic()` builds a `TypeCheckError` with `code` and `message` as separate fields (`lib/typeChecker/diagnostics.ts:672-687`); the registry templates contain no codes. The only place the two get joined is `formatErrors`, which prints `${where}${severity} ${err.code}: ${err.message}` (`lib/typeChecker/index.ts:555`) — a *printing* path.

## Design: compile in a child process

The runner spawns `agency compile` as a subprocess and judges the result by its exit code and its output.

Every one of the four failure modes becomes the same observable event: the child exits nonzero and prints something. `process.exit(1)` in a child is a normal nonzero exit to the parent. A codegen throw propagates to the CLI's top-level `await runCli()` (`scripts/agency.ts`, bottom), which node reports as an unhandled rejection — stack on stderr, exit code 1. And the diagnostic paths print through `formatErrors`, so the AG code really is in the text the matcher sees.

It also tests the thing a user actually hits. `agency run template.agency` must refuse; a subprocess compile is one step away from that, where an in-process function call is three.

The cost is one process spawn per such fixture. There will be a handful, and each replaces a test that would otherwise spawn a process anyway.

### The field

`expectedCompileError` goes on the `Tests` type — the top-level `.test.json` shape (`lib/cli/test.ts:79-97`) — not on `TestCase`. Compilation is per file. If it fails, no case in the file can run; if it succeeds, the expectation is already violated. Such a file has no cases at all: the file *is* the test.

```json
{
  "expectedCompileError": "AG8001",
  "description": "A file with unfilled holes refuses to compile and names the hole"
}
```

- `expectedCompileError: string` — matched as a substring against the child's combined stderr and stdout. Diagnostic codes are the intended values; the substring form also lets a test pin part of the message text (`"unfilled holes"`), which is what parse errors need since they have no code.
- `description?: string` — printed in the run output, same role as the per-case field.

**Substring, not equality**, because messages carry absolute paths and line numbers that differ by machine. The code, or a distinctive phrase, is the stable part.

**Combined stderr and stdout**, not stderr alone, because the four failure modes don't agree on a stream, and a test author should not have to know which one their diagnostic takes.

### What counts as a pass

Both conditions, together:

1. The child exited nonzero (a signal death — timeout, suite abort — is not a pass; see below).
2. The combined output contains the expected substring.

Three distinct failures, each with its own message:

- **Exited zero** — the file compiled but was expected to fail. Report which substring was expected.
- **Exited nonzero, substring absent** — report the expected substring and the actual output, through `formatDiff` so the mismatch reads the way every other runner mismatch does.
- **Killed by signal** — timed out or the suite aborted. Report as a failure distinct from the two above, because a killed child says nothing about whether the file compiles.

### How the child is invoked

```
process.execPath  [process.argv[1]]  compile  <sourcePath>
```

- `process.argv[1]` is the CLI entry the runner is itself executing (`dist/scripts/agency.js`). Using it, rather than resolving a path, means the child is the same build as the parent — no chance of testing a stale `dist`.
- **cwd is the fixture's directory.** The CLI resolves config by walking up from cwd (`findProjectRoot`, `lib/config.ts:544-560`), so a fixture directory that ships its own `agency.json` gets it, and one that doesn't inherits the project root's. This is a deliberate, stated divergence from the rest of the runner, which *merges* a dir-local `agency.json` over the base config (`lib/cli/test.ts:791-796`). The child gets whichever single config the walk-up finds, because this mode is testing what the CLI does, and that's what the CLI does. A fixture needing `typechecker.strict` writes the whole config it needs.
- **`AGENCY_ALLOW_TEST_IMPORTS=1`** in the child's environment, read by the `compile` command's action and passed through as the existing `allowTestImports` option. Every other compile the runner performs sets this (`lib/cli/util.ts:240-243`); without it a fixture that uses `import test { … }`, or that imports something which does, would fail for a reason unrelated to what it's testing — and would still "pass," since the matcher only sees a nonzero exit and whatever text came out. An env var rather than a flag because that is how the runner already talks to its children (`AGENCY_LLM_MOCKS`, `AGENCY_USE_TEST_LLM_PROVIDER`, `AGENCY_COVERAGE_OUTDIR`), and because this is test-harness plumbing that does not belong in `agency compile --help`.

  It also settles the incremental-build manifest, which would otherwise be a live hazard: a manifest entry left from a run where the file *did* compile could short-circuit to "1 file(s) up to date" and exit zero, reporting a false failure. `allowTestImports` maps to `freshness: "always"` in `resolveFreshness` (`lib/compiler/buildSession.ts:101-116`), which consults and records nothing. So no `--force` is needed, and the coupling is worth knowing about: if that carve-out ever changes, this mode needs `--force`.
- **Timeout and abort signal**, from the same machinery every test case uses: `resolveTimeoutMs` against the file-level `defaultTimeoutMs` (`lib/cli/test.ts:115-122`) and the suite's `AbortController` signal, so a hung compile can't outlive the suite ceiling and Ctrl+C still drains cleanly.

### Sibling `.js` hygiene

The fixture's `.js` sibling is deleted twice: before spawning, and after a compile that unexpectedly succeeded.

Before, because a `.js` from an earlier run — from before the fixture was made to fail, or from a run of an older build — is a file that other machinery might execute. `runAgencyNode` prefers a sibling `.js` when `preferCompiled` is set (`lib/cli/util.ts:305-308`), and these fixtures are precisely the ones that must never run.

After, for the same reason, applied to the file the unexpected success just wrote.

### Interaction with the rest of the runner

**Precompile.** `groupTestSources` skips any `.test.json` whose parsed content has a truthy `expectedCompileError`, right next to the existing `isFileLevelSkipped` check, reusing its try/parse shape (malformed JSON stays live so the runner surfaces the real error later). This is what keeps the suite alive with an intentionally-broken fixture in the tree.

**Counting.** The file contributes one passing or one failing test to `TestStats`, and one to `filesPassed` or `filesFailed` (with the path in `failedFiles` on failure). The summary prints "Test Files" and "Tests" as separate lines (`scripts/agency.ts:736-738`); both stay honest, and sharding is unaffected because it partitions `.test.json` paths.

**Fields that make no sense here.** `retry` is ignored — compilation is deterministic. `llmMocks`, `fetchMocks`, `useTestLLMProvider`, `fakeClock`, `interruptHandlers`, and a non-empty `tests` array are *rejected*: the file reports as one failing test naming the offending key. Silently ignoring them would hide an author's misunderstanding of what this mode does. `skip`, `skipOnCI`, and `skipReason` keep their existing meaning, and a skipped file is skipped before any of this runs.

**Coverage.** `agency test --coverage` maps each `.test.json` to its sibling `.agency` and compiles it for a source map (`lib/cli/coverage.ts:76-98`, driven from the loop at 200-206). A throw there is caught and downgraded to a warning, but a parse failure would `process.exit(1)` and kill the report. The house solution already exists: `config.coverage.exclude`, which today carries `tests/agency/topsort/cycles/**` for the same reason (`agency.json`). The fixture directory gets an entry. No code change.

CI is unaffected either way: the sharded runs pass `--collect-only` (no report), and the report job targets `stdlib` only (`.github/workflows/test.yml:219-225, 315-327`).

### The matcher is a pure function

The comparison — expected substring, exit code, combined output, signal — goes in its own small module returning a verdict and a formatted message, with no I/O. Everything interesting about this feature is in that function, and it's the part a test can drive in both directions without spawning anything or leaving a permanently-failing fixture in the tree.

## Type changes

On `Tests`:

- `expectedCompileError?: string`, with a comment explaining the mode and pointing at the spawn.
- `description?: string` at file level.
- `tests` becomes optional. This matters more than it looks: `const total = tests.tests.length` runs at `lib/cli/test.ts:799`, *before* the file-level skip check at 802, so a `.test.json` with no `tests` array throws a TypeError today. The new mode must be handled before that line, and the line itself needs to tolerate an absent array.

## What stays out of scope

- **Per-case expected runtime errors.** Different feature, different mechanics (the subprocess result path), and the catch-your-own-error pattern covers it adequately.
- **The agency-js test path.** It compiles per-directory and already reports compile failures as test failures (`lib/cli/test.ts:1106-1111`) — with the same in-process caveat, but nothing there needs this today.
- **Structured diagnostic matching** (code plus span plus severity). Substring on the output is enough for the consumers we have.
- **Migrating `tests/agency/topsort/cycles/`.** Those fixtures are exercised by a vitest that stubs `process.exit` to capture the diagnostic (`lib/runtime/topsortCycleErrors.test.ts:95-137`), and its README says it exists because the runner can't express this. That's now false, and moving them onto this mode is a reasonable follow-up — but it's a migration of working tests, not part of shipping the mechanism.

## Tests for this change

1. **Unit, the matcher.** Every branch: nonzero exit with the substring present, nonzero exit with it absent, exit zero, killed by signal. This is the wrong-way-round check made permanent, instead of a manual one-time check that rots.
2. **Unit, precompile grouping.** A `.test.json` with `expectedCompileError` is excluded from `groupTestSources` output, alongside the existing skip-exclusion test in `lib/cli/precompile.test.ts`.
3. **Fixture, parse failure.** A file that doesn't parse, expecting a substring of the parse message. This is the case that proves the whole design: under any in-process approach it would kill the suite.
4. **Fixture, type error.** A directory-local `agency.json` with `typechecker.strict`, a file with a type mismatch, expecting the `AG2xxx` code. This proves code matching works through `formatErrors` output, and it is the shape any future `AG8002`-style typechecker diagnostic will use.

Both fixtures live in their own directory with no ordinary tests beside them. Two reasons: the dir-local `agency.json` would otherwise form a precompile group whose config differs from the base, and `compileGroups` throws `CompileClosureError` when groups with differing configs share a module (`lib/compiler/buildSession.ts:196-213`); and the whole directory is what goes into `coverage.exclude`.

Helper `.agency` files without a sibling `.test.json` remain invisible to both collection and precompile, so template fixtures used by *other* tests (`holeReturnTemplate.agency` and friends) need no changes from this spec.
