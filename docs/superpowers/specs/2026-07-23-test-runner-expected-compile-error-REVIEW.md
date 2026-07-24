# Review: Test runner expected compile errors

Reviewing `/Users/adityabhargava/agency-lang/worktree-code-templates/docs/superpowers/specs/2026-07-23-test-runner-expected-compile-error.md`.

All line references below are to files in `/Users/adityabhargava/agency-lang/worktree-code-templates/packages/agency-lang`, read while writing this review.

## What the spec gets right

The two structural calls are correct and worth keeping whatever else changes.

**File-level, not per-case.** Compilation is per-file, so an expectation about it belongs on the file. The reasoning in the spec is sound.

**The precompile carve-out.** `precompileTestSources` really does compile every collected source up front (`lib/cli/test.ts:979-987`), and a failure there ends the run before any test executes. `isFileLevelSkipped` (`lib/cli/precompile.ts:36-43`) is exactly the precedent the spec claims, down to the comment saying skipped files "may intentionally not compile." Adding a second exclusion next to it is the right shape.

**Substring over equality.** Messages carry absolute paths; matching them exactly would be machine-dependent. Right call — though see finding 4, because the substring the spec picks isn't in the string it's matching against.

## Blocking: `compile()` mostly does not throw

The whole design in §2 rests on one sentence: "Compile throws and the message contains the expected substring." For most compile failures, `compile()` does not throw. It prints and calls `process.exit(1)`.

Concretely, inside `compileEntry`:

- **Parse failure** → `parseFileOrExit` prints `Failed to parse Agency program: …` and `process.exit(1)` (`lib/compiler/buildSession.ts:571-587`).
- **Type error, strict mode** → `runTypecheck` prints `formatErrors(...)` and `process.exit(1)` (`lib/compiler/buildSession.ts:645-655`).
- **Type error, non-strict mode** → `console.warn` and compilation *succeeds* (same function, `else` branch).
- **Closure error** → `CompileClosureError` is caught inside `ensureCompiledClosure` and turned into `process.exit(1)` (`lib/compiler/buildSession.ts:339-346`).

`compileMany`'s doc comment says this outright: "Parse/typecheck failures inside per-file `compile()` keep their existing exit behavior" (`lib/cli/commands.ts:263-266`).

What *does* throw out of `compile()` is an exception raised during code generation. There is no try/catch anywhere between `generateTypeScript` and the caller (`lib/compiler/buildSession.ts:520-530`), so the plan's `AG8001` — thrown from `typescriptBuilder.processNode`, per the code-templates plan Task 7 — propagates normally. That single case works.

The consequence is worse than "some cases aren't covered." A fixture whose `.agency` file fails to *parse* would call `process.exit(1)` from inside the runner process, mid-run, with worker files still in flight and no summary printed. That is precisely the failure the precompile carve-out exists to prevent; the spec would reintroduce it one phase later, in a place where it looks like the suite hung rather than failed.

The spec needs to either (a) state the contract narrowly — "only failures that throw out of codegen can be expressed; parse and typecheck failures exit the process and are out of scope" — and add a guard so an author cannot accidentally write a fixture that kills the suite, or (b) change the mechanism. See the subprocess suggestion below.

## Blocking: `AG8002` cannot be tested this way at all

The goal line names two consumers, `AG8001` and `AG8002`. The second one is a typechecker diagnostic — the code-templates plan (line 1798) says the checker "push[es] `AG8002`" when a hole has neither an expected type nor an annotation.

Typechecker diagnostics never throw. Under the repo's config they don't even fail the compile: `agency.json` sets `"typechecker": { "enabled": true }` with no `strict`, and `runTypecheck` only calls `process.exit(1)` when `tc?.strict` is set. So an `AG8002` fixture under the default config compiles *successfully*, and the new mode reports "the file compiled but was expected to fail." Add a dir-local `agency.json` with `strict: true` (which both `groupTestSources` and `runTestFile` would merge) and you get the process-exit problem from finding 1 instead.

So the feature as specified serves one of its two stated consumers. Say which, or fix the mechanism so both work.

## Blocking: the spec's own end-to-end test cannot pass

Test 2 under "Tests for this change" proposes a fixture with "a deliberate type error that produces a stable diagnostic today (a plain `AG2xxx` type mismatch)." That is finding 2 exactly: a type mismatch under the repo config produces a warning and a successful compile. The proof-of-mechanism test would report a failure on a correct implementation.

If you keep the throw-based design, the fixture has to be something that throws out of codegen — which today, before the templates work lands, is awkward to produce on purpose. That awkwardness is itself a signal about the design.

## Blocking: `"AG8001"` will not match the message

The example `.test.json` matches the substring `"AG8001"` against `e.message`. Diagnostic codes are not part of message text. `diagnostic()` builds a `TypeCheckError` with `code` and `message` as *separate fields* (`lib/typeChecker/diagnostics.ts:672-687`), and the templates in `DIAGNOSTICS` contain no codes. The only place the two are spliced is `formatErrors`, which prints `${where}${severity} ${err.code}: ${err.message}` (`lib/typeChecker/index.ts:555`) — a printing path, not the error object.

