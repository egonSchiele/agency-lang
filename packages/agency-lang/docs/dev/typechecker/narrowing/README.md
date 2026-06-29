# Type Narrowing

Flow-sensitive **narrowing** refines a variable's type inside a guarded region so
its branch-specific shape type-checks precisely — inside `if (isSuccess(r))`,
`r.value` is the success type instead of `any`. Narrowing (and the related
**exhaustiveness** checking) is the type checker's highest-leverage feature for
Agency's goal of giving agents *compile-time* feedback on the programs they write.

The narrowing engine lives in `lib/typeChecker/narrowing.ts` (fact production) and
is applied during scope building in `lib/typeChecker/scopes.ts`.

> **Status — mid-migration.** Narrowing is moving from the **scope-chain** model
> documented below to a **flow-typed** model where a single `typeAt(reference,
> flowNode)` oracle answers "what is this variable's type at this program point"
> for every pass. The bottom type `never` (the first prerequisite) has landed; the
> flow graph itself has not. This page documents the **current** implementation
> accurately, plus a capabilities matrix and the **planned** architecture. As each
> flow-checker increment lands, the per-topic pages listed at the bottom get
> filled in. See the design spec:
> [`docs/superpowers/specs/2026-06-29-flow-typed-checker-design.md`](../../../superpowers/specs/2026-06-29-flow-typed-checker-design.md).

## Capabilities & limitations (current)

What narrows today, and what does not yet. "Planned" items are tracked against the
flow-typed checker work and the four narrowing specs at the repo root.

| Guard / form | Narrows today? | Notes |
|---|---|---|
| `isSuccess(r)` / `isFailure(r)` on a bare variable | ✅ | then- and else-branch; `r.value` / `r.error` type precisely |
| `r.prop == literal` / `!= literal` on a bare variable | ✅ | discriminated-union member filter (either operand order; string/number/boolean literals) |
| `match` arm **bound fields** | ✅ | free via lowering to a `__s` temp — no match-specific code |
| `!c`, `a && b`, `a || b` combinators | ✅ | `!` swaps then/else; `&&` unions then-facts; `\|\|` unions else-facts |
| Post-guard / early-return (`if (isFailure(r)) { return }` ⇒ `r` is Success after) | ✅ | `alwaysExits` counts only `return` (conservative) |
| Nested-access scrutinee (`a.b.c`, `obj.field`) | ❌ | single-hop **bare variable** only |
| The scrutinee *variable* in a `match` arm (vs a bound field) | ❌ | only bound fields narrow; the source var isn't re-typed |
| Mixed union with a non-literal discriminant member | ❌ | by design — the `string` member can't be proven disjoint |
| Narrowing to `never` (dead-branch detection) | ❌ | suppressed today; **planned** with the flow model + `never` |
| `null` / truthiness (`if (x != null)`, `if (x)`) | ❌ | **planned** (now unblocked by nullish unification — `T \| null`) |
| `typeof` / value-kind split of plain unions (`number \| string`) | ❌ | **planned fast-follow** — needs surface syntax |
| User-defined type guards (`def isFoo(x): x is Foo`) | ❌ | **planned fast-follow** — needs `x is T` syntax |
| Aliased condition (`const ok = isSuccess(r); if (ok) …`) | ❌ | **planned** — no new syntax, smarter `analyzeCondition` |
| `match` exhaustiveness (all cases covered) | ❌ | **planned** — orthogonal to flow; `decomposeCases` + `never` |

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
