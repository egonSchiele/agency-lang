# Running tests and programs under a policy and an Agency-only closure

`agency test run` and `agency run` share three flags that, together, let the
harness run code it does not trust: an agent's solution in an eval, or any
`.agency` file someone else wrote.

| Flag | What it guarantees | Where it lives |
|---|---|---|
| `--policy <name\|path>`, `--approve <effects>`, `--reject <effects>` | A root interrupt handler the caller chose, installed before the entry node's body runs. A reject from it wins over the tested code's own `with approve`. | `lib/cli/childEnv.ts` for every CLI spawner. `installRunPolicyHandler` in `lib/runtime/runPolicyHandler.ts` reads `AGENCY_RUN_POLICY`, and `lib/runtime/node.ts` calls it at the root. |
| `--max-cost <dollars>`, `--max-time <duration>` | The root budget, per process (so per test case). `llm()` is not an interrupt; this is what bounds it. | same files. `installRootBudget` in `lib/runtime/rootBudget.ts` reads `AGENCY_MAX_COST` and `AGENCY_MAX_TIME`. |
| `--agency-only` | The import closure is Agency source plus `std::` and nothing else: no TypeScript/JavaScript, Node built-ins, `pkg::` packages, compile-time splices, absolute imports, or symlinks. Compiled from a private mirror of the validated bytes and written beside the sources as `<name>.js`, like a normal compile. | `compileAgencyOnly` in `lib/compiler/compileSandboxed.ts`, over `validateClosure` in `lib/compiler/closureValidator.ts` |
| `--json` (test only) | Exactly one JSON document on stdout (`lib/cli/testReport.ts`, version 1); every human line on stderr (`lib/cli/testOutput.ts`). | `lib/cli/test.ts` |

`--reject '*'` is a reject-everything policy: the policy's catch-all key is
the literal `"*"` (`lib/runtime/policy.ts`), and `--reject` writes a rule
under each name it is given.

## Why the two flags together are the safety argument

> These flags reduce attack surface; they are **not yet a complete sandbox**.
> The bind-check is defense in depth (a runtime-computed property key slips
> past it), and the containment layers that close the remaining gaps are
> tracked in `docs/dev/security/roadmap.md` (A1). Do not treat `--agency-only`
> as sufficient to run fully untrusted code on its own yet.


- With `--agency-only`, every effect the code can perform is an interrupt,
  and the JS-globals bind-check refuses the compiled-to-JavaScript escapes
  that would otherwise bypass interrupts entirely (`process`, `fetch`,
  `eval`, `new Function`, the `.constructor` walk, tag arguments, default
  values). See `docs/dev/compiler/agency-only-bound-names.md`. That check is
  defense in depth, not the whole boundary: a runtime-computed property key
  gets through it, so the backstop for code-from-strings is layer 2 in
  `docs/dev/security/roadmap.md` (A1). There is no other way to touch the
  world from pure Agency once those hold.
- With `--reject '*'`, the root handler rejects each of those interrupts.
  The handler chain resolves reject over approve (`lib/runtime/interrupts.ts`,
  "reject > propagate > approve > noResponse"; pinned by
  `tests/agency/connector-core.agency`), so an inline `with approve` in the
  tested code is a vote that loses.
- Top-level code (static initializers, top-level callbacks) runs under the
  same root handler, which installs before any user code (#966,
  `initFreshExecCtx` in `lib/runtime/node.ts`). A top-level raise the chain
  does not settle fails instead of pausing: there is no node frame to
  checkpoint, and the runtime throws "Cannot create checkpoint: no current
  node id".
- A `std::run` subprocess the tested code launches forwards its interrupts
  to this root chain and installs no policy of its own.
- What is not covered: CPU inside the time limit, and reads of files the
  scratch directory already contains.

## Environment discipline

The policy and budget reach the child as env vars (`AGENCY_RUN_POLICY`,
`AGENCY_RUN_POLICY_INTERACTIVE`, `AGENCY_MAX_COST`, `AGENCY_MAX_TIME`),
read by `installRunPolicyHandler` and `installRootBudget` in the runtime. One
function writes them: `withRootCarriers` in `lib/cli/childEnv.ts`, used by
`agency run`, `agency agent`, and the test runner. It deletes all four from
the inherited environment and sets only what this invocation's flags
resolved, so a child's behavior never comes from a parent shell or an outer
`agency run --policy`.

## Things that are easy to get wrong

- The flags go after `agency test run`, not after `agency test`:
  `agency test run --reject '*' x.test.json`. `run` is the default
  subcommand and owns these options, so the parser refuses
  `agency test --reject …`, the same way it already refused `--shard` there.
- Under `--agency-only` a refusal is a **file failure**, not a process exit:
  the file's cases are reported failed with the diagnostics, the suite goes
  on, and the command exits 1 at the end. "The agent's code does not compile"
  is an ordinary grading outcome. The exit code follows `filesFailed` as
  well as `failed`, so a refused file that declared no cases still fails
  the command.
- Without `--agency-only`, sources are compiled by the shared precompile
  pass (`lib/cli/precompile.ts`), which goes through `BuildSession` and
  calls `process.exit(1)` on a parse or type error. Under `--json` that
  means **no document at all**: exit 1, diagnostics on stderr, empty
  stdout. A consumer must treat a missing document as a failure, and the
  eval grader does. The document is only guaranteed for invocations that
  reach the run phase. Lifting this needs a non-exiting `BuildSession`, which is
  a separate change.
- `--json` refuses `--coverage` unless `--collect-only` is also given: the
  coverage report prints to stdout, which `--json` reserves for the document.
- A suite abort keeps every file and case in the document. Ctrl+C and the
  30-minute suite ceiling are both aborts. Files that never started are `aborted` with no cases,
  unrun cases in the interrupted file are `aborted`, and an aborted file
  counts in `filesFailed`, so the command exits 1.

Tests: `tests/agency-js/test-cli-policy`, `test-cli-agency-only`,
`test-cli-json`, each with a positive control, plus the unit suites beside
each file.
