# The `agency doc` incremental cache

`agency doc <dir>` used to re-parse and re-render every file on every run
(~5.3s for the 83-file stdlib, dominated by parsing). It now keeps a
per-page cache and re-renders only what changed: a warm run costs ~0.4s,
and editing one file re-renders that page plus the pages that genuinely
depend on it. Output is byte-identical to a cold run.

The pieces live in `lib/cli/docLedger.ts` (ledger, lock, freshness,
entry builder) and the directory branch of `lib/cli/doc.ts`
(`generateDocDirectory`). Single-file mode (`agency doc file.agency`) has
no cache behavior at all — but it does take the same lock, because it
writes into the same directory a cached run owns.

## One ledger per physical output directory

The mutable resource a doc run contends for is the output directory, so
that is the unit of state: one ledger (`.agency-doc.json`) and one lock
(`.agency-doc.lock`), stored as sidecars **inside** the output directory,
with the directory realpath'd so symlink aliases meet the same files.

Why inside the output directory rather than `.agency-build/`? Three
reasons. Two different invocations (different input roots, different
ignore lists — even different project roots) can write the same physical
directory, and they must meet the same ledger and contend on the same
lock; only a sidecar is structurally one-per-output. The ledger also
shares the pages' lifetime: `rm -rf` of the output removes both together,
and `make clean` (which wipes `.agency-build/` but not
`docs/site/stdlib/`) severs neither. The sidecars are gitignored, and
`stage-stdlib-docs` strips `.agency-doc*` from its copy so they never
ship inside `stdlib/docs/`.

The input directory and ignore list are stored **inside** the ledger as
the current invocation identity — data, not a namespace. Changing them is
a transition: every page goes stale, but the old entries remain the
ownership evidence that lets reconciliation delete pages the new
invocation no longer produces.

## Freshness vs ownership — the load-bearing distinction

"Is this page current?" and "did we write this file?" have different
failure costs. Freshness can be invalidated wholesale at any time (the
cost is a re-render). Ownership is what authorizes **deletion**, so it is
held to a stricter standard and never discarded by ordinary invalidation:

- An identity or render-key mismatch marks everything stale but keeps the
  prior entries for reconciliation. (Concretely: delete a source AND
  change `--base-url` in one run — the old page is still cleaned up.)
- Only corruption-shaped state forfeits deletion authority: unparseable
  JSON, wrong version, a `outputDir` naming a different directory (a
  copied tree), or ANY malformed field anywhere — `loadDocLedger`
  validates every entry and key recursively before returning
  `authority: true`, and callers never dereference an unvalidated field.
  Without authority the run re-renders everything and deletes nothing.

The **conservative output contract** follows: files the ledger doesn't
record are never deleted. A stray handmade file always survives. The
corollary is accepted and documented: if the ledger is destroyed or
corrupted while an obsolete generated page exists, that page becomes
indistinguishable from a handmade file and survives permanently — the
escape hatch is deleting the output directory for a truly cold start.

## What makes a page fresh

All of: entry `cacheable` (see below) with no `pkg::` in its subtree;
source bytes unchanged; every recorded dep's bytes unchanged (deps come
from `dependencyFingerprint` — `std::`-resolved for stdlib-resident
files, so the template's implicit `std::index` prelude edge is a real
recorded dependency); the stdlib hash flavor unchanged (`stdlibHashFlavor`
— the same names-vs-contents rule the compile manifest uses); compiler
stamp unchanged; render key unchanged (config + effective base URL,
hashed structurally); recorded link resolutions unchanged (below); and
the rendered page present with its recorded content hash — which is how
deleted AND hand-edited pages get repaired.

## `registrySymbols` and `linkTargets`

Pass 1 exists to build the symbol registry, and it is where the 83 parses
went. Each entry caches the file's **registry contributions**
(`extractRegistrySymbols` — deliberately not named "exports": the set
includes non-exported and underscore-prefixed functions), so a fresh
file's contribution costs a dictionary merge, not a parse. Contributions
are applied in traversal order whether cached or parsed, preserving
last-writer-wins collision outcomes. Never sort the traversal.

