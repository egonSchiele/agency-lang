# Feedback: Match Expressions Implementation Plan

**Reviewed:** `docs/superpowers/plans/2026-07-01-match-expressions.md`
**Against spec:** `docs/superpowers/specs/2026-07-01-match-expressions-design.md`

## Overall

The plan is thorough, well-sequenced (Task 9 migration before Task 10 error
activation), TDD-driven throughout, and grounds most steps in concrete
`file:line` references. Interface contracts between tasks are declared, and
verification steps consistently log to files (respecting CLAUDE.md's cost note).
Ordering justification is explicit and correct.

The rest of this document lists substantive issues in roughly decreasing order
of importance. Nothing below is a "don't ship" — most are gaps that will bite
during Task 6 or Task 7 unless addressed up front.

---

## Substantive issues

### 1. Task 7: yield expressions have no scope, so union synthesis will silently break for pattern arms (HIGH)

`lowerMatchExpressionCore` in Task 6 does `yields.push(stmt.value)` — a raw
`Expression` reference. Task 7 then calls `synthType(y, scope, ctx)` on each
stored yield. But **which scope?** A pattern arm like `success(v) => v` binds
`v` in a per-arm scope; the outer scope has no `v`. If `synthType` runs against
the outer (assignment) scope, this either errors ("unknown identifier") or
resolves to the wrong binding.

Options:
- Store `{ expression, armIndex }` and have Task 7 look up the arm scope from
  the CU's scope table (requires the scope builder to have visited the lowered
  match by then — probably it has, since typechecking runs after buildScopes).
- Drop the `yields` array entirely and have Task 7 walk the tagged `MatchBlock`
  in place: for each arm, look up its scope, find the `matchYield` node(s), and
  synth their `value` against the arm scope. This is cleaner and also matches
  what the typechecker will need anyway for checked-position per-arm checking.

Recommended: **drop `yields` from `Assignment.matchExprSource` and have Task 7
resolve arm scopes at check time.** The typechecker already indexes scopes by
node id (verify) — this is the same pattern used for `IfElse` branches.

### 2. Task 7: nested `return match(...)` produces a `varRef` yield whose type is not in any scope (HIGH)

Task 6 Step 4(c) handles nested `return match(...)` by lowering the inner match
and pushing `inner.valueRef` (i.e. `varRef("__matchval_<innerId>")`) into the
outer `yields`. But `__matchval_<innerId>` is a synthetic local; unless it is
registered as a scope variable with its own synthesized union type, Task 7's
`synthType` on that varRef will fail.

Fix: when lowering an expression match, register `__matchval_<matchId>` as a
scope variable in the enclosing scope with the match's synthesized union type.
This has to happen through the scope builder, not directly in the lowerer.
Alternative: propagate the type via a side-table keyed on matchId and teach
`synthType` to consult it for `__matchval_*` names.

Either way this needs to be added to Task 6 or a new step in Task 7.

### 3. Task 4: `_matchExit` clearing in `ifElse` — try/finally, not "trace every exit" (MEDIUM)

Step 3 says: "Place the clear after the existing branch-execution logic but
before the final return, and ALSO on the early-return path taken when a branch
body completed — trace the method and ensure every exit point after branch
execution passes through the clear."

This is fragile. A single missed exit path silently corrupts unwind state
(nested matches, adjacent statements, later loop iterations all suddenly become
"skip"). Wrap the branch execution in `try { ... } finally { if (opts?.matchId
!== undefined && this._matchExit === opts.matchId) this._matchExit = null }`
so the clear is unavoidable. Add a runtime unit test that throws from inside a
branch body and asserts the flag is still cleared.

Also add a test: **outer match's `exitMatch` must not be swallowed by an inner
non-match `ifElse`.** The current opts-based clearing handles this (inner
ifElse has no matchId or a different one), but a test is cheap insurance.

### 4. Task 4: handler registration inside arm bodies after `_matchExit` — spec calls handlers "safety infrastructure" (MEDIUM)

