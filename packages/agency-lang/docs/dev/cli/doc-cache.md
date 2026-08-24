# The `agency doc` incremental cache

`agency doc <dir>` used to re-parse and re-render every file on every run
(~5.3s when the stdlib had 83 files, dominated by parsing). It now keeps a
per-page cache and re-renders only what changed. A warm run costs ~0.4s,
and editing one file re-renders that page plus the pages that genuinely
depend on it. Output is byte-identical to a cold run.

The pieces live in `lib/cli/docLedger.ts` (ledger, lock, freshness,
entry builder) and the directory branch of `lib/cli/doc.ts`
(`generateDocDirectory`). Single-file mode (`agency doc file.agency`) has
no cache behavior at all. It does take the same lock, because it writes
into the same directory a cached run owns.

## One ledger per physical output directory

The mutable resource a doc run contends for is the output directory, so
that is the unit of state: one ledger (`.agency-doc.json`) and one lock
(`.agency-doc.lock`), stored as sidecars **inside** the output directory,
with the directory realpath'd so symlink aliases meet the same files.

Why inside the output directory rather than `.agency-build/`? Three
reasons. First, two different invocations can write the same physical
directory, and they must meet the same ledger and contend on the same
lock. Only a sidecar is structurally one-per-output. Second, the ledger
shares the pages' lifetime: `rm -rf` of the output removes both together,
and `make clean` wipes `.agency-build/` but not `docs/site/stdlib/`, so
it severs neither. Third, the sidecars are gitignored, and the
`stage-stdlib-docs` recipe in the Makefile runs
`rm -f stdlib/docs/stdlib/.agency-doc*` so they never ship inside
`stdlib/docs/`.

The input directory and ignore list are stored **inside** the ledger as
the current invocation identity — data, not a namespace. Changing them is
a transition: every page goes stale, but the old entries remain the
ownership evidence that lets reconciliation delete pages the new
invocation no longer produces.

## Freshness vs ownership, the load-bearing distinction

"Is this page current?" and "did we write this file?" have different
failure costs. Invalidating freshness wholesale costs only a re-render,
so it is cheap and can happen at any time. Ownership authorizes
**deletion**, so it is held to a stricter standard and ordinary
invalidation never discards it:

- An identity or render-key mismatch marks everything stale but keeps the
  prior entries for reconciliation. (Concretely: delete a source AND
  change `--base-url` in one run — the old page is still cleaned up.)
- Only corruption-shaped state forfeits deletion authority: unparseable
  JSON, a `version` other than `1`, an `outputDir` naming a different
  directory (a copied tree), or ANY malformed field anywhere.
  `loadDocLedger` validates every entry and key recursively before
  returning `authority: true`, and callers never dereference an
  unvalidated field. Without authority the run re-renders everything and
  deletes nothing.

The **conservative output contract** follows: files the ledger doesn't
record are never deleted. A stray handmade file always survives. The
corollary is accepted and documented: if the ledger is destroyed or
corrupted while an obsolete generated page exists, that page becomes
indistinguishable from a handmade file and survives permanently. The
escape hatch is deleting the output directory for a truly cold start.

## What makes a page fresh

`isDocEntryFresh` in `docLedger.ts` checks most of this, and the doc
command's own flow checks the rest. All of the following must hold: the
entry is `cacheable` and its `hasPkgImports` flag is false; the source
bytes are unchanged; every recorded dep's bytes are unchanged; the stdlib
hash flavor is unchanged; the compiler stamp is unchanged; the render key
is unchanged; the recorded link resolutions still answer identically; and
the rendered page is present with its recorded content hash.

A few of those deserve a note. `dependencyFingerprint` decides
`cacheable`. It sets the flag to false for a parse failure, a filesystem
error while reading candidates, or a splice anywhere in the subtree. Deps
come from `dependencyFingerprint` too. It resolves `std::` imports for
stdlib-resident files, so the template's implicit `std::index` prelude
edge is a real recorded dependency. `stdlibHashFlavor` picks the same
names-vs-contents rule the compile manifest uses. The render key hashes
the config together with the effective base URL.

The output-hash check is how deleted and hand-edited pages get repaired.
Identity and render key are ledger-level checks, and the link re-check
needs the rebuilt registry, so those three live in `generateDocDirectory`
rather than in `isDocEntryFresh`.

## `registrySymbols` and `linkTargets`

Pass 1 exists to build the symbol registry, and it is where all the
parsing went. Each entry caches the file's **registry contributions**
from `extractRegistrySymbols`, so a fresh file's contribution costs a
dictionary merge, not a parse. Contributions are applied in traversal
order whether cached or parsed, which preserves last-writer-wins
collision outcomes. Never sort the traversal.

`linkTargets` records every registry lookup a page's rendering made. It
maps a name to a target page, or to `null` for "rendered unlinked". Each
run rebuilds the registry, and a fresh page stays fresh only if every
recorded lookup still answers identically. That replaces the tempting
"links only point inside the import closure" assumption with a mechanical
check. The code does not enforce that assumption anyway, because
`formatTypeLinked` is a bare name lookup. With the check, a symbol moving
files, appearing somewhere new, or winning a name collision re-renders
exactly the pages that linked it.

