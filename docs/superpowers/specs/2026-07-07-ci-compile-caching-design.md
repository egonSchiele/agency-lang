# CI Compile Caching + Job Split — Design

Date: 2026-07-07
Status: Approved

## Problem

CI wall-clock for the `build (22.x)` job grew from ~14 min (2026-07-01) to ~24 min
(2026-07-07). Root-cause analysis of run 28549258023 (fast) vs 28902551402 (slow):

1. **Every Agency compile got ~60% slower** (avg 211ms → 341ms on identical
   files; identical-file compile total 133s → 218s). Driver: stdlib growth —
   `stdlib/index.agency` (auto-imported into every program) grew 301 → 519
   lines when the std::array functions moved into it (`cce04f10`), plus new
   modules (std::git, std::data/finance, littlesis, std::tag). Neither
   `buildCompiledClosure` nor `SymbolTable.build` caches parses: each compile
   re-reads and re-parses the full stdlib prelude chain from disk. Measured
   locally: a trivial 8-line test file compiles in ~135ms, of which ~55ms is
   `buildCompiledClosure` and ~37ms is `SymbolTable.build`.

2. **The test runner compiles once per test *case*, not per file.** Each
   `executeNodeAsync` → `runAgencyNode` → `compile()`. The per-session cache in
   `lib/cli/commands.ts` (`compiledFiles` + `currentClosure`) is cleared by
   `ensureCompiledClosure` whenever the entry file is not covered by the
   current closure — and with `-p 12` interleaving test files, it almost never
   is. Result: ~1750 compiles per CI run for ~870 unique files; the
   agency-agent module tree (~15 modules, `agent.agency` alone 1.3–1.8s)
   recompiles for every one of ~120 agent test cases (612 → 1181 compiles in
   the "Built-in agent tests" step after the attachments/imageTool/gitPolicy
   test additions).

3. All test suites run sequentially inside one job.

## Fix 1: Parse cache

New module `lib/parseCache.ts` exporting `parseAgencyFileCached(absPath,
config, applyTemplate)`:

- Process-wide cache keyed by `(absolute path, mtime, applyTemplate)`.
- Key on `mtimeMs` + file size (not second-granularity `mtime`, which can miss
  rapid successive edits in watch mode). Stdlib files never change mid-run so
  they hit ~always.
- **Returns a `structuredClone` of the cached AST.** Downstream code mutates
  ASTs in place (`compile()` rewrites `node.modulePath`; the typechecker
  annotates nodes), so sharing one object across consumers would corrupt
  state. Cloning costs a few ms vs ~30ms+ for a re-parse. If a later audit
  proves consumers read-only, the clone can be dropped.
- Config is NOT part of the key: the only `AgencyConfig` field the parse path
  reads is `tarsecTraceHost` (`lib/parser.ts:186`, debug tracing). The cache
  bypasses (no read, no store) when `tarsecTraceHost` is set.
- The cache is pinned to `lower: true` parses (`parseAgency`'s fourth param;
  the formatter passes `lower: false`). If the formatter ever migrates, `lower`
  joins the key.
- Cache successful parses only. The parser's module-global error state
  (rightmost-failure tracking) is per-parse; confirmed nothing reads
  parse-global state after a successful parse, so hits skipping those side
  effects are safe.
