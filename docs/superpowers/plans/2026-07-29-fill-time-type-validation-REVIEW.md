# Review: fill-time type validation — implementation plan

Reviewed plan: `/Users/adityabhargava/agency-lang/docs/superpowers/plans/2026-07-29-fill-time-type-validation.md`

Every import, helper, and syntax form the plan leans on was verified against
the code (list at the end). The architecture is faithful to the revised spec
and the global constraints are the right ones. Three findings need fixing
before execution — one is a test-ordering contradiction the plan's own
stop-condition rule would trip over, and two are correctness bugs in Task 3's
proposed code.

## Verdict

Tasks 0, 1, and 4 are executable as written. Task 2's test list asserts
message content that does not exist until Task 3 — and in one case never
exists at all under Task 3's stated scope. Task 3's explainer compares
property types by printed-string inequality, which is both a violation of the
plan's own "no second comparer" constraint and wrong for aliased properties;
its splice hint fires on legitimate array-annotated splices too. All three
fixes stay inside the plan's structure.

---

## Finding 1 (blocking): Task 2 asserts messages Task 2 cannot produce, and one it can never produce

Task 2's `assertFillerType` throws the general two-types message:
`` expects `Person`, but the fill supplies `{ name: string }` ``. The
property-naming messages arrive in Task 3. But Task 2's tests assert content:

- **"rejects a record missing a required property" — `.toThrow(/age/)`.** The
  general message contains `Person` and `{ name: string }`; the word `age`
  appears nowhere in it. This test fails at the end of Task 2, and the plan's
  own global constraint ("expected FAIL, observed PASS" — and its mirror)
  means the executor stops, correctly confused.
- **"checks a nested record" — `.toThrow(/city/)`.** Worse: this can never
  pass, even after Task 3. The explainer deliberately declines nested records
  (`if (propertyTarget.type === "objectType") continue`), so the nested case
  always falls back to the general message — which prints
  `{ name: string, address: {} }` and `Person`, neither containing `city`.
  The test contradicts the explainer's documented scope.
- **"checks an array of records" — `.toThrow(/age/)`.** This one passes, but
  by coincidence: the synthesized element union
  `{ name: string, age: number } | { name: string }` happens to contain the
  string `age` when printed in the general message. A dedupe change or
  message reword breaks it for the wrong reason.

Fix: Task 2's rejection tests assert `/expects/` (the stable general-form
marker) plus the hole name; all property-content assertions (`/age/`,
`/city/`) live in Task 3. And the nested case needs a decision made on
purpose: either the explainer recurses one level and reports a path
(`is missing the required property \`address.city\``), or the nested test
expects the general message and the guide says localization is top-level
only. Recursing with a path is the better product answer and is still
containment-safe (it only ever annotates), but either way the test and the
explainer must tell the same story.

## Finding 2 (must fix): the explainer's property comparison is a second comparer, and a wrong one

Task 3 Step 3 blames a present property when its printed types differ:

```ts
if (printedActual !== printedExpected) {
  return `has \`${property.key}\` as ...`;
}
```

Printed-string inequality is a hand-rolled type comparison — the exact thing
the plan's global constraint bans — and it mis-blames. Concrete case:

```ts
type Name = string
type Person = { name: Name; age: number }

fill(t, { person: { name: "Alice" } })   // missing age
```

`isAssignable` rejects for the missing `age`. The walk reaches `name` first:
synthesized `string`, declared `Name`, printed forms differ, so the error
says `` has `name` as `string` where `Name` is expected `` — confidently
wrong, about a property that is fine, while the real problem goes unnamed.
Any aliased or union-typed property misfires the same way.

Fix: use the checker for the sub-question too —
`if (!isAssignable(actual, property.value, aliases)) return ...`. One
comparer everywhere, correct blame, and the containment rule is untouched
since this still only runs inside an already-decided rejection.

## Finding 3 (must fix): the splice hint mis-diagnoses a legitimate array-annotated splice

Task 3 Step 5 throws the "describes one element" hint whenever a splice
hole's expected type resolves to an array and the element was rejected. But
an array-typed splice annotation is sometimes correct: `#...rows: number[]`
splicing rows where each element *is* an array. Feed that a bad element
(`rows: [[1], "x"]`) and the hint fires, telling the author their correct
annotation "should be `number`" — pointing away from the actual bad data.