So if `AG8001` is thrown as `new Error(renderMessage(...))`, its `.message` reads "This file is a template with unfilled holes (#text) and cannot be run directly…" with no code anywhere in it, and the spec's headline example fails to match.

Pick one and write it down: the thrown error must carry a code-prefixed message (and the templates plan owns that, so the two documents have to agree), or the matcher reads a `code` field off the error, or matching happens against `formatErrors`-style output. Right now the spec's own example is broken.

## Suggested alternative: spawn the compile

Run `agency compile <file>` as a subprocess and match on a nonzero exit code plus a stderr substring.

This dissolves findings 1, 2, and 4 at once. `process.exit(1)` in the child is a normal nonzero exit to the parent, so parse failures, strict typecheck failures, closure failures, and codegen throws all behave identically. Stderr for the diagnostic paths is `formatErrors` output, which *does* include the code, so `"AG8001"` and `"AG8002"` match the way the spec's example assumes. And it tests the thing a user actually hits — `agency run template.agency` refusing — rather than an in-process function call that happens to sit behind it.

The runner already spawns a child per test case, so this is the house pattern, not a new one. Cost is one process spawn per such fixture, which is noise next to what these fixtures replace.

It also removes a smaller hazard the current design carries: `compile()` routes through the shared default session (`lib/cli/commands.ts:283-293` → `getDefaultSession()`), so a compile that throws halfway leaves that session's `compiledFiles` set and cached closure in a partial state, in the runner process, while other files are still being processed. The js-test path takes the same risk (`lib/cli/test.ts:1106-1111`), so there's precedent, but precedent for a hazard isn't an argument for repeating it.

## Altitude: does this need to be a runner feature?

Worth answering explicitly in the spec, because the cheaper option is already sitting there.

`lib/compiler/buildSession.test.ts` writes `.agency` fixtures to a temp dir and compiles them in-process (lines 49-88). A vitest test asserting `expect(() => session.compile(...)).toThrow(/AG8001/)` covers the codegen-throw case today, with no new `.test.json` field, no precompile carve-out, and no non-compiling file living in `tests/agency/`. And typechecker diagnostics are already tested directly against `typeCheck()` across `lib/typeChecker/*.test.ts` — which is where `AG8002` naturally belongs anyway, since it never reaches codegen.

What the runner mode buys over that is a real `.agency` file on disk in the tests tree, exercised through the same collection path as every other fixture. That is a genuine benefit, but the spec should make the argument rather than assume it. The argument gets considerably stronger with the subprocess approach, because then the test covers the user-visible CLI behavior, which no unit test does.

## Correctness details in the current draft

**The insertion point in §2 is wrong.** The spec says to add the branch "after the existing file-level skip handling and before the per-case loop." But `const total = tests.tests.length` runs at `lib/cli/test.ts:799`, *before* the skip check at 802. A `.test.json` with no `tests` array — which the spec recommends as the preferred shape — throws a TypeError on that line before your branch is ever reached. The new mode has to be handled before line 799, and §3 needs to make `tests` optional on the `Tests` type, which it currently doesn't mention.

**Say what happens to the file counters.** `TestStats` carries `passed`/`failed` *and* `filesPassed`/`filesFailed`/`failedFiles`, and the summary prints "Test Files" and "Tests" as separate lines (`scripts/agency.ts:736-738`). "Counts as one test" only specifies half of it.

**Stale `.js` in the other direction.** The spec deletes the sibling `.js` after an unexpected successful compile. It should also state the rule for a `.js` left behind by an *earlier* run, from before the fixture was made to fail — delete before compiling, so nothing can execute it.

**Coverage.** `agency test --coverage` maps a `.test.json` to its sibling `.agency` and compiles it for the source map (`lib/cli/coverage.ts:76-98`, called from the loop at 200-206). A thrown error there is caught and downgraded to a warning, so the throw-based design survives. A `process.exit(1)`-style failure would kill the report after the whole suite ran — one more reason to keep exit-path failures out of these fixtures, or to have coverage skip sources whose `.test.json` sets the new field. Worth a sentence either way.

**The other per-case fields are meaningless here.** The spec covers `retry`. Also decide on `timeoutMs`, `defaultTimeoutMs`, `llmMocks`, `fetchMocks`, and `fakeClock`. My preference is to reject rather than ignore: a fixture in this mode carrying LLM mocks is an author mistake, and a silent ignore hides it.

**Test 3 shouldn't be manual.** "Temporarily point the fixture at a wrong code, check by hand, don't commit" is a check that runs once and then rots. Extract the comparison into a small pure function — expected substring plus caught error in, pass/fail plus formatted message out — and let vitest drive both directions permanently. That refactor is worth doing on its own merits; it's the only part of this feature with any logic in it.
