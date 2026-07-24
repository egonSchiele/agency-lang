# Review: Test Runner Expected Compile Errors plan

Plan reviewed: `/Users/adityabhargava/agency-lang/worktree-code-templates/docs/superpowers/plans/2026-07-23-test-runner-expected-compile-error.md`
Spec: `/Users/adityabhargava/agency-lang/worktree-code-templates/docs/superpowers/specs/2026-07-23-test-runner-expected-compile-error.md`

All file references below are to `worktree-code-templates/packages/agency-lang` unless written absolute.

## Verdict

The plan is close to executable as written. The architecture matches the spec, the task order is right, and I verified the load-bearing claims against the code: `precompileTestSources` and the `skip` carve-out (`lib/cli/test.ts:979-987`, `lib/cli/precompile.ts:36-43`), the `process.exit(1)` failure paths in `compileEntry`, `resolveFreshness` mapping `allowTestImports` to `"always"` (`lib/compiler/buildSession.ts:95-116`), `isTimeoutError` requiring SIGKILL (`lib/cli/test.ts:141-145`), the `Tests` type and the `tests.tests.length` TypeError hazard at `lib/cli/test.ts:799`, `formatDiff`'s signature (`lib/utils/diff.ts:347`), the separate `code`/`message` fields in `diagnostic()` (`lib/typeChecker/diagnostics.ts:672-687`), the exact string `Failed to parse Agency program` (`lib/compiler/buildSession.ts:624`), and node return-type syntax having fixture precedent (`tests/agency/fork-arg-position.agency`). `pnpm run typecheck` exists.

Three findings need a plan edit before execution. Finding 1 is a spec contradiction; findings 2 and 3 are wrong statements that would land in the shipped docs.

## Finding 1 (must fix): `skip: true` loses to `expectedCompileError`

The spec says: "`skip`, `skipOnCI`, and `skipReason` keep their existing meaning, and a skipped file is skipped before any of this runs."

The plan wires it the other way. Task 4 Step 5 inserts the `expectedCompileError` branch in place of lines 797-799 — which sit *above* the file-level skip check at `lib/cli/test.ts:805`. So a `.test.json` carrying both `skip: true` and `expectedCompileError` spawns the compile and judges it instead of skipping. The precompile side is fine (Task 3's `isExcludedFromPrecompile` ORs both conditions), but the runner side contradicts the spec, and skip is exactly the escape hatch someone reaches for when one of these fixtures starts flaking.

Fix: gate the new branch on not-skipped, e.g. check `tests.skip || (tests.skipOnCI && process.env.CI)` before entering `runExpectedCompileError` (or move the skip early-return above the new branch — note the skip message prints `total`, which is 0 here, so "Skipped 0 test(s)" wants a small wording tweak if you go that way). Add a fixture-free unit assertion or at least a plan step that states the intended precedence.

## Finding 2 (must fix): the config "walk-up" claim is false, and Task 6 would publish it

The plan (Task 5 Step 1, and the Task 6 doc text) says the child "resolves config by walking up from its cwd (`findProjectRoot`, `lib/config.ts:544-560`)". The spec makes the same claim and adds "one that doesn't [ship an `agency.json`] inherits the project root's."

Neither is what the `compile` command does. Its action calls `getConfig()` → `loadConfig(opts.config)` (`scripts/agency.ts:183`), and `loadConfig` reads exactly `path.join(process.cwd(), "agency.json")` (`lib/cli/commands.ts:95-100`) — no walk-up, no `findProjectRoot` on this path. If that file is missing, `loadConfigSafe` returns an **empty config** (`lib/config.ts:512-514`), not the project root's.

For the two planned fixtures nothing breaks: the child's cwd is the fixture directory, which ships a complete `agency.json`, so the outcome the plan wants is the outcome it gets. But the consequence for future authors is the opposite of what Task 6 documents. A fixture directory *without* its own `agency.json` gets `{}` — typechecker off entirely — not "the project root's config." Someone writing an `AG8002` fixture in a bare directory would read the doc, expect inherited strict mode, and get a compile that succeeds.

Fix: correct the rationale in Task 5 and the doc paragraph in Task 6 to say: the child reads `agency.json` from its cwd (the fixture's directory) and nothing else; a fixture directory without one compiles with an empty config, so every fixture directory in this mode must ship a complete `agency.json`. That is a *stronger* argument for the plan's "complete on its own" instruction than the walk-up story was. The spec has the same error; worth a one-line errata there too.

## Finding 3 (must fix): Task 6 documents an `llmMocks` rejection that Task 1 doesn't implement

The doc text in Task 6 ends: "`llmMocks`, `fetchMocks`, and a non-empty `tests` array are rejected rather than ignored." But `findIncompatibleField` (Task 1) checks only `tests` and `fetchMocks`. There is no file-level `llmMocks` field today (`llmMocks` lives on `TestCase`, `lib/cli/test.ts:57`), so a top-level `llmMocks` key in a `.test.json` is silently ignored by this mode — the doc would be describing a check that doesn't exist.

The spec's longer rejection list (`useTestLLMProvider`, `fakeClock`, `interruptHandlers`, …) is effectively covered by rejecting a non-empty `tests` array, since those only exist inside test cases — that simplification is fine. Pick a side for `llmMocks`: either add `if (tests.llmMocks !== undefined) return "llmMocks"` to `findIncompatibleField` (cheap, matches the spec's intent of catching author misunderstanding), or drop `llmMocks` from the doc sentence. Don't ship the mismatch.

## Minor points (fix while in there, none blocking)

- **Abort/timeout check order.** `compileInSubprocess` checks `isTimeoutError` before `isAbortError`; the existing spawn path checks abort first (`lib/cli/test.ts:661-665`). With `killSignal: "SIGKILL"` on both kill paths, the two error shapes shouldn't overlap in current Node, but mirroring the established order costs nothing and keeps the two sites from drifting apart.
- **The incompatible-field failure never lands in `suite.completed`.** `completed` is defined as "files that started running and whose runTestFile() returned normally" (`lib/cli/test.ts:164`) and feeds the suite-abort summary's three-way classification (completed / in-flight / never started, line 928). The plan's `fail()` early return for an incompatible field skips the push, so on a later suite abort that file appears in none of the three buckets (its `pending` entry was already deleted at `lib/cli/test.ts:782`). Move the `suite.completed.push(testFile)` into `fail()` or push before the incompatible-field return.
- **Task 2 Step 3 opens with a dead command.** The `cat > /tmp/agency-scratch.txt` heredoc creates a placeholder file nothing uses; delete it.
- **Line-citation drift in the Background section.** The parse-failure `process.exit(1)` is at `lib/compiler/buildSession.ts:624-628`, not 571-587. Harmless for an implementer (the claim itself is right) but worth correcting since the section tells the reader to trust these numbers.
- **Strict-mode exit is conditional on severity.** `runTypecheck` under strict only exits when some diagnostic has `severity === "error"` (the `hasFatal` check); warnings-only strict output compiles fine. The type-mismatch fixture is severity error, so Task 5 is unaffected, but the Background's flat "strict → exit 1" slightly overstates it — a future fixture pinned to a warning-severity code would compile and the test would fail confusingly. A parenthetical in the Task 6 doc ("the diagnostic must be error severity") would head that off.

## Anti-pattern audit (docs/dev/anti-patterns.md)

**On the central question — does the plan split "what" from "how" behind declarative interfaces — it does, and deliberately.** `judgeCompileAttempt` is the "what" (which outcomes count as a pass), pure and driven entirely by its two inputs; all the imperative machinery — spawning, stream concatenation, kill signals, error-shape sniffing — is quarantined in `compileInSubprocess`, which reports back through the declarative `CompileAttempt` type; the runner branch is thin glue that composes the two. Changing what counts as a pass never touches the spawn code and vice versa. `findIncompatibleField` and `isExcludedFromPrecompile` follow the same shape: one named decision function, one call site. This is the pattern the catalog's "Imperative code everywhere" entry asks for.

Two entries the plan does violate:

1. **`safeDelete` for file deletion.** `runExpectedCompileError` calls `fs.rmSync(siblingJs, { force: true })` twice. The catalog says deletions go through `safeDelete` (`safeDeleteFile` in `lib/utils.ts:83`). The codebase is honestly inconsistent here — `lib/cli/debug.ts:272` and `lib/cli/coverage.ts:44` use `rmSync` on temp dirs, while `lib/eval/runArtifacts.ts` uses `safeDeleteFile` — but the plan is deleting a file next to a checked-in fixture, which is exactly the case the safety wrapper exists for. Note `safeDeleteFile`'s `dryRun` parameter defaults to `true`, so the call must pass `false` explicitly.

2. **The catch block in `compileInSubprocess` launders non-exec errors silently.** The error-as-data conversion is right for exec failures (a nonzero exit is the expected outcome, and its output flows into the verdict — nothing is swallowed). But the fallback branch (`typeof err.code === "number" ? err.code : 1`) also catches errors that never ran a compile at all — an ENOENT spawning the CLI entry, a bad `cwd` — and converts them to `{ exitCode: 1, output: "" }`. That reports as "the compile failed, but not with the expected message" with an empty diff, which is the catalog's swallowed-error problem wearing a costume. Fix: when the caught error has neither `stdout` nor `stderr` (it isn't an exec result), rethrow or log it before returning, so a broken harness looks like a broken harness.