Fix: only claim the one-level-off diagnosis when the evidence supports it —
the rejected element is itself assignable to the annotation's element type:

```ts
if (hole.splice && resolved.type === "arrayType"
    && actual !== null && isAssignable(actual, resolved.elementType, aliases)) {
  // the data fits one level down: the annotation is one level up
```

Then `[{ name, age }]` against `Person[]` gets the hint (the element fits
`Person`), while a genuinely bad element falls through to the ordinary
message. Add the array-of-arrays case to Task 3's tests, asserting the hint
does *not* appear.

## Smaller points

- **Resolve once in the splice hint.** The Task 3 Step 5 snippet calls
  `resolveType(expectedType, aliases)` twice in adjacent lines; bind it to a
  local. Also `ArrayType` needs importing where the cast happens.
- **`STRING_T` and friends are shared singletons**
  (`lib/typeChecker/primitives.ts:3-9`). The synthesizer embeds them in the
  object types it builds, which is fine only as long as nothing ever mutates
  a synthesized type. One sentence in `synthesizeType`'s doc comment saying
  the result may share structure and must be treated as read-only is cheap
  insurance.
- **Commit trailers** again say "Claude Opus 5 (1M context)"; the session
  convention is `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **The nested guide fence** in Task 4 Step 3 nests a ``` block inside a
  ```markdown block, which will end the outer fence early when pasted
  literally. The executor should take the content, not the fencing.

## Claims verified as correct

- `STRING_T` / `NUMBER_T` / `BOOLEAN_T` / `NULL_T` / `ANY_T` all exist with
  exactly the shapes the tests assert (`lib/typeChecker/primitives.ts:3-9`).
- `typeKey(t, aliases)` exists with that signature
  (`lib/typeChecker/typeKey.ts:26-31`), and it resolves through
  `safeResolveType`, so the empty-table call in Task 1 is safe for
  alias-free synthesized types — the soft-spot note is accurate.
- `Object.hasOwn` with null-prototype records is a real house pattern
  (`lib/preprocessors/expandSplices.ts:77`, `lib/analysis/effects.ts:56`).
- The fixture's shape is valid Agency: stdlib `fill` returns `Result<Code>`
  via `return try _fill(...)` (`stdlib/agency.agency:565-576`), so a thrown
  validation error becomes a `failure`; `match (result)` with
  `success(v)` / `failure(e)` arms and `=> return` bodies are documented
  syntax (`docs/site/guide/pattern-matching.md:266-272`,
  `docs/site/guide/match-expressions.md:83-84`).
- The two existing tests the plan declares load-bearing are real:
  "treats an interpolated string literal as unknowable" and "validates
  against the FIRST position when a name appears twice"
  (`lib/runtime/template/fill.test.ts:229,238`), and `fillAndPrint`,
  `load`-style helpers and the `_parseExpr` import exist in that file.
- `isOptionalType` exists in `assignability.ts` with an aliases parameter,
  so Task 3's instruction to prefer it over the local guess is actionable —
  and the local fallback's null-union assumption is the one case it covers.
- The stop-condition global constraint and the run-to-fail expectations
  reflect the earlier test-audit feedback; with Finding 1 fixed, every
  expected-fail step's prediction is one I could confirm from the code.

---

## Anti-pattern audit (against `docs/dev/anti-patterns.md`)

Requested separately: does the plan's code violate the catalog, and in
particular does it expose declarative interfaces that encapsulate the
imperative work?

### One direct catalog hit

**`aliasTableFrom` uses the banned conditional-spread pattern, four times.**
The catalog's "Ugly code" entry outlaws exactly this shape —
`{ ...(traceFile ? { traceFile } : {}) }` — and Task 2 Step 3 builds every
alias entry out of four of them:

```ts
...(alias.typeParams === undefined ? {} : { typeParams: alias.typeParams }),
...(alias.valueParams === undefined ? {} : { valueParams: alias.valueParams }),
```

Replace with the plain form: build `const entry: TypeAliasEntry = { body: alias.aliasedType }`
and follow with braced `if (alias.typeParams !== undefined) { entry.typeParams = alias.typeParams; }`
lines. Same behavior, and it is the shape the catalog demands.

### Two duplication-flavored softies

- **The local `isOptional` duplicates the checker's `isOptionalType`.** The
  plan writes a fresh null-union check and says "prefer importing the
  checker's helper if its signature fits" as an afterthought. The catalog's
  first entry (duplicating existing code) says that preference is the rule:
  the checker's helper takes the alias table and resolves before answering,
  which the local version does not — so the local version is not just a
  duplicate, it is a worse one. Make importing `isOptionalType` the primary
  instruction and drop the local helper from the plan entirely.
- **The printed-string property comparison in `explainMismatch`** (Finding 2
  above) is the same anti-pattern wearing a different hat: a second,
  hand-rolled implementation of "do these types match" alongside the real
  one. The Finding 2 fix — per-property `isAssignable` — is also the
  anti-pattern fix.

### On the declarative-interface question specifically

The plan's structure is the good version of the "imperative code everywhere"
entry, and deliberately so. Each new file exposes one declarative question
and hides the walk that answers it: `synthesizeType(value)` — what type is
this value; `aliasTableFrom(nodes)` — what aliases does this template
define; `explainMismatch(value, expected, aliases)` — what, specifically, is
wrong. The imperative loops (the dedupe walk, the property walk) live
entirely inside those functions, and `fill.ts` itself reads as policy:
synthesize, compare with `isAssignable`, explain on failure. The `FillTypes`
context object is the right call against parameter creep, and the
`positionInferredVariableTypes` / derived-printed-form split enforces "one
place decides what a position supplies" structurally rather than by
discipline. The what and the how are separated exactly the way the catalog
asks.

Checked and clean: no order-dependent mutable state (every value is a
`const` derived from its inputs), no nested ternaries (`members.length === 1
? ... : ...` is single-level), no one-line `if`s, no magic numbers, no
try-catch-without-logging, no dynamic imports, no nested type definitions
(`FillTypes` names its parts), null-prototype records with `Object.hasOwn`
match the house pattern, and no test failure is destructive. The empty-array
and single-member special cases in `arrayTypeOf` are load-bearing rules from
the spec, not the catalog's "useless special case".

---

## Test plan audit

Requested separately: does each test test what it claims, will it fail when
the code breaks, and what is missing. This audit is on top of Finding 1
(the `/age/` and `/city/` ordering contradictions), which already covers the
message-content assertions and is not repeated here.

### The biggest finding is a missing test that exposes missing code

**Unresolvable aliases reject when the spec says they must skip — and no
test would catch it.** The spec's rule is "treat an unresolvable alias name
as unknowable — skip, do not reject", and the plan's own global constraint
says the same. Nothing in the plan implements it. I traced what actually
happens: an unknown alias survives resolution as a `typeAliasVariable`
(`assignability.ts:68-70`), and `isAssignable`'s unresolved-alias escape
hatch (`assignability.ts:552-558`) fires only when *both* sides are the same
unresolved name. A synthesized record is never an alias, so a synthesized
`objectType` against unresolved `Person` compares structurally and returns
**false**. Consequence: any template that gets its types from an `import`,
or declares them inside a body, has every record fill rejected — the exact
over-rejection class the constraint bans, on a completely ordinary template
shape. The fix needs code (before comparing, if the resolved expected type
still contains an unresolved name anywhere — including inside a property,
`type Person = { pet: Animal }` with `Animal` undeclared — skip; check
whether the checker already owns a "contains unresolved reference" walk
before writing one) and three tests: an imported-type template accepted, a
body-declared-alias template accepted, and a deep unresolved property
accepted. Without these, the feature ships with a landmine its own test
suite cannot see.

### Tests that do their job

- **The dedupe test fails without dedupe**: 1000 same-shaped records without
  dedupe produce a 1000-member union, so `elementType.type` is `unionType`,
  not the asserted `objectType`. Structural assert, right proxy for the cost
  bound.
- **The literal-fragment pair** ("still rejects a literal fragment of the
  wrong primitive" / "now rejects against an alias") are exactly the
  no-regression pin and the new-win test the spec review demanded. Deleting
  the fragment row from the synthesizer fails the first; deleting alias
  resolution fails the second.
- **The acceptance tests** (complete record, optional absent, union arms,
  empty array, recursive accept, unknowable fragment through) guard the
  over-rejection direction, which for a check running on model data is the
  costlier failure. Breaking `isAssignable` wiring or the skip-on-null rule
  fails them.
- **The fixture** runs the guide's own example end to end through the
  `Result` path and asserts the message names `age` — it fails if fill stops
  rejecting, stops naming the property, or stops converting the throw to a
  `failure`.

### Tests that do not test what they claim

- **"still names the hole and keeps the graft origin" does not graft.** It
  fills a hole written directly in the template and asserts `/#person/`. The
  origin suffix — ``(in code grafted by the fill for `#helpers`)`` — appears
  only for holes that *arrived through a graft*, which needs the two-step
  shape: fill a `#helpers` hole with a fragment that itself contains
  `#person`, then fill `#person` with bad data, and assert the suffix text.
  As written the test passes whether or not `originSuffix` survives the new
  error paths — the thing its name promises to check.
