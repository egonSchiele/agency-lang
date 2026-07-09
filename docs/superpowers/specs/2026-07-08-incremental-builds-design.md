# Incremental Builds — Design

Date: 2026-07-08
Status: Stage C merged (PR #463). Stage A design closed 2026-07-08 (second
brainstorm); ready for planning.

## Problem

Full `make` costs 16.8s locally (~50s CI) and every second of it is paid on
every run, including no-change rebuilds. Measured split: tsc 7.0s (42%),
agency compiles 4.6s (27%), pnpm/node process overhead + copies ~4.7s (28%),
tsc-alias/templates/doc ~1.4s. Agency compile cost grows linearly with the
stdlib and bundled agents (both growing fast); the CPU profile shows no
redundant work left *inside* a compile after PR #457 — parse-once + AST walks
+ emit is the irreducible per-file cost — so further speedup must come from
not compiling unchanged files at all.

Primary target (owner decision): **local `make` iteration**. CI keeps clean
builds; no `actions/cache` plumbing.

## Constraints discovered in research

- `package.json` `files` ships `./dist` AND `./stdlib/**/*.js` wholesale. A
  stale output orphaned by a deleted/renamed source would ship in the npm
  tarball. Publish/pack must therefore always route through a clean build
  (owner decision: incremental is the dev default, clean for publish).
- mtimes are unreliable staleness tokens across `make` runs: `make agents`
  does an unconditional `cp -r lib/agents dist/lib` (fresh mtimes every run)
  and `git checkout` churns mtimes wholesale. Content hashes are required.
- Compiled agency output is config-dependent (generator bakes config in) and
  compiler-dependent (a codegen change must invalidate every compiled
  `.agency`).
- tsc `--incremental` measured on this repo: cold 6.9s, no-change 1.9s,
  one-file-change 1.5s.
- Stdlib outputs are gitignored `.js` siblings inside `stdlib/`; agent
  outputs live inside the `dist/lib/agents` copy. Two output roots.

## Stage C — tsc incremental + process consolidation (land first)

Goal: no-change `make` ≈ 5–6s. No new invalidation machinery.

1. **tsc incremental.** Enable `incremental` in tsconfig.json with
   `tsBuildInfoFile` at `.agency-build/tsc.tsbuildinfo` — NOT inside `dist/`,
   which ships wholesale in the npm tarball (`files: ["./dist", ...]`), and a
   clean build regenerates the buildinfo right before pack. `.agency-build/`
   is the same gitignored scratch dir Stage A's manifest uses; `make clean`
   wipes it. Remove `rm -rf dist/` from the default `build` target. Keep
   `tsc-alias` paired immediately after every `tsc` (a bare `tsc` leaves
   broken `@/` aliases in dist — verified the hard way during research).
2. **`make clean` + clean publish.** New `clean` target: `rm -rf dist/` plus
   delete gitignored `stdlib/**/*.js` siblings (both are shipped in the
   tarball). `make publish` gains a hard dependency on a from-clean rebuild.
   CI needs no change (fresh checkouts are always clean).
3. **Process consolidation.** The `compile` CLI is ALREADY variadic
   (`scripts/agency.ts:151`, `.argument("<inputs...>")`) — the delta is
   Makefile-only. Replace the five per-agent-dir `pnpm run agency compile`
   invocations AND the separate stdlib invocation with ONE direct
   `node ./dist/scripts/agency.js compile stdlib/ <5 agent dirs>` call in the
   default build path (keeping `stdlib`/`agents` as thin aliases for
   selective use). One process means the stdlib prelude parses once, warm,
   for all 94 files — this is the load-bearing lever for the Stage C target,
   since agency compiles are otherwise still full builds. Drop `pnpm run`
   wrappers (pure startup overhead) in favor of direct `node` everywhere in
   the Makefile. Note: the existing variadic action calls `compile()` per
   input (independent closure per entry), not the union-closure path — fine
   for these self-contained roots; Stage A's session unifies it.
