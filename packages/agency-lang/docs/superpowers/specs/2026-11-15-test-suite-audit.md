# Test suite audit

Date: 2026-11-15. The numbers come from CI run 43797201141, the latest green run on main, at commit `c5ee2b6ec`.

This document answers two questions: which tests should we remove, and which tests should we add. It starts with a summary of the suggested changes. The sections after that give the details and the evidence.

Every finding here was checked against the code. A finding marked "not verified" came from a reviewer and was not checked line by line.

## Summary of suggested changes

Effort means: **small** is under half a day, **medium** is about a day, **large** is several days.

### Group 1: make CI faster without losing coverage

| # | Change | Effort | Impact | Confidence |
|---|---|---|---|---|
| S1 | Stop two statelog tests from sleeping through real retry delays | Small | About 21 s of unit-test time | High |
| S2 | Parse the test corpus once instead of in six separate files | Medium | 40 to 60 s of unit-test time | Cause verified, saving estimated |
| S3 | Check splice fragments in-process in `expandSplices.test.ts` | Medium | About 40 s of unit-test time | Cause verified, saving estimated |
| S4 | Pack cases that only inspect values into fewer cases (`toolkits`, `toolGaps`, safeBash planning) | Medium | About 7 CPU-minutes off the Agency shards | High for toolkits, medium for safeBash |
| S5 | Assign Agency test shards by measured time instead of by file name | Medium | 1 to 2 minutes off the CI critical path | Medium |
| S6 | Stop `runBundledAgent.test.ts` hashing the whole agent on every call | Small | About 25 s of unit-test time | Medium (not profiled) |
| S7 | Remove duplicate cases from the tests that start the CLI as a process | Medium | 60 to 80 s of unit-test time | Medium-high |
| S8 | Remove the stdlib module-table check that CI already runs another way, and share one stdlib parse between three meta-tests | Small to medium | 25 to 35 s of unit-test time | Medium-high |

The unit tests run on 3 shards, so the wall-clock saving is about a third of the unit-test time saved. Together, S1 to S8 should take 2 to 3 minutes off each unit-test shard and 1 to 2 minutes off the Agency test critical path.

### Group 2: remove dead and duplicate tests

| # | Change | Effort | Impact | Confidence |
|---|---|---|---|---|
| R1 | Resolve the skipped tests (turn each into a ticket or fix it) | Small | Less confusion; CI time unchanged | High |
| R2 | Delete orphaned fixtures and test scripts that point at nothing | Small | Less clutter | High |
| R3 | Delete or merge tests that repeat another test | Small | A few seconds; less upkeep | High |
| R4 | Stop the generated-code snapshots from being rewritten on every compiler change, and delete the ones that repeat execution tests | Medium | Far fewer mass rewrites (92 commits since May each rewrote 50+ snapshots) | Medium; needs your decision |
| R5 | Remove the `cli-main` cases that repeat the pull-request suites | Small | Less upkeep; no PR time saved | High |

### Group 3: add missing tests

| # | Change | Effort | Impact | Confidence the gap is real |
|---|---|---|---|---|
| A1 | Rewrite the 27 LLM-graded test files with mocks so they run on pull requests | Medium to large | High: 10 parallel tool-call interrupt cases and 7 thread tests run only after merge today | High |
| A2 | Test answering the `agency run --interactive` prompt in a real terminal | Medium | High: this is how most users answer interrupts | High |
| A3 | Test that rejecting `copy`, `move`, `remove`, `fetch` and `exec` stops them | Small | High: these are the risky stdlib functions | High |
| A4 | Run one `agency agent` turn with the test LLM | Small to medium | High: most-used command, never run end to end | High |
| A5 | Test the interrupt round trip through `agency serve http` and `/resume` | Small to medium | High: the only suite that tested it is switched off | High |
| A6 | Move the thorough `typecheck` and `interrupts` CLI tests into a suite that runs on pull requests | Small | Medium: today a break is found only after merge | High |
| A7 | Test answering interrupts from the packed npm tarball | Medium | Medium | High |
| A8 | Start `agency lsp`, `agency mcp` and `agency serve mcp` as processes and do a handshake | Medium | Medium | High |
| A9 | Typecheck all of `lib/agents` in CI | Small to medium | Medium | High |
| A10 | Fix the tests whose expected output is just the mock model's reply | Medium to large | Medium | Not verified |
| A11 | Smaller interrupt edge cases (partial answers, edited interrupt data, resuming into the middle of a `handle` block) | Medium | Medium | Medium |
| A12 | Interrupt tests for other risky stdlib functions (`registerProvider`, `memory.forget`, github writes, email and SMS) | Small each | Medium | Not verified |