- **The Task 3 fallback test cannot detect the failure it exists for.**
  `/expects/` matches the general message *and* any confidently-wrong
  specific one (both start "The hole `#v` expects ..."). The test's own
  comment says the point is "not a confidently wrong specific" — assert the
  general form's unique tail instead: `/supplies `boolean`/`.

### Missing cases

1. **A primitive where a record is wanted**: `fill(..., { person: 42 })`.
   The headline behavior change (non-primitive expected types now checked)
   has no test of its simplest shape.
2. **`null` fillers**: `{ who: null }` against `: string` now rejects
   (`NULL_T` is not assignable to `string`) — a behavior change nothing
   pins; and the mirror, `null` against an optional/nullable target,
   accepted. Also decide and pin `undefined` (the synthesizer maps it to
   `NULL_T`, but whether an `undefined` value even reaches validation
   depends on how fill treats the key as present).
3. **Non-plain objects.** The synthesizer's `typeof value === "object"`
   branch describes *any* non-Code, non-array object as a record — a `Date`
   or `Map` filler synthesizes as an empty-ish `objectType` and gets
   rejected, where the spec's table says unknowable-skip. Needs a
   plain-object check in the code (prototype is `Object.prototype` or
   `null`) and a `Date`-stays-unchecked test.
4. **An inline-annotated record hole** (`#person: Person`). Every record
   test reaches the type through the assignment-position path
   (`const p: Person = #p`); the `hole.typeAnnotation` branch with a named
   type is never exercised with the alias table.
