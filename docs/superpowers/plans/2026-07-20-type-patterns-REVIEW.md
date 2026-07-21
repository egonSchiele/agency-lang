# Review: Type Patterns implementation plan (2026-07-20-type-patterns.md)

Verdict up front: this is a strong, well-grounded plan. I checked its
load-bearing claims against the actual code and they hold — the pipeline order
(`lowerPatterns` runs at parse time in `lib/parser.ts:289`, before the symbol
table and checker), the line references (`caseLhsParser` at `parsers.ts:3256`,
the bare binder in `_matchPatternParser` at `:5452`, the `is` wrap around
`:2852`, `validateExpr` at `typescriptBuilder.ts:939`), the directory casing
(`lib/typeChecker`), the narrowing README, and `MatchArmMeta.caseValue` being
preserved through lowering (`patternLowering.ts:464`). The two new diagnostic
codes are free and land in the correct families (AG1xxx is "Types and aliases";
AG5xxx is match). The task decomposition is TDD-first and the commit boundaries
are clean.

The findings below are ordered by severity. Each names the file I checked so you
can verify. Nothing here is a reason not to build the feature; the MAJOR one is a
test-coverage gap on the headline behavior, and the rest are integration seams to
nail down before the tasks that touch them.

## 1. MAJOR: the test that claims to prove arm-binder narrowing is vacuous

The whole point of `pattern: Type` over `is Type` is that the binder receives the
narrowed type: `s: string => ...` should give `s : string`, and
`{name}: Person => ...` should give `name : string`. That is the feature's
headline promise. But the Task 7 test meant to verify it cannot fail:

```ts
def f(x: any): number {
  match (x) {
    n: number => n + 1
    _ => 0
  }
}
// asserts: diagnostics.length === 0
```

`x` is `any`. The binder `n` lowers to `const n = <scrutinee>`, and if narrowing
to the binder does **not** happen, `n` is `any` — on which `n + 1` is still
perfectly legal. So this test passes whether or not the narrowing works. Same
hole in the Task 10 `isCondition` node (`v.length` is fine on `any` too) and in
the plan's mental model generally: `any` masks the absence of narrowing
everywhere, because `any` permits everything.

Why this matters mechanically: narrowing to the binder is not free. The lowered
arm is `if (typeTest) { const s = scrutinee; ... }`. For `s` to come out `string`,
the checker's `analyzeCondition` (Task 7) must narrow the *scrutinee variable* in
the then-branch, and `const s = scrutinee` must then read that narrowed type. The
existing match-arm narrowing (`matchArmNarrowing.test.ts`) narrows the scrutinee
on a **discriminant literal** (`match(e.effect) { "app::confirm" => ... }` narrows
`e.data`); the type-pattern path is a different narrowing trigger on a possibly
different (temp) scrutinee variable. It probably works through the same machinery,
but the plan asserts it rather than proving it.

Fix: add a test that fails when the binder is *not* narrowed. Two ways that
actually bite:

```ts
// (a) narrowed type must be REQUIRED, and `any` must be excluded upstream:
def wantsNumber(n: number): number { return n }
def f(x: string | number): number {   // NOT any — union, so no-narrow => AG2008/mismatch
  match (x) {
    s: string => 0
    n: number => wantsNumber(n)        // fails unless n : number
    _ => 0
  }
}

// (b) field access that is invalid on the un-narrowed type:
def f(x: string | Person): string {
  match (x) {
    {name}: Person => name             // `.name` invalid on `string` half unless narrowed
    _ => "none"
  }
}
```

Use a union (or a concrete type) as the scrutinee, never `any`, in any test whose
job is to prove narrowing. Apply the same correction to the Task 10 execution
tests where they intend to demonstrate narrowing rather than dispatch.

## 2. MODERATE: AG1013 will likely double-fire with the existing AG1006

`AG1006` already exists and reads "Type alias '{alias}' is not defined
(referenced in '{context}')". Task 7 adds `AG1013` ("`{name}` is not a type; to
bind the value write `const {name} = x`") fired by the synthesizer when a
`TypeTestExpression`'s `typeHint` names an unresolved alias. But the synthesizer
resolves that `typeHint` through the normal type-resolution path — the same path
that emits AG1006 for an undefined alias. So `x is Bogus` risks emitting **both**
AG1006 and AG1013, or emitting AG1006 first and never reaching AG1013.

The plan needs to state the interaction explicitly: either (a) resolve the
`typeHint` in a mode that suppresses AG1006 so AG1013 is the sole, tailored
diagnostic, or (b) drop AG1013 entirely and let AG1006 stand (it is nearly the
same message, minus the "to bind, write const" hint). I lean toward (a) because
the binding hint is exactly the confusion this feature introduces, but it must be
a decision in the plan, not an accident discovered in Task 7. Add a test asserting
`x is Bogus` yields *exactly one* diagnostic.

