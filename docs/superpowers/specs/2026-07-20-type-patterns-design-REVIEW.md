# Review: Type Patterns spec (2026-07-20-type-patterns-design.md)

Verdict up front: the core design is good and sits at the right altitude. Reusing
`schema(T)` for Tier 2 instead of building a second structural walker is exactly
right, and the "declarations keep annotation semantics, bang keeps
transformation" split is well argued. But the spec has one major hole: the `is
Type` spelling collides with an existing, documented feature (bare-identifier
binder patterns), and the spec treats that collision as parser plumbing when it
is actually a surface-design decision with a back-compat story. That needs to be
resolved in the spec, not deferred to the plan.

Everything below is ordered by severity. I verified each claim against the
parser and docs; file references are included so you can check my work.

## 1. MAJOR: `is Type` collides with bare-identifier binders, and the spec doesn't decide the rule

A bare identifier is already a valid pattern today. `variableNameParser` is one
of the alternatives in `_matchPatternParser`
(`packages/agency-lang/lib/parsers/parsers.ts:5452`), and I confirmed
empirically with `pnpm run ast`:

- `if (x is string)` parses **today** as an always-true test that binds a new
  variable named `string` to the value of `x`. The pattern-matching guide
  documents this binder behavior for `if`/`while` conditions.
- `match (x) { Person => ... }` parses **today** as a catch-all arm binding
  `Person`.

And none of the Tier 1 names are reserved words — the keyword list is just
`["break", "continue"]` (`packages/agency-lang/lib/types/keyword.ts:3`). So the
feature's primary spelling reinterprets currently-valid, currently-meaningful
programs.

Open question 2 frames this as "decide whether a type pattern becomes a new
pattern-node variant or a distinct branch in the `is` parser." That's the small
half of the problem. The big half is semantic: **the parser cannot tell a binder
from a type name.** `x is Person` is a binder if `Person` is a fresh name and a
type test if `Person` is a type alias in scope. Resolving that requires the
symbol table, which means the meaning of `x is s` changes when someone later
adds `type s = ...` to the module (or the prelude) — spooky action at a
distance.

The spec needs to state the disambiguation rule and its migration story. The
options as I see them:

1. **Reserve the Tier 1 names in pattern position** (`string`, `number`,
   `boolean`, `null`, `object`, plus the `[]` suffix). Small, honest break:
   `if (x is string)` changes meaning, but nobody plausibly binds a variable
   named `string`. This handles Tier 1 at parse time with no scope dependence.
2. **For named types (Tier 2), decide binder-vs-type at preprocess time via the
   symbol table.** If that's the plan, the spec must say what happens on
   collision (a binder name that matches an in-scope type alias). A compile
   error on the ambiguous case is probably safer than silently preferring
   either reading.
3. **Retire bare-identifier binders in `is` position entirely.** Worth at least
   considering in the spec: `if (x is y)` as "bind y, always true" is a strange
   construct of limited use (you can write `const y = x`), and it is the entire
   source of this ambiguity. Check whether any corpus/tests actually use it.

Relatedly, the match-arm story has the same confusion hazard even after
`pattern: Type` lands: `Person => ...` (binder, matches anything) and
`p: Person => ...` (type test) will sit one character apart with wildly
different semantics. The spec should say whether bare-identifier arms stay
legal, and if so, whether the checker should warn when a bare arm's name
matches an in-scope type — that's almost certainly a user who meant the type
test.

One back-compat direction is safe and worth stating: in *pure-boolean*
contexts, `value is string` is a compile error today ("bare identifier binder
has nowhere to bind", `packages/agency-lang/lib/lowering/patternLowering.ts:1119`),
so `const looksLikeText = value is string` goes from error to working — no
break there. The breaks are confined to `if`/`while` conditions and match arms.

### Recommended resolution for #1

Corpus evidence first: a grep across `tests/`, `lib/`, and `examples/` for the
bare-binder form (`x is someName`) finds **zero real uses** — every hit is
English prose inside comments. The always-true binder is an unused construct,
which makes the clean fix cheap.

The principle: **grammar position decides type-vs-binder; name resolution never
does.** Three rules:

1. **After `is`, a top-level bare identifier is always a type reference.**
   Retire the binder reading there — it was always expressible as
   `const y = x`, and it has no users. The identifier resolves against the
   type namespace (primitives always; aliases via the symbol table). A name
   that isn't a type is a compile error with a pointed message ("`foo` is not
   a type; to bind the value write `const foo = x`"). Nested patterns keep
   their binders (`x is {name, age}` is unchanged) — the collision only ever
   existed at the top level of the RHS. Scope-dependence now only works in
   the safe direction: adding a type alias later can turn an error into
   working code, never silently change a working program. No reserved words
   needed.
2. **The arm-level `: Type` suffix always parses its RHS with the type
   grammar.** It's new syntax; there is nothing to disambiguate. Same error
   shape as rule 1 for non-type names.
3. **Bare-identifier match arms stay binders, with a shadowing warning.**
   The binding catch-all (`other => f(other)`) is genuinely useful, unlike
   the `is` binder. Close the `Person =>` (binds) vs `p: Person =>` (tests)
   hazard with a checker warning when a bare arm binder's name matches an
   in-scope type, suggesting `p: Person` or `is Person`.

Residual risk: code outside the corpus that wrote `if (x is y)` where `y` is
also an in-scope type would silently change from always-true-bind to runtime
test instead of erroring. Given zero observed usage of the construct at all, I
would accept this; a one-release parser notice on every top-level bare
identifier after `is` is available as a belt-and-suspenders option.

## 2. MODERATE: Rule 1 plus transforming validators binds values that violate the type's invariant

Rule 1 says the pattern consults validators only to decide the match and binds
the **original** value. But `schema(T).parse` treats a transforming validator
as a success: the guide's own example clamps `age: -5` to `1` and returns
`success` (`docs/site/guide/type-validation.md`, "With the validator that
modifies the value"). So under Rule 1:

```ts
match (u) {           // u = { name: "Alice", age: -5 }
  p: Person => ...    // MATCHES — parse succeeded (by transforming)
}
```

and `p` is bound to the original with `age: -5`, statically narrowed to
`Person`. The arm now holds a `Person`-typed value that the type's own
validator would have rewritten — the invariant the validator exists to enforce
does not hold on `p`. Rule 1 was written to avoid the "test silently rewrites
its subject" trap, but for transforming validators it creates the opposite
trap: the test says yes to a value the type would never let through unchanged.

The spec should confront this head-on. Options, roughly in order of my
preference:

- Match only when the parse output **equals** the input (transform was the
  identity). "Is this a Person?" then means "is this already a valid Person,"
  which is arguably the honest answer for a test-shaped construct. Cost: a
  deep-equality check on match, and repair-style validators make the pattern
  stricter than the bang.
- Keep Rule 1 as written but document the hole explicitly, in the spec and in
  the eventual guide page: "a transforming validator counts as a pass; the
  bound value is pre-transform."

Either is defensible; silence is not, because this is precisely the sort of
subtle semantic that bites someone six months later.

## 3. MINOR: `null` is already a pattern; the spec presents `is null` as new

`null` is already in `_matchPatternParser` (`nullParser`), so both
`draft is null` and a bare `null => ""` match arm work **today**. Two
consequences:

- The background section's claim that "the only way to ask that question is to
  fall back to raw JavaScript-style checks" overstates — the null third of the
  opening example is already expressible. Worth a one-line correction so the
  motivation stays credible.
- The arm section introduces a third spelling for the same test: `null`,
  `is null`, and `_: null` would all be legal arms. The spec justifies
  `is null` over `_: null`, but never mentions the plain `null` literal arm
  that already exists. Either drop `is null` from the examples in favor of the
  existing literal (my lean — one fewer spelling), or acknowledge all three
  and say the literal remains the idiomatic one.

## 4. MINOR: union types are named as Tier 2 but never spelled

The Tier 2 list includes "a union," but no example shows one in pattern
position. Is `x is A | B` legal, or only a named alias for that union? Inline
`|` in expression context raises its own precedence questions (`is` currently
takes a pattern, not a type expression, on its right). Simplest v1 answer:
inline unions are not spellable in a pattern; use a named alias. Whatever the
answer, the spec should state it — "union" appearing in the Tier 2 list reads
as a promise of `is A | B`.

## 5. MINOR: say the cost and the async question out loud

A `match` with several Tier 2 arms runs a full Zod parse — deep structural
walk plus every attached validator — per arm, in order, until one matches.
For big values or expensive validators that's real work per match, and
validators are arbitrary Agency functions, so a non-matching arm's test can
run user code with side effects. This is the same cost profile as the bang, so
it's acceptable, but the spec should state it as an accepted cost rather than
leave it implicit.

Related open question for the plan stage (worth adding as #5): can `@validate`
validators be async? If the schema parse can be async, the compiled form of
`if (x is Person)` and of match-arm tests needs to await, which shapes the
generated code and belongs on the plan's radar early.

## 6. MINOR: state whether narrowing is positive-only

The narrowing section only claims narrowing in the branch where the test
succeeded. Users will immediately ask about the other direction:

```ts
if (draft is null) { return "" }
// is draft narrowed to exclude null here?
```

The opening example's `if`-chain rewrite reads as if it relies on this. One
sentence settles it either way — "v1 narrows only the success branch; negative
narrowing may come later" is fine if that's the truth. Silence will be read as
yes.

## Confirmations (things I checked that hold up)

- `schema(T)` is already a user-facing function that works on arbitrary
  in-scope aliases (`docs/site/guide/schemas.md`), so open question 3 is
  mostly pre-answered: the generated Tier 2 check can emit `schema(T)` and
  lean on existing schema-parameter machinery.
- `object` is already a primitive type in the type grammar
  (`packages/agency-lang/lib/parsers/parsers.ts:930`), so `is object` has an
  existing static type to narrow to. Same for `any`/`any[]`. No new type
  keyword needed — the spec's "no new `array` keyword" instinct extends
  cleanly.
- The bang description in Rule 1 matches the guide: `Person!` yields a
  `Result` carrying the transformed value on success.
- Exhaustiveness conservatism (type-pattern arms never count; `_` required)
  matches the existing guide guidance for open scrutinee types and is the
  right v1 call given validators can reject.
- Keeping type patterns out of `let`/`const`/`for` is correctly reasoned —
  `: Type` there is an annotation today and must stay one.
