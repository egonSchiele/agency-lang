# Review: Handler Payload Typing (H3)

Review of [docs/superpowers/plans/2026-07-01-handler-payload-typing-h3.md](2026-07-01-handler-payload-typing-h3.md). Verified against current source: [handlerParamTyping.ts](../../lib/typeChecker/handlerParamTyping.ts), [effectPayloadCheck.ts](../../lib/typeChecker/effectPayloadCheck.ts), [interruptAnalysis.ts](../../lib/typeChecker/interruptAnalysis.ts), [index.ts](../../lib/typeChecker/index.ts).

---

## Overall: The strongest plan in the series — but 2 real blockers and several tests hedged

This plan is markedly better than H1/M2 in three ways: (1) it identifies the ONE real architectural constraint (retype must happen BEFORE `checkScopes`, not after), (2) it opens with a throwaway SPIKE (Task 1) to measure blast radius before committing, and (3) it acknowledges the flat-scope limitation up front and pins it with a documenting test. Genuine engineering hygiene.

**But** two blockers remain:

1. **Nested-handle guard silently dropped.** Current H1 has `bodyHasNestedHandle(body)` in [handlerParamTyping.ts:12-18](../../lib/typeChecker/handlerParamTyping.ts) that SKIPS retyping when the handler body contains a nested `handleBlock` (because a nested handle catches some effects, making the outer raisable set an over-count → the discriminant union would include effects the outer handler will never actually see). Task 3's rewrite doesn't discuss this guard. Silently dropping it → false-positive payload narrowing.
2. **Task 3's Step 1 test hedges on syntax existence.** "If `match (e) { is <effect> => … }` is not supported, fall back to `match (e.effect) …`." That's a red flag: the test that GUARDS the shape of the union is unclear on WHICH surface syntax proves it. The Task-3 test may end up asserting only the H1 behavior again.

---

## Source verification

- [handlerParamTyping.ts:29-33](../../lib/typeChecker/handlerParamTyping.ts) docstring confirms the plan's architectural claim: "although this is a closed `objectType`, it does NOT make `e.<field>` a 'does not exist' error — field-access checking runs in `checkScopes`, BEFORE this pass re-types the param." The reorder rationale is exactly right.
- [effectPayloadCheck.ts:43](../../lib/typeChecker/effectPayloadCheck.ts) `function buildRegistry(ctx)` is currently un-exported. Task 2's rename+export is correct.
- [effectPayloadCheck.ts:20](../../lib/typeChecker/effectPayloadCheck.ts) `const registry = buildRegistry(ctx)` — one call today, one registry, so the plan's "conflicts reported exactly once" baseline is correct.
- [index.ts:303](../../lib/typeChecker/index.ts) `analyzeInterruptsFromScopes` and [index.ts:309](../../lib/typeChecker/index.ts) `buildInterruptCallGraph` are separate — the plan's claim that only the former (not the call graph) needs to move up is correct.
- [handlerParamTyping.ts:12-18](../../lib/typeChecker/handlerParamTyping.ts) `bodyHasNestedHandle` — the existing guard the plan omits to discuss. **Blocker 1.**

---

## Design assessment

**The reorder is correctly scoped.** `analyzeInterruptsFromScopes` and `buildRegistry` are both pure computations over already-populated data (`ctx.functionDefs` from `inferReturnTypes`, `ctx.symbolTable.allEffectDeclarations()`). Moving them ahead of `buildFlowGraphs`/`checkScopes` should be side-effect-free. The plan lays this out with the right level of detail and evidence.

**The reorder unblocks the memo-reset hack.** H1 today needs `ctx.flowEnv.memo = new WeakMap()` because retype happens AFTER flow-build. Task 4 removes this because flow-build now happens AFTER retype. Cleaner. Correct because `typeAt` reads scope at query time; the memo is the only stale artifact.

**The spike-first approach is right.** Task 1's throwaway measurement is the right pattern for a change with unknown blast radius. Discarding the spike code and requiring GO/NO-GO before proceeding is disciplined.

