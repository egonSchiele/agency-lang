# Review: CI Compile Caching + Job Split — Design

Date: 2026-07-07
Spec: `2026-07-07-ci-compile-caching-design.md`
Verdict: **Sound and well-grounded.** Every factual claim checked against the code is
accurate except one (coverage accumulation, finding 4). Two real gaps in Fix 2
(findings 1 and 2) and one one-line omission (finding 3) should be folded into the
spec before implementation. Fixes 1 and 3 are ready as written modulo small
corrections.

## Claims verified true

- `lib/cli/commands.ts:177-235`: `compiledFiles` + `currentClosure` exist and
  `ensureCompiledClosure` clears them exactly as described (rebuild whenever the
  entry isn't covered by the current closure).
- `preferCompiled` is already plumbed through both `ExecuteNodeAsyncArgs` and
  `RunAgencyNodeArgs` (`lib/cli/util.ts:229,263,301`) and reuses the sibling `.js`.
- `SymbolTable.build`'s `visit()` (`lib/symbolTable.ts:147`) and
  `buildCompiledClosure` (`lib/compiler/compileClosure.ts:255-257`) both re-read
  and re-parse from disk with no caching.
- The AST-mutation concern justifying `structuredClone` is real: `compile()` →
  `resolveImports`/`resolveReExports`, pattern lowering, and typechecker
  annotation all mutate the AST in place. The planned clone-isolation unit test
  will also catch a `DataCloneError` if the AST ever holds non-cloneable values.
- `testTs()` already compiles once per dir with the local-config merge
  (`lib/cli/test.ts:1009-1015`), and `runTestFile` does the same merge
  (`lib/cli/test.ts:730-733`).
- The CI job split maps cleanly onto the actual steps in
  `.github/workflows/test.yml`; the permissions change and the
  push-to-main/22.x-only conditional moves are all correct.

## Findings

### 1. Fix 2's "staleness impossible by construction" has an unguarded config dimension

Compiled output is config-dependent — the generator bakes config into emitted
code (`lib/backends/typescriptBuilder.ts:348` `configDefaults`, `:3848`
`buildSmoltalkDefaults`). Sibling `.js` is a single slot per module, so if a
module were reachable from two entries whose merged configs differ (a
local-`agency.json` dir importing a shared helper, or a base-config test
importing into such a dir), precompile is last-writer-wins and `preferCompiled`
runs the wrong config's code. Today's per-case recompile rewrites the closure
with the correct config just before each spawn, so this is a genuine semantic
change.

Checked all 16 local-config dirs under `tests/`: none currently imports outside
its own directory, so this is latent, not live — but nothing enforces it.

**Recommendation:** the precompile pass should assert the invariant — any module
reachable from entries with differing merged configs → fail loudly, or exclude
those files from `preferCompiled` (fall back to per-case compile for them).

### 2. Precompile will thrash the closure unless it uses the existing union-closure path

"Precompile each unique source exactly once" via per-file `compile()` calls hits
`ensureCompiledClosure`'s covers-check on nearly every file → ~870 closure
rebuilds (each one an import-tree walk + init-topsort analysis; the parse cache
makes them cheaper but not free).

The codebase already owns the solution: `compile()` on a directory builds ONE
union closure covering all entries (`lib/cli/commands.ts:282-317`), added
precisely to avoid this thrash.

**Recommendation:** group precompile entries by merged config — one union
closure for all base-config files, plus one directory compile per local-config
dir. Note this also weakens the out-of-scope rejection of "union-closure
priming": the thrash argument applies to interleaved per-case compiles, not to
a sequential, config-grouped precompile phase.

### 3. Fix 2 omits `allowTestImports`

The runner passes `allowTestImports: true` on every per-case compile today
(`lib/cli/test.ts:586`), and the flag is documented as inert on the
`preferCompiled` branch (`lib/cli/util.ts:264-266`) — so ALL
`import test { … }` enforcement moves to the precompile pass. If precompile
doesn't pass the flag, every test using test-only imports fails to compile.
One line, but it's a correctness requirement the spec should state.

### 4. Fix 3 misstates coverage accumulation

`test:agents` is `test lib/agents -p 12` with **no** `--coverage`/`--accumulate`
(`packages/agency-lang/package.json:12`); coverage accumulates across the
agency (`--coverage`) and agency-js (`--coverage --accumulate`) steps only. The
grouping still works, but the stated reason for pinning the agents step to
`agency-tests` is wrong — that step is actually free to move to whichever job
balances better, which matters since load-balancing is the whole point of
Fix 3.

### 5. Fix 1's open question about config-dependent parsing resolves cleanly

The only `AgencyConfig` field the parse path reads is `tarsecTraceHost`
(`lib/parser.ts:186`, debug tracing) — the cache needs no config in its key,
just a bypass when tracing is on. Two adjacent nits:

- `parseAgency` has a fourth param `lower` (the format path passes
  `lower: false`) — pin the cache to `lower: true` or add it to the key before
  any "opportunistic migration" touches the formatter.
- Key on `mtimeMs` (ideally + size): second-granularity `mtime` can miss rapid
  edits in watch mode, which is exactly the correctness story the spec leans on.

### 6. Minor

- `compile()` itself parses the entry a third time per compile
  (`lib/cli/commands.ts:348`) — same mechanism, worth switching in the same
  change rather than "opportunistically".
- Cache successful parses only; the parser's module-global error state
  (`getErrorMessage`, rightmost failure) is populated per-parse. Confirmed
  nothing reads parse-global state (`getInputStr`/template offset) after a
  successful parse, so cache hits skipping those side effects are safe.
