# Type Narrowing

Flow-sensitive **narrowing** refines a variable's type inside a guarded region so
its branch-specific shape type-checks precisely — inside `if (isSuccess(r))`,
`r.value` is the success type instead of `any`. Narrowing (and the related
**exhaustiveness** checking) is the type checker's highest-leverage feature for
Agency's goal of giving agents *compile-time* feedback on the programs they write.

The narrowing engine lives in `lib/typeChecker/narrowing.ts` (fact production) and
is applied during scope building in `lib/typeChecker/scopes.ts`.

> **Status — dual model, flow-typed primary.** The flow graph and the
> `typeAt(reference, flowNode)` oracle have LANDED (the #359–#386 series):
> every diagnostic pass (`checkScopes`, exhaustiveness, definite returns)
> resolves types through the flow model, and `FlowEnvironment.memo`
> invalidation is automatic (a Scope-tree generation counter — see
> `FlowMemo` in `lib/typeChecker/flow.ts`). The scope-chain model documented
> below survives for ONE job: declaration-time inference during
> `buildScopes`, which runs before the flow graph exists. Both models share
> fact production (`analyzeCondition`) and fact application
> (`narrowByRefine`), so a new narrowing form lands in both automatically.
> Fusing the walks and deleting the scope-chain path was assessed and
> deliberately deferred (issue #471): the duplication is inert and the
> precision delta was not worth the rebuild. Original design spec:
> [`docs/superpowers/specs/2026-06-29-flow-typed-checker-design.md`](../../../superpowers/specs/2026-06-29-flow-typed-checker-design.md).

## Capabilities & limitations (current)

What narrows today, and what does not yet. "Planned" items are tracked against the
flow-typed checker work and the four narrowing specs at the repo root.

| Guard / form | Narrows today? | Notes |
|---|---|---|
| `isSuccess(r)` / `isFailure(r)` on a bare variable | ✅ | then- and else-branch; `r.value` / `r.error` type precisely |
| `r.prop == literal` / `!= literal` on a bare variable | ✅ | discriminated-union member filter (either operand order; string/number/boolean literals) |
| Same guards on a **member-path** scrutinee (`b.r`, `o.inner.r`, `arr[0]`) | ✅ | M1 (single-hop) + M2 (multi-hop + literal-index) — `isSuccess(arr[0])`, `o.inner.r.kind == "x"`, `b.r != null` narrow the path; `arr[0].value` then types precisely |
| `match` arm **bound fields** | ✅ | free via lowering to a `__s` temp — no match-specific code |
| `!c`, `a && b`, `a || b` combinators | ✅ | `!` swaps then/else; `&&` unions then-facts; `\|\|` unions else-facts |
| Post-guard / early-return (`if (isFailure(r)) { return }` ⇒ `r` is Success after) | ✅ | `alwaysExits` counts only `return` (conservative) |
| Multi-hop + literal-index member paths (`a.b.c`, `arr[0]`) | ✅ | M2 — `Reference.chain` is `PathSegment[]` (property + literal-index hops); `arr[0]` narrows per-index (does not leak to `arr[1]`). Covers **array-nested patterns** (`[success(v), _]`). Computed/dynamic index (`arr[i]`), slices, and method hops stay un-narrowable |
| The scrutinee *variable* in a `match` arm (vs a bound field) | ❌ | only bound fields narrow; the source var isn't re-typed |
| Mixed union with a non-literal discriminant member | ❌ | by design — the `string` member can't be proven disjoint |
| Narrowing to `never` (dead-branch detection) | ❌ | suppressed today; **planned** with the flow model + `never` |
| `null` / truthiness (`if (x != null)`, `if (x == null)`, `if (x)`) | ✅ | strips/keeps the `null` member of a `T \| null` optional; bare variable or single-hop member-path scrutinee (`c.timeout`). `x != null` / `x == null` are exact and narrow **both** branches. Bare `if (x)` narrows **only the then-branch** to non-null: the runtime uses JS truthiness, so a falsy `x` may be `""`/`0`/`false` (not just `null`), so the else-branch (and the post-`while` region) is left unnarrowed — narrowing it to `null` would be unsound. `if (x)` is accepted as a condition for optionals (an opt-in carve-out from the boolean-only condition rule — see `checkConditionType`). |
| `typeof` / value-kind split of plain unions (`number \| string`) | ✅ | type patterns (`x is number`, arm `n: number`) — the `typeTest` Refine narrows the subject to the tested type. **Positive-only**: no else-branch or post-return narrowing, because a Tier 2 test can fail on a `@validate` validator even when the static type matches. Bare-variable and stable member-path subjects. |
| User-defined type guards (`def isFoo(x): x is Foo`) | ❌ | **planned fast-follow** — needs `x is T` syntax |
| Aliased condition (`const ok = isSuccess(r); if (ok) …`) | ❌ | **planned** — no new syntax, smarter `analyzeCondition` |
| `match` exhaustiveness (all cases covered) | ❌ | **planned** — orthogonal to flow; `decomposeCases` + `never` |

## Enforced safety: strict member access

Narrowing's payoff is **enforcement**. Accessing a property that exists on only
*some* members of an un-narrowed union — most importantly `r.value` / `r.error`
on an un-guarded `Result` — is a compile-time error by default. Agency has no
exceptions, so `Result` is *the* error mechanism; this makes handling the failure
branch a compiler-enforced guarantee rather than a convention.

- Governed by `typechecker.strictMemberAccess: "silent" | "warn" | "error"`
  (default `"error"`; see [config](../../../misc/config.md)). `"silent"` restores
  the old lenient behavior (such accesses type as `any`).
- A **narrowed** receiver resolves to a single member (via the flow oracle) and is
  never flagged — so guarded code never errors. This is exactly why the check is
  safe to enable by default: it can only fire on genuinely un-narrowed access.
- Implemented in `synthValueAccess` (`lib/typeChecker/synthesizer.ts`): the
  `unionType` / `resultType` property branches route through `accessUnionField` /
  `accessResultField`, which emit the gated diagnostic when a field is present on
  some-but-not-all members. Result receivers expand via `resultToObjectUnion` and
  get Result-framed guidance.
- **Escape hatches** (no new syntax): an `if (isSuccess(r))` / `if (isFailure(r))`
  guard, `r catch …`, or `match (r) { … }`.

## Match exhaustiveness

A `match` over a **closed** value type — a `Result`, or a closed literal/value
union (`"a" | "b"`) — that doesn't cover every case and has no `_` arm is a
diagnostic, governed by `typechecker.matchExhaustiveness: "silent" | "warn" |
"error"` (default `"error"`; see [config](../../../misc/config.md)).

- A shared `decomposeCases(type)` (`typeCases.ts`) enumerates a value type's
  cases; `checkMatchExhaustiveness` (`matchExhaustiveness.ts`) reports the cases
  the **un-guarded** arms leave uncovered. Effect sets enumerate via
  `resolveEffectSet`, not here, so `decomposeCases` returns *open* for them.
- **Conservative — never a false "missing case":** open types (`string`,
  `number`, `any`, unions containing `any`, effect sets) are never required;
  a guarded arm never counts toward coverage; a `_` (or un-guarded bare binder)
  satisfies any match. **B1 scope:** Result + closed literal/value unions.
  Object/tagged-union discriminant coverage (`{kind:"a"}`) is **B2** — until then
  a non-discriminated object union is treated as un-coverable (no diagnostic).
- The `match(x is …)` form is never checked (its lowered output carries no
  `matchSource`), by construction.

## Current model: scope-chain narrowing

Narrowing is produced as pure facts and applied via throwaway child scopes during
the scope-building walk. Because pattern syntax is lowered *before* the checker
runs, `if (r is success(v))` arrives as `if (isSuccess(r)) { const v = r.value; … }`,
so the binding `v` picks up the narrowed type with no pattern-specific code.

### Fact production: `analyzeCondition`

`analyzeCondition(condition)` reports the narrowing candidates a guard implies for
its then- and else-branches. It recognizes a single `isSuccess(x)` / `isFailure(x)`
over a bare variable (both are `RESERVED_FUNCTION_NAMES`, so the match is
unambiguous), and composes over boolean combinators: `!c` swaps then/else, `a && b`
unions then-facts, `a || b` unions else-facts.

Each candidate carries a tagged `Refine` (`{ variableName, refine }`) and is applied
through a declarative `narrowers` table keyed by `refine.kind` — so a new narrowing
form is one table entry, not a change to the apply loop. The two forms today are
`resultBranch` and `discriminant`.

### Result branch narrowing (`resultBranch`)

Refines a `Result`-typed variable inside a guard so its branch-specific fields type
correctly: inside `if (isSuccess(r))`, `r.value` synthesizes to the success type
instead of `any`; inside `if (isFailure(r))` (or the `else` of an `isSuccess`
guard), `r.error` synthesizes to the failure type.

### Discriminated-union narrowing (`discriminant`)

`analyzeCondition` also recognizes `v.prop == literal` / `v.prop != literal` over a
bare variable (either operand order; string/number/boolean literals via the shared
`literalToType`). `narrowUnionByDiscriminant` then filters the union's members by
that literal discriminant property — `if (r.kind == "answer")` narrows `r` to the
matching member(s) in the then-branch and the complement in the else-branch.

Like Result narrowing it is sound/conservative: a member whose discriminant
property isn't a *matching-kind literal type* (a plain `string`, a wider union, a
different literal kind) can't be proven disjoint, so it is kept — and narrowing to
`never` (or to the full set) is suppressed entirely (returns "no narrowing").

Match arms come for free: `match (r) { { kind: "answer", data } => … }` lowers to
`const __s = r; if (__s.kind == "answer") { const data = __s.data; … }`, so the
bound field `data` reads the narrowed temp with no match-specific code.

Two limitations: (1) only *bound fields* of the scrutinee narrow — the scrutinee
variable in the source isn't re-typed, only the lowered temp; (2) a mixed union with
a non-literal discriminant member (`{ kind: "a" } | { kind: string }`) doesn't
narrow, by design (the `string` member can't be excluded). The `is`-form match
(`match (x is …)`) is guard-based and intentionally untagged.

### Application: `walkWithNarrowing`

`walkScopeBody` applies the facts by walking each branch in a `scope.child()` whose
refinements are written with `declareLocal` — so they never leak past the branch,
while real declarations inside the branch still flow to the function scope via
`declare()`. The shared `walkWithNarrowing` helper encapsulates the "child scope +
apply facts + walk" recipe.

### Post-guard (early-return) narrowing

When exactly one branch of an `if` provably always exits, the statements *after* the
`if` run only on the surviving branch's condition, so they are walked in a child
scope carrying those facts — e.g. after `if (isFailure(r)) { return … }`, `r` is
Success for the rest of the block. `alwaysExits` decides this and is deliberately
conservative: it counts only `return` (a `raise`/interrupt may resume, and
`propagate` semantics are non-trivial, so treating them as exits could be unsound).

### Soundness

Every narrowing is a false-negative-only approximation. A whole-body reassignment
scan skips narrowing any variable the branch (or the post-guard tail) reassigns,
since its type could change. The `narrowedBranch` marker on `ResultType` is set only
by this layer and is stripped by `widenType`, so it never leaks through `declare()`
into a function's inferred return type.

**Member-path prefix invalidation.** A narrowing of `box.r` (or `arr[0]`) is keyed
on the whole path — `Reference.chain` is a `PathSegment[]` of `prop`/`index` hops,
so `box.r` and `arr[0]` (and a numeric property `obj["0"]` vs `arr[0]`) never alias
in `referenceKey`/`isPrefixOf`. Reassigning the path *or any prefix of it* drops the
narrowing: after `box = …`, `box.r = …`, `b.inner = …`, or `arr[0] = …`, the path
re-resolves from the reassigned base, not the stale narrowed flow. `typeAt`'s
`assign` case detects this via `isPrefixOf(at.ref, ref)` and re-resolves through
`resolvePath`; the `loop` back-edge case does the same when the body widened the
base var; and the flow builder now emits a path-keyed `assign` node for stable
access-chain WRITES (`obj.field = x`, `arr[0] = x`) so a mutation invalidates too
(an unstable target like `obj[i()] = x` can't be keyed and passes through — no
aliasing analysis). A *sibling* assignment (`box.q = …`) is **not** a prefix, so it
correctly leaves `box.r` narrowed. At the access site `synthValueAccess` consults
the LONGEST narrowed stable prefix via `stablePrefix` (so `o.inner.r.value` reads the
more precise `o.inner.r` narrowing, and a later unstable hop — `a.b[i()].x` — doesn't
block narrowing the stable `a.b` prefix), behind the `flowHasNarrowFor` gate so an
un-guarded (or re-bound) access still hits the strict-member-access diagnostic.

Strict member access is itself flow-sensitive, so `strictMemberAccessSeverity`
returns `silent` whenever `ctx.flowEnv` is unset — i.e. during the pre-flow inference
passes (return-type inference; scope-building, where an untyped `let v = b.r.value`
synthesizes its RHS to declare `v`). Emitting there would be a false positive on
narrowed access; the flow-aware `checkScopes` pass re-synthesizes every value access
and is the single source of the diagnostic.

**Block bodies narrow.** Trailing `as` blocks and inline `\… -> …` blocks narrow
with the enclosing flow wherever the block-bearing call appears (statement,
assignment value, pipe operand, argument). `attachExpressionsToFlow` walks the
block body (`functionCall.block.body` / `blockArgument.body`) as statements with
the live flow, so a guarded `r.value` / `b.r.value` inside a block resolves, and a
guard nested in the block builds its own `narrow` nodes. CAVEAT: this narrows as
if the block runs in the enclosing flow; a deferred callback that executes after a
later reassignment is the classic closure-staleness limitation (mainstream
checkers narrow `const` but not reassigned `let` across closures) and is not
specially handled.

Un-narrowed `Result` field access still synthesizes to `any` (the legacy escape
hatch in `synthValueAccess`); tightening that into a hard error is a later increment
(the enforced-Result-safety flip, which the flow-typed model unblocks).

## Planned: the flow-typed checker

The scope-chain model above has a structural weakness: narrowing lives in transient
child scopes inside one walk, but other passes re-synthesize against the flat,
un-narrowed function scope — so they can disagree (this is what blocks enforced
Result safety). The fix is a **flow-typed environment**: narrowing lives on a graph
of program points attached to AST nodes, and every type query routes through
`typeAt(reference, flowNode)` — one oracle, consulted by every pass, with no
scope-chain disagreement possible.

Highlights of the planned model (see the spec for detail):

- **Flow graph** — `start` / `assign` / `narrow` / `join` / `loop` / `exit` nodes;
  `typeAt` resolves a reference's type by walking the graph, memoized per node.
- **Reference-keyed** narrowing (a `{ variable, chain }` path, not a bare name) so
  property-path guards (`if (user.profile != null)`) can narrow.
- **Loop widening** at the back-edge (sound, sometimes over-widens; no fixpoint).
- **`never`** as the bottom type (landed) — empty joins and fully-excluded
  discriminant narrowings become `never`, unlocking dead-branch and exhaustiveness
  diagnostics.

> **Exhaustiveness is not a flow byproduct.** `match (r) { … }` coverage checking is
> an enumerate-and-subtract over `decomposeCases`, orthogonal to the flow graph. It
> rests on the `never` type but ships on its own track.

## Pages in this directory

Today this README is the whole reference. As the flow-typed increments land, the
content splits into focused pages (each owned by the PR that builds it):

- `flow-graph.md` — `FlowNode` kinds, `typeAt`, `Reference` keys, memoization, loop widening.
- `result-unions.md` — Result-as-union + discriminant narrowing.
- `null-truthiness.md` — `T | null` member stripping.
- `handler-effects.md` — narrowing an inline handler param to its raisable effect set.
- `match-exhaustiveness.md` — `decomposeCases` and `never` as the endpoint.

Until a page exists, its topic is covered above. Keep this list in sync when adding
a page so the directory stays discoverable.

## Handler param `.effect` typing (H1)

`lib/typeChecker/handlerParamTyping.ts` (`refineInlineHandlerParams`) is a
type-only pass that types an inline `handle … with (e)` param's `.effect` field
as the literal union of effect kinds the handled body can raise, so
`match (e.effect)` is a plain literal-union match checked by the value-track
exhaustiveness diagnostic — no handler-specific check.

Pipeline position: **after** `buildInterruptCallGraph` (the transitive raisable
set needs the graph) and after the interrupt checks, **before**
`checkMatchExhaustiveness` (index.ts). It re-declares the param
(`buildScopes` declared it `any`) as a closed object
`{ effect: <union>, message: any, data: any, origin: any }` matching the runtime
interrupt object. The raisable set is computed by `collectRaisableEffects`
(shared with `collectHandlerOffenderKinds`), so the exhaustiveness check and the
unhandled-interrupt check agree on "what can be raised."

Two subtleties:
- **Ordering.** The pass runs before `buildFlowGraphs` so the oracle is
  seeded with the refined `e` from the start. Historically this ordering was
  load-bearing (a post-flow retype required a manual memo reset); since the
  generation counter, the memo self-invalidates on `declare()` and the
  ordering is an oracle-seeding-quality choice, not a soundness cliff.
- **Not a breaking change.** Field-access checking runs in `checkScopes`, before
  this pass, so the refined object type only reaches `checkMatchExhaustiveness`;
  no `e.<field>` read is re-checked against the closed object.

Conservative fall-backs to `any` (a missed warning, never a wrong one): explicit
annotation, `functionRef` handler, empty/unknown kinds, a param name shared by
two inline handlers in one scope (they'd clobber the flat function scope), and a
body containing a nested `handle` (the walker would over-count inner-caught
effects). Per-effect payload typing on `e.data` is a follow-on (H3, via
discriminated-union narrowing).
