# Review: performance regression tests in CI

Reviewer: Claude
Date: 2026-07-24
Reviewing: `2026-07-24-ci-performance-tests-design.md`

## Verdict

Approve with changes, but one of those changes is load-bearing: the ratio check
is less CI-robust than the spec claims, and the fix (interleave the sampling)
needs to be in the design before the plan, not discovered during calibration.
Everything else is small — a few wrong entry points, a self-contradiction
between the prose and the harness signature, and some under-specified operational
edges. The overall shape — relative-not-absolute, informational-first, library-level
measurement — is right.

## What I verified against the code

- **The motivating bug is real and described accurately.** Commit `2250838e2`
  ("perf(linter): make offset->line/col O(log n) via a per-pass newline index")
  says exactly what the spec says: `locFromOffsets` scanned from byte 0 on every
  call, AL0002 emits one finding per exported function, so the pass was O(n²); a
  433 KB / 4000-export file went from ~1235 ms to ~13 ms. The 15.6× ratio is a
  faithful retelling. ✅
- **The vitest-precedent claim holds.** `vitest.integration.config.ts` exists and
  is exactly the "separate config + own include + `test:integration` script"
  pattern the spec proposes to mirror. The default `vitest.config.ts` excludes
  `tests/`, so a new `*.perf.test.ts` exclude is the right lever. ✅
- **The CI structure matches.** `.github/workflows/test.yml` has `build` (node
  22.x/23.x matrix), `integration`, and the fan-out the spec describes. A new
  single-version `perf` job alongside them fits. ✅
- **Two entry points are named wrong** (fix before the plan):
  - **fmt** is `formatSource(source, config)` in **`lib/formatter.ts`**, not
    `format(...)` in `lib/cli/commands.ts`. (There is no `format` export in
    `commands.ts`.)
  - The **validation revert target** is not `locFromOffsets`. The fix lives in
    `buildLineIndex` + the indexed path in **`lib/linter/rules/util.ts`**;
    `locFromOffsets` now delegates to it. Also worth knowing: `util.test.ts`
    already pins the indexed path byte-for-byte against the linear scan, so part of
    the canary the spec wants to build already exists — reference it.
  - The others I spot-checked are right: `parseAgency` (`lib/parser.ts`),
    `buildCompilationUnit` (`lib/compilationUnit.ts:192`), `typeCheck`
    (`lib/typeChecker/index.ts:519`), `lintSource` (`lib/linter/registry.ts`),
    `runDiagnostics` (`lib/lsp/diagnostics.ts:78`), `getCodeActions`
    (`lib/lsp/codeAction.ts:57`).

## The one that matters: the ratio is not as noise-proof as claimed

The spec's core claim is: "Because it is a ratio of two measurements on the same
machine in the same run, the machine's absolute speed divides out — this is what
makes it CI-robust." That is only half true, and the false half is the dangerous
one.

The ratio cancels out **steady-state** speed differences between machines: a
runner that is uniformly 2× slower produces the same ratio. Good. But the actual
source of CI flakiness is **not** a uniformly slow machine — it is a
noisy-neighbor VM whose contention **varies second-to-second within a single
run**. If `time(N)` is sampled during a quiet moment and `time(4N)` during a
contention spike (or vice versa), the ratio inflates or deflates for reasons that
have nothing to do with your algorithm. Dividing two independently-noisy numbers
produces a result *noisier* than either input, not cleaner. So the ratio is
robust to the thing that rarely varies (machine class) and exposed to the thing
that constantly varies (intra-run contention).

This is fixable, and the fix should be in the harness design:

- **Interleave the samples.** Instead of "measure N seven times, then measure 4N
  seven times," alternate: N, 4N, N, 4N, … Contention then hits both sizes
  roughly equally and largely cancels in the per-pair ratio. `scalingRatio` as
  specified (median of all-N then median of all-4N) does *not* do this. This is
  the single most important change.
- **Widen the size step.** A 4× input step gives a signal-to-noise margin of ~4×
  against a bound of 6 — thin. An 8× or 16× step makes a genuine O(n²) stick out
  far past any plausible noise (64× / 256×) and lets you keep the bound loose
  without missing sub-quadratic regressions.
- **Report the pair spread, not just the median ratio,** during the
  informational period, so calibration sees the actual variance rather than a
  point estimate.

