# Incremental builds

The compiler skips recompiling `.agency` files whose inputs have not
changed. The record of those inputs is the **build manifest**:
`.agency-build/manifest.json` at the project root (the nearest directory
with an `agency.json`; without one, each compiled file's own directory —
so an agency.json-less multi-directory project grows one `.agency-build/`
per directory). The manifest is gitignored, wiped by `make clean`, and
written atomically (temp file + rename), so concurrent compiles get
last-writer-wins and never a torn file.

## The entry schema

Each compiled module gets one entry. Every field is an input that shapes
the compiled output; a mismatch on any field forces a recompile, so a bug
in a field can only cause an unnecessary rebuild, never a stale skip.

| Field | Why it exists |
|---|---|
| `sourceHash` | The module's own bytes. Also the soundness anchor: imports are part of the source, so an unchanged `sourceHash` implies the recorded `deps` list is still the module's true deps. |
| `deps` + `depsHash` | Transitive agency imports (paths + one hash over their contents, built by `computeDepsHash` — the single shared construction). Freshness also requires every recorded dep to have a manifest entry whose OUTPUT exists: a skip never recurses into deps, so a deleted dep `.js` would otherwise ship a broken import. |
| `stdlibHash` | Two flavors, selected per entry by `stdlibHashFor` (schema v2). NON-stdlib entries store one hash over all stdlib source CONTENTS: the closure walker excludes `std::` imports, so `depsHash` cannot see stdlib edits — yet stdlib content genuinely shapes their output (`resolveReExports` bakes resolved stdlib paths in), so any stdlib edit rebuilds their world. STDLIB-RESIDENT entries store a names-only hash (`computeStdlibNamesHash`, the sorted file list with no contents): their `deps` DO carry real `std::`-resolved per-file edges, so editing one stdlib file rebuilds only its importers, while adding/removing/renaming a stdlib file still rebuilds all of stdlib (path resolution could shift). This is what makes `agency compile stdlib/` incremental for the everyday one-file edit. |
| `hasPkgImports` | Modules whose import subtree touches `pkg::` are NEVER skipped: package content shapes emitted imports and is invisible to the manifest. Detection shares the closure walker's edge extraction (`programHasPkgImport`), covering plain imports, node imports, and re-exports; the fingerprint walk (below) reports it subtree-wide. |
| `cacheable` | `false` when dependency discovery could not fully establish the module's subtree — recorded (so `outputFor` keeps working) but never fresh. Set by the fingerprint walk for: a splice anywhere in the subtree (splices expand at compile time and may legally emit top-level imports, so raw-parse edges are not the true edges there), or an unparseable/missing reachable file (its own imports are unknowable). |
| `compilerStamp` | Content hash of the compiled compiler (`dist/lib` excluding `runtime/` — generated text does not depend on runtime internals — and `agents/`, which are the agency compiler's own output; including them would make every build invalidate the next). Content, not mtimes: `tsc-alias` rewrites the whole outDir every build. |
| `configKey` | Compiled output bakes config in. Canonical because configs pass through zod (schema shape order). |
| `outputPath` | Where the `.js` landed; a missing output is stale. |

## The dependency fingerprint (stdlib-resident modules)

Stdlib modules compile closure-free by design (the init-plan analysis
deliberately never roots at a stdlib file), so their deps cannot come from
the session closure. They come from `dependencyFingerprint`
(`lib/compiler/depFingerprint.ts`): a breadth-first walk over
`parseAgencyFileCached` + `agencyImportTargets(…, { resolveStdlib: true })`
that returns `{ deps, hasPkgImports, cacheable }`. It is a shared contract
(the planned doc cache consumes it too), and it makes no freshness
decisions — the tracker interprets the data.

Completeness is data, not an exception. A missing direct target stays in
`deps` (a missing file hashes to null at check time, so the entry stays
stale while the file is absent) but marks the fingerprint
`cacheable: false`, as do unparseable reachable files and splices anywhere
in the subtree. The walk never throws for *discovery* reasons — it runs on
the record path, after the module already compiled and emitted, and must
not turn that success into a failure. "Discovery reasons" is an enumerated
errno list (`ENOENT`, `EACCES`, `EPERM`, `EIO`, `EBUSY`, `EMFILE`,
`ENFILE`, `EISDIR`, `ENOTDIR`, `ELOOP`, `ESTALE` — the stat-then-read race
classes), never "has a `code` property": programming errors like
`ERR_INVALID_ARG_TYPE` carry string codes too and must surface, or a real
bug would silently pin modules stale forever. Resolver throws are a vacuous
class in this walk — `pkg::` (the only throwing resolution path) is
filtered before resolution; if a throwing resolver path ever appears for
`std::`/relative targets, extend the classifier.

The residual soundness assumption, mirrored from the user-module side: a
stdlib module's output does not depend on the *contents* of a stdlib file
it does not transitively import (structural changes are separately covered
by the names hash).

**The single-file guarantee boundary:** `agency compile stdlib/math.agency`
records an entry, but `compileEntry` does not recurse into `std::` imports,
so the deps only have manifest entries (and outputs) after a directory
compile created them. Until then the dep-entry freshness clause keeps the
file stale — safe over-rebuilding; do not weaken that clause to "fix" it.
Precise per-file freshness is guaranteed after a complete
`agency compile stdlib/`.

**Schema migration:** the `cacheable` field and the two-hash-flavor rule
bumped the manifest to version 2. Old manifests are discarded on load —
one full rebuild after upgrading, never a misread.

## Freshness modes and the tracker

Policy is interpreted in exactly one place: `createManifestTracker`
(`lib/compiler/manifestTracker.ts`). Session call sites are unconditional —
if you find yourself comparing `freshness === "..."` elsewhere, extend the
tracker instead.

- `incremental` (default for all disk compiles): consult and record.
- `always` (internal only): the shared no-op tracker — no reads, no
  writes, no manifest file. Forced for `allowTestImports` (the test
  runner; `configKey` cannot see that flag), `--ts` mode (different
  artifact), and any compile with a caller-supplied `importStrategy`
  (RunStrategy — the run/coverage paths — rewrites emitted import
  specifiers and transpiles sibling `.ts` deps, none of which the key can
  see).
- `force` (`agency compile --force`): reads disabled, writes on —
  recompile everything and rewrite the manifest.

## Skip granularity

A fully-clean entry set takes the fast path in `BuildSession.compile`:
no closure walk, no parsing at all. A closure with any dirty member pays
closure-level parse + analysis, and its clean members skip typecheck,
codegen, and emit (their per-module check sits before the closure build in
`compileEntry`). Skipped modules also skip their typecheck warnings —
`make clean` or `--force` restores full output.

## What never touches the manifest

`std::agency` (all its compile/run functions are in-memory `compileSource`
calls — sandboxed agent code can neither read nor poison the manifest),
the LSP (it never calls `compile()`), the test runner's precompile, and
run/coverage paths (via the `importStrategy` rule above).

## Recovery

`agency compile --force` rebuilds everything and rewrites the manifest.
`make clean` deletes the manifest with all outputs; a from-scratch build
is byte-identical to an incremental build that found nothing to skip
(verified by the cold-vs-warm hash gate in the Stage A PR 2 verification).
