# std::agency test()/testFile()

The spec and its review history live in
`docs/superpowers/specs/2026-08-20-std-agency-test-design.md`. This page maps
the code and the rules that are easy to get wrong.

## What this is

`test()` runs agency tests the way `run()` runs a node: each case executes in
the sandboxed subprocess, and every interrupt the tested code raises — plus
the per-case `std::run` launch itself — is voted on by the caller's handlers.
Any reject wins, so a parent that rejects everything vetoes every effect,
including the tested code's own inline `with approve`. `testFile()` is the
portable form: it runs the same `.test.json` file `agency test` runs,
restricted to the sandbox subset.

The public API is `test`, `testFile`, and the types they use
(`AgencyTestCase`, `InterruptAnswer`, `CaseReport`, `TestReport`) in
`stdlib/agency.agency`. `_testFileForGrading` is
framework-only stdlib ABI (the eval grader wrapper adds a whole-call cost cap). Everything under
`lib/compiler/closureValidator.ts` and `compileValidatedClosure.ts` is
compiler-private. `snapshotValidatedClosureForTest` is a test seam.

## The sandboxed compile (closure validator + mirror)

The safety invariant: the compile closure contains only Agency source and
`std::` imports. `validateClosure` (`lib/compiler/closureValidator.ts`) walks
the raw import graph and refuses, listing every violation:

- TypeScript/JavaScript files and node builtins (`fs`, `child_process`) —
  the one thing that would break the interrupt-gating guarantee;
- local imports escaping the sandbox `dir` (realpath containment via
  `isStrictDescendant`, symlink targets included; a symlink alias resolving
  INSIDE dir is valid);
- `pkg::` packages whose own Agency closure reaches either, walked under the
  package's own root;
- compile-time splices, anywhere — BEFORE anything could expand them.
  Splice generators execute in the compiling process, outside the sandbox,
  so untrusted code gets no compile-time execution hook. The tests observe
  this through a call-through mock of `runGenerator` (generators are
  effect-blocked, so a sentinel file cannot exist).

`compileValidatedClosure` then compiles from a private 0700 mirror of the
VALIDATED bytes, with each local import's path rewritten (at its
parser-recorded location, `modulePathLoc`) to the mirrored target. That is
the TOCTOU boundary: a file or symlink swapped after validation is never
re-read, because compilation never touches the caller's directory again.
`pkg::` files are the one documented re-read boundary — node_modules is
already-trusted executable content. Multi-file closures carry every
non-entry module's compiled JS in the `CompiledProgram` value (`modules`),
which `materializeCompiledScript` lays out beside the entry script at fork
time; without that, the entry's rewritten `./helper.js` import would
resolve to nothing.

The same rules serve `compile(source, dir)`, `runCode(..., dir)`, and
`runFile`. `dir` is compile-only (import anchor + boundary); `runCode`'s
`cwd` is execution-only. Empty `dir` means local imports cannot resolve.

## test() execution

One compile per call, cases sequential, each in its own `run()` subprocess.
A case's scripted `interrupts` answers are consumed in order by a handler
wrapped closest around the case: one vote each, so a parent reject always
wins. Exhausted answers stay silent (the interrupt propagates outward);
leftover answers fail the case; an `expectedMessage` mismatch fails the
case. `maxCost` guards the whole call with the same `guard(cost:)` pattern
and `limit_exceeded` shape as `run()`.

The verdict is the shared structural comparison in
`lib/testFormat/verdict.ts` — the same helper the `agency test` CLI runner
now uses, so a case cannot pass under one runner and fail under the other.
A tested node RETURNING a failure is unwrapped in Agency before the TS
verdict seam (failure propagation forbids handing tagged failures to TS).

Known semantics wart, surfaced during this work: within one process's
handler chain, a valueless outer `approve()` OVERWRITES an inner approval's
value (`DEFAULT_MERGE` in `lib/runtime/effectMerge.ts`; only the IPC merge
defers). A scripted `approve(value)` therefore only delivers its value when
no outer handler also blanket-approves. The fixtures in
`tests/agency/agency-test-fn.agency` use a silent-except-`std::run` parent
for exactly this reason.

## testFile() and the shared format

`lib/testFormat/schema.ts` owns the `.test.json` format in two profiles:
FULL (everything the CLI runner supports, now validated) and SANDBOX (the
subset that makes sense inside the sandbox; out-of-subset fields are
refused BY NAME, `evaluationCriteria` must be exactly one `exact`, and
`expectedOutput` parses to a value at parse time). `inputArgs.ts` converts a
case's `input` string with the language parser (literals only) and binds it
through `planArgumentBindings` — the decision extracted from
`AgencyFunction.resolvePositional`, so the converter cannot drift from real
calls.

`testFile` gates BEFORE every read, the `typecheckFile` idiom: a
`std::read` interrupt for the JSON, then the TS read+parse; a `std::read`
for the declared source, then ONE read builds the node binding table; every
case binds up front. A bad case is a whole-call failure with zero launches.

## Convergence with the CLI runner

Shared, single-owner: the `.test.json` parser (both `lib/cli/test.ts` and
`lib/cli/precompile.ts` consume `parseTestFileFull`, including `sourceFile`
resolution) and the exact verdict (the full profile keeps a raw-string
fallback for expectedOutput that is not JSON; the sandbox profile refuses
those files). Execution deliberately stays split by trust posture:
`agency test` runs YOUR code with authoritative scripted answers; `test()`
runs someone else's under the handler chain.