### Decisions only you can make

1. Should retry-from-failure (`restore(result.checkpoint, ...)`) be fixed or removed? Its four tests have been skipped since June.
2. What should happen to the generated-code snapshots (R4)?
3. Should `make` fail on stdlib type errors (#1468)? If it does, 31 s of `fixtureTypeCheck` can go.

## Background: where CI time goes

### Unit tests (vitest)

There are 1,201 files with 19,122 tests. Together they take about 1,176 seconds of test time, split over 3 shards. Each shard takes 3.5 to 4.7 minutes.

The time is concentrated in a few files:

- 46 files take 895 of the 1,176 seconds (76%).
- The 931 files that each run in under 200 ms take 32 seconds combined.
- `lib/cli` alone takes 512 seconds. The tests that start the CLI as a separate process are most of that.
- `lib/parsers` runs 2,314 tests in 5.5 seconds.

So deleting small unit tests saves almost no CI time. It only saves upkeep. The time goes to tests that start a process or compile real programs.

Starting the CLI as a process costs about 1.7 seconds for a trivial command, and 3.5 to 4 seconds for `agency run`, because `run` recompiles the program and starts a child process.

### Agency execution tests

There are 1,207 `.test.json` files with 2,424 cases in `tests/agency`, and 230 multi-step tests in `tests/agency-js`. They run on 8 shards.

**Every test case runs in its own `node` process** (`lib/cli/util.ts:329`). Compiling a small program takes about 12 ms. The process start is the real cost. This matters for every merge suggestion below: putting several single-case files into one file with several cases saves almost nothing, because each case still starts its own process. Time is saved only when one case checks several things and returns all the results together.

The shards are unbalanced. The test step took between 1m45s and 4m41s. The runner deals out files in turn by name. A small set of cases takes 13 to 46 seconds each, and they land unevenly. The slowest are:

| Seconds | Case |
|---|---|
| 46.5 | `toolbox/designTool/keptDrafts` |
| 41.7 | `toolbox/designTool/accept` |
| 41.5 | `subprocess/nested-pause-resume` |
| 41.2 | `subprocess/nested-pause-user-wrapper` |
| 30.6 | `subprocess/nested-depth-boundary` (atCap) |
| 30.1 | `toolbox/writeTool` |
| 30.0 | `agents/agencyVerifier` |

Each shard also spends 1.5 to 2 minutes on `make ci` before any test runs.

## Question 1: tests to remove

### Dead tests

**Skipped tests:**

- `tests/agency/result/result-{extended,restore-globals,retry-new-args,retry}.test.json` have been skipped since 2026-06-04. **The feature they test still ships.** `restore()` is a builtin (`lib/typeChecker/builtins.ts:405`), it is documented in `docs/site/guide/checkpointing.md:88-104`, and a failure still carries a `checkpoint` (`lib/runtime/result.ts:77`). The only test that runs is `tests/agency-js/result-retry-max`, and it only checks the "too many restores" error. Nothing checks that a retry with new arguments or new globals succeeds. This is decision 1: fix the feature and turn the tests back on, or remove the feature.
- `tests/agency/function-refs/functionRef-object-interrupt.test.json` is skipped because "calling a function through a property is not supported". A reviewer noticed the compiled code already handles `transforms.a(5)`, so this test may pass today. Run it once, then turn it on or move it to a ticket.
- `tests/agency/hosted-tools/web-search.test.json` uses the live web and an LLM judge. One case is skipped forever, and the other never runs on pull requests. Move it to the live-API workflow or delete it.
- `lib/lsp/semanticTokens.test.ts:307` has been skipped since 2026-07-23. Move it to a ticket and delete it.

**Orphans:**

- `tests/typecheck/redact-custom-label.agency`: no test, script, Makefile or workflow refers to it.
- `packages/email/package.json:31` defines `test:agency`, pointing at a `tests/agency` folder that does not exist.
- `packages/mcp/package.json:36` defines `test:agency` the same way. Its three agency-js tests (`mcp-basic`, `mcp-catch-failure`, `mcp-tool-call`) are never run by CI. They were last changed 2026-05-01. Not verified whether they still pass.

I found no test for a stdlib function that no longer exists. A test like that would fail to compile in CI.

### Overlapping tests

| Test | Repeats | Action |
|---|---|---|
| `tests/agency/handlers/handle-nested` (8 cases) | `handle-nested-inline`: the same 8 scenarios, with inline handlers instead of named ones. `handle-function-ref` already covers named handlers. | Delete |
| `tests/agency/fork/fork-multi-interrupt` | `tests/agency-js/fork/fork-parallel-interrupts`: the same program, and the JS test checks more | Delete |
| `tests/typescriptBuilder/` (2 fixtures) and the snapshot loop in `lib/backends/typescriptBuilder.integration.test.ts:39-68` | `tests/typescriptGenerator/simple` and `assignment`, through the same pipeline | Delete |
| The 7 "named argument validation" tests at `typescriptBuilder.integration.test.ts:116-197` | They only check that nothing throws. Validation now happens at run time and is tested in `namedArgsResolver.test.ts` and `tests/agency/dynamic-functions/runtime-arg-errors` | Delete |
| `lib/stdlib/stdlibModules.test.ts:7`, "matches the stdlib folder" | The `node-build` CI job runs `make` and fails if `stdlibModules.data.ts` changed (`.github/workflows/test.yml:146`) | Delete (saves about 10 s) |
| `lib/cli/effects.spawn.test.ts` (6 cases) | `lib/cli/effects.test.ts:46-110` covers the same output in-process | Keep one case |
| `tests/agency-js/parallel-tools-no-ids-resume` and `parallel-tools-resume-messages-intact` | Same program and same checks; only the tool-call ids differ | Merge into one test that runs both id shapes |
| `tests/agency/stdlib/setenv-roundtrip` | `tests/agency/env-interrupt.agency:11-24` (not verified) | Delete |
| `tests/agency/stdlib/gitignore-search` (9 cases) | `lib/stdlib/shell.test.ts:253-420` (not verified) | Cut to 2 cases that show the option reaches the TypeScript code |

I also checked the six test programs that appear twice under different folders. Apart from the two listed above, each pair checks different behavior. For example, `subprocess-pause-basic` resumes in the same process, while `subprocess-durable-resume` resumes in a fresh one. Keep those.

### Generated-code snapshots (R4)

`tests/typescriptGenerator/` holds 104 pairs of an `.agency` program and the `.mjs` code it should compile to. Checking them takes 2.6 seconds, so they cost almost no CI time. Their cost is churn:

- About 157 lines, mostly runtime preamble, are the same in nearly every snapshot.
- Since May, 92 commits each rewrote 50 or more snapshot files at once. For example, #1328 added one preamble line, `const __sourceFile = null;`, and that rewrote 102 snapshots.
- The snapshots are never run, so wrong generated code still passes if it matches.

About 35 fixtures have an execution test of the same name in `tests/agency`, which compiles the program and runs it. A handful of snapshots check something the execution tests cannot see, because the mock LLM cannot inspect the request sent to the model: `objectDescription`, `docstrings`, `noResponseFormat`, `llmConfigParam`, `schemaParamInjection` and `asyncLlm`.

Suggested steps, which need your decision:

1. Strip the shared preamble before comparing, and keep the full file for `simple` only. This alone would have prevented most of the mass rewrites.
2. Delete the snapshots that have an execution test of the same name. Check each one by hand first, since that match was made by file name only.
3. Keep the LLM-facing snapshots until a test can record the request sent to the model (see A10).

### Trivial things that are over-tested

The parser tests (75 files, 2,314 tests, 25,540 lines) are over-detailed. For example, the number parser table at `lib/parsers/literals.test.ts:182` has 23 cases, including three positive integers. The "number literal grammar" block at `literals.test.ts:1810` repeats cases already in that table. They take 5.5 seconds in total. Trimming them would reduce upkeep but saves no CI time, so I would leave them.

Many Agency test folders hold one case per file: `validation` (94 of 98 files), `guards` (78 of 92), `async` (53 of 55), `subprocess` (56 of 61), `decorators` (39 of 40) and `fork` (40 of 40). Some of these could be folded into cases that check several things at once:

- In `validation/`, `bangParams`, `bangParamsFail` and `bangParamsMultipleCalls` are covered by `bangMultipleParams`. The 10 `jsonSchema*` files could be one case.
- In `async/`, the `value-in-*` files could be about 2 cases.

But each folded case saves only about 0.3 seconds on its shard. This is a tidy-up, not a speed-up.

The 213 files at the top level of `tests/agency` are mostly misplaced rather than duplicated. About half are stdlib tests (`safeBash`, `skills-*`, `scheduled-helpers`). Moving them into folders would help readers but saves no time.

### Slow tests (the "too many tests" that cost CI time)

**S1. Statelog retry delays.** `lib/cli/statelog/projectClient.test.ts:318` and `accountClient.test.ts:408` each test an HTTP 503 response. The code under test waits 0.5, 2 and 8 seconds between retries (`statelogRequest.ts:50`), so each file takes exactly 10.5 seconds. The code already accepts a `sleep` function for tests (`statelogRequest.ts:43`), but these tests don't pass one. Passing one saves about 21 seconds.

**S2. Six files parse the whole test corpus separately.** Vitest runs each file in its own worker, so they can't share a cache. None of them uses `lib/parseCache.ts`.

| File | Seconds |
|---|---|
| `lib/typeChecker/fixtureTypeCheck.integration.test.ts` | 34 |
| `lib/lowering/patternGuards.tripwire.test.ts` | 28 |
| `lib/utils/expressionSlots.test.ts` | 19 |
| `lib/backends/agencyGenerator.roundtrip.test.ts` | 19 |
| `lib/linter/agencySourcesClean.test.ts` | 13 |
| `lib/commentConservation.test.ts` | 5 |

Putting the corpus checks into one file that parses each program once should save 40 to 60 seconds. Lowering a parsed program costs about 2% of parsing it (comment at `patternGuards.tripwire.test.ts:110`).

`fixtureTypeCheck` spends 31 seconds typechecking the stdlib. Today it is the only thing in CI that fails on a stdlib type error, because the Makefile never typechecks. Keep it until `make` fails on type errors (decision 3).

**S3. `lib/preprocessors/expandSplices.test.ts` (62 seconds, 38 tests).** It clears the splice cache before each test, so each test compiles a generator and starts a `node` process (`lib/compiler/splice/runGenerator.ts:307`). About 20 tests only check the code fragment the generator returns. Plain functions in `lib/preprocessors/expandSplices.ts:352-645` could check those in-process. About 10 more repeat `tests/agency/splices/*`. Keep 2 or 3 real end-to-end runs. Estimated saving: 40 seconds.

**S4. Agency cases that only inspect values.**

- `tests/agency/agents/toolkits.test.json` and `toolGaps.test.json` hold about 30 cases. Each checks a fixed tool list, yet takes 12 to 14 seconds because it loads every agent module. CI's slowest list shows `toolkits > readOnlyGitIsTheReadHalfOfGitTools` at 14.4 seconds. Folding each file into one case that returns all its checks saves about 7 CPU-minutes. The static cases in `oracleExplorer` and `agentSkill` could be folded the same way.
- `tests/agency/safeBash.test.json` has 135 cases, and each loads the 2.1 MB compiled `safeBash.js`. A reviewer counted 85 that only classify a command string and never run anything. Packing those into about 10 cases removes about 75 process starts. Keep every row: safeBash decides which effect a shell command raises, and a wrong answer would let a command past a policy.

**S5. Shard balance.** The runner prints only the 10 slowest cases per shard. If it saved every case's time, the next run could assign files to shards by measured time. With the slowest shard at 4m41 and the fastest at 1m45, that should take 1 to 2 minutes off the critical path.

**S6. `lib/cli/runBundledAgent.test.ts` (30 seconds, 52 tests).** Each call to `runBundledAgent` runs `withCodeIdentity` (`runBundledAgent.ts:338`), which hashes every file the bundled agent imports. Replacing it with a stand-in everywhere except the one test that checks it should save about 25 seconds. Not profiled.

**S7. Tests that start the CLI as a process.**

| File | Time | Suggested change | Saving |
|---|---|---|---|
| `lib/cli/resume.spawn.test.ts` | 118 s, 12 tests | Each test checks something different. Four of them (`:146`, `:181`, `:355`, `:454`) rerun the same program just to get the same checkpoint: run it once for all four. `:454` repeats `:472`. The tests use separate folders, so they could also run in parallel. | 11 to 19 s, more with parallel runs |
| `lib/cli/workflow/workflow.spawn.test.ts` | 102 s, 21 tests | Four cases repeat `commands.test.ts`, and one repeats `locate.test.ts:43`. The `--max-time` and `--draft` refusals can run in-process. | 20 to 25 s |
| `lib/cli/validatorInterrupts.spawn.test.ts` | 21 s, 6 tests | One program covering all three checks, run 3 times instead of 6 | About 10 s |
| `lib/cli/wait.spawn.test.ts` and `spawn.spawn.test.ts` | 32 s and 42 s | Several cases start the same waiting program; combine them | About 14 s |
| `lib/compiler/platform.spawn.test.ts` | 8.6 s | `:53` repeats `platformCheck.test.ts:61` | About 4 s |
| `lib/cli/effects.spawn.test.ts` | 10.4 s | Keep one case | About 8 s |

**S8. Whole-stdlib meta-tests.** Three files each parse the whole stdlib from scratch, in their own worker:

- `lib/stdlibRaises.test.ts` (34 s)
- `lib/stdlibCapabilities.test.ts` (14 s)
- `lib/linter/agencySourcesClean.test.ts` (13 s)

One file could build the symbol table once and run all three checks, saving an estimated 15 to 25 seconds. The CI-duplicate test in `stdlibModules.test.ts` (in the table above) saves about 10 more.

One more finding from S8: `lintSource` returns no problems when a file fails to parse (`lib/linter/registry.ts:31-33`). So the lint test passes silently on a stdlib file that no longer parses. Other tests catch parse failures, so the risk is low.

## Question 2: tests to add

### Core language features

**Interrupts and handlers are well tested.** These rules all have deterministic tests that run on every pull request:

| Rule | Test |
|---|---|
| Any rejection wins over approvals | `tests/agency/handlers/handle-nested-inline`; also unit-tested in `lib/runtime/interrupts.test.ts:244-280` |
| An inner handler approves and an outer one rejects, so the call is rejected | `tests/agency/handlers/handle-nested.agency:30` |
| Propagate combined with reject | `tests/agency/handlers/handle-propagate.agency:53` |
| Handlers still work after a checkpoint is restored | `handle-survives-restore`, `handler-function-across-resume` |
| A rejection makes the function exit | `handle-reject` |
| Interrupts in parallel branches | `fork/fork-handler-mixed`, `async/reject-in-arm` |
| Interrupts in subprocesses | `subprocess/pause-fork-all-unhandled`, the nested-pause tests |
| Resume is refused after the code changes, or when the signature is bad | `interrupt-code-changed`, `resume.spawn.test.ts:328` and `:454` |

**A1. Tests that never run on pull requests.** CI runs the Agency tests with a mock LLM. Any case graded by an LLM judge is skipped in that mode (`lib/cli/test.ts:1092-1100`) and runs only after merge. There are 27 such files with about 30 cases. They include:

- 10 cases of tool calls that interrupt while running in parallel:
  - `fork/llm-tools/{multi-tool-all-interrupt, multi-tool-mixed, tool-multi-cycle, tool-succeeds-then-interrupts, nested-llm-interrupt}`
  - `fork/{fork-llm-tool-nested, fork-llm-deep-loop, race-interrupt}`
  - `race/{race-multi-cycle, race-with-fork-inside}`
- 7 of the 16 thread tests: `threads/{no-thread, thread-inside-function, nested-threads, nested-threads-and-subthreads, nested-function-calls/*}`.

Two scenarios have no pull-request coverage at all: two tools both pausing in one round, with one approved and one rejected; and one tool call that raises twice across two resumes.

Rewrite these with mocked tool calls (`llmMocks` with `toolCalls`), and check the tool messages the way `tests/agency-js/tool-rejection` does. This is the most valuable test work in this audit.

**A10. Tests that pass by echoing the mock (not verified).** A reviewer found about 57 cases whose expected output equals the mock model's final reply. They would pass even if the tool never ran. Examples:

- `interrupts/interrupt.test.json` (`foo`)
- `interrupts/interruptAssignment`
- `hoist/roundtrip-tools`
- `try-llm` `toolInterrupt*`
- all six tests in `tools/`

`fork/fork-reject` also passes partly by accident: the approved branch shows `success: false` because the test calls `isSuccess` on a plain string. To fix these, the mock model needs an option to echo the last tool result or check the tool messages it receives. Then the tests can check a real effect.

**A11. Interrupt edge cases with no test:**

- **Partial answers.** Three interrupts are raised and the client answers only two. The runtime asks the third one again (`lib/runtime/agencyInterrupt.ts:191-200`), but no test pins this. `tests/agency-js/interrupts/interrupt-respond-mismatch` only checks a length mismatch, and could be reused for this.
- **Edited interrupt data.** Changing an interrupt's `data` or `message` before resuming must change nothing, because the function resumes with its saved local. No test edits `.data` before `respondToInterrupts`.
- **Resuming into the middle of a `handle` block.** The only restore test, `handle-survives-restore`, takes its checkpoint before the `handle` statement. No test takes a checkpoint inside a `handle` body, restores or rewinds to it, and checks that a later interrupt is still answered by the handler.
- **Serialization in the test harness.** `lib/templates/cli/evaluate.mustache:50` passes the live interrupt objects straight back. Adding `JSON.parse(JSON.stringify(interrupts))` there would make every interrupt test also check serialization. Not verified.

**A note on a security claim.** A reviewer pointed out that on resume, if a checkpoint already holds an interrupt id with a matching answer, the runtime returns that answer without asking any handler (`agencyInterrupt.ts:188-196`). An edited checkpoint could plant such an id. This is one more case of a documented limit, not a new hole: `docs/dev/hosting/how-hosted-serving-works.md:262` already says `agency serve` checkpoints are unsigned and a caller can change any value before resuming. Signing checkpoints would close it. A test that records today's behavior is reasonable.

### Stdlib

**A3. Reject tests for risky functions.** `tests/agency-js/stdlib/std-fs-ops` calls `copy`, `move` and `remove` only `with approve`. No test rejects them and checks that the files are unchanged. No test rejects `fetch`, `fetchJSON`, `fetchMarkdown` or the real `std::exec`. One test file per module would cover these:

- For fs: reject each call, then check the source or target is unchanged.
- For http: reject the call with a `fetchMocks.json` of `[]`, which fails the run if any request is made.
- For exec: run `exec("touch", [f]) with reject`, then check `f` does not exist.

**A12. Other raises with no test (not verified):**

- `registerProvider` (`stdlib/llm.agency:228-235`), which loads code into the running process
- `memory.forget` (`stdlib/memory.agency:208-221`)
- the github write functions other than issue comments, which can copy the pattern in `tests/agency/github/main.agency:161`
- `sendEmail` and `sendSms`, which go through the host's fetch, so fetch mocks work

Stdlib coverage overall is 82.8% of Agency statements. These modules sit at 0%:

- `calendar`, `clipboard`, `notes/apple`, `messaging/*`, `auth/*`: need a fake subprocess host at the Agency level first.
- `weather`, `wikipedia`, `web/search`: could be tested with fetch mocks.

**A9. Typecheck `lib/agents`.** It holds 125 Agency files, and no CI step typechecks them. This fits in the merged corpus file from S2.

### CLI commands: integration coverage

"End to end" here means the test runs the real CLI as a separate process:

- **PR**: it runs on every pull request.
- **Main**: it runs only after a merge to main (the `cli-main` suite).
- **Tarball**: it runs against the packed npm package installed in a temporary project.

| Command | End-to-end coverage | How thorough | Expected use |
|---|---|---|---|
| `run` | Tarball `cli` and many `*.spawn.test.ts` (PR) | Thorough | Very high |
| `run --approve/--reject/--policy` | `runPolicy.spawn`, `validatorInterrupts.spawn`, `workflow.spawn` (PR). From the tarball, only `--policy approve-all` | Several, not from the tarball | High |
| `run --interactive` (answering the prompt) | Only the no-terminal fallback (`wait.spawn.test.ts:242`) | **None** | High |
| `agent` | Tarball `cli` test 8e: help, flag errors, config. **Never runs a turn** | Smoke only | Very high |
| `compile` | `smoke`, `cli`, `cli-main` | Several | High |
| `test`, `test js` | The CI Agency jobs run them on hundreds of files | Thorough | High |
| `fmt` | `cli-lang` (PR), repeated in `cli-main` | Several | High |
| `typecheck` / `tc` | `cli-lang` (2 cases, PR); full set in `cli-main` (main only) | Smoke on PRs | High |
| `resume` | `resume.spawn` (12 tests, PR) | Thorough, not from the tarball | Medium |
| `lsp` | None | **None** | High (editors start it) |
| `logs` | `--csv` and one `view` case. `logs traces/outline/search` and `logs session`: none | Smoke | Medium to high |
| `serve http` | `serve` suite: call, list, 404. **No interrupt and `/resume` round trip**; the `remote` suite that had one is off (`if: false`, `test.yml:507`) | Smoke | Medium |
| `serve mcp` | None | **None** | Medium |
| `mcp` (and `setup codex`, `list`, `add`, `remove`) | None as a process | **None** | Medium |
| `debug`, `debug session` | Driven in-process only | Partial | Medium |
| `pack` | `cli`, `cli-tier2`, `cli-main` | Thorough | Medium |
| `eval run`, `eval grade` | `cli`, `eval-run` | Thorough | Medium |
| `eval ls/new/edit/logs/upload/judge`, `label` | None | None | Low to medium |
| `local list/resolve`, `models list` | `cli-tier2`; other `local` commands in a separate post-merge workflow | Partial | Medium (local-model users) |
| `run --wait-for-response`, `--detach` | `wait.spawn`, `detach.spawn`, `spawn.spawn` (PR) | Several | Low (new) |
| `attach` | Never started as a process | None | Low (new) |
| `doc` | `cli-lang`, `cli-main`, `docCli.test` | Several | Low to medium |
| `effects` | `effects.spawn` | Several | Low to medium |
| `workflow tools/check/compile/run/list` | `workflow.spawn` (21 tests) | Thorough | Low to medium |
| `lint`, `explain` | `cli-lang`, 1 case each | Smoke | Medium / low |
| `trace`, `bundle`, `unbundle`, `coverage` | `cli-tier2`, repeated in `cli-main` | Several | Low |
| `optimize` | `cli`, baseline only | Smoke | Low |
| `schedule` | `cli-main` only | Main only | Low |
| `interrupts` (hidden) | `cli-main` only, 5 cases | Main only | Low |
| `doctor`, `skills`, `models refresh` | Unit tests only | None | Low to medium |
| `remote ...`, `review`, `policy gen` | None (the `remote` suite is off) | None | Low |

### CLI tests to add, most valuable first

- **A2. `run --interactive` in a real terminal.** Run a program that raises `std::read` under a pseudo-terminal (for example `script -qec` on the Linux runner). Answer once with approve and once with reject, and check that the program saw each answer. Not verified: whether `script` gives a working terminal on the CI runner.
- **A4. One `agency agent` turn.** Run `agency agent -p "hi"` with `AGENCY_USE_TEST_LLM_PROVIDER=1`, `AGENCY_LLM_MOCKS` and a throwaway `HOME`. Check that it exits 0 and prints the reply. One turn may make several model calls (router, decision models), so the mock list may need several entries.
- **A5. The serve round trip.** In the `serve` suite, post a call to a node that raises an interrupt and expect the interrupt back with a checkpoint. Then post `/resume` once with approve and expect the value, and once with reject and expect a failure.
- **A6. Thorough checks on pull requests.** Move the `interrupts` cases and the `tc` stdin, directory and missing-import cases from `cli-main` into `cli-lang`, which runs on pull requests.
- **A7. Answering interrupts from the tarball.** In the `cli` suite:
  - `run --policy rules.json` with a rule that approves one write and rejects another
  - `--approve` and `--reject`
  - no flags, so the run exits non-zero with "was not handled"
  - `run --wait-for-response`, then `resume <checkpoint> <file> --approve`
- **A8. Stdio handshakes.**
  - `agency lsp`: send `initialize`, then `didOpen` on a broken file, and expect `publishDiagnostics`.
  - `agency mcp`: send `initialize`, then `tools/list`.
  - `agency serve mcp`: send `initialize`, then `tools/call`.
- **Lower priority:** `agency debug session` as a process, `skills install` into a throwaway `HOME`, `logs traces/outline/search` on a log the suite already writes, `eval ls`, and `runs extract`.

**R5.** The cases in `cli-main` that repeat a pull-request suite can be removed: `fmt`, the coverage cycle, `pack`, `trace`, `bundle` and `unbundle`, and `doc`. This saves no time on pull requests, since `cli-main` runs only on main, but it removes duplicate upkeep.

## What was not verified

- Per-test timings inside a file. CI gives one time per vitest file and the 10 slowest Agency cases per shard. Most savings above are estimates from those numbers.
- Whether the four skipped Result tests or `functionRef-object-interrupt` pass today.
- The count of tests that echo the mock (A10), and the stdlib items marked "not verified".
- Whether a mocked `agency agent` turn gives the same result every run.

## How to reproduce the numbers

The timings come from the job logs of CI run 43797201141:

```
gh run view 43797201141 --json jobs
gh api repos/{owner}/{repo}/actions/jobs/<job-id>/logs
```

- **Vitest file times** are on the `✓ <file> (N tests) <time>` lines of the `unit-tests` jobs.
- **The slowest Agency cases** are after each "Slowest 10 tests" line in the `agency-tests` jobs.
- **Stdlib coverage** is printed by the `coverage-report` job.
