# Review: std::agents Worker Agents — Implementation Plan (Part 1 of 2)

**Reviewed:** `docs/superpowers/plans/2026-07-12-std-agents-worker-agents.md`
**Against:** the spec, `verify.agency`, `code.agency`, `stdlib/agency.agency` (`writeAgency`), `lib/importPaths.ts`, `docs/site/guide/basic-syntax.md`, and existing `tests/agency` fixtures.
**Date:** 2026-07-12

## Verdict

The overall shape is sound: TDD per task, each agent anchored to a proven template (`verify.agency` / `code.agency`), `plannerAgent` deferred, a two-tier (wiring + real-LLM) test story, and the composition-not-configuration constraint carried verbatim from the spec. The syntax claims I could verify hold (`if…then…else` expressions and `=~`/`re/…/` are real — `docs/site/guide/basic-syntax.md:68,255`; the test-fixture JSON schema matches existing fixtures).

But the plan's own "Known risk" caveat — *"several agent bodies must be checked against the guide and templates"* — is doing a lot of load-bearing work, and **at least three code snippets do not compile as written.** The Self-Review's "Type consistency ✓" claim was not actually compile-checked. Fix the blocking items below before executing, and reconsider the two design gaps (verifyArtifact-for-Agency and the unnecessary allowlist step).

---

## Blocking (won't compile / breaks a stated invariant)

### B1. `verifyArtifact` does NOT fail open, despite its docstring (Task 3)
The docstring says *"Fails open (satisfied=true) on any internal failure so verification never blocks,"* and the design note repeats it. But the implementation has no `try` anywhere:

```
let result: Verdict = { satisfied: true, gaps: [] }
thread(...) { ... const analysis = llm(...); const parsed = llm(...); result = parsed }
return result
```

If either `llm()` throws, the exception propagates straight out of the `thread` block and aborts the caller — the default `result` is never returned. The template's fail-open is not in `verify()` itself; it comes from the **caller**: `code.agency:498` does `try verify(originalUserMsg)` then `unwrapVerdict(...)` (`verify.agency:70-80`). The plan dropped `unwrapVerdict` and the caller-side `try`, so the fail-open guarantee is gone. `codingAgent` and `agencyCodingAgent` also call `verifyArtifact(task)` bare.

**Fix:** port `unwrapVerdict` + `failOpenVerdict` into `std::agents` and have every caller do `unwrapVerdict(try verifyArtifact(task))`, or wrap the two `llm` calls' failure path inside `verifyArtifact`. Don't ship the fail-open claim without the mechanism.

### B2. `researchJudgePrompt` references out-of-scope names and is dead (Task 6)
```
static const researchJudgePrompt = "Judge... Task: ${task}\n\nAnswer:\n${answer}"
```
At module scope neither `task` nor `answer` exists — this is a compile error. It's also never used: the function body inlines the identical string in the `llm(...)` call. Delete the const, or make it a `def researchJudgePrompt(task, answer): string` and call it.

