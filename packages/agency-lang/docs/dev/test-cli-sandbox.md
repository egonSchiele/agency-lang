# Running tests and programs under a policy and an Agency-only closure

`agency test run` and `agency run` share three flags that, together, let the
harness run code it does not trust: an agent's solution in an eval, or any
`.agency` file someone else wrote.

| Flag | What it guarantees | Where it lives |
|---|---|---|
| `--policy <name\|path>`, `--approve <effects>`, `--reject <effects>` | A root interrupt handler the caller chose, installed before the entry node's body runs. A reject from it wins over the tested code's own `with approve`. | `lib/cli/testChildEnv.ts` (test runner), `lib/cli/commands.ts` (`run`); the runtime installs it in `lib/runtime/node.ts` (`installRunPolicyHandler`) from `AGENCY_RUN_POLICY` |
| `--max-cost <dollars>`, `--max-time <duration>` | The root budget, per process (so per test case). `llm()` is not an interrupt; this is what bounds it. | same files; `AGENCY_MAX_COST` / `AGENCY_MAX_TIME`, `installRootBudget` |
| `--agency-only` | The import closure is Agency source plus `std::` and nothing else: no TypeScript/JavaScript, Node built-ins, `pkg::` packages, compile-time splices, absolute imports, or symlinks. Compiled from a private mirror of the validated bytes. | `lib/cli/agencyOnlyCompile.ts` over `lib/compiler/compileSandboxed.ts` (#878) |
| `--json` (test only) | Exactly one JSON document on stdout (`lib/cli/testReport.ts`, version 1); every human line on stderr (`lib/cli/testOutput.ts`). | `lib/cli/test.ts` |

`--reject '*'` is a reject-everything policy: the policy's catch-all key is
the literal `"*"` (`lib/runtime/policy.ts`), and `--reject` writes a rule
under each name it is given.

## Why the two flags together are the safety argument

- With `--agency-only`, every effect the code can perform is an interrupt.
  There is no other way to touch the world from pure Agency.
- With `--reject '*'`, the root handler rejects each of those interrupts.
  The handler chain resolves reject over approve (`lib/runtime/interrupts.ts`,
  "reject > propagate > approve > noResponse"; pinned by
  `tests/agency/connector-core.agency`), so an inline `with approve` in the
  tested code is a vote that loses.
- Code that runs before the handler exists (static initializers, top-level
  callbacks) cannot raise an interrupt at all: there is no node frame to
  checkpoint, and the runtime throws "Cannot create checkpoint: no current
  node id". An effectful initializer fails rather than runs.
- A `std::run` subprocess the tested code launches forwards its interrupts
  to this root chain and installs no policy of its own.
- What is not covered: CPU inside the time limit, and reads of files the
  scratch directory already contains.

## Environment discipline

Both carriers are internal: the four variables (`AGENCY_RUN_POLICY`,
`AGENCY_RUN_POLICY_INTERACTIVE`, `AGENCY_MAX_COST`, `AGENCY_MAX_TIME`) are
deleted from the child's inherited environment and set again only from this
invocation's flags (`testChildEnv`, the same clear-then-set rule `run` uses).
A test run's behavior is decided by its own command line, never by an outer
`agency run --policy` that happened to spawn it.

## Two things that are easy to get wrong

- The flags go after `agency test run`, not after `agency test`:
  `agency test run --reject '*' x.test.json`. The parser refuses
  `agency test --reject …` (as it already refused `--shard` there).
- Under `--agency-only` a refusal is a **file failure**, not a process exit:
  the file's cases are reported failed with the diagnostics, the suite goes
  on, and the exit code is 1 at the end. "The agent's code does not compile"
  is an ordinary grading outcome.

Tests: `tests/agency-js/test-cli-policy`, `test-cli-agency-only`,
`test-cli-json` (each with a positive control), and the unit suites beside
each file.