Without interleaving, I'd expect this suite to be flakier than the spec predicts
the moment it gates — which is exactly the outcome ("a flaky red check everyone
ignores") the spec is trying to avoid.

## Second: the prose says three sizes, the API does two

Layer 1 prose says "Run a command at input sizes N, 2N, 4N," but
`scalingRatio(build, small, large)` takes **two** points and returns one ratio.
Two points cannot distinguish O(n²) from O(n log n) from a linear algorithm with
a constant-factor cliff; they only bound the growth over one interval. Three-plus
points let you check that the ratio is *stable* across intervals (curvature),
which is a much stronger quadratic detector. Either:

- lift the harness to N, 2N, 4N (, 8N) and assert successive ratios are each
  under bound, or
- keep two points but be honest in the prose that it is a two-point growth bound,
  and pick a wide step (see above) so two points suffice.

Right now the doc contradicts itself, and the weaker option is the one that got
written into the type signature.

## Third: memory-hierarchy effects cap how tight the bound can be

A truly linear algorithm does **not** produce ratio ≈ 4 at large N. As the 4N
input falls out of L2/L3 cache and drives more GC, per-unit cost rises — memory
bandwidth and allocation are real superlinear-ish factors independent of
algorithmic complexity. This is a legitimate reason the bound must stay loose,
and it argues for **keeping fixture sizes in a sane memory regime** (don't push N
so high that a linear pass looks quadratic because it blew the cache). The spec
should name this as a constraint on fixture sizing, and it strengthens the case
for starting the bound at 8 rather than 6 (open question 1).

## Operational gaps

- **Calibration needs cross-run aggregation, which "step-summary-only" doesn't
  give you.** The flip depends on reading "observed p95 ratio across many runs,
  different runners." Step summaries are per-run and ephemeral — there is no way
  to compute a p95 across 30 runs from them without hand-scraping. So open
  questions 2 and 4 are coupled: to calibrate at all you need the informational
  data *aggregated*. Recommend uploading a small stable-named **artifact** (one
  JSON line per measurement) during the informational period, even if you keep
  the step-summary table for humans. This is my one real disagreement with the
  spec's stated lean (step-summary-only for v1) — it makes the v1 calibration
  goal reachable rather than manual.
- **The perf job's own wall-clock is unbounded.** 9 executions per size (2 warmup
  + 7) × multiple sizes × multiple fixtures × ~10 command areas, where a single
  4N execution can be a full compile of a large synthesized file. That can run
  into many minutes on every PR, even informational. Please put a rough
  time-budget and a **max N** in the design, and confirm the job stays under
  something like 5–10 minutes. A slow perf job taxes everyone whether or not it
  gates.
- **Does the job need `make`?** The library-level tests run from source through
  the `@`→`lib` vitest alias, so parse/compile/typecheck/lint/fmt don't need a
  build. Only the CLI cold-start smoke (`node dist/scripts/agency.js`) and,
  arguably, the stdlib-compile smoke need artifacts on disk. Worth a sentence on
  what actually requires `make` so the job isn't paying a full build for tests
  that don't use it.

## Smaller notes

- **Altitude check on rolling your own harness.** vitest ships a `bench`
  API (tinybench). I looked and I agree with building the small custom harness
  anyway — `bench` is mean-based, comparison-oriented, and gives you no clean
  hook for a ratio assertion or the `PERF_ENFORCE` gate. Just say in the doc that
  `bench` was considered and rejected for those reasons, so it reads as a
  conscious choice.
- **Compile is measured end-to-end but not per-stage.** The whole lesson of the
  motivating bug is that per-rule isolation surfaced what an all-rules average
  buried. The same logic applies inside the compile pipeline: a quadratic
  preprocess or generate stage would hide inside "compile got 1.5× slower." The
  spec isolates parse and typecheck (good) but leaves preprocess and TS-generation
  folded into the end-to-end number. Consider isolating each major pipeline stage
  the way lint is per-rule — it is the same principle you already learned.
- **The flip is reversible; say so.** Removing `continue-on-error` and setting
  `PERF_ENFORCE=1` can be undone in one line if a new runner class starts
  tripping bounds. Stating that lowers the stakes of flipping and makes it easier
  to flip sooner.
- **Interaction with the `test.yml` `concurrency` cancel-in-progress.** The
  workflow cancels in-progress runs on new pushes. Fine for correctness, but it
  means a perf run can be killed mid-measurement, producing a partial step
  summary. Not a problem while informational; just don't read a truncated summary
  as a signal.

## Answers to the open questions

1. **Ratio bound.** Start at **8**, not 6. The ratio-of-noisy-numbers variance
   plus memory-hierarchy effects both push the linear baseline above the ideal 4,
   and 15.6× (the real bug) clears 8 easily. Tighten from data if the observed
   p95 is comfortably low. Starting tight and loosening trains people to ignore
   red; starting loose and tightening builds trust.
2. **How long informational.** A fixed **count of runs across runner classes**
   (~30, spanning both `push` and PR events) beats a calendar window — but only
   works if the data is aggregated (see operational gaps). Two weeks of runs that
   you can't aggregate teaches you nothing.
3. **Node version.** 22.x LTS. Agree with the spec's lean; the stable reference
   is the right call and matrixing perf adds noise for no signal.
4. **Trend destination.** **Artifact plus step summary**, not step-summary-only —
   because the v1 calibration goal itself requires cross-run aggregation. This is
   the one place I'd override the spec's stated lean.

## Bottom line

The design is sound and the informational-first mechanism (`expectPerf` +
`PERF_ENFORCE` + `continue-on-error`) is a genuinely good way to de-risk the
flip. Before the plan: (1) interleave the sampling in `scalingRatio` and widen
the size step — this is the difference between a robust check and a flaky one;
(2) reconcile the two-point API with the three-point prose; (3) upload
informational data as an artifact so calibration is actually possible; (4) fix
the two entry-point names. The rest can be absorbed in the plan.