`linkTargets` records every registry lookup a page's rendering made
(name → target page, or `null` for "rendered unlinked"). Each run, after
the registry is rebuilt, a fresh page stays fresh only if every recorded
lookup still answers identically. This replaces the tempting
"links only point inside the import closure" assumption — which the code
does not enforce (`formatTypeLinked` is a bare name lookup) — with a
mechanical check: a symbol moving files, appearing somewhere new, or
changing a collision winner re-renders exactly the pages that linked it.

## `@hidden` and the registry

`@hidden` (see `docs/site/cli/doc.md` for the user-facing rule) keeps a
declaration out of the rendered page. It has to keep it out of
`registrySymbols` too, or the page stops matching the registry: a hidden
type renders no `### Name` section, so any other page linking to it would
point at an anchor that does not exist. `extractRegistrySymbols` therefore
drops hidden declarations of every kind. Only the type-alias case can
actually break a link today — `formatTypeLinked` returns early for
anything that is not a `typeAliasVariable` — but the registry is defined
as "the set link targets resolve against", so it stays honest about all
four.

This needs no render-key bump. Adding `@hidden` to a file changes that
file's source hash, so its page re-renders and contributes a smaller
symbol set; the `linkTargets` re-check then invalidates exactly the pages
whose lookups changed. The cache corrects itself through machinery that
already exists.

Note that `extractRegistrySymbols` reads tags off the declarations, so its
input must have been through `preprocessProgram` — `parseFor` does this,
and a caller that skips it will silently see no tags at all.

## Deletion boundary

Reconciliation deletes a prior-owned page only when: the prior ledger had
full authority; the entry's **recomputed** deterministic path
(`outputPathFor(key)` — the stored `outputPath` field is never
dereferenced) is absent from the new desired set; and
`resolveOwnedOutputPath` accepts the path. That helper `lstat`s every
existing component under the output root and refuses symlinked ancestors
— lexical `startsWith` containment alone would follow `out/sub → victim`
and delete outside the root. A symlink at the leaf is removed as a link,
never followed; rendering likewise refuses to write through one.

Ledger keys are validated (`isSafeSourceRel`) to be relative, normalized,
`..`-free, and ending exactly in `.agency` — the suffix rule matters
because `outputPathFor` on a key like `README` would be a no-op mapping
and could otherwise aim deletion at a handmade file.

## The lock

`wx`-exclusive create; concurrent runs against one output directory are
refused with a message naming the holder. Stale locks are removed
**manually** — automatic dead-pid breaking was rejected because
check-then-overwrite lets two processes race past the same dead lock. The
lock stores `pid:uuid` and release compares the whole token, so a stale
handle can never delete a successor's lock (same-pid re-acquisition
included). Token-verify-then-unlink is still not atomic; the contract is
that nobody removes a *live* lock by hand.

## Testing gotchas

`lib/cli/docCache.test.ts` and `lib/cli/docStdlibDeps.test.ts` hold the
behavior suites. Things that silently regress:

- Rewrite detection backdates page mtimes and runs incremental generation
  **once** — content parity alone passes when everything re-renders, and
  a second run can conceal a first-run defect.
- Parity always compares against a cold run of the **same** invocation
  into a fresh directory, and semantic content (Throws effects, exact
  link targets) is asserted directly — both sides of a parity comparison
  run the same code, so parity alone cannot catch a shared regression.
- Fixture mutations call `evictParseCache` — the fingerprint reads the
  process-global parse cache, whose mtime+size key can miss same-size
  writes within one timestamp granule.
- The fake stdlib in `docStdlibDeps.test.ts` mirrors the REAL template
  carve-out (only `index`/`array` non-templated) and stubs the prelude
  surface in fake `index.agency` — an all-non-templated fake would hide
  the prelude edge that doc rendering actually sees. The mock overrides
  `getStdlibDir`, `isNonTemplatedStdlib`, AND `resolveAgencyImportPath`
  together (module-internal calls bypass export mocks).

## The Makefile

`make doc` is now a plain invocation: no `rm -rf`, no outer stamp (the
stamp skipped the command entirely, so deleted or hand-edited pages were
never repaired and orphan cleanup never ran). `scripts/stdlib-stamp.ts`
is gone. Warm `make doc` costs one node start plus the freshness pass.