Suppose an arm body is `[stmt1, if (cond) { return X }, pushHandler(...),
stmt3]`. If `cond` is true, `return X` sets `_matchExit`. `shouldSkip()` then
skips the remaining arm statements, including the `pushHandler`. That is
**correct** intent-wise (we're unwinding), but CLAUDE.md flags handlers as
never-skip infrastructure.

The plan needs an explicit design note: **"handlers registered *after* the
yield point in an arm are intentionally skipped, mirroring how `return` from
a function skips subsequent registrations."** Then add one execution test
covering this scenario (a handler declared textually after a nested-if
`return` and confirming it does NOT fire when the yield path is taken).
Without this, a code reviewer will (correctly) raise the concern.

### 5. Task 5: baseAtom backtracking risk with `parseError` (MEDIUM)

`matchBlockExprParser` sequence is `str("match") → char("(") → exprParser →
char(")") → optionalSpaces → char("{") → parseError(...)`. If `match(r)` at
an expression site is followed by something other than `{`, `char("{")` must
fail cleanly and `or(...)` in `baseAtom` must fall back to `valueAccessParser`.

Two risks worth verifying explicitly in Step 3:
1. Does tarsec's `or` backtrack after `char("{")` has consumed no input but
   `str("match")` / `char("(")` / `exprParser` / `char(")")` did? Some parser
   combinator libraries commit after any consumption. If tarsec does, wrap the
   whole thing in an explicit backtracking `attempt(...)` combinator (verify
   its name; `tarsec` has one).
2. The third test (`const y = match(r)` — no braces — still parses as call) is
   the right regression, but add a fourth: `const y = match(r) + 1` (call form
   followed by operator, in a full expression context) to prove backtracking
   works past the `)`.

### 6. Task 6: `alwaysYields` and `rewriteReturnsToYields` — nested-match traversal (MEDIUM)

`rewriteReturnsToYields` has `case "matchBlock": return stmt;` (correct — inner
match owns its returns). But `containsReturn` (used inside the concurrency-
block guard) must apply the same rule, or it will flag legitimate inner-match
returns as illegal cross-boundary returns. Add an explicit "does not descend
into nested `matchBlock` arms" contract to `containsReturn` and one test.

Also: `alwaysYields` treats `for`/`while` as never yielding on all paths, which
is correct, but the plan should note that this means

```
_ => {
  for (x in xs) { return x }
}
```

is a compile error even though it may yield at runtime — matching the spec's
"syntactic all-paths-yield" (v1 restrictions #4). Add a test asserting this
errors so the choice is nailed down.

### 7. Task 6: `lowerMatchBlock` re-entry with expression-tagged match (MEDIUM)

The plan calls `this.lowerMatchBlock(tagged)` (tagged = the match with
`matchExprId` set), then post-hoc walks the resulting statements and sets
`matchExprId` on the root `matchBlock` / `ifElse` / scrutinee-assignment. But
what if `lowerMatchBlock` internally invokes `this.lower(arm.body)` (which
recursively re-enters lowering, including `lowerAssignment`)? Any nested
expression matches inside arm bodies are lowered on that pass. Confirm:

- The recursive `this.lower(arm.body)` call in `lowerMatchBlock` will encounter
  a `const y = match(...)` inside an arm body and dispatch to
  `lowerAssignment` → `lowerMatchExpression`. Verify by reading
  `lowerMatchBlock`'s current arm-body handling (foldArms, buildIfChain...);
  if it does NOT feed arm bodies through the general lowering pipeline, this
  needs to be threaded in Task 1 Step 6 or Task 6.

### 8. Task 6: `matchYield` inside `for`/`while` won't compile correctly (MEDIUM)

`rewriteReturnsToYields` recurses into `for`/`while` bodies and converts
`return X` inside them to `matchYield`. The `matchYield` compiles to
`__matchval_M = X; runner.exitMatch(M); return;` (Task 4 codegen). Inside a
loop iteration callback, `return` returns from the iteration callback — Task 4
adds `if (this._matchExit !== null) break;` to `loop()`/`whileLoop()` after
each iteration, which correctly breaks the loop. Good.

But: verify that `runner.exitMatch()` inside a nested `ifElse` inside a loop
inside an arm correctly propagates back out through both the ifElse and the
loop before the arm's owning ifElse clears. This is exercised by the test
matrix in Task 8 Step 4 (interrupt-in-match-in-loop) if — and only if — the
test's arm body has a nested `if` with `return`. Consider adding a dedicated
Task 8 test: match arm with `for (...) { if (...) return X }`, no interrupt,
just verifying the value and that trailing arm statements did not run.

### 9. Task 4: `exitMatch` semantics inside `parallel`/`fork`/`race`/`thread` (LOW — spec-forbidden but worth defensive test)

Spec v1 restriction #3: "return-to-match may not cross a concurrency boundary."
Task 6 catches this at lowering time via `containsReturn` check in the
concurrency-block case. Good. But it's worth adding one runtime assertion (or
at least a comment in the runner): if `_matchExit` is somehow set inside a
`parallel` child (should be impossible after Task 6's guard), what happens?
Currently the flag is a scalar on the runner — a race between parallel arms
could clobber it. Because Task 6 makes this impossible via a compile error,
this is a defense-in-depth concern; a comment suffices.

### 10. Task 1 Step 5: `matchArmBlockParser` and `bodyParser` whitespace handling (LOW)

`bodyParser` likely consumes trailing newlines/optional-space; the arm-block
wrapper then expects `char("}")`. Verify by reading `bodyParser`'s tail
behavior. If `bodyParser` consumes an optional trailing newline but not enough
whitespace to reach the `}`, Step 5 needs an extra `optionalSpacesOrNewline`
before `char("}")`. The plan does include one; just verify against a real
sample after implementation.

Also: the plan's third parser test asserts `=> { label: "hi" }` **fails** to
parse. Confirm that failure comes from *inside* the block parser (label being
an invalid statement) and doesn't fall through to `exprParser`'s object literal
path. If `or(matchArmBlockParser, exprParser)` first commits to the block via
`char("{")`, this works. Add an explicit assertion that the error message
mentions block/statement, not "object literal".

### 11. Task 4: mustache template edit and `pnpm run templates` (LOW)

The plan mentions `pnpm run templates` once. CLAUDE.md says only edit
`.mustache` files; ensure the generated `.ts` is regenerated before running
any codegen tests. Also, the template change adds a conditional 4th argument
— verify the emit for the "no-else, no-matchId" case is unchanged (a
byte-identical fixture diff of existing `matchBlock.mjs` after Task 4 proves
this).

### 12. Task 6: `matchExprSource.yields` array vs. arm re-lookup (design choice, follows from #1/#2)

If issues #1 and #2 push us toward looking arms up in the tagged MatchBlock at
check time rather than storing raw expression references, `matchExprSource`
becomes just `{ matchId: number }` (the tag). This is arguably cleaner and
avoids stale-reference bugs after any subsequent AST rewriting. Consider it
during Task 6 design.

### 13. Missing coverage: module-level `const x = match(...)` (LOW)

Init-topsort orders module-level `const` initializers by dependency
(`docs/dev/init-topsort.md`). A module-level expression match must:
- register `__matchval_<id>` in the correct init plan;
- have its scrutinee's dependencies participate in the topsort.

The plan does not exercise this. Add either an execution test or explicitly
declare it out of scope for v1 (with a follow-up ticket). If the lowering
produces standard statements consumed by init-topsort's existing machinery,
it may Just Work; verify with one test.

### 14. Task 11: docs list doesn't mention the `AGENTS.md` files under `docs/site/` (LOW)

Some doc directories have per-directory `AGENTS.md` guidance. Task 11 should
scan for them (`ls docs/site/**/AGENTS.md`) and follow any relevant
instructions when editing pattern-matching.md and basic-syntax.md.

---

## Smaller notes

- **Task 1 Step 6 grep list:** the plan already lists `flowBuilder.ts:213`,
  `foldArms:397`, and the walker; also grep for `MatchBlockCase` type usages
  outside the parser (imports may need `AgencyNode` added). One command:
  `rg -n 'MatchBlockCase|matchBlockCase' lib/` — save to file, address each hit.
- **Task 3 fixture inspection:** after `make fixtures`, the plan says to
  eyeball substep IDs. Consider adding a scripted assertion in the fixture
  diff (grep for `runner.step(0,` occurrences per arm) so this is not a
  human-attention step.
- **Task 6 error location fallback:** `arm.body[0]?.loc ?? arm.caseValue === "_" ? undefined : (arm.caseValue as any).loc` — operator precedence bug.
  `??` binds tighter than `?:`. Parenthesize: `arm.body[0]?.loc ?? (arm.caseValue === "_" ? undefined : (arm.caseValue as any).loc)`.
- **Task 8 Step 5 handler test:** the plan defers scenario details to
  discovery-during-implementation ("read an existing handle test"). That's OK,
  but the ONE required assertion — the handler must fire on both the normal
  and post-interrupt-resume paths — should be spelled out here so the executor
  cannot skip it.
- **Task 9 object-literal arms in stdlib/policy.agency:** the plan hedges
  between `pat => ({ ... })` and `pat => { return { ... } }` depending on
  parenthesized-object-literal support (decided in Task 1 Step 2). Make sure
  Task 9's grep pass picks up whichever form landed and rewrites consistently.
- **Commit-message policy:** several proposed messages use backticks and
  parentheses. CLAUDE.md only forbids apostrophes on the command line;
  backticks are fine as long as they aren't shell-interpreted. Consider
  writing every commit message to `/tmp/msg` and using `git commit -F` as the
  default pattern to eliminate the class of issue.

---

## Spec alignment

Task coverage against the spec sections:

- **Syntax / block arms / `=> {` rule / AST change:** Tasks 1, 2, 5 — good.
- **Semantics of return / nearest-value-scope / `return match(...)`:** Tasks
  4, 6 — good, modulo issues #1, #2, #3, #6.
- **Breakage and migration:** Tasks 9, 10 — good; order correct.
- **Expression-position rules:** Tasks 6, 7 — good, modulo issues #1, #2, #8.
- **Lowering / runner / interrupts:** Tasks 3, 4, 6, 8 — good, modulo #3, #4.
- **Testing matrix:** Tasks 1–3, 5–8 — good; add tests noted in #3, #4, #6, #8.
- **Docs:** Task 11 — good, add #14.
- **v1 restrictions:** all reflected in Tasks 6, 10 — good.

## Recommendation

Address issues #1–#4 before starting implementation (they change interfaces
between Tasks 6/7 and require additional tests in Task 4). Issues #5–#8 can
be handled inside the relevant tasks. The rest are nits.

---

# Test-quality review

The plan is TDD-driven, but many of the tests do not actually assert what the
step description claims to prove, and there are several gaps where a broken
implementation would still produce a green suite. Below is a per-task audit.

## Task 1 — parser tests for block arms

**Test 1 (multi-statement block arm) — weak assertions:**
- Asserts `body[0].type === "valueAccess"` for `print("hi")`. A function call is
  more likely `functionCall`/`callExpression` in the AST, not `valueAccess`. This
  will probably fail for the wrong reason; either verify the actual AST node
  name via `pnpm run ast` first, or assert `body.length === 2` and check node
  content instead of `.type` strings.
- Same issue for `let y = 1` → `assignment`. Confirm the exact type.
- The test never verifies statement CONTENT. If the parser silently drops a
  statement and picks up a stray token, `body.length` could still be 2 with
  wrong contents. Add: assert the print's argument is `"hi"` and the assignment
  target is `y`.

**Test 3 (`=> {` treated as block) — fragile:**
- Only asserts `success === false`. Any parse failure passes, even ones caused
  by a bug in an unrelated part of the parser. Add an assertion on the error
  message (must mention "statement" or "expected" — not "unexpected `}`" from
  a totally different code path). Better: pair with a POSITIVE test —
  `_ => { return { label: "hi" } }` MUST parse, proving the block interpretation
  is correct.

**Test 4 (block arm with a guard) — weak:**
- Only asserts `success === true`. Doesn't verify the guard is captured, doesn't
  verify the body contains the `print`. Add:
  `expect(cases[0].guard).toBeDefined()` and inspect body length.

**Test 5 (parenthesized object literal arm) — weak:**
- Only asserts `success === true`. Doesn't verify the arm body is actually the
  object literal. Add assertion on `body[0].type` and content.

**Missing tests:**
- **Block arm that ends with a `return` statement** — this is the primary
  motivating use case for block arms in an expression match. Assert
  `body[body.length - 1].type === "returnStatement"`.
- **Mixed arms in one match** — one single-expr arm, one block arm, back-to-back;
  verifies separator handling around `}`.
- **Empty block arm** `_ => { }` — spec doesn't specify; pick a behavior and
  lock it in with a test (probably: parse succeeds with `body: []`; later
  lowering catches it as non-yielding).
- **Block arm followed by another arm on the same line** — separator handling.
- **Multiple statements separated by `;` inside a block arm.**

## Task 2 — formatter round-trip

**Coverage gap:** the plan describes two assertions (multi-line block
round-trips, single-expression stays inline). This is not enough. Add:
- Round-trip a block arm with a **guard**.
- Round-trip a **pattern** arm (e.g. `success(v) => { print(v); return v }`).
- Round-trip `_ => ({...})` — parenthesized object literal should stay
  parenthesized, not become a block.
- Round-trip a match whose arms mix block and single-expr forms.

Also: the assertion "format(input) === input (modulo the harness's whitespace
convention)" is too loose. Two-pass fixed-point: `format(format(input)) ===
format(input)` catches non-idempotent formatting.

## Task 3 — per-statement substeps

**`interrupt-in-match-arm` test — good but under-specified:**
- Expected `"start,arm1,arm2,"` correctly proves arm1 doesn't re-run and the
  default arm doesn't fire. Load-bearing assertion is solid.
- **Missing:** interrupt as the FIRST statement in the arm (substep 0 is the
  interrupt itself — verifies the substep guard at position 0 works).
- **Missing:** interrupt as the LAST statement in an arm (verify nothing after
  the interrupt is re-run and the arm completes cleanly).
- **Missing:** two interrupts in the same arm (verifies substep advancement
  across multiple pauses).

**Fixture inspection is manual:** Step 3 asks the executor to "read the new
`.mjs`" and "verify... each multi-statement arm must contain one `runner.step`
per statement with ids that do not collide across arms." This is a
human-attention check that no reviewer will re-run. Convert to an assertion:
`grep -c 'runner\.step(' tests/typescriptGenerator/matchBlockBlockArms.mjs`
should equal the expected number, and IDs should be sequential — encode as a
scripted check.

## Task 4 — runtime unit tests

**Tests are described in comments only.** Bodies say "Assert: the step AFTER
the ifElse runs" etc.; actual Runner-construction is deferred to "flesh out
from the existing test file". This is the highest-risk task and the tests are
the least concrete. Insist on:
- Real Runner-construction shown inline in the plan, or
- A reference to an existing similar test with a note about what to change.

**Missing test cases:**
- **exitMatch clears even if branch throws** — required to justify the
  `try/finally` change in issue #3. Without this, the refactor from "trace
  every exit" to `try/finally` is untested.
- **Nested matches** — outer `matchId=1`, inner `matchId=2`, `exitMatch(1)`
  called from inside inner arm. Verify inner ifElse does NOT clear the outer
  flag; verify outer ifElse does clear it.
- **exitMatch propagates through a non-owning ifElse** — e.g. arm contains a
  nested `if (cond) { runner.exitMatch(...) }`, verify subsequent steps in the
  same callback are skipped and the outer match's ifElse clears the flag.
- **exitMatch inside `whileLoop` specifically** (only `loop` is in the plan's
  scenario list).
- **Serialization test:** snapshot Runner state after `exitMatch` is set (during
  skip), verify `_matchExit` is NOT in the serialized checkpoint. The spec
  claims "the flag is never serialized"; no test enforces this claim.

**Template change is untested in isolation.** The mustache emit for
`{ matchId: N }` with no-else vs. with-else vs. no-matchId should have three
snapshot cases in a prettyprint unit test. Currently only end-to-end fixtures
would catch a bug like `undefined, { matchId: 5 }` being emitted with the
wrong comma placement.

## Task 5 — expression grammar

**Test 3 (call to `match` still parses) — good regression** but doesn't cover
the trickier backtracking cases from issue #5. Add:
- `const y = match(r) + 1` — the atom parser tries `matchBlockExprParser`,
  fails at the missing `{`, backtracks to `valueAccess`, and continues into
  the `+ 1`. If tarsec's `or` does not backtrack cleanly, this fails.
- `f(match(r))` — should FAIL per spec v1 restriction "expression position is
  limited to assignment RHS and return operands". The plan does NOT test this
  restriction; without a test, someone will unknowingly allow it.
- `const a = 1 + match(r) { ... }` — same restriction, should fail.

**Missing:**
- Statement separation: `const a = match(x) { ... }` immediately followed by
  another statement on the next line — verify no trailing consumption bug.

## Task 6 — lowering tests

**"pattern arms" test — fragile finder:**
- `body.find((n) => n.matchSource)` may match multiple nodes (scrutinee AND
  maybe others). Prefer explicit indexing into the expected structure.

**"lowers const x = match to temp + tagged match + assignment" — missing checks:**
- Doesn't verify that `assignment.matchExprSource.matchId === matchStmt.matchExprId`.
  A bug that mints two different IDs would slip through.
- Doesn't verify the scrutinee is hoisted (bound once). Add: for a pattern
  arm form, find the scrutinee assignment and assert it precedes the match.

**"rewrites return inside block arms to matchYield" — missing value check:**
- Doesn't verify the yielded VALUE. A bug that swaps arm yields (yield the
  wrong expression) would pass. Add: assert `matchYield.value.value === "1"`.

**"lowers return match(...) to statements + return temp" — missing checks:**
- Doesn't verify the temp NAME matches the match's tempId.
- Doesn't verify the match statements come BEFORE the return.

**"errors when an arm does not yield on all paths" — narrow coverage:**
Only tests one non-yielding shape (`if (true) { return X } / print(...)`).
Missing:
- `if (cond) { return X }` with NO else at all — should error.
- `if (cond) { return X } else { print(y) }` — should error.
- `if (cond) { return X } else { return Y }` — should PASS.
- `for (...) { return X }` — should error (loops don't yield on all paths per
  the syntactic rule in v1 restrictions).
- Empty block arm `_ => { }` — should error.
- Trailing `matchYield` after a non-yielding statement — should pass.

**Missing entirely:**
- **Nested `return match(...)` inside an outer arm.** This is the exact
  scenario driving feedback issue #2. If the lowering is broken here, no test
  catches it.
- **Return inside `parallel`/`fork`/`race` in an arm** — should error per v1
  restriction. Not tested at all.
- **All-bare-expression arms** — no matchYield rewriting or all-paths check
  needed; verify the simple path.
- **Guarded arms in expression position** — verify all-paths analysis treats
  guards correctly (guarded arm alone does not count toward exhaustiveness).
- **Match with a single arm that is `_ => { assignment; matchYield }`** —
  verify assignments inside arm blocks are not mistaken for yields.

## Task 7 — typechecker tests

**Test 1 (annotation mismatch) — loose assertion:**
`expect(errs.some((e) => /not assignable|expected/i.test(e)))` — any error
matching this regex passes. Two different bugs (annotation not checked at all
+ some other unrelated error) could both make this green. Pin down the exact
error string, or at minimum add `expect(errs.length).toBe(1)`.

**Missing tests:**
- **Synthesis (no annotation):** `const val = match(r) { "a" => 1; _ => "s" }`
  should give `val: number | string`. Verify by using `val` in a context that
  requires one or the other, or by inspecting the scope's recorded type.
- **Narrowing flows into yields:** `match(r) { success(v) => v.value ... }`
  where `success` narrows `v` to a shape with `.value`. Verify that
  `v.value`'s type contributes to the union correctly. This is the exact
  scenario that feedback issue #1 (arm-scoped synthesis) is about — the plan's
  test suite does not exercise this path.
- **Nested expression matches:** inner match's synthesized type flows into the
  outer arm's yield.
- **Any-typed yield collapses to any:** verify `unionTypes` behavior.
- **Guarded exhaustiveness in expression position:** `match(r) { success(v) if
  (v > 0) => 1; failure(e) => 0 }` — no `_`, guarded arm doesn't cover
  `success` with `v <= 0`. Should hard-error.

## Task 8 — end-to-end tests

**`matchExpression.agency` — all-in-one test is hard to debug:**
Four match scenarios in one test with a single array assertion. When one
fails, the diff shows the whole array. Split into separate `.test.json` entries
(same file is fine, different `nodeName` or `input` variants).

**Missing observability:**
- The `"checking"` print inside the `d = match(a) { "zero" => { print("checking"); return "was zero" }}` arm is never verified. If the block arm silently short-circuits and yields `"was zero"` without running the print (impossible with correct impl, but that's the point of the test), the assertion still passes. Either capture stdout or use `setMutable` to log side effects.

**`interrupt-in-match-in-loop.agency` — critical assertion buried:**
Expected `"n0,ONE,n2,"`. This proves:
- Iteration 0 matched the `_` arm.
- Iteration 1 matched the `1` arm AND resumed AND ran the `return "ONE"` line.
- Iteration 2 matched the `_` arm AGAIN (proving `__condbranch` reset).
Good scenario. But: if the `__matchval` temp is not cleared between iterations
and a stale value leaks, the log still comes out the same (the temp is
overwritten before use). Add an assertion that specifically exercises the
"stale temp" failure mode: an arm that does NOT write on some iteration (via
`return` inside an `if`) — wait, the all-paths-yield rule forbids that.
Correct: the temp CAN'T leak, so the test is fine. Add a comment noting why.

**`handler-in-match-arm.agency` — vague:**
Plan defers scenario to "read one existing test and copy conventions". The ONE
required assertion (handler fires on both normal path and post-interrupt-
resume path) should be spelled out here. As written, an executor may write a
weaker test.

**Missing end-to-end tests:**
- Match expression as the value of a `return` inside a `for` loop (verifies
  interaction of Task 6's return-hoisting with existing loop lowering).
- Nested match expressions (`return match(x) { _ => match(y) { ... } }`).
- Match expression whose scrutinee is a function call with side effects —
  verify the scrutinee runs exactly once (scrutinee-hoisting claim in spec).
- Module-level `const x = match(...)` — see feedback item #13.

## Task 10 — statement-position `return` error

**Coverage gap:**
- **Bare `return` (no value)** inside a statement match arm — should also
  error. Not tested.
- **`return` inside a `for`/`while`/`parallel` inside a statement arm** —
  should error. Not tested (only the arm-block-if-return path is).
- **Return inside a nested match's arm when the OUTER is statement-position
  and the INNER is expression-position:** the outer `return` scan should NOT
  descend into the inner match (that inner is a different scope). Test both
  directions to lock the boundary rule in.

## Task 11 — docs

**No verification step.** Add: `pnpm run doc` (or whatever the docgen command
is) must succeed after edits. Also `rg 'match\(x\)' docs/site/guide/` to check
no stale examples remain that pre-date the block-arm syntax.

---

## Summary of test issues

- **Assertions too loose:** Task 1 tests 3–5, Task 6 error tests, Task 7
  error-message regex.
- **Test bodies deferred to "copy from existing":** Task 4 runtime tests,
  Task 8 handler test. These are the highest-risk changes; concrete assertions
  should be in the plan.
- **Manual verification steps that should be automated:** Task 3 fixture
  inspection, Task 8 Step 1 line-by-line `.mjs` inspection.
- **Missing scenarios that would silently regress:** nested expression
  matches, exitMatch under exceptions, exitMatch inside whileLoop, function-
  argument position (must error), narrowing into yield expressions, bare
  return in statement arm, return inside for/parallel in statement arm.

Fixing these does not require restructuring the plan — most are "add N test
cases to Step 1 of Task X" edits. The Task 4 tests and the Task 6 nested-match
tests are the two areas where I would insist on concrete bodies in the plan
before starting.

---

# Anti-pattern audit

Cross-referenced against `docs/dev/anti-patterns.md`. The most severe hits are
around "Imperative code everywhere" (missing declarative wrappers), and
"Duplicating existing code" (bespoke walkers where the codebase already has
utilities).

## A. Imperative code where a declarative abstraction is needed

### A1. Task 4 — `_matchExit` state is smeared across four methods (HIGH)

The plan spreads the match-exit protocol across four methods with no
encapsulating abstraction:

- `exitMatch()` sets the flag.
- `shouldSkip()` checks it (two return sites).
- `ifElse()` clears it — but only when `opts.matchId` matches, and only "after
  the existing branch-execution logic but before the final return... trace the
  method and ensure every exit point after branch execution passes through the
  clear."
- `loop()` / `whileLoop()` check-and-break.

That "trace every exit point" instruction is exactly the anti-pattern the doc
warns about: order-dependent mutable state with a fragile invariant that has
to be re-established every time `ifElse()` gains a new return path.

**Declarative fix:** encapsulate the protocol behind a scoped method:

```ts
async runMatch<T>(matchId: number, body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } finally {
    if (this._matchExit === matchId) this._matchExit = null;
  }
}
```

And have codegen wrap the match's ifElse callback in `runMatch(matchId, ...)`
instead of threading `opts.matchId` through `ifElse`. Callers never touch the
flag; the "how" (set/check/clear) lives in one place, and adding a new exit
path to `ifElse` cannot break match-exit semantics.

If the plan keeps the current opts-threading approach for symmetry with
existing patterns, at minimum use `try/finally` (already raised as issue #3 in
the top section) so the clear is unavoidable — the current "trace every exit"
prescription is the imperative anti-pattern verbatim.

### A2. Task 6 — post-hoc tag mutation across a heterogeneous set of nodes (HIGH)

```ts
const statements = this.lowerMatchBlock(tagged);
for (const s of statements) {
  if (s.type === "matchBlock" || s.type === "ifElse" || (s as any).matchSource) {
    (s as any).matchExprId = matchId;
  }
}
```

The "what" (this match is an expression match) is expressed by walking the
result and mutating multiple node kinds with `as any`. Every added node type
that can be produced by `lowerMatchBlock` will need a new branch here, and the
`as any` cast bypasses the type system exactly where an invariant needs
enforcement.

**Declarative fix:** thread `matchExprId` into `lowerMatchBlock` (or a new
`lowerMatchBlockForExpression`) so the tag is attached at construction time to
the one specific node that owns it. The caller loses the scan; the type
system enforces that only the right node kinds can carry the tag.

### A3. Task 6 — bespoke tree walkers duplicate `walkNodesArray` (MEDIUM)

The plan proposes three ad-hoc traversals:

- `rewriteReturnsToYields` — a switch over ~9 node types.
- `containsReturn` — "recursive walk for `returnStatement`... else a small
  local recursion over `thenBody` / `elseBody` / `body` / `branches`."
- `alwaysYields` — recursive over `thenBody`/`elseBody`.

The anti-patterns doc's first entry cites this exact scenario and points at
`walkNodesArray` in `lib/utils/node.ts`. `containsReturn` in particular is a
one-liner using the existing walker:

```ts
const containsReturn = (nodes: AgencyNode[]) =>
  walkNodesArray(nodes).some(n =>
    n.type === "returnStatement" && !isInsideNestedMatch(n));