- Consumers switched in this change: `buildCompiledClosure`,
  `SymbolTable.build`'s `visit()`, and `compile()`'s own entry parse
  (`lib/cli/commands.ts:348` — the same file's third parse per compile).
  Other parse-from-disk sites can migrate opportunistically.

This speeds up every compile everywhere: the test runner, vitest unit tests
(which compile in-process), `agency run`, and the coverage report step.

## Fix 2: Compile-once in the test runner

In `test()` (`lib/cli/test.ts`, used by both `tests/agency` and `lib/agents`
suites):

- Before any test case runs, precompile each unique `.agency` source exactly
  once, **grouped by merged config**: one union-closure compile over all
  base-config files (the same union path directory `compile()` already uses,
  `lib/cli/commands.ts:282-317` — per-file `compile()` calls would rebuild the
  closure ~870 times via `ensureCompiledClosure`'s covers-check), plus one
  compile per local-`agency.json` dir with its merged config (same merge
  `runTestFile` does today). The union path needs a small exported entry point
  in `commands.ts` (e.g. `compileMany(config, files, options)`), since the
  existing union logic is reachable only via the directory branch.
- The precompile pass passes `allowTestImports: true` — the per-case compiles
  it replaces pass it today (`lib/cli/test.ts:586`), and the flag is inert on
  the `preferCompiled` branch, so ALL `import test { … }` enforcement lives in
  the precompile pass. Omitting it would break every test using test-only
  imports.
- **Cross-config invariant, asserted loudly:** compiled output is
  config-dependent (the generator bakes config into emitted code —
  `lib/backends/typescriptBuilder.ts:322,348,3848`), and a sibling `.js` is a
  single slot per module. If any module is reachable from two entries whose
  merged configs differ, precompile fails with an error naming the module and
  the conflicting entry dirs. Verified none of the 16 local-config dirs under
  `tests/` currently imports outside its own directory, so the assert is
  enforcement, not a behavior change. (Graceful fallback — excluding
  conflicting files from `preferCompiled` — was rejected: interleaved per-case
  compiles would rewrite shared siblings mid-run, reintroducing the overwrite
  race this fix removes.)
- Every `executeNodeAsync` call then passes the already-implemented
  `preferCompiled: true`, so `runAgencyNode` reuses the sibling `.js` instead
  of recompiling. Staleness is impossible by construction — the runner
  compiled the sibling in the same run.
- Compile failures during precompile keep today's behavior (parse errors in
  `compile()` exit the process; other errors fail that file's tests).
- `testTs()` (agency-js) already compiles once per dir; it inherits the Fix 1
  speedup unchanged.

Expected effect: ~1750 → ~870 compiles per CI run; the agent tree compiles
once instead of ~120 times; each remaining compile is itself several times
faster via Fix 1.

## Fix 3: CI job split

Split the single `build` job in `.github/workflows/test.yml` into two
self-contained jobs, each doing its own `pnpm install && make` (~2 min; no
artifact plumbing — chosen over artifact sharing, which adds a serial
dependency and upload/download costs that eat the savings):

- **`build`** (matrix 22.x/23.x): checkout, install, make, docs, vitest,
  tarball/bundler/CLI integration, main-only CLI, statelog, sandbox, and the
  **built-in agent tests** (`test:agents` runs with no `--coverage` flag, so it
  has no coupling to the coverage steps and lands here for load balance).
  Existing 22.x-only step conditionals unchanged.
- **`agency-tests`** (matrix 22.x/23.x): checkout, install, make, agency
  execution tests, agency-js tests, stdlib coverage report + PR comment,
  github stdlib smoke test. Agency + agency-js stay together because coverage
  accumulates across those two steps (`--coverage` then
  `--coverage --accumulate`). Existing 22-vs-23 and push-to-main conditionals
  move with their steps.
- `integration-credentials` job unchanged.
- Permissions: `pull-requests: write` (coverage comment) moves to
  `agency-tests`; `build` drops to `contents: read`.

## Verification

- Unit tests for the parse cache: hit, mtimeMs+size invalidation,
  applyTemplate keying, tarsecTraceHost bypass, clone isolation (mutating a
  returned AST must not affect the next read).
- Unit test for the cross-config assert: two synthetic entries with differing
  configs sharing a module must fail precompile with the named module.
- `pnpm run test:agents` locally — the worst offender; expect a large drop.
- A slice of `tests/agency`, plus one local-config dir
  (`tests/agency-js/debugger/...`) to prove the config-merge path.
- Fixture/generator suites (`pnpm test:run`, `make fixtures` diff-clean) to
  prove compiled output is byte-identical.
- Compare CI wall-clock on the PR. Expected: 22.x leg ~24 min → two parallel
  jobs of roughly 7–9 min each.

## Out of scope

- Persistent (cross-process/disk) compile caching.
- Reducing the stdlib prelude itself.

Note: an earlier draft rejected union-closure use in the runner on thrash
grounds. That argument applies to *interleaved per-case* compiles, not to the
sequential, config-grouped precompile phase Fix 2 now specifies — the union
closure is exactly right there and is what the directory-compile path already
does.
