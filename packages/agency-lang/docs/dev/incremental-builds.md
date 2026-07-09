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
| `stdlibHash` | One hash over all stdlib sources. The closure walker excludes `std::` imports, so `depsHash` cannot see stdlib edits — yet stdlib content genuinely shapes output (`resolveReExports` bakes resolved stdlib paths in). Any stdlib edit rebuilds the world. |
| `hasPkgImports` | Modules whose import subtree touches `pkg::` are NEVER skipped: package content shapes emitted imports and is invisible to the manifest. Detection shares the closure walker's edge extraction (`programHasPkgImport`), covering plain imports, node imports, and re-exports. |
| `compilerStamp` | Content hash of the compiled compiler (`dist/lib` excluding `runtime/` — generated text does not depend on runtime internals — and `agents/`, which are the agency compiler's own output; including them would make every build invalidate the next). Content, not mtimes: `tsc-alias` rewrites the whole outDir every build. |
| `configKey` | Compiled output bakes config in. Canonical because configs pass through zod (schema shape order). |
| `outputPath` | Where the `.js` landed; a missing output is stale. |

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