4. Unchanged in this stage: the agents staging copy (NOTE, corrected by the
   second design review: as shipped, `stage-agent-sources` does
   `rm -rf dist/lib/agents` before copying — it deletes the compiled agent
   OUTPUTS every build, not just mtimes. Stage A must replace it; see the
   agent-staging decision in Stage A), `make fixtures`, `make doc`, CI
   workflow.

Verification: time `make` — the ~5–6s warm target is an ESTIMATE whose
load-bearing assumption (one warm process collapses the agency share) must
be measured first; if single-process compile of stdlib+agents doesn't get
agency under ~2.5s, say so and re-scope. Also: `make clean && make` (expect
today's ~17s), fixture regeneration diff-clean, and an orphan test on the
publish path (create+compile a scratch .ts/.agency, delete source, run the
publish-path build, assert the orphan output is absent from the tarball
file list via `npm pack --dry-run`).

## Stage A — build sessions + content-hash manifest (follow-up)

Goal (corrected by the second design review — the original "1.5–2s" did
not close arithmetically): **agency compile share of a no-change `make`
drops to ≈0.2–0.3s**, constant as stdlib/agents grow. Total warm `make`
lands ≈3s: the non-agency floor is tsc-incremental 1.9s + tsc-alias 0.5s +
templates 0.3s + copies. In scope as a cheap adjacent win: `make doc` (0.6s,
re-parses all of stdlib every run) gets a stamp — `.agency-build/doc.stamp`
holding the stdlibHash; the recipe skips regeneration when the stamp
matches. With it, warm `make` ≈ 2.5s. Secondary goal, unchanged: the
caching/compile machinery consolidated behind one declarative interface
(per docs/dev/anti-patterns.md "imperative code everywhere" / "leaky
abstractions" feedback on PR #457's layout).

### Rollout decisions (owner, 2026-07-08)

- **Two PRs.** PR 1 is pure consolidation: buildSession absorbs the
  existing machinery with freshness pinned to "always" — provably
  byte-identical, zero behavior change. PR 2 adds the manifest and the
  freshness policy on the clean interface. Each is independently
  revertable.
- **Incremental is the DEFAULT and ONLY public mode for disk compiles.**
  No `--incremental` flag. Rationale: tsc keeps incremental opt-in
  because of a huge legacy base, because tsc is one tool inside pipelines
  it does not own, and because opt-in shifts under-invalidation risk onto
  the user — none of which applies to agency (tiny user base, owns its
  output convention; note tsc's own `--build` mode, where it owns the
  graph, is effectively always-incremental). There is no second build
  path to maintain: a full build IS the incremental path with an empty
  manifest, so "always" costs one `if` at the skip decision, not a
  parallel pipeline.
- **`--force` is the escape hatch** on `agency compile`: ignore the
  manifest, compile everything, rewrite the manifest fresh. Covers
  "I do not trust the cache" without hand-deleting files. (`make clean`
  remains the in-repo full reset.)
- **`freshness: "always"` survives as an INTERNAL policy only** — the
  test runner's precompile requires it (allowTestImports sessions never
  touch the manifest), and the in-memory path has no freshness dimension
  at all.
- Consequences accepted: user projects grow a gitignored-by-convention
  `.agency-build/` dir; manifest writes are atomic (write temp + rename)
  with last-writer-wins so concurrent compiles cannot corrupt it; a
  staleness bug would reach users as stale `.js`, mitigated by the
  conservative invalidation fields (each can only over-rebuild) plus
  `--force`. Orphaned sibling `.js` from deleted sources is a
  pre-existing property of sibling outputs, not new.

### Boundary constraints (verified against code, 2026-07-08)

- **std::agency is out of the manifest's world entirely.** Every function
  on that module (compile, run, runFile, typecheck, …) routes through
  `compileSource` (`lib/stdlib/agency.ts` → `lib/compiler/compile.ts`) —
  even `runFile` reads the file itself and passes a string
  (`_compileFile`). In-memory, sandboxed, no `.js` outputs → nothing to
  skip, nothing to go stale, and sandboxed agent code can neither read
  nor poison the build cache.
- **Refactor contract for the above:** `compileSource` calls
  `buildCompiledClosure` directly (both callers are named in
  compileClosure.ts's header). `buildCompiledClosure` therefore STAYS a
  pure exported function; the buildSession wraps it as the disk-pipeline
  consumer and must not swallow it.
- **The LSP is untouched by the manifest.** Diagnostics parse editor
  buffers as strings with `lower: false` (`lib/lsp/diagnostics.ts:88`) —
  the parse cache is file-keyed and lower:true-pinned, so buffer parses
  bypass it. Cross-file symbol builds (`lib/lsp/server.ts:74`,
  `SymbolTable.build` from disk) already read through the #457 parse
  cache; mtime+size keying is what makes that safe in a long-lived
  server. The LSP never calls `compile()`, so manifest, compilerStamp
  hashing, and `--force` never execute in the LSP process. Pre-existing
  and unchanged: cross-file symbols reflect other files' on-disk state,
  not unsaved buffers.

### The interface (the "what")

One module — `lib/compiler/buildSession.ts` — becomes the single entry point
for multi-file compilation:

```ts
// As built in PR 1 (transitional — mirrors the legacy call sites so the
// consolidation stays byte-identical):
const session = createBuildSession();
session.compile(config, entry, outputFile?, options?);   // file or dir, per-entry closure
session.compileMany(config, files, options?);             // one union closure
session.compileGroups(groups, options?);                  // multi-config + single-slot assert
// config is per-call: cache state is config-agnostic while grouped
// compiles carry per-group configs — which per-module configKey needs in
// PR 2. configKey is derived INSIDE the session (integrity mechanism, not
// caller input); the prebuilt-closure handoff is internal-only.

// Destination (PR 2, with the manifest): compile/compileMany collapse into
// ONE entries-based method — a single entry is a degenerate union — and
// the closure strategy becomes the session's decision, not the caller's:
//   session.compile(config, { entries: string[], freshness?, allowTestImports? })
// freshness defaults "incremental" for disk compiles; "always" stays
// internal-only (test runner). --force maps to a forced-"always" that
// rewrites the manifest.
```

Callers declare entries + config (+ freshness, from PR 2). The session owns
the "how", ALL of it: parse cache, union closure, config grouping and the
cross-config assert, per-session compile dedupe, and (new) manifest-driven
staleness. Consumers after the refactor:

- CLI `compile` command (dirs and multi-path): a session with
  `freshness: "always"` initially; `"incremental"` once the manifest lands.
- Test-runner precompile (`precompile.ts`): shrinks to an adapter that
  builds the config groups and calls the session.
- `commands.ts`: `compileMany` folds into the session; `ensureCompiledClosure`
  + `compiledFiles` + `currentClosure` module-globals become session state.
- `parseCache.ts`: becomes internal to the session (module stays, but its
  only importers are the session and tests).

Success criterion for the refactor: "how does compilation caching work" has
a one-file answer, and no compile-path module-global state remains in
`commands.ts`.

### The manifest (the "how" of incremental)

`.agency-build/manifest.json` at the package root (gitignored; wiped by
`make clean`). Per compiled module:

- `sourceHash` — sha256 of the module's source bytes (content, not mtime —
  survives `cp -r` and `git checkout`).
- `deps` — the module's transitive agency-import paths (package-root-relative)
  as recorded at the compile that wrote the entry. This field exists so the
  skip check can run FROM THE MANIFEST ALONE, without a closure walk — the
  closure walk parses every file, which would make "skipped modules skip
  parse" impossible (second review, blocking finding #2). Soundness
  invariant, load-bearing: import statements are part of the source, so an
  unchanged `sourceHash` implies an unchanged import list, which implies the
  recorded `deps` are still the module's true deps. A refactor that breaks
  this implication (e.g. imports resolved through some source-external
  state) must add that state to the key.
- `hasPkgImports` — true when the module's recorded closure contains any
  `pkg::` import. Such modules are NEVER skipped. The closure walker
  excludes pkg imports exactly as it excludes stdlib
  (`compileClosure.ts`: `isStdlibImport(target) || isPkgImport(target) →
  continue`), and package content genuinely shapes emitted output (import
  classification per docs/dev/pkg-imports.md) — so an `npm update` could
  otherwise strand stale user `.js` with every manifest field matching.
  Never-skip is the smallest sound rule; a real `pkgHash` (hash of resolved
  package `.agency` sources) can replace it if pkg usage grows.
- `depsHash` — hash over the sorted `sourceHash`es of the module's transitive
  agency imports, VERIFIED at check time by re-hashing the recorded `deps`
  paths (not by rebuilding the closure). CRITICAL CAVEAT
  (design review finding #1): the closure walker EXCLUDES stdlib and pkg
  imports (`compileClosure.ts`: `isStdlibImport(target) → continue`), so
  `depsHash` alone can never see a stdlib edit — and recompiled stdlib `.js`
  siblings live in `stdlib/`, not `dist/lib/`, so `compilerStamp` misses them
  too. Without the next field, "touch `stdlib/index.agency`" would skip every
  user module — a stale-output bug.
- `stdlibHash` — hash over the contents of all `stdlib/**/*.agency` sources,
  one value per session, a separate manifest field precisely because the
  closure will never carry it. This is not merely conservative: user-module
  codegen genuinely depends on stdlib content — `resolveReExports` resolves
  user imports through stdlib re-export declarations into concrete module
  paths in the emitted `.js`, so moving a function between stdlib modules
  changes downstream output (this happened in practice in the `cce04f10`
  stdlib reorganization). A stdlib edit therefore rebuilds the world, by
  deliberate decision.
- `configKey` — PR #457's canonical config serialization.
- `compilerStamp` — one value per session: hash over the CONTENT of compiled
  compiler files. mtime-based stamping is settled as unworkable (review
  finding #2): `tsc-alias` reprocesses the entire outDir on every build, so
  mtimes churn every `make`. Scope: `dist/lib/**/*.js` EXCLUDING
  `dist/lib/runtime/` and `dist/lib/agents/` — generated code's TEXT does not
  depend on runtime internals (it imports runtime symbols by name at
  execution time; any rename that would change emitted references requires a
  codegen edit, which is inside the stamp), and runtime is where the most
  common non-codegen edits land. Exclusion-list design is fail-safe: a new
  compiler dir is included by default. NAMED LIMIT: an edit to any other
  `.ts` file still invalidates all agency output, so Stage A's incrementality
  pays off in agency-only and runtime-only iteration loops, not in
  compiler-hacking loops. That is the accepted trade for a stamp that can
  never under-invalidate.
- `outputPath` — where the `.js` landed, so staleness can also verify the
  output still exists.

Skip algorithm (runs from the manifest alone, no parsing):

1. Hash M's source bytes; compare `sourceHash`.
2. If it matches, the recorded `deps` are still valid (soundness invariant
   above). Hash each recorded dep's current source bytes; recompute and
   compare `depsHash`. A missing dep file = dirty.
3. Compare `stdlibHash`, `compilerStamp`, `configKey`; check `outputPath`
   exists; check `hasPkgImports` is false.
4. All pass → skip M entirely. Any miss → M compiles.

Skip granularity, stated precisely (second review, finding #2): a FULLY
CLEAN closure skips everything — no parse, no symbol table, no init
analysis, no typecheck, no codegen. A closure with ANY dirty member pays
closure-level parse + symbol table + init analysis (that machinery is
closure-granular by design), and its clean members skip only typecheck +
codegen. So "recompile" and "reparse" diverge on partially-dirty closures;
tests must assert the right one. Skipped modules also skip their typecheck
warnings (same trade tsc makes; `make clean` restores full output).

Freshness-oracle layering (second review, finding #6): the MANIFEST decides
whether to compile; `parseCache` is an intra-process memo consulted only
once compilation is already happening. Its `mtimeMs+size` key can in theory
serve a stale AST that content hashing would have caught — accepted as-is
(APFS sub-ms mtimes + the size guard make it astronomically unlikely). Do
not "unify" the two caches in the other direction.

### Residual risks, named

- The manifest is dev-only by construction (publish path is clean-built), so
  a manifest bug can produce a confusing local state but can never ship
  stale code. `make clean` is always the escape hatch.
- Hashing every source file per build costs ~1–2ms/file (sha256 of ~12k
  lines total) — noise next to the 1s+ it replaces.
- `import test { … }` modules are local files and DO participate in
  closures, so `deps`/`depsHash` cover them. `pkg::` imports do NOT (the
  walker skips them) — covered by the `hasPkgImports` never-skip rule above.
  (The first draft of this bullet claimed pkg imports were in the closure;
  the second review showed that is false — `compileClosure.ts` skips them
  like stdlib.)
- `allowTestImports` is deliberately NOT on `AgencyConfig`, so `configKey`
  cannot distinguish a test-import compile from a normal one. Rule: sessions
  with `allowTestImports: true` (the test runner's precompile) NEITHER read
  NOR write the manifest — they stay `freshness: "always"`. If precompile is
  ever flipped to incremental, `allowTestImports` must join the manifest key
  first.
- `.gitignore`: DONE in Stage C — the root `.gitignore` carries an explicit
  `.agency-build/` entry. No Stage A task needed. (User projects get
  `.agency-build/` by convention only; see Consequences accepted.)

### Agent staging (decision — second review, blocking finding #1)

Stage C's `stage-agent-sources` recipe does `rm -rf dist/lib/agents` before
copying, which deletes every compiled agent output on every `make` — under
the skip rule (`outputPath` must exist) no agent file would EVER skip, and
the "constant as agents grow" goal would be unreachable. The wipe exists
for orphan safety (an overlay copy would keep outputs of deleted sources),
so the fix is a replacement, not a removal.

Decision: **sync-style staging** via a small script (`scripts/stage-agents.mjs`
or equivalent), replacing the `rm -rf` + `cp -r` recipe:

1. Copy every file from `lib/agents` over `dist/lib/agents` (overwrite).
2. Delete from `dist/lib/agents` any file whose source counterpart no
   longer exists in `lib/agents` — and for a deleted `foo.agency`, also
   delete its compiled `foo.js` sibling.
3. Never touch compiled `.js` whose `.agency` source survives, and never
   touch `docs/` (owned by `stage-agent-docs`).

Orphan safety is preserved twice over: the sync deletes orphans itself, and
publish still routes through `make clean`. Alternatives rejected: letting
the manifest/session own staging (heavier, blurs the session's boundary
into Makefile concerns); accepting always-rebuild agents (contradicts the
stated goal).

Verification: unit tests on the staleness rule (each field's mismatch
triggers rebuild — including `stdlibHash` and a recorded-dep content change
via `deps`; missing dep file, missing output, and `hasPkgImports: true`
each trigger rebuild); a no-parse proof for the clean case (fully clean
closure → zero `parseAgency` calls, assert via parse-cache stats or a spy);
end-to-end: warm `make` twice → second run skips ALL 94 modules INCLUDING
the five agent dirs (this is the acceptance test for the sync-staging
decision — the old recipe made agent skips impossible); touch any stdlib
file → all agency modules recompile (`stdlibHash`) AND `make doc`
regenerates (doc.stamp); no stdlib change → `make doc` skips; touch a
non-stdlib `.agency` → its closure re-parses, only dirty members re-codegen
(assert recompile vs reparse per the granularity statement); delete an
agent `.agency` from `lib/agents` → sync staging removes its dist copy and
compiled sibling; edit `lib/backends/typescriptBuilder.ts` + rebuild → all
recompile (stamp); edit `lib/runtime/*.ts` + rebuild → ZERO agency
recompiles (stamp exclusion); `cp -r` and branch-switch churn → zero
spurious rebuilds (content hashes unchanged); fixtures diff-clean;
test-runner behavior unchanged (its precompile stays `freshness: "always"`
and never touches the manifest — flipping it to incremental is a separate,
later decision gated on adding `allowTestImports` to the manifest key).

## Out of scope

- CI incrementality via `actions/cache`.
- Micro-optimizations found in profiling (tarsec's always-on `trace()`
  wrapper ~116ms, `getAllVariablesInBody` 306ms) — each worth ~0.1–0.3s;
  candidates for separate small PRs.
- Watch-mode / daemonized compiles.
- Orphan-tracking deletion (rejected in favor of clean-for-publish: simpler,
  and a manifest bug then can't affect a tarball).
