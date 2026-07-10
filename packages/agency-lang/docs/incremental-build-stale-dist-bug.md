# Bug: incremental build leaves `dist` inconsistent (stale skip → missing export)

**Status:** observed 2026-07-10, not yet reproduced deterministically or fixed.
**Severity:** high — produces a `dist` that fails to load, with a *misleading* downstream symptom that looks like a config bug.
**Workaround:** `make clean && make` (a full clean rebuild always produces a correct `dist`).

## Symptom

After a series of incremental `make agents` builds, the compiled `dist` was
internally inconsistent: a consumer module imported a symbol that its
(stale) dependency module no longer exported. Running the agent failed at
module load:

```
$ node dist/scripts/agency.js agent -p "hi"
file:///.../dist/lib/agents/agency-agent/agent.js:25
import { builtinPolicy, builtinPolicyNames, ..., BUILTIN_POLICIES } from "./lib/defaultPolicy.js";
                                                 ^^^^^^^^^^^^^^^^
SyntaxError: The requested module './lib/defaultPolicy.js' does not provide an export named 'BUILTIN_POLICIES'
```

**The misleading part:** depending on *which* files were stale, the same
underlying inconsistency also surfaced earlier as a bogus **config error**:

```
--provider undefined has no built-in defaults; also pass --model
(or --fastmodel/--slowmodel). Providers with defaults: openai, anthropic, google, openrouter.
```

That error is a red herring — the provider-resolution source code is correct;
a half-stale compiled agent was resolving flags/config against out-of-date
generated code. An investigator who trusts the message will waste time in the
provider path (`lib/agents/agency-agent/lib/models.agency` `resolveDetected`),
which is NOT where the bug is.

## Evidence it is a stale/inconsistent `dist` (not a source bug)

The **source** exports the symbol and is committed clean on `main`:

```
$ grep -n BUILTIN_POLICIES lib/agents/agency-agent/lib/defaultPolicy.agency
184:export static const BUILTIN_POLICIES = [ ... ]        # present in source
$ git status --short lib/agents/agency-agent/lib/defaultPolicy.agency
                                                          # (empty — unmodified/committed)
```

but the **compiled output** did not have it:

```
$ grep -c BUILTIN_POLICIES dist/lib/agents/agency-agent/lib/defaultPolicy.js
0                                                          # BEFORE clean rebuild
```

A clean rebuild fixes it:

```
$ make clean && make
$ grep -c BUILTIN_POLICIES dist/lib/agents/agency-agent/lib/defaultPolicy.js
5                                                          # AFTER clean rebuild — agent starts fine
```

So the incremental build **skipped recompiling `defaultPolicy.agency`** (or
recompiled other files against a stale copy of it), leaving `defaultPolicy.js`
older than the source while its consumer `agent.js` was rebuilt against the new
source. `BUILTIN_POLICIES` / the `approve-all` policy were added to
`defaultPolicy.agency` in commit `66b5a9ae8` ("A couple of agent fixes:").

## Root-cause hypothesis

This is a **stale-skip** in the content-hash incremental manifest: a module
that needed recompiling was judged "fresh" and skipped, so its `.js` output
lags its `.agency` source, and a consumer that WAS rebuilt imports a symbol the
stale output doesn't provide. This is a **known class of bug** for this build
system — the incremental-manifest work (Stage A, PR #468) found and fixed
several instances of exactly this shape:

- **`serve.ts` poisoning:** a threaded `symbolTable` produced no closure →
  `deps: []` recorded in the manifest → later builds skipped after dep edits →
  stale output. (Fixed by only recording deps when knowable.)
- **Skip never checks dep OUTPUTS:** a plan-review finding — "deleted
  `helper.js` survives → broken import"; the freshness check must also require
  each recorded dep to have an existing `outputPath`.
- **`importStrategy` invisible to the manifest key:** run/compile share one
  slot; the wrong strategy's output could be served.

Our occurrence has the same signature (stale dependency output → consumer
imports a missing export), so it is either a **regression** of one of the
above, a **new stale-skip path** not covered by those fixes, or a **corrupted /
out-of-date manifest** (e.g. from branch switches, a merge that changed
`defaultPolicy.agency` while a prior `dist`/manifest lingered, or interleaved
`make agents` runs during active parallel work).

## Where to investigate

- `lib/compiler/buildManifest.ts` — the manifest shape and freshness fields
  (`sourceHash` / `depsHash` / `stdlibHash` / `configKey` / `compilerStamp` /
  `outputPath`) and the skip decision (`moduleIsFresh`-style logic).
- `lib/compiler/manifestTracker.ts` — records/reads manifest entries; the
  "record only when deps knowable (closure-covered OR stdlib)" gate lives here.
- `lib/compiler/buildSession.ts` — drives compile-vs-skip.
- The manifest itself: `.agency-build/manifest.json` (plus `tsc.tsbuildinfo`,
  `doc.stamp`). **Inspect the entry for `defaultPolicy.agency`** — compare its
  recorded `sourceHash`/`outputPath` against the actual source hash and the
  on-disk `.js`.
- Existing tests to extend: `lib/compiler/buildManifest.test.ts`,
  `manifestTracker.test.ts`, `buildSession.test.ts` (a "purity gate" already
  asserts incremental tree hash-identical to a cold build — this bug means that
  gate has a hole for some edit/merge sequence).

## Reproduction (NOT yet deterministic — needs an investigator)

I only captured the **end state**, not a reliable trigger, and my
`make clean && make` **overwrote the stale `.agency-build/manifest.json`**, so
the poisoned manifest entry is no longer available for forensics. Suggested
experiments to force the inconsistency:

1. **Cross-commit incremental skip.** Check out a commit *before* `66b5a9ae8`
   (no `BUILTIN_POLICIES`), run `make` to populate `dist` + manifest, then check
   out `main` (or `66b5a9ae8`) and run **`make agents`** (incremental, NOT
   clean). Check whether `dist/.../defaultPolicy.js` gains `BUILTIN_POLICIES`. If
   it doesn't, the manifest treated the file as fresh across the source change.
2. **Manifest vs source-hash divergence.** After a normal build, edit
   `defaultPolicy.agency` (add/remove an export), run `make agents`, and diff the
   emitted `defaultPolicy.js` against the source. Repeat while toggling which
   *consumer* (`agent.agency`) is also touched, to see if only the consumer
   rebuilds.
3. **Interleaved / partial builds.** Reproduce the session pattern: many
   `make agents` runs, a `make clean`, more `make agents`, with unrelated files
   edited/reverted in between (this session did exactly that before the failure
   appeared).

For each experiment, capture: the manifest entry for the changed file
(recorded `sourceHash` + `outputPath`), the actual source hash, and whether the
`.js` was regenerated. A failing run where the recorded `sourceHash` matches the
NEW source but the `.js` is OLD (or vice-versa) pinpoints the freshness bug.

## Fix direction

Once reproduced: the skip decision must recompile a module whenever its own
source changed **or** any recorded dependency's OUTPUT is stale/missing, and the
purity gate should be extended to cover the reproducing edit/merge sequence so
it can't regress. Until fixed, treat `make agents` as unsafe after cross-module
export changes and prefer `make clean && make`; consider making the agent
startup fail with a clearer "stale dist — run `make clean`" hint instead of a
raw `SyntaxError` / a misleading provider error.
