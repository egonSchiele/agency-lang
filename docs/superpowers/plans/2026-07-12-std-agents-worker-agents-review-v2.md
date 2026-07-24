# Review v2: std::agents Worker Agents — Implementation Plan (rewrite)

**Reviewed:** `docs/superpowers/plans/2026-07-12-std-agents-worker-agents.md` (rewritten version)
**Against:** `docs/site/guide/guards.md`, `docs/site/guide/basic-syntax.md`, `stdlib/agency.agency` (`Feedback`/`review`/`verify` neighborhood), `lib/importPaths.ts` (+ tests), `stdlib/web/search.agency`, `lib/agents/agency-agent/subagents/verify.agency`, `code.agency`.
**Date:** 2026-07-12

## Verdict

The rewrite is a real improvement in *type design* — dropping the duplicated `Verdict`/`renderGaps`/`verifyArtifact` and reusing `Feedback`/`feedbackHasErrors`/`renderFeedback` from `std::agency` is the right call and resolves the earlier "duplicating existing code" finding. Money/duration literals (`$50.00`, `10m`), `std::web/search`, and the `WriteFailure` import all check out now.

**But the new `guard`-based control flow does not work as written.** All three agents mutate a variable declared *outside* the guard from *inside* it and then return it — which `guard`'s scoping explicitly forbids. As written, every agent returns an empty/stale value. This is a foundational, blocking error (G1/G2 below). Several earlier findings also survived the rewrite unchanged: the import-allowlist step is still wrong, the "wiring" tests still test only compilation, `verify`'s fail-open is still not implemented, and `syntaxHintFor`/`researchAgent` still have no behavioral tests.

---

## Blocking

### G1. `guard` does not expose inner mutations — all three agents return a stale value
`guards.md:28`: *"You don't have access to all the variables inside the guard, only to the return value."* A guard block is a value-producing scope; the only thing that escapes is what the block returns (as a `Result`).

Every agent violates this. `codingAgent` (Task 3):
```
let reply = ""
guard(cost: maxCost, time: maxTime) as {
  thread(...) { ... reply = llm(...) ... }   // mutates the OUTER reply from inside the guard
}
return reply                                  // reply is still "" out here
```
`reply` assigned inside the guard is invisible after it, so `codingAgent` returns `""`. Same bug for `researchAgent`'s `answer` (Task 4) and `agencyCodingAgent`'s `result` (Task 5, `result = writeAgency(...)` inside the guard, `return result` outside).

**Fix:** the guard block must *return* the value and the agent must *capture* it:
```
const captured = guard(cost: maxCost, time: maxTime) as {
  thread(...) { ...; ... }
  reply            // block's return value
}
```
The `let reply`/`let done`/`let msg`/`while` can all live *inside* the block; only the final value crosses the boundary. This forces G2.

### G2. `guard` returns `Result<T, GuardFailureData>` — the return types don't match and the trip case is unhandled
Once G1 is fixed, `captured` is `Result<string, GuardFailureData>` (`guards.md:29-40`), but `codingAgent`/`researchAgent` are declared to return plain `string`. You must `match`/unwrap:
```
return match (captured) {
  success(v) => v
  failure(_) => ???   // what does the agent return when the cap trips?
}
```
The plan's note — *"if `!done` never flips, `guard` trips on cost/time and aborts the block; `reply` holds the last attempt and is returned"* — is **false on two counts**: (1) `guard` does not "abort the block" and propagate; it returns a failure `Result` you must handle; (2) the last in-progress `reply` lived *inside* the tripped block, so it is **lost**, not returned. There is no partial-result-on-trip behavior for free. Decide explicitly what each agent returns when its budget trips (an error string? an empty string? change the signature to `Result<...>`?), and write it. `agencyCodingAgent` already returns a `Result`, so it can fold the guard failure into a `WriteFailure`, but that conversion still has to be written.

