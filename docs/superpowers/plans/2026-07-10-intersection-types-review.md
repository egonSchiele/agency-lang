# Review: Intersection Types (`&`) implementation plan — round 2

**Plan reviewed:** `docs/superpowers/plans/2026-07-10-intersection-types.md` (revised)
**Spec:** `docs/superpowers/specs/2026-07-10-intersection-types-design.md`
**Reviewed against:** `origin/main` (commit `d771b88b7`), the plan's worktree base.

**Verdict: Ship it.** All four substantive findings from round 1 are fixed, one of them better than I suggested. The rewritten merge pipeline is correct. I re-grounded every changed claim against `origin/main`; nothing new blocks.

---

## Round-1 findings — all resolved

1. **Printer parenthesization (was blocking) — FIXED.** Task 1 Step 5 now extends the three existing paren conditions (`arrayType`, `keyofType`, `indexedAccessType`) for `intersectionType` operands in BOTH `formatType.ts` and `typeToString.ts`, and calls out that `formatType.ts`'s throwing default won't catch it. Round-trip tests for `keyof (A & B)`, `(A & B)[]`, `(A & B)["id"]` are added (Task 1 Step 6). I confirmed all three forms parse to the nesting the tests assume (`arrayType`/`keyofType`/`indexedAccessType` wrapping an `intersectionType` via `parenthesizedTypeParser`), so they genuinely exercise the printer fix.

2. **Dropped `blockTypeParser` (was blocking) — FIXED.** Task 1 Step 4 now says keep ALL current members verbatim including `lazy(() => blockTypeParser)` as the first alternative, with the rationale inline.

3. **`typeKey` cycle (was should-fix) — FIXED, and improved.** `evalIntersection` now takes an injected `TypeEquals` comparator, so `typeOperators.ts` never imports `typeKey`/assignability and its CYCLE RULE stays literally true. The resolver builds `(a, b) => typeKey(a, typeAliases) === typeKey(b, typeAliases)` on the **real** alias table — strictly better than the empty-table form, and cheaper than my "update the comment" fallback. Verified `typeKey(t: VariableType, aliases: Record<string, TypeAliasEntry>)` — the two-arg call is valid.

4. **Missing unknown-alias-in-intersection test (was should-fix) — FIXED.** Added in Task 2 Step 4 (`type X = A & Undefined` expects "Type alias 'Undefined' is not defined"), proving the `visitTypes` → `validateTypeReferences` wiring.

5. **Minor (imports, brittle codegen regex) — FIXED.** Task 2 Step 1 now extends the existing imports correctly; Task 3 Step 1 carries the "match the observed string" note.

---

## New content reviewed

### The rewritten `evalIntersection` (group → combine → build) is correct

I traced it against all nine unit tests:

- **Disjoint keys, first-seen order** — `groupPropertiesByKey` records `keyOrder` on first sight; single-element groups pass through `combineGroup`'s initial-value-less `reduce` untouched. Left-operand keys first, then right's new keys. ✓
- **Identical shared key (incl. non-object)** — `intersectPropertyValues` resolves both sides and returns `left` when `typesEqual`. This is exactly the case plain recursive-merge couldn't handle (`string & string`), so the comparator earns its place. ✓
- **Recursive object merge** — both-`objectType` branch recurses through `mergeObjects([left, right], …)`; the nested-level `toEqual` assertion holds. Note the survivor property carries `tags: mergeTagSets(undefined, undefined) === undefined`; `toEqual` (not `toStrictEqual`) ignores undefined-valued keys, so the assertion passes. ✓
- **Conflict** — neither-equal-nor-both-object throws, naming the key and both `formatTypeHint`s. ✓
- **Tag merge / description** — `{...left}` preserves the LEFT description (spec rule 4); `mergeTagSets(left.tags, right.tags)` keeps both validate chains, left-first. ✓
- **n-ary + associativity by construction** — grouping ALL operands in one pass (no pairwise top-level fold) means `(A&B)&C` and `A&(B&C)` produce identical key order `[id, name, age, extra]`; `typeKey` compares equal. Traced both nestings by hand. ✓
- **No input mutation** — grouping only reads and pushes references; multi-element groups spread into fresh objects; single-element groups share references but are never mutated. This matches the existing `Partial` operator, which also passes properties through by reference. ✓
- **`Object.create(null)` for `byKey`** — correctly guards against `__proto__`/`toString` key collisions, matching the scope.ts discipline. Good catch to include it.

One observation, not a defect: the three-arg `evalIntersection(members, resolve, typesEqual)` is now the public signature and every caller/test passes all three — consistent throughout the plan.

### Step 6b parse-performance gate — paths valid

`stdlib/ui.agency` (57 KB, the largest stdlib module) and `stdlib/policy.agency` (29 KB) both exist and resolve from `packages/agency-lang`, so `pnpm run ast stdlib/ui.agency` is a real measurement, not a silent no-op. The ~5% budget and "record numbers, not expectations" framing are reasonable for a change that adds a parser level under every union item.

---

## Nothing blocking remains

Everything I flagged is addressed and the additions are sound. Remaining items are all judgment calls the plan already makes reasonably (perf budget threshold, codegen regex tolerance). Approved to execute.

