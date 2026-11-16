# Test suite audit

Date: 2026-11-15. Timings come from CI run 43797201141, the latest green run on main at commit `c5ee2b6ec`, unless a line says "local".

This document answers two questions: which tests to remove, and which tests to add. The first section lists what this PR changed. The rest records the evidence and the open suggestions.

A claim marked "measured" or "checked" was confirmed against the code or a timing. A claim marked "estimate" was not measured.

## What this PR changes

### Faster tests, same coverage

| Change | Before | After |
|---|---|---|
| `lib/cli/statelog/projectClient.test.ts` and `accountClient.test.ts`: the 503 tests use fake timers instead of sleeping through the retry waits of 0.5, 2 and 8 s | 10.5 s per file in CI | 18 ms and 13 ms (local) |
| `lib/cli/runBundledAgent.test.ts`: the agent's import walk is replaced by the entry file alone. The code identity is still hashed and merged by the real code | 30 s in CI, 11.2 s local | 24 ms (local) |
| `tests/agency/agents/toolkits` and `toolGaps`: 15 checks each, now one case per file. Each case loads every agent module, and the cases in one file run one after another (`lib/cli/test.ts`) | 15 cases at 12 to 14 s each per file in CI (two measured, the rest estimated) | 1.6 s per file (local) |
| `lib/cli/effects.spawn.test.ts`: five cases now call `effectsCmd` in-process in `effects.test.ts`. One case still runs the built CLI | 6 CLI runs, 10.4 s in CI | 1 CLI run |
| `lib/cli/workflow/workflow.spawn.test.ts`: two cases that fail before the driver runs were removed (bad `--inputs`, a path outside `workflows/`; both covered by `commands.test.ts` and `locate.test.ts`), and the `--log-file` case was folded into the approve run | 21 CLI runs | 18 CLI runs |
| `lib/stdlib/stdlibModules.test.ts`: removed "matches the stdlib folder". The `node-build` CI job runs `make` and fails on any diff to `stdlibModules.data.ts` | One parse of the whole stdlib | None |

### Duplicate and dead tests removed

Each item was checked against the test it repeats.

| Removed | Covered by |
|---|---|
| `expandSplices.test.ts`: "off by default", two splices, kind mismatch, not imported, generated export | `expandSplices.test.ts:130`, and `tests/agency/splices/{twoSplices, refuseKindMismatch, refuseNotImported, refuseExport}`, which compile and run the same cases |
| `runGenerator.test.ts`: "still gives the child enough to run" | "brings back an expression fragment", which runs the child with the same environment |
| `rebuild.test.ts`: "same output warm as cold" | Folded into the cache test, which already expands three times |
| `typescriptBuilder.integration.test.ts`: three "named arguments compile" cases (correct, reordered, with a block) | `tests/agency/namedArgs`, `namedArgsReorder`, `named-arg-with-trailing-block` |
| `literals.test.ts`: "parses a decimal", "parses a negative number", "rejects a run with no digits" | The `numberParser` table in the same file |
| `tests/agency/fork/fork-multi-interrupt` | `tests/agency-js/fork/fork-parallel-interrupts`: the same program, plus checks on the count, ids, checkpoint and messages |
| `tests/agency/fork/edge-cases/fork-empty` | `tests/agency/race-empty`, which checks `fork([])` |
| `tests/agency/stdlib/setenv-roundtrip` | `tests/agency/env-interrupt`, which does the same round trip and also checks the effects raised |
| `tests/agency/stdlib/gitignore-search`: 5 of 9 cases (folder named as the root, folder named in the pattern, plain `ls`, `ls` and `grep` on a named folder) | `lib/stdlib/shell.test.ts`. The 4 cases kept check the Agency wrappers' default and the `respectGitignore` option |
| `tests/agency/validation/bangParams`, `bangParamsFail`, `bangParamsMultipleCalls` | `tests/agency/validation/bangMultipleParams` |
| `tests/integration/cli-main`: `pack` standalone and `pack` with imports, `trace log`, `fmt` run twice and stdout mode, full coverage and `coverage clean`, `bundle` and `unbundle`, single-file `doc`; plus the fixtures only they used | The pull-request suites `cli-tier2` and `cli-lang`. `cli-main` keeps one `fmt` case (the alias of `format`) and the bare `trace <file>` case (the default subcommand), since nothing else checks those forms |
| `tests/typecheck/redact-custom-label.agency` | Nothing referred to it |
| `test:agency` scripts in `packages/email` and `packages/mcp` | They pointed at `tests/agency` folders that do not exist |

`docs/dev/runtime/concurrent-interrupts.md` named `fork-multi-interrupt`, so it now names `fork-parallel-interrupts`.

### Examined and kept

A reviewer suggested each of these. Checking showed each one tests something nothing else does.