### G3. `verify` still does not fail open, despite the docstring (Task 1)
Same defect as v1, carried into the lifted function. The docstring says *"Fails open (empty success) on internal failure,"* but the body has no `try`:
```
let out: Result<Feedback[]> = success([])
thread(...) { const analysis = llm(...); const items = llm(...); out = success(items) }
return out
```
If either `llm()` throws, it propagates out of the `thread` and past `return out`; the `success([])` default is never returned. And no caller wraps it — `codingAgent`/`agencyCodingAgent`/the `verify.agency` delegate all call `verify(task)` bare. (`guard` won't save you: a thrown exception is not a cost/time trip.) Either wrap the two `llm` calls' failure path in `try` inside `verify`, or have every caller do `try verify(task)` and unwrap. Ship the mechanism or drop the claim.

### G4. `researchAgent`'s judge asks the LLM to emit a `Result` union (Task 4)
```
const fb: Result<Feedback[]> = llm("Judge the answer ...")
```
This annotates the structured-output schema as a `Result<Feedback[]>` — a `success | failure` tagged union — which the LLM cannot sensibly produce. Contrast the lifted `verify`, which correctly does `const items: Feedback[] = llm(...)` (a plain array) and then wraps it in `success(items)`. Make `researchAgent` consistent: `const items: Feedback[] = llm(...)` then gate on `feedbackHasErrors(success(items))` / render with `renderFeedback(success(items))`.

---

## Design gaps (survived the rewrite)

### D1. The import-allowlist step is still wrong — there is nothing to modify
Tasks 3/4/5, the File Structure section, and known-risk (d) all say to *"Modify the stdlib import allowlist (`lib/importPaths.ts`) so `std::agents/*` resolves (mirror how `std::web/*`, `std::ui/*` are allowed)."* I grepped: **`web/search`, `ui/layout`, `web`, and `agents/` appear nowhere in `importPaths.ts`.** There is no per-module allowlist. `isImportAllowed` gates by *kind* (`stdlib`), and stdlib modules resolve purely by path (`resolveAgencyImportPath` → `<stdlib>/agents/coding.agency`; `getStdlibFiles` walks recursively). `std::agents/coding` will resolve the moment the file exists — exactly like `std::web/search` does today with no allowlist entry. Delete every "modify the allowlist" step; the wiring test already proves resolution. (This was D1 in the v1 review and is unchanged.)

### D2. `verify` is still a mismatched checker for `agencyCodingAgent` (Task 5)
`verify` reconstructs a task's success check and runs a **file/program artifact on disk**. But `agencyCodingAgent`'s deliverable is the *return value* of `runCode(src)`, which the agent discards: `const ran = try runCode(src)` — `ran` is never read. For the plan's own efficacy task ("return the sum of [1,2,3]") there is no disk artifact, so `verify` finds nothing → `success([])` → `feedbackHasErrors` false → "done" on the first pass, having verified nothing. Meanwhile Task 6 asserts `runCode` yields `6` — a signal the agent throws away. Feed `runCode`'s `.data` into the verification (a judge over task + actual result), or have the generated program write a file `verify` can inspect. As-is the agencyCodingAgent "verify" loop is a no-op for compute tasks.

### D3. `match` with a binder inside a stepped `while` loop (Task 5)
`agencyCodingAgent` puts `match (result) { failure(f) => {...} success(src) => {...} }` inside `while (!done)`. `verify.agency:68-69` warns that binder patterns in stepped-loop bodies trip the codegen (`unwrapVerdict` was extracted precisely to keep a `match` out of the loop). Test this early; if it breaks, hoist the match into a plain `def`. (Also `failure(f)` binds `f` but only sets `done = true` — use `failure(_)`.)

### D4. Anti-patterns: duplication and inconsistency remain (AP1/AP2 from v1)
The `let msg = if context == "" then task else "${task}\n\n<context>\n${context}\n</context>"` context-builder is duplicated verbatim in `codingAgent` and `researchAgent` — extract `def withContext(task, context): string`. And the three loops are still three different shapes (coding/research: `while (!done)` with a flag; agency: `match`-in-`while`), so a reader can't relate them. Standardize the skeleton (guard-capture from G1 gives you a natural shared shape). The `Feedback` consolidation already fixed the *type* duplication — finish the job on the *loop* glue.

---

## Test review (mostly unchanged from v1 — the concerns were not addressed)

Break the code, and these tests still pass:

| Break this | Caught? |
|---|---|
| G1 (agents return stale `""`) | **No** — no test calls an agent and inspects a real return |
| G2 guard-trip returns wrong thing | **No** |
| G3 `verify` throws instead of failing open | **No** |
| Wrong tool / prompt / cap | **No** |
| `syntaxHintFor` returns wrong hint / never fires | **No** — no test |
| `researchAgent` returns garbage | **No** — no behavioral test |
| `verify` stuck always-`error:false` | **No** — strictness test only checks the error=true polarity |
| Any compile/typecheck error | Yes (the import forces compilation) |

### T1. The "wiring" tests still only prove the module compiles (Tasks 1/3/4/5)
Every wiring test is still `node xExported(): boolean { return true }` with the imported symbol referenced *only* in the `import` line, never in the body — so the comment "referencing the symbol proves it typechecks" is still inaccurate, and all four tests assert the same fact ("std::agents/... compiles"). None tests tools, caps, routing, or the verify→fix loop. With `guard` now the *only* thing bounding each loop, an untested cap is riskier than before. Replace the stubs with deterministic tests: (a) pure unit tests of any extracted helper (`withContext`, and a fail-open unwrap for G3); (b) mock-LLM tests (`useTestLLMProvider` / llm-mocks, observed via statelog) that feed a never-satisfied `verify` and assert the guard bounds the loop, and feed a satisfied `verify` and assert single-pass short-circuit.

### T2. `syntaxHintFor` (Task 2) is pure and untested — and the test pointer is stale
Task 2 says its test is *"covered by Task 7 efficacy"* — **there is no Task 7** (efficacy is Task 6), and Task 6's three cases don't include a `writeAgency`/`syntaxHintFor` case. `syntaxHintFor` is a pure `string → string` function: unit-test it directly (C-style-`for` error → while-loop hint; missing-`main` error → main hint; unrelated error → `""`). Also assert the hint is actually prepended to the retry prompt. Note the matches are loose (`re/main/` fires on any diagnostic containing "main"); tighten and test.

### T3. `researchAgent` has zero behavioral coverage
Task 6's efficacy list is coding + agencyCoding + verify-strictness. `researchAgent` is absent; only the compile-only wiring stub covers it. Add an efficacy case (a Wikipedia-answerable question, assert a cited answer) and ideally a mock-LLM test of the judge loop.

### T4. `verify` strictness test checks only one polarity (Task 6)
Seeding a wrong-format file and asserting `feedbackHasErrors == true` is good, but a `verify` that *always* reports an error passes it too. Add the mirror: a correctly-formatted artifact → `feedbackHasErrors == false`. Both polarities are needed to pin the behavior.

### T5. Efficacy tasks skip the loop under test
`codingAgent`'s "write `42\n`" is nailed on attempt 1, so the verify→fix loop never iterates — delete the loop and the test still passes. Pick an output-contract task the model plausibly gets wrong first (exact JSON keys, no trailing newline) so the loop has to fire. (The switch to a relative `./answer.txt` + temp dir did fix the earlier `/out/` path concern — good.)

---

## Minor / nits

- **N1. Duplicate import.** `stdlib/agency.agency:2` already imports `{ guard, systemMessage } from "std::thread"`. Task 1 Step 2 re-imports `systemMessage` (and the agents use `guard` — fine, but note it's already available in `agency.agency`). Add only the new `std::shell` names; don't double-import. (Confirmed no cycle: `std::shell`/`std::thread` do not import `std::agency`.)
- **N2. Dead code after delegation.** Once `subagents/verify.agency`'s `verify` delegates to `std::agency::verify`, its local `verifyTools`/`verifySysPrompt` become unused. Remove them. Confirm `code.agency` still gets `renderGaps`/`unwrapVerdict` (it uses them at ~501/499) — those stay.
- **N3. `ran` unused (Task 5).** `const ran = try runCode(src)` discards the result and swallows the failure — see D2. Use it or fold its failure into the feedback.
- **N4. `session:` re-adds the system message.** `verify` (and the agents) keep `session: "verify"`/`"coding"`/`"research"` while adding `systemMessage(...)` unconditionally each call; a resumed same-session thread re-appends it. Drop `session:` for a genuinely fresh thread, or gate the `systemMessage`.
- **N5. Self-Review overclaims.** It asserts "Type consistency ✓" but G2 (guard `Result` vs `string`) and G4 (LLM emitting a `Result`) are type errors, and G1 is a scoping error — none were compile-checked. Recommend running `pnpm run ast`/`make` on each snippet before its commit step (the TDD structure already supports this).

---

## Credit (what the rewrite got right — keep)
- Reusing `Feedback` + `feedbackHasErrors` + `renderFeedback` instead of a parallel `Verdict`/`renderGaps` type — resolves the v1 "duplicating existing code" finding.
- File-per-agent modules resolve by path with no barrel — clean, and (per D1) needs no allowlist plumbing.
- Money/duration literal signatures (`$50.00`, `10m`) are valid `number`s (`basic-syntax.md:297-303`).
- `std::web/search` exists with a `search` export; that import is valid.
- Lifting `verify` into `std::agency` (out of `lib/agents/`, which stdlib can't import) is the correct home — just finish G3 and D2.
</content>