---

# Second-pass review (reconciliation) — 2026-07-24

I verified the review above against the code and agree with its substance — the
interleaving point especially is correct and load-bearing, and per-stage compile
isolation, the calibration-artifact, bound-of-8, and node-22 calls are all right.
Two things to correct, and one issue **both** the spec and the review above
missed that matters more than anything either flagged.

## The big miss: caches poison the compile and build measurements

There is a **process-wide parse cache** — `parseAgencyFileCached`
(`lib/parseCache.ts`, "Process-wide cache of successful `.agency` file parses,"
returns a `structuredClone` on read) — consumed by the compile path
(`lib/compiler/buildSession.ts:52`, `compileClosure.ts:23`). On top of it, the
build **manifest** decides whether to compile a file at all
(`buildManifest.ts`). Neither the spec nor the review accounts for this, and it
breaks the two measurements most people would trust:

- **`compile` end-to-end**, measured the way the spec lists it (through the real
  pipeline), warm-up run 1 populates the cache and the manifest; runs 2–7 (the
  ones we actually time, median-of-7) hit the cache and/or skip via the manifest.
  The number is then *cache-hit-parse*, not compile, and the N-vs-4N ratio is
  meaningless because both sides are cached. A genuine O(n²) in preprocess or
  codegen could be fully invisible.
- **Incremental build** (the "cold vs warm" test) *is* the cache — fine — but it
  means that test cannot share a process or a temp dir with the others without
  contaminating them.

Precisely scoped, so the plan doesn't over-react: the cache lives on the
**file-level** wrapper. The primitive calls the other tests use — `parseAgency`
on a string, `typeCheck`, `lintSource`, `formatSource` — do **not** consult
`parseAgencyFileCached` (I checked: `lib/parser.ts`'s string path reads no cache;
it only clears its own per-call memo). So parse/typecheck/lint/fmt scaling tests
are clean as designed. Only **compile-via-pipeline** and **incremental-build** are
exposed.

The harness must neutralize the cache for those two, and there is a ready lever:
`evictParseCache(absPath)` is exported for exactly this. Options, in order:
call `evictParseCache` (and reset the manifest) before every timed run; or give
each run a **unique synthesized path+content** so the cache key never repeats
(this also keeps input size controlled). The spec should state which, and add a
harness rule: *a perf test that re-measures the same input must prove the code
path under test is cache-free, or evict between runs.* This is the same class of
mistake as the original bug — measuring the wrong thing and trusting the number.

## Correction to the review above: `format` is not a wrong entry point

The review says fmt "is `formatSource` in `lib/formatter.ts`, not `format(...)`
in `lib/cli/commands.ts` … there is no `format` export in `commands.ts`." That is
not right: `format(source, config)` **is** exported at
`lib/cli/commands.ts:296` (async, and it is what the CLI action calls at
`:321`). So the spec's reference is valid, not a wrong name.

That said, the review's *recommendation* lands: `formatSource`
(`lib/formatter.ts:9`) is the better perf target because it is the **synchronous,
pure** core (`string | null`), while `format` wraps it in a promise. Measuring
`formatSource` avoids async-scheduling jitter in the sample. So: use
`formatSource`, but because it is the cleaner measurement, not because `format`
doesn't exist. (The `locFromOffsets`/`buildLineIndex` and other entry-point
notes in the review are correct.)

## Sharpening the interleaving fix — it is an API change, not a tweak

I agree interleaving is the single most important correction. But note it cannot
be bolted onto `scalingRatio(build, small, large)` as written: interleaving
requires holding the closures for *both* sizes and alternating them, then taking
the **median of the per-pair ratios** `t_i(4N)/t_i(N)`, not the ratio of two
independently-taken medians. So the harness signature has to change to something
like `scalingRatio(build, sizes: number[], { pairs })` that owns the interleaved
schedule internally. That also resolves the review's two-point-vs-three-point
contradiction in one move: pass `[N, 2N, 4N]`, interleave across all of them, and
assert each successive per-pair ratio is under bound. Fold both corrections into
one harness redesign rather than patching them separately.

## One operational add beyond the review

The **incremental-build** perf test is operationally the hardest one in the
suite and the spec treats it as a peer of the others. It needs a real on-disk
`dist/` (so the job *does* need `make` for this test, answering the review's
"does it need make" partly: yes, for this one and the cold-start smoke), a
**temp working directory**, and a **manifest reset** between the cold and warm
legs — and it must be isolated from every other test's process-wide cache state.
Recommend it live in its own `*.perf.test.ts` with its own setup/teardown, and
that the plan budget extra time for it. It is the test most likely to be flaky for
reasons unrelated to the code under measurement.

## Net

The review above is strong and I'd act on all four of its "before the plan"
items. Add a fifth, above them in priority: **neutralize the parse cache and
build manifest for the compile and incremental-build measurements** (evict or
unique-path per run), or those two tests measure caching, not compilation. And
fold the interleaving + two-vs-three-point fixes into a single harness-signature
redesign rather than two patches. The `format`-is-missing claim is the one factual
correction to walk back.