Minor, judgment-call items:

- **`tests.tests![i]` plus `tests.tests?.length ?? 0`** (Task 4 Step 5) — two workarounds for the same optionality. One binding, `const cases = tests.tests ?? [];`, then `cases.length` / `cases[i]`, removes both the non-null assertion and the coalesce and reads as the "what."
- **`maxBuffer: 10 * 1024 * 1024`** — a magic number by the catalog, but it is the exact literal the two existing spawn sites use (`lib/cli/util.ts:543`, `lib/cli/test.ts:1169`), so the plan is following the "Inconsistent patterns" rule instead. Extracting a shared named constant across all three sites would satisfy both entries; optional here.

Checked and clean: no duplication of existing helpers (`compileInSubprocess` is not `executeNodeAsync` — different contract, no mock plumbing, failure-as-data); no order-dependent mutable state (the verdict function is guard clauses over `const` inputs); no nested ternaries, one-line ifs, or nested type definitions; `CompileAttempt`/`CompileVerdict` are flat; the fixture tests risk nothing catastrophic on failure.

## What I checked and did not find problems with

- Child invocation via `process.argv[1]` — the runner *is* `dist/scripts/agency.js`, so the child matches the parent build.
- Sibling-`.js` delete-before-and-after, and the `preferCompiled` hazard it defends against (`lib/cli/util.ts:232-233, 267`).
- One-file-one-test accounting against the `TestStats` shape (`lib/cli/test.ts:474-481`); sharding partitions `.test.json` paths, so an empty `tests` array doesn't skew it.
- The dedicated fixture directory rationale: the cross-config single-slot throw is real (`findCrossConfigConflicts` via `compileGroups`), and `coverage.exclude` with the `topsort/cycles` precedent is in the repo `agency.json:20-24`.
- `resolveTimeoutMs(undefined, tests)` falls back to `DEFAULT_PER_TEST_MS` (2 min) — generous but harmless for a compile.
- Task ordering and the TDD shape of Tasks 1 and 3.