## 3. MODERATE: `caseLhsParser` is rewritten wholesale, with no regression tests for the arm forms it must preserve

Today `caseLhsParser` (`parsers.ts:3256`) is 13 lines: try `defaultCaseParser`,
then `matchPatternParser` with a `=>`/`if` lookahead, else fall through to
`exprParser`. That `exprParser` fallback is load-bearing — it is how
expression-guard arms (`role == "admin" => ...`) and the `match(expr is pattern)`
form reach the parser. Task 3 replaces the whole function with a substantially
larger one (`isArm` detection, `armTypeSuffix`, `armFollowsPattern`, three
ordered branches). The new function is a superset in intent, but the plan's Task 3
tests cover only the new spellings plus `other =>` and one object-with-colon case.
There is no regression test that the pre-existing arm forms still parse:

- an expression-guard arm: `role == "admin" => grantAll(user)`
- the `match(req is { user, role }) { role == "admin" => ... }` form
- a literal arm and a bare `_` arm

A parser rewrite that silently drops the `exprParser` fallback would break these
with no test to catch it. Add those three as explicit "still parses" regressions,
and prefer the smallest possible insertion into the existing function over a
from-scratch rewrite — the existing lookahead is already exactly `armFollowsPattern`.

## 4. MODERATE: name the exact lowering gate that must learn about `typePattern`

`patternLowering.ts:426–429` gates behavior on
`caseValue.type === "objectPattern" || "arrayPattern" || "resultPattern"` (it
decides which arms get destructure-style handling). A `typePattern` caseValue is
not in that list, so with no change it falls to the else path. Task 5 says "find
every switch or if-chain that dispatches on pattern `.type`," which is the right
instinct, but this specific gate is the one most likely to silently misroute a
`typePattern` arm — either skipping its inner-pattern binder emission or
mislabeling it for exhaustiveness. Call it out by line, and add a lowering test
that a `{name}: Person` arm emits the `name` binder (it currently would not, if
this gate is missed, because `typePattern` isn't recognized as a destructuring
arm).

Relatedly, confirm in the same task that the arm's `MatchArmMeta.caseValue` keeps
the original `typePattern` node (preserved at `:464` today for the existing
kinds) — Task 8's exhaustiveness and AG5003 logic depend on seeing it.

## 5. MINOR: the central architectural choice (a surviving `TypeTestExpression` node) deserves an explicit tradeoff note

The existing Result patterns lower to a plain recognizable **call** —
`if (r is success(v))` becomes `if (isSuccess(r)) { const v = r.value }` — and the
checker narrows by recognizing the `isSuccess(...)` call shape, with no dedicated
AST node. This plan instead introduces `TypeTestExpression` as a node that
survives lowering and is compiled away only in the builder. That is a defensible
choice (it keeps the `typeHint` attached for the narrower to read directly, and
centralizes the Tier-1/Tier-2 decision in one place in the builder), but it
diverges from the `success`/`failure` precedent. State the tradeoff in the
Architecture section so a future reader sees it was deliberate — "we could have
lowered to `isSuccess(__coarseTypeTest(...))` and narrowed on the call shape as
Result patterns do; we chose a dedicated node because X." One paragraph.

## 6. MINOR: substantiate the "zero uses of the is-binder" claim in this repo

Retiring the always-true `is`-binder (`x is y` binding `y`) is a real,
documented behavior break, justified in the spec by "a search found zero uses."
But Task 2 Step 4 simultaneously hedges: "any old test asserting the binder
behavior must be updated." Those cannot both be fully true. Resolve it by
actually running the search in *this* checkout — including `tests/`, the corpus,
the real-llm tests, and `docs` examples — and recording the command and its
result in the plan (e.g. a `grep` over `.agency` files for `\bis\s+[a-z_]` triaged
by hand). If there are hits, list them and their migration. A breaking change
should carry its evidence, not an assertion.

## 7. MINOR: formatter normalizes `_: Type` to `is Type` — state it as intended

`is string` and `_: string` both lower to a `typePattern` with `pattern: null`
and identical `typeHint`. The parse AST cannot distinguish them (Task 3 builds the
same node for both), so the Task 9 formatter will normalize `_: string` →
`is string`. That is fine, but the Task 9 round-trip test must not assert
byte-identity for the `_: Type` spelling. Note the normalization in Task 9 so it
is a decision, not a surprising test failure. (If preserving the user's spelling
matters, the parse node would need a discriminator field — I do not think it is
worth it; just document the normalization.)

## 8. MINOR: pin down what `is object` narrows to, and access after it