- **`tests/agency/handlers/handle-nested`.** It is the only test of nested handlers written as named functions, and of a named handler that passes. `handle-function-ref` covers named handlers only one level deep.
- **`lib/cli/resume.spawn.test.ts:454`.** It is the only end-to-end check that the default mode refuses changed code. The fingerprints come from compilation, which differs under `--agency-only`.
- **`lib/compiler/platform.spawn.test.ts`.** "Node is the default" is the only check of the CLI default.
- **`lib/cli/validatorInterrupts.spawn.test.ts`.** Three of its cases pin known bugs and will be flipped one at a time.
- **`lib/cli/spawn.spawn.test.ts:155` and `:184`.** One drives the raw socket and checks the question is held until it is answered. The other drives the `agency attach` client.
- **`workflow.spawn` `compile`, `list` and `--json`.** The in-process tests use a fake driver, so these are the only checks of the real one.
- **`tests/agency-js/parallel-tools-no-ids-resume` and `parallel-tools-resume-messages-intact`.** They are regression tests for two different bugs, with different checks.
- **`tests/agency/stdlib/ls-missing`.** It checks that the wrapper turns an error into a failed Result.
- **`tests/agency/match.agency`.** It is the only test of a statement-form `match` whose arms assign.
- **`tests/agency/interrupts/interrupt` case `foo`.** It also checks the interrupt's message.
- **`tests/agency-js/interrupts/interrupt-respond-mismatch`.** It checks the `respondToInterrupts` that compiled code exports. The unit test checks the validator directly.
- **`tests/agency/validation/bangParamsMessage`.** It checks the message end to end, from codegen through the runtime.

### Not done in this PR

- **Skipped tests.** Left for later, as decided.
- **Snapshots.** Unchanged, as decided. That includes `tests/typescriptBuilder` and `typeOperators.mjs`.
- **Merging the six files that each parse the test corpus.** Measured locally, parsing the whole corpus takes about 8.6 s:

  | Part | Files | Parse time |
  |---|---|---|
  | stdlib | 113 | 2.4 s |
  | tests/agency | 1,314 | 4.5 s |
  | lib/agents | 125 | 1.5 s |
  | tests/typescriptGenerator | 104 | 0.15 s |

  Most of their time is their own work: lowering, typechecking, generating code and linting. Merging them would save little, and it would turn six files that run in parallel into one. The earlier estimate of 40 to 60 s was wrong. The same applies to merging `stdlibRaises`, `stdlibCapabilities` and `agencySourcesClean`.
- **Moving `expandSplices` fragment checks in-process.** That would mean exporting private compiler functions only for tests.
- **Packing the safeBash planning cases.** `tests/agency/safeBash.test.json` has 135 cases that run one after another in their shard. That shard is not the slowest one, so packing them would not shorten CI, and it means rewriting a large security test.
- **Assigning Agency test shards by measured time.** It needs a time for every file, which CI does not record (the runner prints only the 10 slowest cases per shard). It also changes how `agency test --shard` works. This needs a decision.
- **`commentConservation`'s corpus check.** It may be covered by the round-trip test, but it uses a different entry point (`formatSource` against `generateAgency`), so I did not remove it.

## Decisions still open