```

`rewriteReturnsToYields` is a *transform* not a *find*, so it may need a
bespoke walker if the codebase has no visit-and-rewrite helper — but check
first (`rg -n 'walkNodes|transformNodes|mapNodes' lib/utils/` and
`lib/typeChecker/walk*.ts`). The Task 1 inventory step already grep'd for
walkers; the plan should say "reuse whichever walker Task 1 identified" and
not open-code another switch.

### A4. Task 2 formatter — imperative `result +=` accumulation (LOW)

```ts
result += this.indentStr(`${pattern}${guardCode} => {\n`);
this.increaseIndent();
for (const stmt of caseNode.body) {
  result += this.processNode(stmt);
  if (!result.endsWith("\n")) result += "\n";
}
this.decreaseIndent();
result += this.indentStr("}\n");
```

Two smells:
- Order-dependent `result` accumulation with an inline `endsWith` check.
- The special case `body.length === 1 && body[0].type !== "matchBlock"` for
  inline printing has no comment explaining why matchBlock is excluded.

The consistency argument (matches `processIfElse`) is legitimate, so the
imperative style is acceptable here. But the un-commented special case is a
"useless special case" smell unless explained inline. Add a one-line comment
or use `.map(...).join("")` + a normalization helper.

## B. Duplicating existing code

### B1. Task 7 — duplicate error-construction (MEDIUM)

Step 3: "push the same-shaped error — copy the error construction from
`utils.ts:134-141`".

This is the "duplicating existing code" anti-pattern by name. The correct move
is to promote lines 134-141 into a helper (`emitAssignabilityError(actual,
expected, loc, ctx)`) and call it from both sites. If the helper already
exists, use it; if not, refactor first.

### B2. Task 6 — `isExpressionNode` re-lists Expression-union members (LOW)

"write it as a lookup over the known expression type strings" — this
information already exists in the `Expression` type union in `lib/types.ts`.
Recommend co-locating a runtime const (`EXPRESSION_NODE_TYPES: readonly
Expression["type"][]`) with the type definition, so adding a new expression
kind is a one-file change. If a similar predicate already exists (grep for
`isExpression`), use it.

## C. Leaky abstractions

### C1. Task 4 codegen — internal storage layout leaks into the emit (MEDIUM)

The generated code writes `__stack.locals.__matchval_<matchId> = ...` directly
in an emitted string in `prettyPrint.ts`. If the storage location ever moves
(e.g. `__stack.locals.matchvals[matchId]`), every emitted `.mjs` breaks and
so does the runner. Recommend a runner helper:

```ts
runner.setMatchValue(matchId, value)
runner.getMatchValue(matchId)
```

with the storage detail owned by the runner. Codegen emits calls, not raw
member writes. Same argument for the consumer — the reads should also go
through a helper rather than baking `__stack.locals.__matchval_<id>` into the
consuming statement.

This aligns with the "leaky abstractions" example in the doc, which uses the
exact same `__stack.locals.__substep_0` pattern as the bad case.

## D. Useless special cases

### D1. Task 1 Step 6 — `agencyGenerator` bodyCode `= null` sentinel (LOW)

```ts
const bodyCode =
  caseNode.body.length === 1
    ? this.processNode(caseNode.body[0]).trim()
    : null; // multi-statement handled in Task 2; emit block minimally for now