After `is object` the value narrows to `primitiveType object`, which is typically
opaque — you cannot read `.foo` off it. That is arguably correct, but it is a
sharp edge for exactly the users this feature targets: the opening `draft` example
wants "it is an object, now stringify it," which is fine, but a user who writes
`if (draft is object) { return draft.title }` will hit a property error and be
surprised. Add one test fixing the intended behavior (error or allow), and make
sure the guide's `is object` example does not imply field access works.

## Confirmations (claims I checked that hold up)

- Pipeline: `lowerPatterns` runs inside `parseAgency` (`lib/parser.ts:289`),
  before the symbol table and checker — so a lowered carrier node the checker
  can recognize is the right shape, and the plan's design follows it.
- `MatchArmMeta.caseValue` is preserved through lowering
  (`patternLowering.ts:464` maps `{ caseValue, guard }`), so exhaustiveness
  (Task 8) can see a `typePattern` caseValue as the plan assumes.
- `validateExpr` (`typescriptBuilder.ts:939`) is the correct door for Tier 2:
  it already resolves visible aliases and emits the validator chain with its own
  `await`, so reusing it (not `Schema.parse`) genuinely gets `@validate` semantics
  and resolves spec open questions 3 and 5.
- AG1013 and AG5003 are unused and in the right families (AG1xxx types/aliases,
  AG5xxx match). Severity "warning" is supported (the diagnostics overhaul added
  severity); the Task 8 test asserting `severity === "warning"` will catch it if
  not.
- The Task 10 `bindsOriginal` test is well-constructed: `Repaired` with a
  clamp-to-1 validator matches (parse succeeds by transforming) while the binder
  reads the original `-5`. This genuinely pins Rule 1 and its transforming-validator
  corner. Good.
- The `/tmp` + `pnpm run ast` nuance in Task 3 Step 5 is correct: `ast` only
  parses, so the missing node_modules in `/tmp` do not matter.
- No handler/interrupt paths are touched; type patterns lower to conditions and
  bindings only. Worth one sentence in the plan stating that explicitly, given how
  load-bearing handlers are.

## Anti-pattern audit (against docs/dev/anti-patterns.md)

Headline question — does the plan split declarative "what" from imperative
"how"? Mostly yes, and in the load-bearing places (runtime, checker, builder)
genuinely well. The exception is the Task 3 parser dispatcher.

Good declarative encapsulation (no change needed):

- `__coarseTypeTest(value, kind)` (Task 4) hides all six typeof/Array.isArray
  checks behind one helper with a `CoarseKind` union; callers say what, not how.
- `coarseKindFor(typeHint)` (Task 6) is a pure `VariableType → CoarseKind | null`
  mapping, keeping `processTypeTestExpression` to a clean two-branch decision.
- Tier 2 reuses `validateExpr` instead of reimplementing shape+validator walking
  — the most important "don't duplicate the how" call in the plan.
- The `narrowers` table entry (Task 7) adds narrowing as one declarative table
  row, exactly the extension point the narrowing README advertises. Best example
  in the plan.
- `_isRhsParser` (Task 2) is a clean declarative `or(...)` of named alternatives.

The exception — `caseLhsParser` (Task 3) drifts imperative: hand-rolled
`.success` checks, early returns, and a `suffixable` guard across three ordered
`if` blocks, doing the same "first alternative that also passes the `=>`/`if`
lookahead" job that Task 2 does declaratively with `or(...)`. This trips
"Imperative code everywhere" and "Inconsistent patterns." The parser carve-out in
the doc excuses ordering constraints, not choosing hand-plumbing over available
combinators. Since Task 3 is a full rewrite anyway, decompose into named
alternative parsers (`isArmParser`, `wildcardSuffixParser`, `patternSuffixParser`,
`bareePatternParser`), each carrying its own trailing-`=>` lookahead, combined
with `or(...)`. Caveat: the existing `caseLhsParser` is already imperative for the
lookahead reason, so this is not a new style — but the rewrite triples the
imperative surface, so it is the moment to fix it.

Smaller catalog hits in illustrative code (fix before writing Task 3):

- One-line `if` (banned): `if (armFollowsPattern(pat.rest)) return pat;` needs
  braces.
- Single-character names (banned): `t`, `p`, `r` in `coarseKindFor`/`caseLhsParser`
  /`armTypeSuffix` → `typeHint`, `pattern`, `result`.
- `as any` in `armTypeSuffix` (`(r.result as any).t`) — type the helper instead of
  casting; the cast is only acceptable in the test snippets.

Counterweight: the two helpers the plan does factor out — `armFollowsPattern` and
`armTypeSuffix` — are correct declarative extractions of previously-inline logic.
The plan moves the right direction; it just stops short of applying the same
decomposition to the dispatcher that combines them. No structural anti-pattern in
the parts that matter most; the misses are one imperative dispatcher plus three
cosmetic violations, none blockers.