1. Should retry-from-failure (`restore(result.checkpoint, ...)`) be fixed or removed? Its four tests have been skipped since 2026-06-04, and the feature still ships.
2. Should `make` fail on stdlib type errors (#1468)? If it does, the 31 s that `fixtureTypeCheck` spends on the stdlib can go.
3. Should the Agency test shards be assigned by measured time (see above)?

## Background: where CI time goes

### Unit tests (vitest)

There are 1,201 files with 19,122 tests and about 1,176 s of test time, split over 3 shards of 3.5 to 4.7 minutes each (measured).

- 46 files take 895 of the 1,176 s, which is 76% (measured).
- The 931 files that each run in under 200 ms take 32 s combined (measured).
- `lib/cli` takes 512 s (measured), mostly in tests that start the CLI as a process.
- `lib/parsers` runs 2,314 tests in 5.5 s (measured).

Deleting small unit tests saves upkeep, not CI time.

### Agency execution tests

There are 1,207 `.test.json` files with 2,424 cases, plus 230 agency-js tests, on 8 shards (counted).

- Every case runs in its own `node` process (`lib/cli/util.ts:329`).
- Files in a shard run in parallel, and the cases inside one file run one after another (`lib/cli/test.ts`). So a file with many slow cases can set its shard's length. `toolkits` and `toolGaps` were two such files.
- The test step took between 1m45s and 4m41s per shard (measured).
- The slowest cases are in `toolbox/`, `subprocess/` and `agents/`, at 30 to 46 s each (measured from CI's "Slowest 10" lists).

## Question 1: tests to remove

The removals are in the tables above. Four skipped tests remain, left for a later PR:

- `tests/agency/result/result-{extended,restore-globals,retry-new-args,retry}`: skipped since 2026-06-04. The feature still ships (`restore()` at `lib/typeChecker/builtins.ts:405`; `checkpoint` on failures at `lib/runtime/result.ts:77`). This is decision 1.
- `tests/agency/function-refs/functionRef-object-interrupt`: skipped as "not yet supported". A reviewer noticed the compiled code now handles the call, so it may pass. Not checked.
- `tests/agency/hosted-tools/web-search`, case `searchEnabled`: flaky live search, skipped since 2026-07-20.
- `lib/lsp/semanticTokens.test.ts:307`: skipped since 2026-09-20.
- `tests/integration/local-model/agent-flag.test.ts:12`: skipped since 2026-09-14 (issue #1054).

Generated-code snapshots: 92 commits since May each rewrote 50 or more of the 104 snapshots at once (counted). Those diffs show every change to the code every program compiles to, which is what the snapshots are for, so they stay as they are.

The parser tests are detailed (75 files, 2,314 tests), but they take 5.5 s in total. Trimming them would save upkeep only.

## Question 2: tests to add (for discussion)

### Core language features

Interrupts and handlers have deterministic tests that run on every pull request (checked):

| Rule | Test |
|---|---|
| Any rejection wins | `handlers/handle-nested-inline`; `lib/runtime/interrupts.test.ts:244-280` |
| Inner approves, outer rejects, so the call is rejected | `handlers/handle-nested.agency:30` |
| Propagate combined with reject | `handlers/handle-propagate.agency:53` |
| Handlers after a restore | `handle-survives-restore`, `handler-function-across-resume` |
| Approve and reject in parallel branches | `fork/fork-handler-mixed`, `async/reject-in-arm` |

Candidates to add:

- **LLM-graded tests that never run on pull requests (checked).** 27 files with about 30 cases are graded by an LLM judge. CI skips them on pull requests (`lib/cli/test.ts:1092-1100`) and runs them after merge. They include 10 cases of tool calls that interrupt in parallel (under `fork/` and `race/`) and 7 of the 16 thread tests. They could be rewritten with mocked tool calls, the way `tests/agency-js/tool-rejection` checks tool messages.
- **Tests that pass by echoing the mock (not checked).** A reviewer counted about 57 cases whose expected output equals the mock model's final reply. Fixing them needs a mock option that shows what the tools returned.
- **Interrupt edge cases (reviewer claims, not checked).**
  - Answering only part of a batch of interrupts.
  - Editing an interrupt's data before resuming.
  - Resuming into the middle of a `handle` block.

### Stdlib

- **Reject tests for risky functions (checked).** No test rejects `copy`, `move`, `remove`, `fetch` or the real `exec`. Such a test must only ever target a throwaway file inside a temp folder the test creates. If the reject were broken, `remove` would delete whatever it was pointed at: `allowedPaths` defaults to no restriction (`stdlib/fs.agency:206-212`). The existing `tests/agency-js/stdlib/std-fs-ops` shows the safe pattern: a fresh `mkdtempSync` folder.
- **Other raises with no test (not checked).** `registerProvider`, `memory.forget`, the github write functions, `sendEmail` and `sendSms`.
- **`lib/agents` is never typechecked in CI (checked).** It holds 125 Agency files.

### CLI commands with no end-to-end test

The CLI is never started as a process for these (checked):

- `agency agent`: never runs a full turn. Integration test 8e checks help, flag errors and config only.
- `agency run --interactive`: only the no-terminal fallback is tested (`lib/cli/wait.spawn.test.ts:242`).
- `agency serve http`: no interrupt and `/resume` round trip. The `remote` suite that had one is switched off (`.github/workflows/test.yml:507`). The `serve` suite takes 11 s in a group that finishes 78 s before the longest group (measured), so a round trip would not lengthen the job.
- `agency lsp`, `agency mcp`, `agency serve mcp`, `agency attach`, `agency debug`, `doctor`, `skills`, `policy gen`, `deploy`, `review`.
- `typecheck` and `interrupts` have thorough end-to-end tests only in `cli-main`, which runs after merge.
- Answering interrupts (`--policy`, `--approve`, `--reject`, `resume`) is tested only against the repo build, never the packed tarball.

## How to reproduce the numbers

```
gh run view 43797201141 --json jobs
gh api repos/{owner}/{repo}/actions/jobs/<job-id>/logs
```

- **Vitest file times** are on the `✓ <file> (N tests) <time>` lines of the `unit-tests` jobs.
- **The slowest Agency cases** are after "Slowest 10 tests" in the `agency-tests` jobs.
- **Stdlib coverage** is printed by the `coverage-report` job.