5. **A recursive-alias rejection.** The recursive test only accepts. The
   riskier path for the coinductive cycle guard is a rejection inside the
   cycle — a `Tree` whose nested child is missing `children` — asserting it
   rejects and terminates.
6. **`synthesizeType(undefined)`** is handled in the code and asserted
   nowhere in the unit tests; one line alongside the `null` case.

---

## Round 4: architecture review of the revised plan

Question asked: is this the right way to make the change, is it maintainable,
does it fit the architecture, or is it a band-aid — and is there a better
way. Short answer: right layer, right shape, one genuine design flaw found
this round (string-literal types cause false rejections), and two
band-aid-adjacent aspects that are fine only if they are managed, not
ignored.

### Is this the right layer? Yes — the alternatives are all worse

- **Compile-time checking of `fill(...)` calls** cannot cover the primary
  use: fillers are model-supplied at run time. (Still worth doing someday
  for literal arguments; the spec correctly scopes it out.)
- **Checking the completed program at fill time** is just `runCode`'s
  compile moved earlier. It cannot run while holes remain, and its errors
  point at generated source — the exact user experience this change exists
  to fix.
- **Mapping `runCode` compile errors back through origin stamps** ("this
  value arrived via `#person`") is genuinely valuable and *complementary* —
  it would cover `Code` fragments, which fill-time checking never can — but
  it is still late, and still requires running the program to learn the
  data was bad. It deserves its own issue; it does not replace this.

Validation at the boundary where the caller's data enters, expressed in the
checker's own semantics, is the correct design. And it is not a band-aid on
the reported bug: both root causes (the stringified expected type, the
undescribable value) are removed, not patched around.

### A better way existed in theory, and checking it exposed a real flaw

The highest-altitude design would be: lift the value with `liftValue`, then
ask the checker's own expression synthesizer (`synthType`) what type the
lifted literal has — making drift between fill-time checking and the real
compile impossible by construction. I checked whether that is practical: it
is not. `synthType(expr, scope, ctx)` (`lib/typeChecker/synthesizer.ts:318`)
requires a `Scope` and a full `TypeCheckerContext` (flow graphs, match-temp
tables); dragging that into the runtime for what is, for literals, a
twenty-line walk would be the wrong trade. The plan's standalone synthesizer
is the right call — **but only if it mirrors `synthType`'s inference policy
exactly, and today it does not**:

**The plan's synthesizer widens strings; the checker does not.** `synthType`
infers a plain string literal as a *string-literal type*
(`synthesizer.ts:409-414`, via `literalToType`), and `synthArray` runs
`synthType` per element, so lifted string arrays get literal-union element
types too. Numbers and booleans stay widened — deliberately, per the comment.
The plan's synthesizer returns `STRING_T` for every string. Consequence, for
a completely plausible template:

```ts
const mode: "fast" | "slow" = #mode
fill(t, { mode: "fast" })
```

The lifted program compiles — `"fast"` infers as the literal type `"fast"`,
assignable to the union. But fill synthesizes `string`, `string` is not
assignable to `"fast" | "slow"`, and the fill **rejects a value the compile
accepts**. That violates the contract this whole feature stands on, which
the plan should now state explicitly as its design invariant: **fill may
only reject fills the completed program's compile would also reject.**
False rejection is the one unforgivable failure for a check running on
model-supplied data.

The fix that honors both the invariant and the dedupe cost bound is a
second chance on the failure path only: keep the widened, deduped synthesis
for the fast path; when `isAssignable` rejects, re-synthesize
literal-accurately (strings as literal types, exactly `synthType`'s policy)
and re-check before throwing. Accepts everything the compile accepts; the
literal-union cost lands only on fills that were about to throw anyway.
And add the test: `"fast"` against `"fast" | "slow"` accepted, `"medium"`
rejected.

### The two band-aid-adjacent aspects, and what keeps them honest

- **The unresolved-name skip makes the feature silently inert for
  import-typed templates.** Correct fail-open policy, and the plan now
  implements and tests it — but silence is the problem. As template
  libraries grow, importing types will be the *normal* shape, and users
  reading "fill checks records" in the guide will believe they are protected
  when they are not. Two obligations: the guide text must state the
  boundary plainly ("fill checks types declared in the template itself;
  imported types are not checked until the program compiles"), and a
  follow-up issue should exist for import-aware resolution — that is the
  same module-resolution work as the deferred fragment-checking entry
  point, so it has a natural home.
- **Three definitions must now agree**: `liftValue` (what a value becomes),
  `synthesizeType` (what type fill says it has), and `synthType` (what type
  the checker will infer for what it became). Drift between them is the
  long-term maintenance risk — fail-open drift silently unchecks fills;
  fail-closed drift creates false rejections like the one above. The cheap
  insurance: state the invariant in `synthesizeType`'s doc comment naming
  both other functions, add a cross-reference comment in `liftValue`, and
  keep the execution fixture as the one end-to-end agreement test (it is
  currently the only thing binding all three).

### Verdict

Right way, right layer, good architectural citizenship — five checker
exports reused, zero duplicated decisions, fail-open in every uncertain
direction, precedented import direction, and the new modules each answer
one question the checker structurally cannot. Not a band-aid: the root
causes are removed and the deferred pieces (fragments, imported types,
compile-time fill checking) are deferred honestly rather than silently.
Before execution it needs the string-literal fix and its test, the stated
invariant, the guide sentence about imported types, and the follow-up
issue — with those, this is the design I would keep long-term.