```

Then the plan says "for this task emit multi-statement bodies as `{ stmt1\n
stmt2 }` by joining...". Just write it directly:

```ts
const bodyCode = caseNode.body.length === 1
  ? this.processNode(caseNode.body[0]).trim()
  : `{ ${caseNode.body.map(b => this.processNode(b).trim()).join("\n")} }`;
```

The `null` sentinel adds nothing.

### D2. Task 2 formatter — unexplained `!== "matchBlock"` guard (LOW, see A4)

Either document why nested matches force the block form, or drop the guard.

## E. Try-catch without logging

### E1. Task 6 Step 3 — LoweringError catch (NOT A HIT, but note)

```ts
} catch (e) {
  if (e instanceof LoweringError) {
    return { success: false, message: ... };
  }
  throw e;
}
```

This is NOT the swallow anti-pattern (message is surfaced, non-Lowering errors
are rethrown). Fine as-is.

## F. `as any` casts

### F1. Multiple sites in Task 6 (MEDIUM)

The plan uses `as any` liberally:
- `(node.value as any).type === "matchBlock"`
- `(s as any).matchExprId = matchId`
- `return [...inner.statements, y] as any; // flatten below`
- `return { success: false, ... } as any;`

Not listed in the anti-patterns doc explicitly, but each of these bypasses the
type system at exactly the point where the code is doing something novel. The
`matchExprId` propagation (A2) removes several. The others: use proper type
guards (`isMatchBlock(node.value)`) and a proper `AgencyNode | AgencyNode[]`
flatten with `.flat()`.

## G. Single-character variable names

### G1. Task 4 pretty-printer emit (LOW)

```ts
const v = printTs(node.value, 0);
...
].map((l) => " ".repeat(indent * 2) + l).join("\n");
```

`v` and `l`. Rename to `value` and `line`.

---

## Summary — anti-patterns in the plan

Ranked by impact:

1. **A1: `_matchExit` state smeared across four methods with no
   encapsulating abstraction.** Fix with a `runMatch(matchId, body)` helper
   or at minimum `try/finally`. Most important because the "trace every exit"
   instruction is directly the anti-pattern the doc warns about.
2. **A2: Post-hoc mutation of `matchExprId` across multiple node kinds with
   `as any` casts.** Fix by threading the tag into `lowerMatchBlock` and
   attaching it at construction.
3. **C1: Storage layout `__stack.locals.__matchval_<id>` baked into codegen
   strings.** Wrap with runner helpers.
4. **A3: Bespoke tree walkers (`containsReturn` especially) duplicating
   `walkNodesArray`.** Reuse the existing walker.
5. **B1: Copy-paste error-construction in Task 7.** Refactor a helper.

Lower-severity items (A4, D1, D2, F1, G1) are code-review nits that should
be addressed inline when writing the code but don't warrant plan changes.
