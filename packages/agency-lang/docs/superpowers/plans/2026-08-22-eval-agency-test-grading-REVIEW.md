# Plan Review

**Status:** Issues Found

## Issues

- **[Task 3, all steps]: The plan does not define a path that can actually satisfy the JSON contract.** `runSingleTest` and `runTestWithRetries` currently return only `"passed" | "failed" | "aborted"`; the failure text exists only as calls to `log`, so `runTestFile` has no feedback value from which to build `TestCaseReport.feedback`. The plan needs to change the outcome contract to return structured status and feedback, including the final retry's feedback, rather than saying only that `runTestFile` records it. Separately, changing `createBufferedLogger` to target stderr is insufficient to guarantee one JSON document on stdout: `test()` writes shard and abort output directly with `console.log`, precompile is not called with `quiet: true`, and the command action in `scripts/agency.ts` writes summaries and slow-test output directly to stdout. Without an explicit output-routing design covering those paths, the advertised machine-readable interface will be contaminated even if the proposed happy-path integration test happens to pass.

- **[Tasks 6, 8, and 9]: The `revision` removal sequence is contradictory.** The plan does intend to snapshot both the existing module graders and the new Agency harness, and Task 6 describes storing both sets of files. The blocking problem is narrower: Task 6 removes `GradersIdentity.revision` while the current `loadGradingSnapshot` still reads it; Task 8 then says to remove that reader branch, and Task 9 says to remove both again. This violates the plan's claim that tasks are independently testable and leaves Task 6 with an expected TypeScript break, followed by duplicate edits. Assign each `revision` deletion to exactly one task and remove the synthesized-grader writer before, or in the same task as, the types and reader it requires.

- **[Task 1, `testChildEnv` step]: Budget inheritance does not match the promised `agency run` semantics.** The current `run()` implementation clears `AGENCY_MAX_COST` and `AGENCY_MAX_TIME` before setting values resolved from this invocation. The proposed helper always clears only `AGENCY_RUN_POLICY` and `AGENCY_RUN_POLICY_INTERACTIVE`, so an ordinary `agency test` with no budget flags can silently inherit a parent-shell budget. Add both budget keys to the clear-then-set contract and test the no-budget case. Also make `TestRunOptions` use the resolved budget representation (`string` env values, with `--max-time` already converted to milliseconds by `resolveBudget`) rather than the proposed `number` fields, or explicitly define the conversion boundary.

## Recommendations

- **[Task 6, snapshot plumbing]:** The snapshotting approach is sound, but make its intermediate type explicit. `snapshotGraders` currently returns one `TestGraders | undefined` per test, while the new path needs an optional module snapshot and an optional harness snapshot to coexist. Define a combined per-test snapshot type and show it being passed through `executeTest` to `foldIntoRunDirectory`; there, concatenate both file lists and write the harness records separately on the run row. This is a clarity improvement, not a missing snapshotting design.
- **[Task 8, live grading step]:** Remove the placeholder “if that path exists; check.” `gradeRun.ts` explicitly treats the run directory as grading's only input. If a live path is genuinely required, name its caller and add a concrete test; otherwise it is out of scope.
- **[Task 6, stored filenames]:** Correct the claim that existing judge files use `<sha256>-<basename>`. `snapshotGradingModule` currently stores external files as `<sha256><extension>` and has no exported naming helper. Either adopt that existing format or explicitly plan the new helper and explain why harness names intentionally differ.
- Add an end-to-end JSON test for a shard or suite-abort path, not only a normal two-case fixture, because those are the direct-output paths most likely to violate stdout purity.


## Response (plan v2, 2026-08-22)

Every finding was checked against the code and holds. What changed:

- **Task 3 (JSON contract):** `runSingleTest` / `runTestWithRetries` now return `CaseOutcome = { status, feedback?, durationMs }` with the last attempt's feedback; `runTestFile` returns a `TestFileReport`; `test()` returns the full document. A single `TestOutput` sink (`lib/cli/testOutput.ts`) replaces every direct `console.log` on the test command's paths, including the shard line, the suite-abort summary, the precompile pass (`{ quiet }`), and the totals and slowest-tests table in `scripts/agency.ts`. A grep audit is part of the task. Tests: unit tests for the sink and the report builder (incl. `aborted` and `compile-failed`), an agency-js test with normal and sharded runs asserting exactly one stdout line, and a unit test that the abort summary writes nothing to stdout (the suite abort cannot be triggered deterministically from outside).
- **Tasks 6/8/9 (`revision`):** Task 6 no longer touches `revision`; Task 8 only reads `harness`; Task 9 removes the writer, the types, the reader branch, and the schema field in one commit.
- **Task 1 (budget):** `testChildEnv` returns `{ set, unset }` with all four keys (`AGENCY_RUN_POLICY`, `AGENCY_RUN_POLICY_INTERACTIVE`, `AGENCY_MAX_COST`, `AGENCY_MAX_TIME`) in `unset`; `runAgencyNode` gains `unsetEnv` so keys can actually be removed; `TestRunOptions.budget` is `resolveBudget`'s string shape, so nothing downstream re-parses. The no-flags inheritance case is a named test.
- **Task 6 (snapshot type):** `TestSnapshots = { module?, harness? }` per test, passed through `executeTest` to `foldIntoRunDirectory`, which concatenates the file lists and writes `harness` records separately.
- **Task 8 (live grading):** removed; grading's only input is a run directory (`gradeSuite.ts` and the optimizer both call `gradeRun`/`gradeSnapshot`).
- **Task 6 (file names):** harness files are stored as `<sha256><extension>`, the rule `snapshotGradingModule` uses; no new helper. The spec's example was corrected.
- **End-to-end JSON tests:** the sharded run is in the agency-js test; the abort path is pinned at the unit level as described above.