## The registry is the set of rendered anchors

`extractRegistrySymbols` used to be deliberately wider than "what the page
shows": it registered non-exported and underscore-prefixed functions too.
That is unsafe, because `formatTypeLinked` turns a registry hit into
`[Name](page.md#name)`. A registered name with no `###` section on that
page is a link to an anchor that does not exist. Contributions are also
last-writer-wins in traversal order, so a non-exported declaration in one
file can steal the name from a documented one in another.

So the registry now applies exactly the render sections' rule, through the
single `isDocumented(name, exported, tags)` predicate both sides call:
exported, not underscore-prefixed, not `@hidden`. If you add a visibility
rule to a section, put it in `isDocumented` or the two will drift and the
drift shows up as a broken link, not as a test failure.

`extractRegistrySymbols` reads `exported` off AST nodes and tags off
attached declarations, so its input must have been through
`preprocessProgram`. `parseFor` does this; a caller that skips it sees no
tags at all and silently over-registers.

None of this needs a render-key bump. Adding `@hidden` changes the file's
source hash, so its page re-renders with a smaller symbol set, and the
`linkTargets` re-check invalidates exactly the pages whose lookups
changed.

## Warnings have to survive a cache hit

`generateDocForFile` runs only for stale pages, so anything it prints
vanishes on the next run. The author sees a warning once, reruns, and
gets a clean build with the problem still there. Any per-page diagnostic
therefore has to be recorded in the ledger and re-emitted for fresh pages.
`strayHiddenLines` is the one instance: the source lines of a `@hidden`
that attached to no declaration. It is optional on the entry, so an older
ledger keeps its authority and simply warns nothing until the page next
re-renders.

Where those lines come from matters. Tag attachment recurses into
function and node bodies and through control flow, so it can strand a tag
anywhere, not just at the top level. A `@hidden` above a `return` is
dropped as silently as one at the end of a file. `strandedTags` in
`lib/preprocessors/typescriptPreprocessor.ts` therefore mirrors
`collectTags`'s own walk, and lives beside it so the two are read
together. `lib/cli/doc.ts` wraps it as `strayHiddenLines`. A separate
walker here would drift, and the drift would show up as missing warnings,
which nothing tests for.

## Deletion boundary

Reconciliation deletes a prior-owned page only when: the prior ledger had
full authority; the entry's **recomputed** deterministic path
(`outputPathFor(key)` — the stored `outputPath` field is never
dereferenced) is absent from the new desired set; and
`resolveOwnedOutputPath` accepts the path. That helper `lstat`s every
existing component under the output root and refuses symlinked ancestors.
Lexical `startsWith` containment alone would follow `out/sub → victim`
and delete outside the root. A symlink at the leaf is removed as a link
and never followed, and rendering likewise refuses to write through one.
Anything that is neither a regular file nor a leaf symlink, such as a
directory now sitting at the path, is skipped rather than deleted.

`isSafeSourceRel` validates ledger keys as relative, normalized,
`..`-free, and ending exactly in `.agency`. The suffix rule matters
because `outputPathFor` on a key like `README` would be a no-op mapping,
which could aim deletion at a handmade file.

## The lock

`acquireDocLock` creates `.agency-doc.lock` with the `wx` flag. A second
run against the same output directory is refused with a message naming
the holder. Stale locks are removed **manually**, because automatic
dead-pid breaking lets two processes race past the same dead lock via
check-then-overwrite. The lock stores `pid:uuid`, and `releaseDocLock`
compares the whole token, so a stale handle can never delete a
successor's lock even after the same pid re-acquires. Token-verify-then-
unlink is still not atomic, and the contract is that nobody removes a
*live* lock by hand.

## Testing gotchas

`lib/cli/docCache.test.ts` and `lib/cli/docStdlibDeps.test.ts` hold the
behavior suites. Things that silently regress:

- Rewrite detection backdates page mtimes and runs incremental generation
  **once**. Content parity alone passes when everything re-renders, and a
  second run can conceal a first-run defect.
- Parity always compares against a cold run of the **same** invocation
  into a fresh directory, and semantic content (Throws effects, exact
  link targets) is asserted directly. Both sides of a parity comparison
  run the same code, so parity alone cannot catch a shared regression.
- Fixture mutations call `evictParseCache` from `lib/parseCache.ts`. The
  fingerprint reads the process-global parse cache, whose mtime+size key
  can miss same-size writes within one timestamp granule.
- The fake stdlib in `docStdlibDeps.test.ts` mirrors the REAL template
  carve-out (only `index`/`array` non-templated) and stubs the prelude
  surface in fake `index.agency`. An all-non-templated fake would hide
  the prelude edge that doc rendering actually sees. The mock overrides
  `getStdlibDir`, `isNonTemplatedStdlib`, AND `resolveAgencyImportPath`
  together (module-internal calls bypass export mocks).

## The Makefile

`make doc` is now a plain `agency doc stdlib -o docs/site/stdlib/`: no
`rm -rf`, no outer stamp. The old stamp skipped the command entirely, so
deleted or hand-edited pages were never repaired and orphan cleanup never
ran. `scripts/stdlib-stamp.ts` is gone. Warm `make doc` costs one node
start plus the freshness pass.