**Discriminated union reuses existing D1/M2 machinery.** The narrowing flows through `narrowUnionByDiscriminant` (union of objects → filter by `effect` literal) + `synthValueAccess` (member-path). No new checker code. Elegant.

---

## Real bugs / concerns

### Blocker 1: `bodyHasNestedHandle` guard silently dropped

Current H1 pass at [handlerParamTyping.ts](../../lib/typeChecker/handlerParamTyping.ts) has a guard that skips retyping if the handler body contains a nested `handleBlock`. Reason: a nested handle catches some effects, so the outer body's raisable set is an OVER-count → the discriminated union would include members for effects the outer handler can never actually receive at runtime. If preserved in H3, this is fine (conservative). If dropped, `if (e.effect == "innerKind")` narrows to a member the code can never reach, and the "impossible" branch's `e.data` typing is wrong (correctly typed, but for a runtime path that can't happen — mostly harmless but wasted). Worse, it may confuse users who see a branch typecheck for an effect they know the inner handler catches.

**Fix:** the plan needs to explicitly retain (or explicitly deprecate) the guard, and add a test for a nested-handle configuration.

### Blocker 2: Task 3 Step 1's syntax hedge is unresolved

The Task-3 test's purpose is to prove the retyped param is a DISCRIMINATED UNION (multiple members with `effect` discriminant), not just the H1 shape (single object with `effect: union`). The e2e signal is exhaustiveness on `match (e)`.

But the plan hedges: "if `match (e) { is <effect> => … }` is not supported, fall back to `match (e.effect) …`". The fallback test EXACTLY reproduces the H1 test — it proves nothing new about the union shape. If the intended `match (e)` arm syntax doesn't exist, the Task-3 test has no diagnostic power for the union shape; the shape is only tested indirectly via the Task-4 payload-narrowing e2e.

**Fix:** verify the pattern grammar via `pnpm run ast` on a scratch file BEFORE Task 3. If `match (e)` on an effect discriminated union isn't supported, drop the Task-3 union-shape test and rely on Task 4's payload-narrowing e2e as the shape guarantee (which is fine — the union shape is a means to that end).

### Concern 3: `analyzeInterruptsFromScopes` reorder claimed pure but not audited

The plan claims: "This pass is `collectProfiles → propagateTransitively → formatResult`; it reads function-ref arg types via `synthType(...)` against `ctx.functionDefs` (populated by `inferReturnTypes`, step 2) and pushes no diagnostics itself."

Two things to actually verify:

- **Does `analyzeInterruptsFromScopes` call `synthType` on any expression whose type depends on flow narrowing?** If yes, moving it BEFORE `buildFlowGraphs` means it sees pre-narrowed types. Unlikely to affect interrupt effect kinds (which are declared per function), but worth a grep.
- **Does `collectFromBody` push any errors?** The plan says no. Verify with `git grep -n "ctx.errors.push\|ctx.errors\[" lib/typeChecker/interruptAnalysis.ts`. If it does, the reorder changes error order (a fixture concern).

### Concern 4: Registry sharing between passes has subtle ordering

Task 2's `buildEffectRegistry` reports conflicts as a side effect. Task 4 calls it ONCE at pipeline step 3b, then passes the same registry into `checkEffectPayloads` at 6d. But if `buildEffectRegistry` pushes conflict errors, those errors are pushed at step 3b (very early), BEFORE `checkScopes` runs. Any test that asserts error ORDER (e.g., "expected error at line X to come before error at line Y") could regress.

Low likelihood but worth grepping error-order assertions.

### Concern 5: Effect declared with empty payload (`effect foo { }`)

If the registry returns `{type: "objectType", properties: []}` for a payload-less effect, then `e.data` after narrowing is that empty object. Accessing `e.data.anything` becomes "does not exist" (correctly). But if the registry returns `undefined` / has no entry, `registry[kind] ?? ANY_T` gives `data: any`.

Which case fires for `effect foo { }`? Verify against `allEffectDeclarations()`. If empty-payload effects DO get registry entries with empty properties, users declaring `effect ping { }` and reading `e.data.foo` will see the new "does not exist" error — a subtle breaking change that the spike may or may not surface (depends on whether stdlib has such patterns).

**Test:** effect with declared empty payload AND effect with no declaration should be tested separately.

### Concern 6: `matchExhaustiveness` and discriminated-union B2

The plan says H1's exhaustiveness (B1, literal union on `.effect`) still works. But with H3, the parameter itself is a discriminated OBJECT union (B2 territory). `match (e.effect)` continues to work by projecting the discriminant string. Does `match (e)` (on the whole discriminated union) work via B2's discriminated-object-union exhaustiveness that shipped in match-exhaustiveness-b2? If B2 hasn't fully shipped yet or has edge cases with these auto-synthesized member types, this could regress.

The plan doesn't audit interaction with B2's `findDiscriminant` — it may correctly detect the `effect` discriminant on the synthesized union, or it may fail (e.g., if `findDiscriminant` bails on some property shape the plan's `handlerParamType` produces). Worth verifying with an e2e test that `match (e) { is foo => … is bar => … }` (or equivalent object-pattern arms) triggers a "not exhaustive: missing bar" diagnostic under B2.

### Concern 7: Task 5 Step 3 "limitation test" is too soft

> "Assert whatever the current behavior is (likely: the second binding wins / a benign result), with a comment citing the flat-scope limitation."

This is a test whose expected outcome the plan author doesn't know. The "documenting comment" is genuinely valuable, but pinning an unknown behavior as a test creates a maintenance burden: the next person to change scope handling will see the test pass or fail arbitrarily and won't know if that's intentional. Either:
- Determine the current behavior via a scratch run BEFORE Task 5, and assert the specific outcome; OR
- Skip the test entirely and put the documenting comment in the module's docstring.

### Concern 8: Machine-specific scratchpad paths

Every `tee` command uses `/private/tmp/claude-501/-Users-adityabhargava-agency-lang-packages-agency-lang/8cc629ca-13fc-4078-93fc-a61171ef7b15/scratchpad/…`. Fine for you but useless for another agent, a fresh clone, or CI reruns. Should be `/tmp/h3-*.txt` or a workspace-relative `./scratchpad/h3-*.txt`.

---

## Missing test cases

Beyond the concerns above, I'd add:

1. **Nested `handle` block** — verify the outer handler param handles nested handles correctly (probably: don't retype at all, per current H1 guard).
2. **Effect with empty payload** (`effect foo { }`) — `e.data` shape after narrowing; access should error.
3. **Effect with no declaration** — `registry[kind]` is undefined → `data: any` → free access.
4. **Guarded arm** — `if (e.effect == "a") { … } else { e.data }` — the else branch's `e.data` should be a union of the other effects' payloads. Verify.
5. **Payload conflict + shared registry** — plan tests conflict-reported-once, but not that the CONFLICTED effect is dropped from BOTH the registry-check AND the handler-param typing (should be treated as "unknown" → `data: any`).
6. **Two handlers, same enclosing scope, same param name** — the "accepted flat-scope limitation" needs a specific test outcome, not "whatever the checker does today."
7. **B2 discriminated exhaustiveness on `match (e)` over the synthesized union** — proves H3 composes with B2, not just B1.
8. **Recursive function raising an effect** — transitive raisable set includes recursive callees; `e.data` in the handler has the union.
9. **Function-ref handler (`handle …  with someFn`)** — plan (and H1) leaves these untouched; should have an explicit test that H3 doesn't accidentally retype the wrong param.
10. **`interruptCallGraph` position** — plan keeps it at 5a, but if the reordered `analyzeInterruptsFromScopes` populates something the call graph reads pre-checkScopes, verify no crash.

---

## Anti-pattern audit (against [docs/dev/anti-patterns.md](../../dev/anti-patterns.md))

- **Duplicating existing code:** the plan builds the effect registry TWICE between Task 3 and Task 4 (temporary bridge). Explicitly flagged as "do NOT ship between Task 3 and Task 4." Acceptable if they land in one PR.
- **Imperative vs declarative:** `handlerParamType` is a pure expression (union of members). Declarative. ✓
- **Order-dependent mutable state:** the pipeline reorder is inherently order-dependent — but every dependency is justified by the docstring's reasoning. Fine.
- **Nested ternaries:** `handlerParamType`'s `kinds.length === 1 ? member(kinds[0]) : { type: "unionType", …}` is a single ternary. ✓
- **Leaky abstractions:** `checkEffectPayloads(scopes, ctx, registry?)` — the optional third arg is a compromise, but the plan justifies it (back-compat for existing callers). ✓
- **Magic numbers / dynamic requires / one-line ifs / try-catch:** none.
- **`interface` / `Map` / `Set`:** plan explicitly follows the objects-not-maps rule for new code; grandfathered existing `Map` in `nameCount`. ✓
- **Machine-specific paths in commands** — anti-pattern by convention (not in the doc); should use `/tmp/` or relative.

---

## "Will the test fail when the code breaks?" matrix

| Regression | Test catches? |
|---|---|
| Payload narrowing doesn't fire (still `any` at usage) | ✓ (Task 4 e2e mismatch test) |
| Nested-handle guard silently dropped | ✗ |
| `match (e) { is foo => … }` union-shape exhaustiveness | ✗ (Task 3 test hedges syntax) |
| Effect with empty payload → `e.data.x` should error | ✗ |
| Effect with no declaration → `e.data.x` should succeed | ✗ (not distinguished) |
| Guarded else branch has correct union payload | ✗ |
| Conflicted effect dropped from handler param typing | ✗ (Task 2 tests once-reported, not once-typed) |
| Two handlers same scope same param name | ✗ (Task 5 Step 3 test is a soft "assert what happens") |
| Function-ref handler untouched | ✗ |
| Recursive raise flows into handler param | ✗ |
| Payload conflict once (basic) | ✓ (Task 2) |
| H1 exhaustiveness regression | ✓ (Task 4 regression test) |
| Payload conflict error order changed | ✗ (no order assertion) |
| Blast radius (closed-object strict field access) | ✓ (Task 1 spike + Task 5 flip) |
| Memo-reset removal breaks flow narrowing | ✓ (any downstream narrowing test would catch) |

Better than the H1 plan, but the highest-value missing tests are **nested handle, empty payload, `match (e)` on union shape, and guarded else branch**.

---

## Recommendations

**Must-fix (blocks execution):**

1. **Address the `bodyHasNestedHandle` guard explicitly.** Either preserve it (recommended, matches H1's conservative behavior) with a test, or drop it with a written justification.
2. **Resolve the Task 3 Step 1 syntax hedge BEFORE writing code.** Run `pnpm run ast` on a scratch `match (e) { is foo => … }` and either commit to the test or replace it with a proxy shape check.
3. **Change machine-specific `/private/tmp/claude-501/…` paths to `/tmp/h3-*.txt` or workspace-relative.** Blocks reproducibility.

**Should-fix:**

4. **Audit `analyzeInterruptsFromScopes` for `ctx.errors.push`** — verify the "no diagnostics" claim, else the reorder changes error order.
5. **Distinguish empty-payload from no-declaration in tests** — different behaviors, both should be pinned.
6. **Add a nested-handle test** covering the guard decision above.
7. **Add a `match (e)` B2 discriminated exhaustiveness test** to prove H3 composes with B2.
8. **Add a guarded-else test** — the else branch of `if (e.effect == "a")` should type `e.data` as the union of remaining payloads.
9. **Convert Task 5 Step 3 from "assert whatever happens" into a specific assertion** by measuring the current behavior in a scratch first.

**Nice-to-have:**

10. Function-ref handler untouched test.
11. Recursive function raise test.
12. Effect-name with special chars (`::`) confirmation.

---

## Bottom line

The **strongest plan in the recent series** — it identifies the real architectural constraint, opens with a disciplined spike, and acknowledges limitations up front. Two real blockers before execution:

1. **`bodyHasNestedHandle` guard needs an explicit decision** (currently dropped without discussion).
2. **Task 3 Step 1's syntax hedge must be resolved** (verify grammar first).

Plus one reproducibility fix (paths) and 4–5 missing tests around edge cases (nested handles, empty payloads, guarded else, B2 composition). Fix those and this is mergeable — the design and pipeline reorder are otherwise sound.