## Test-plan audit (will the tests fail when the code breaks?)

Through-line: the plan tests runtime behavior well and type-level behavior
poorly, because several checker tests assert `no diagnostics` on `any`-typed
scrutinees — and `any` permits everything, so exactly the narrowing the feature
promises is masked. Switching those scrutinees to union types fixes most of it.

### Tests that will NOT fail when the code breaks

1. Task 7 "narrows the then-branch" and "match arm binder gets narrowed type"
   (also the main-review MAJOR): both use `x: any`; every op is legal on `any`,
   so they pass with narrowing fully broken, and they only assert
   `diagnostics.length === 0`, never the synthesized `boolean` or the binder
   type.
2. Task 7 "no negative narrowing": `if (x is null) { return 0 } return 1` never
   touches `x` after the `if`, so it cannot fail in either direction — it passes
   whether negative narrowing is absent (intended) or wrongly present. It
   verifies nothing. Make it bite or delete it and state the limitation.
3. Task 2 "null after is stays literal": asserts `.not.toBe("typePattern")`,
   which passes even if `is null` regressed to a binder (the exact risk). Assert
   the positive null-literal node type instead.
4. Task 8 "type-pattern arm with a binder is not a catch-all": only fails if the
   checker has unreachable-arm detection; otherwise green with the bug present.
   Task 8 test 1 (drop `_`, expect AG5002) already proves non-catch-all-ness
   properly — this one is weak/redundant.
5. Task 10 `isCondition`: `v.length` on `v: any` prints `4` at runtime
   regardless of narrowing, which is a compile-time property execution tests
   cannot observe. Fine as a "branch executes" test; its narrowing intent
   belongs in Task 7. Reframe.
6. Task 6 fixture snapshot (inherent): proves output is stable, not correct. A
   wrong tier mapping would just change the snapshot and rely on a human noticing.
   Task 10 is what pins semantics.

### Tests that are solid (credit where due)

All of Task 4 (`__coarseTypeTest`, positive+negative per kind); Task 10 `coarse`
(exact ordering-sensitive dispatch string), `validatorRejects`, and
`bindsOriginal` (the best test in the plan — pins Rule 1 with a transforming
validator); Task 8 test 1 (AG5002) and test 3 (AG5003 shadowing); the Task 2
structural/result-pattern regression guards.

### Missing test cases (ordered by risk)

- `is` precedence inside boolean expressions: nothing tests `x is string && y`
  or `a is number == b`. The new RHS parses a type via `unionItemParser`; if it
  over-consumes, `a is number && b` could misparse as `a is (number && b)`. High
  priority, zero coverage.
- Array pattern with suffix `[x, y]: number[]`: named in Task 3 interfaces and
  Task 6 fixture but never driven by a parser test (Task 3) or lowering test
  (Task 5).
- Tier 2 typed-array element validation end-to-end: everything uses coarse
  `is any[]`; the `number[]` schema path (per-element, `["a"]` should fail) is
  never exercised at runtime. Add a Task 10 node.
- caseLhsParser rewrite regressions (also main-review finding 3): no test that
  expression-guard arms (`role == "admin" =>`), the `match(expr is pattern)`
  form, literal arms, and bare `_` arms still parse after the wholesale rewrite.
  Highest-probability regressions, zero coverage.
- Coarse union without `_` still non-exhaustive: the spec's v1 decision (type
  arms never earn exhaustiveness credit, even coarse) is untested. `match(x:
  string | number) { is string => 1; is number => 2 }` should still demand `_`.
- Tier 2 narrowing proven: `if (x is Person) { x.name }` with `x` a union (not
  `any`) so `.name` is invalid until narrowed — the positive test finding 1 asks
  for, extended to Tier 2.
- Synthesis is actually `boolean`: `const b: string = x is string` should error;
  nothing asserts the expression's type.
- AG1013 fires exactly once (finding 2): guard against co-firing with AG1006.
- AG5003 negative cases: no warning for a non-type binder (`other =>`) or a
  guarded arm — only the positive is tested.
- `is object` then field access (finding 8): pin whether `draft.title` after
  `is object` errors or is allowed.

### Answering the three questions directly

- Will the tests test what they are meant to? Runtime/dispatch/validator tests,
  yes. Narrowing and exhaustiveness-decision tests largely do not — they assert
  `no diagnostics` on `any`-typed code, which is unfalsifiable.
- If the code breaks, will the test fail? For coarse dispatch and Rule 1, yes.
  For narrowing (both tiers), negative-narrowing, and the `is null` literal
  regression, no — those bugs ship green.
- Missing cases? The `is`-precedence test and the caseLhsParser regression suite
  are the two most important absent tests; both target high-probability bugs with
  zero current coverage.