---

# Addendum: check against `docs/dev/anti-patterns.md`

**Direct answer to the main question — "is the plan writing declarative interfaces that neatly encapsulate complexity and imperative code?"**

**Yes, and it is the plan's strongest quality.** Task 2's rewrite is close to a textbook instance of what anti-pattern #2 ("Imperative code everywhere") prescribes: split the *what* from the *how*, encapsulate the imperative part in one place, and expose a declarative interface.

- The `what` reads as four named steps — RESOLVE → GROUP → COMBINE → BUILD — each its own small function (`evalIntersection` / `groupPropertiesByKey` / `combineGroup` + `intersectPropertyValues` / `mergeObjects`).
- The only imperative construct — the group-by loop — is isolated in `groupPropertiesByKey`. Everything above it is `map`/`reduce`.
- The three shared-key rules sit in one readable ladder in `intersectPropertyValues` (identical → keep; both objects → recurse; else → error). A future rule change touches only that function.
- n-ary and associativity hold *by construction* (all operands group in one pass), so there is no hand-managed accumulator to reason about.

The rest of the plan (parser precedence level, printer `case`s, `typeKey`/`valueParamSubstitution`/`mapTypes`/`visitTypes` fan-out) is `map`/`case`-based and mirrors the existing operator family, so no imperative sprawl there either.

## Anti-patterns explicitly AVOIDED (worth calling out as done-right)

- **Useless special cases (avoided):** `combineGroup` uses `reduce` with no initial value, so a one-element (disjoint) group returns its property with no `length === 1` branch. This is exactly the catalog's "good" example.
- **Leaky abstractions (avoided):** the injected `TypeEquals` comparator *hides* the `typeKey`/assignability dependency behind a callback instead of leaking it into `typeOperators.ts` — the fix to round-1 finding 3, and squarely on the right side of this anti-pattern.
- **Order-dependent mutable state (avoided):** the pipeline is `const`-based; the only mutable locals (`keyOrder`, `byKey`) are self-contained accumulators inside one function, not cross-variable sequencing. Parser ordering is the catalog's explicitly-exempted case.
- **Duplicating existing code (mostly avoided):** the plan reuses `resolveObjectArg`, `mergeTagSets`, `formatTypeHint`, `withUseSiteTags`, `visitTypes`/`mapTypes`, `deepResolveNode` rather than reimplementing them.

## One finding worth a plan edit — the hand-rolled group-by vs. the existing `groupBy`

There IS an existing `groupBy<T, K>(items, key): Record<K, T[]>` helper (private to `lib/typeChecker/effectPayloadCheck.ts`). On its face, hand-rolling `groupPropertiesByKey` looks like anti-pattern #1 (duplicating existing code). But the plan's version is actually the *correct* choice, for a non-obvious reason:

- The existing `groupBy` returns a `Record` and its consumers iterate via `Object.entries`, which **reorders integer-like string keys** ("0", "1" sort ahead of "name").
- Object-type property keys are parsed as `many1WithJoin(varNameChar)` (parsers.ts:1162), so an all-digit key like `"0"` is representable — and property order is semantically load-bearing for the merged schema.
- The plan's explicit `keyOrder` array preserves true first-seen order regardless of key shape. Reusing `groupBy` + `Object.entries` would silently corrupt ordering for numeric keys.

So this is not duplication to "fix" — it's a justified divergence. The risk is the opposite: a future reader sees the loop, notices `groupBy` exists, and "simplifies" it into `groupBy(allProps, p => p.key)` + `Object.entries`, quietly reintroducing the numeric-key reordering bug.

**Recommended edit:** add a one-line comment on `keyOrder` stating *why* it exists — "preserve first-seen key order; `Object.entries` (and the shared `groupBy`) would reorder integer-like keys like `\"0\"`." That converts an invisible design decision into a guardrail. (Optionally, the inner `byKey` accumulation could reuse the shared `groupBy` while keeping the separate `keyOrder`, but that's cosmetic — the comment is the valuable part.)

## Non-issues (checked, no action)

- **One-line `if` (#):** `if (typesEqual(left, right)) return left;` is a one-line guard return, but the file it joins already uses exactly this style (`if (keys.length === 0) return NEVER_T;` in `typeOperators.ts`), and `lint:structure` — which the plan runs — passes on it. Consistency with the local file wins; leave it.
- **Single-char names (#):** the comparator params `(a, b)` and lambda vars `m`/`t`/`p` match the existing file's conventions (`(p) => …`, `id = (t) => t`). Minor cosmetic nit: `(a, b)` in the comparators could be `(left, right)` to echo the pipeline's own naming, but it's conventional for a pure equality function.
- **Nested ternaries / too-much-per-line / nested type objects / dynamic requires / magic numbers / swallowed try-catch / "ugly code":** none present. The one ternary (`members.length === 1 ? members[0] : {…}`) is single, and `IntersectionType`/`TypeEquals` are flat type defs.

**Bottom line:** the plan is clean against the catalog and, on the specific concern you raised, is a positive exemplar. The single actionable item is the `keyOrder` justifying comment.