### B3. `agencyCodingAgent` uses `WriteFailure` but never imports it (Task 7)
The signature is `Result<string, WriteFailure>` and the Interfaces section lists `WriteFailure` as consumed, but the import line is `import { writeAgency, runCode } from "std::agency"`. Add `WriteFailure` (it's exported from `stdlib/agency.agency:579`).

---

## Design gaps (rethink before executing)

### D1. Task 1 Step 4 (import allowlist) is unnecessary and factually wrong
There is **no per-module stdlib name allowlist** in `lib/importPaths.ts`. `isImportAllowed` gates by *kind*: `isImportAllowed("std::agents", { allowKinds: ["stdlib"] })` is already `true` because `std::agents` classifies as kind `"stdlib"` (`importPaths.ts:185-197,222-241`). Stdlib modules resolve purely by path — `resolveAgencyImportPath` maps `std::agents` → `<stdlib>/agents.agency` (`importPaths.ts:501-516`), and `getStdlibFiles` walks the dir recursively. **Creating the file is sufficient; nothing to register.**

The plan also misreads the test it cites: it claims `importPaths.test.ts` asserts `isImportAllowed("fs", { allowKinds: ["stdlib"] })` — but the actual assertion (line 497) is that this returns **`false`** (`"fs"` is kind `"node"`). Drop Step 4 entirely; the Task 1 smoke test already proves resolution end-to-end. (This is the "does the codebase already own these semantics" altitude question — here it does.)

### D2. `verifyArtifact` is a mismatched verifier for `agencyCodingAgent` (Task 7)
`verifyArtifact` reconstructs a task's success check and runs a **file/program artifact on disk** via `useAgentCwd` tools. But an Agency program's deliverable is `runCode`'s **return value**, and the agent discards it: `const ran = try runCode(src)` — `ran` is never read. For Task 8's own example ("return the sum of [1,2,3]") there is no disk artifact, so `verifyArtifact` finds nothing and (once B1 is fixed) fails open → no real verification. Meanwhile Task 8 asserts `runCode` yields `6`, a signal the agent itself ignores. Either verify against `runCode`'s `.data` (a judge over task + result), or make the generated program write a file and keep `verifyArtifact` — but pick one coherent story.

### D3. `match` with binder + block-`return` inside a `while` loop (Task 7)
```
while (rounds <= 1) {
  match (last) {
    failure(f) => { return last }
    success(src) => { ... return last / reassign ... }
  }
}
```
`verify.agency:68-69` explicitly warns that binder patterns in stepped-loop bodies trip the codegen ("the stepped-loop codegen doesn't handle" binder-in-`if`; `unwrapVerdict` was extracted to a plain `def` precisely to avoid it). A `match` binder with `return` arms inside a `while` is the same family. Verify empirically early, and if it breaks, hoist the match into a plain `def` that returns a small status value the loop switches on. The plan currently only says "confirm match/try usage against docs" — that's not enough given the known codegen limitation.

---

## Medium

### M1. `thread` session gating dropped but `session:` kept (Task 3, and coding/research)
The plan removes `verify.agency`'s `first` one-time-systemMessage gate ("a fresh thread each call is fine here") but keeps `session: "verify"`. The `session` key is what makes a thread *resume* rather than start fresh, so a persisted session re-adds the system message on every call. Either drop `session:` (genuinely fresh thread each call) or keep a gate. Same question for `session: "coding"` / `"research"`.

### M2. `syntaxHintFor` heuristics are too loose, and there are 3 injection sites (Task 4)
`errors =~ re/main/` matches any diagnostic text merely containing "main"; `re/for\s*\(/ && re/;/` fires on any error with a `for(` and a semicolon anywhere in the rendered blob — easy to inject the wrong hint. Also `writeAgency` sets `prompt` at **three** sites (parse-fail `agency.agency:656-660`, typecheck-errors `661-669`, compile-fail `671-679`), not one; the plan says "the retry re-prompt" singular. Apply the hint at all three (or centralize the re-prompt construction) and tighten the matches (anchor to actual diagnostic messages).

### M3. `codingAgent` "cap at 2 rounds" is actually up to 3 LLM calls (Task 5)
`while (!done && rounds <= 2)` with `rounds` starting at 0 and incremented only on failure runs at rounds 0, 1, 2 → 3 `llm` calls. Either the comment or the bound is off; align them (`rounds < 2` for 2 total, or update the wording).

---

## Low / nits

- **N1 (Task 7):** `const ran = try runCode(src)` — `ran` is unused. Use it (see D2) or drop the binding.
- **N2:** `std::shell` is imported twice (Task 3: `ls, glob, grep, exec`; Task 5: `bash`). Consolidate to one import line; confirm duplicate-module imports are accepted by the parser.
- **N3 (Self-Review):** "Type consistency ✓" and "no placeholders" were asserted without compile-checking — B1/B2/B3 all survive. Recommend the implementer run `pnpm run ast` / `make` on each snippet as it lands (the plan's TDD-per-task structure already supports this; make it explicit that a snippet must compile before the commit step).

---

## Things the plan got right (keep)

- Template-anchoring each agent to `verify.agency` / `code.agency:454-505` and calling out the exact files to read first.
- Deferring `plannerAgent` to Part 2 with the recursion bound stated structurally.
- Two-tier testing (deterministic wiring on PR, non-blocking real-LLM efficacy post-merge) and `pnpm run a test` as the runner (matches the agency-test-runner convention).
- The strict-vs-fail-open verify prompt deviation is well-reasoned — just make sure B1 keeps the fail-open-on-error half that the prompt change alone doesn't provide.

---

## Anti-pattern audit (`docs/dev/anti-patterns.md`)

**Direct answer to "does it encapsulate the imperative 'how' behind a declarative interface?": No — it does the opposite.** The plan inlines a near-identical verify→fix loop into all three agents, in three subtly different shapes, and leaves the genuinely-extractable pure pieces un-factored. Details below, worst first.

### AP1. "Imperative code everywhere" — the verify→fix loop is copy-pasted, not encapsulated
This is the anti-pattern the doc weights most heavily ("split the *what* from the *how*"). The same "how" appears three times (Tasks 5/6/7):

```
let X = ""
let msg = if context == "" then task else "${task}\n\n<context>\n${context}\n</context>"
let rounds = 0
thread(...) {
  systemMessage(...)
  let done = false
  while (!done && rounds <= N) {
    X = llm(msg, { tools: ... })
    <verdict>
    if (verdict.satisfied) { done = true }
    else { msg = "...${renderGaps(verdict.gaps)}..."; rounds = rounds + 1 }
  }
}
return X
```

Only three things vary per agent: the **tool list**, the **verifier**, and the **cap**. Everything else — the context-prefix construction, the `done`/`rounds` bookkeeping, the gap re-prompt string, the fail-open unwrap — is glue that should live in one place. The plan's own Global Constraints say *"Shared logic is only ever a plain callable helper,"* which is exactly the right framing — but the execution then inlines the helpers instead of writing them.

**Important nuance (and why this is still valid):** the spec correctly rejected a full `verified(makeAgent, criteria)` combinator — Agency has no lambdas, one trailing block per call, and re-invoking an agent body throws interrupts (the `#513` family). I am **not** asking for the combinator back. But that rejection was over-applied: it justified skipping the higher-order combinator and then also skipped the *pure, first-order* helpers that hit none of those blockers. At minimum, extract:

- `def withContext(task: string, context: string): string` — the `if context == "" then task else "…<context>…"` builder, duplicated verbatim in all three agents.
- `def gapReprompt(gaps: string[]): string` — the "here are the gaps, fix them" message wrapper around `renderGaps`.
- `def unwrapVerdict(r: Result<Verdict>): Verdict` — port it from `verify.agency` (also fixes B1's fail-open hole).

The per-agent bodies then shrink to *what differs* (tools + verifier + cap), and the "how" changes in one place. That is the declarative-interface split the doc asks for, achievable within Agency's limits.

### AP2. "Inconsistent patterns" — the same loop, implemented three different ways
Compounding AP1: the three loops aren't even the *same* imperative shape. `codingAgent` and `researchAgent` use a `done`-flag `while` (caps `2` and `1` respectively); `agencyCodingAgent` (Task 7) uses a completely different `match`-with-`return`-arms loop and no `done` flag. A reader can't relate one to the next. The doc's remedy is "standardize on one pattern." Pick one loop skeleton (ideally the extracted helpers from AP1) and use it in all three.

### AP3. "Duplicating existing code" — justified, but then finish the job
`Verdict`, `renderGaps`, and `unwrapVerdict` already exist in `verify.agency`. Re-implementing them in `std::agents` is defensible — `verify.agency` lives under `lib/agents/`, which stdlib cannot import from (worth stating explicitly in the plan as the reason). But the plan copies `Verdict` + `renderGaps` and **drops** `unwrapVerdict`/`failOpenVerdict` — the one piece that carries the safety invariant (see B1). If you must duplicate across the module boundary, duplicate the whole proven unit, not two-thirds of it.

### AP4. Swallowed failure (`try` without surfacing) — cousin of "try-catch without logging"
Task 7: `const ran = try runCode(src)` then `ran` is never read. A runtime failure of the generated program is silently discarded — neither surfaced to the verifier nor recorded. `verify.agency`'s fail-open path deliberately keeps the error string in `gaps` ("verification could not run: ${err}") precisely so it shows up in the trace. Mirror that: fold `runCode`'s failure into the verdict/gaps (and see D2 — its success value should feed verification, not be thrown away).

### AP5. Magic numbers — and they contradict the plan's own words
The round caps are inline literals (`rounds <= 2`, `rounds <= 1`). The Global Constraints explicitly say *"Caps (`maxRounds`, `maxCost`) stay internal constants."* Make them named `static const`s (e.g. `MAX_CODING_ROUNDS`) so the code matches its stated intent and the cap is greppable.

### Anti-patterns checked and NOT present (for the record)
- **Nested ternaries:** the `if…then…else` uses are single-level. Fine.
- **Leaky abstractions:** the public signatures (`(task, context) -> result`) are clean and hide internals — this part is good.
- **Useless special cases:** the empty-`context` branch is a real case (avoids emitting empty `<context>` tags), not a useless one.
- **Order-dependent mutable state:** the loop mutables (`msg`/`rounds`/`done`) are inherent to a retry loop, not the straight-line const-able derivations that anti-pattern targets. Low concern — though extracting the helpers (AP1) would remove most of them anyway.

**Net:** the *philosophy* stated in the plan (plain composable helpers, minimal signatures) is aligned with the anti-pattern doc; the *implementation* under-delivers by inlining a duplicated, inconsistent imperative loop where three small extracted helpers would give the declarative split the doc calls for — without needing the combinator the spec rightly rejected.

---

## Test review — will these tests fail when the code breaks?

Short answer: **mostly no.** The deterministic tier is four tests that collectively prove only "the module compiles," and the real-LLM tier exercises trivial happy paths that pass even if the agents' central feature — the verify→fix loop — is deleted. Concretely, here is what survives with tests still green:

| Break this | Caught? |
|---|---|
| Delete the entire verify→fix loop from `codingAgent` (make it one raw `llm()` call) | **No** |
| Off-by-one / wrong round cap | **No** |
| `verifyArtifact` fail-open hole (B1) — throws instead of failing open | **No** (no test) |
| `verifyArtifact` always returns `satisfied=true` (verifier disabled) | **No** — strictness test only checks the *false* case |
| `syntaxHintFor` (Task 4) returns the wrong hint / never fires | **No** (no test at all) |
| `researchAgent` returns garbage | **No** — it has no behavioral test |
| Break `renderGaps` join | Yes |
| `verifyArtifact` always returns `satisfied=false` | Yes (strictness test) |
| Any typecheck/compile error in the module (incl. B2, B3) | Yes (the import forces compilation) |

### T1. The "wiring" tests (Tasks 5/6/7) don't test wiring — they test that the file compiles
Each is:
```
import { codingAgent } from "std::agents"
node codingAgentExported(): boolean { return true }   // comment: "referencing the symbol proves it typechecks"
```
The body **never references `codingAgent`** — the comment is wrong. The only thing under test is that `import … from "std::agents"` resolves, which forces module compilation. So all three tests assert the identical fact ("the module compiles"); they are redundant with each other and with the Task 1 smoke test. None asserts anything about *that* agent's tools, prompt, cap, routing, or loop.

This also breaks the spec's explicit PR-tier promise: *"deterministic mock-LLM tests … assert wiring (each agent registers, **routes**, **caps apply**)."* Routing and caps are tested nowhere. And these aren't mock-LLM tests at all — they inject no LLM.

**Fix:** replace the three `return true` stubs with tests that actually exercise logic without a live LLM:
- **Deterministic, pure** (highest value, zero LLM): unit-test the extracted helpers. `unwrapVerdict(failure("boom"))` must return `{ satisfied: true, gaps: ["… boom"] }` — this pins the B1 safety invariant and is completely pure. Same for `withContext`/`gapReprompt` if extracted (see AP1).
- **Deterministic, mock LLM** (the spec's actual intent): agency execution tests can inject scripted LLM responses (`useTestLLMProvider` / llm-mocks). Feed a verdict-that's-never-satisfied and assert the agent stops after exactly the cap (proves "caps apply"); feed a satisfied verdict first and assert it short-circuits without a second round (proves the loop routes on the verdict). Use the statelog to observe calls, since the mock can't inspect message contents directly.

### T2. `syntaxHintFor` (Task 4) is pure and untested
The Task 4 upgrade adds `syntaxHintFor(errors): string` — a pure string→string function, the easiest thing in the whole plan to test deterministically — and the plan writes **no test for it**. Add cases: a C-style-`for` error string → the while-loop hint; a missing-`main` error → the main hint; an unrelated error → `""`. Also assert (via statelog or a mock-LLM retry) that the hint is actually *prepended to the re-prompt*, not just computed — the injection is the point, and the plan notes there are three prompt-set sites where it must land. Right now Task 4's entire behavioral claim rests on one line of Task 8 prose ("a task that previously produced invalid code now compiles") that isn't even in the Task 8 test list.

### T3. `researchAgent` has zero behavioral coverage
Task 8's efficacy list is codingAgent + agencyCodingAgent + verifyArtifact-strictness. **`researchAgent` is absent.** Its only test is the `return true` wiring stub. The grounding-judge loop, the cite-or-say-so behavior, and the "degrades when search is off" case the Self-Review flags are all untested. Add at least one efficacy case (a question answerable from Wikipedia, assert a cited answer) and, ideally, a deterministic mock-LLM test of the judge loop shape.

### T4. The real-LLM cases test happy paths that skip the feature under test
- **codingAgent** ("write `42\n`"): a task the model nails on attempt 1, so the verify→fix loop never iterates. If you deleted the loop entirely, the test still passes. To test the *loop*, pick a task whose first attempt plausibly misses the output contract (e.g. an easy-to-get-wrong format — no trailing newline, exact JSON keys) so the verify step has to catch and re-prompt. Otherwise codingAgent is indistinguishable from a bare `llm()` under test.
- **agencyCodingAgent** ("sum of [1,2,3]"): the assertion runs `runCode` in the *test harness* and checks `6`. That validates the generated source, but the agent's own verification path (`verifyArtifact`, which per D2 is mismatched and ignores `runCode`'s value) is never validated — a broken internal verify loop passes this test.
- **verifyArtifact strictness**: only the `satisfied == false` polarity. Add the mirror case — a correctly-formatted artifact must return `satisfied == true` — or a verifier stuck at "always false" passes.

### T5. `renderGaps` (Task 2) — good, add the single-element boundary
The two cases (2-element, empty) are the right core. Add `renderGaps(["x"]) == "- x"` — the one-element case is where a join off-by-one (stray leading/trailing newline) would hide.

### T6. Path/cwd assumption in the codingAgent efficacy test
The task text names an absolute `/out/answer.txt`, but the tools are `useAgentCwd`-partialed and the case runs "in a temp dir." Confirm the assertion reads the file from the same working directory the agent actually wrote to (the agent cwd), not a literal `/out`, or the test fails for the wrong reason (or, worse, the model writes to a path the assertion doesn't check and the test is meaningless).

### Missing test cases — summary
1. **Fail-open invariant** (`unwrapVerdict` on a `failure`) — pure, safety-critical, currently untested. **Highest priority.**
2. **Cap enforcement** for each agent — mock-LLM, spec-promised, untested.
3. **Verdict short-circuit / routing** (satisfied → no extra round) — mock-LLM, untested.
4. **`syntaxHintFor` mapping + injection** (Task 4) — pure, untested.
5. **`researchAgent` behavior** — no test exists.
6. **`verifyArtifact` positive case** (correct artifact → satisfied) — only the negative is tested.
7. **`context` param actually reaches the prompt** — untested for all three agents.
8. **`renderGaps` single-element** — boundary gap.
</content>
</invoke>
