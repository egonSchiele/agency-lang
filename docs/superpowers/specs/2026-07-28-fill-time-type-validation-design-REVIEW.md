# Review: fill-time type validation spec

Reviewed spec: `/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-28-fill-time-type-validation-design.md`

Every code claim was re-verified against the files it cites. The design is
sound and at the right altitude — I specifically checked whether the codebase
already owns a runtime value-against-type checker that this would duplicate,
and it does not (details at the end). Three findings need a spec change
before planning; the rest are boundary conditions to state and pin.

## Verdict

The core decision — carry the `VariableType` instead of its printed string,
synthesize a type from the plain value, compare with the checker's own
`isAssignable` — is right, and the reuse argument holds up under
verification. But the spec as written silently *regresses* the one fragment
check that exists today (Finding 1), never mentions the splice path, whose
per-element validation semantics change meaning under structural checking
(Finding 2), and proposes a failure-explanation pass that is itself the
"second comparer" the spec argues against, without stating the containment
rule that makes that safe (Finding 3).

---

## Finding 1 (must fix): the literal-fragment check disappears under the design as specified

Today this is rejected:

```ts
fill(t, { who: [| 42 |] })   // hole annotated `: string`
```

because `certainTypeOf` (`lib/runtime/template/fill.ts:232-241`) maps a
single-literal expression fragment to its literal's primitive type, and
`"string"` is in the primitive list. The spec makes two claims that cannot
both survive one implementation: the synthesizer's table says any `Code`
value is unknowable ("it must include a `Code` value found anywhere inside
the structure"), and the deliberately-unchanged section says "`certainTypeOf`'s
existing handling of literal expression fragments stays." If
`assertFillerType` is rebuilt around synthesize-then-`isAssignable` and the
synthesizer returns null for every `Code`, the fragment rejection above
silently stops firing — a regression hidden inside an improvement.

The fix is one row in the synthesizer's table: a `Code` value of kind `expr`
holding a single uninterpolated literal synthesizes as that literal's
primitive type (exactly `certainTypeOf`'s current logic, absorbed). Every
other `Code` stays unknowable. This also *improves* the fragment check for
free: `[| 42 |]` against `type Name = string` is caught once aliases
resolve, which the old primitive-list check could never do. The spec should
state this as intended behavior and add both tests: the literal fragment
against a bare primitive (the no-regression pin) and against an alias (the
new win).

## Finding 2 (must address): the splice path is never mentioned, and its expected-type semantics change meaning

`fillOne` has a third path the spec does not discuss
(`lib/runtime/template/fill.ts:168-173`): a splice hole (`#...name`)
requires an array and validates **each element separately** against the
hole's `expectedType`. Today that distinction is invisible — only primitive
expected types fire, so `[1, 2, 3]` spliced into a hole annotated `number`
checks each item as `number`, which happens to be right.

Under structural checking the question "is the annotation the element type
or the array type?" stops being academic. If the per-element call is kept
as-is (element checked against the annotation), then the annotation *means*
the element type, and a user who annotates a splice `Person[]` — a
reasonable guess — gets every element rejected for not being an array. The
spec must state the rule (keeping today's per-element meaning is the
defensible choice, since it is what the code already does), and the test
list needs a splice case: an array of records through a `#...items` splice
annotated with the record type, one element missing a field, rejected with
the element identified. Note this is a different case from the test list's
"array of records" entry, which is an array *value* against an array *type*
through a normal hole.

## Finding 3 (should fix): the explanatory pass is a second comparer — state the containment rule

The spec's strongest sentence is the reuse argument: a hand-rolled comparer
"would disagree with the checker in exactly the cases nobody tests." Option
1 for error messages — "re-walk the resolved expected type against the value
and find the first missing or mismatched property" — is precisely such a
comparer. It runs only on failure, which contains the damage, but the spec
should make the invariant explicit rather than implied: **the explanatory
walk may never change the accept/reject decision; it only annotates a
rejection `isAssignable` already made, and when it finds nothing it can
localize (a union mismatch, an alias it cannot resolve the same way), the
general two-types message is the fallback.** And that disagreement path
needs a test: a rejection the walker cannot explain (a union is the easy
one), asserting the general message appears rather than nothing or a wrong
specific.

## Finding 4 (recommended): array synthesis needs a cost bound

Fills run at run time on model-supplied data. The synthesizer's rule "array
of the union of element types" makes a 10,000-element array of records
synthesize 10,000 object types, then hands `isAssignable` a union that wide.
Two cheap containments, either fine: dedupe structurally identical member
types during synthesis (all same-shaped records collapse to one), or cap
the elements sampled and fail open past the cap. Dedupe is the better
choice — it stays sound rather than sampling — but the spec should pick one
on purpose; as written the cost is unbounded and invisible.

## Smaller points

- **Alias table construction needs the whole entry.** Building
  `TypeAliasEntry` from a template's `typeAlias` nodes must carry
  `typeParams` and `valueParams`, not just `body` — both exist on the node
  (`lib/types/typeHints.ts:285-299`) and generic aliases inside templates
  are legal. Also carry `tags`, but say clearly that fill-time checking is
  assignability only: an alias's `@validate(...)` validators do not run at
  fill, so a value can pass fill and still fail its validator in the
  completed program. One sentence in "what deliberately does not change"
  prevents an overclaim.
- **First-occurrence-wins interacts with the new strictness.** The existing
  rule (documented at `lib/utils/holes.ts:49-59`) means a hole used at two
  positions of different types is validated against the first only. That is
  unchanged by this spec, but the failure it permits gets more surprising
  when validation is otherwise thorough — worth one test pinning it and one
  sentence in boundaries acknowledging it.
- **`isAssignable` returning true for `any` on either side is confirmed**
  (`lib/typeChecker/assignability.ts:562`), so the empty-array-as-`any[]`
  rule works as described. The null value also has a representation
  (`PrimitiveType` with value `"null"`), and target-side
  optionality/null-acceptance is handled (`assignability.ts:479`).

## Claims verified as correct

- `assertFillerType` and `certainTypeOf` are exactly as quoted
  (`fill.ts:215-243`); the printed-string flattening happens at
  `fill.ts:164-167` and `positionInferredTypes` (`lib/utils/holes.ts:60`)
  stringifies `parent.typeHint` as described.
- `isAssignable(source, target, typeAliases)` exists with that signature
  (`assignability.ts:485`), resolves aliases internally, and the cycle
  guard is real — the coinductive in-flight-pair mechanism from issue #470,
  so the recursive-alias test is testing something that exists.
- The layering claim holds: nothing in `lib/typeChecker/` imports
  `lib/runtime/` outside tests, and the cited precedent is real
  (`lib/runtime/toolBlockDiagnostics.ts:1` imports
  `../typeChecker/diagnostics.js`).
- The altitude check the spec implicitly makes — "this should not introduce
  a new type comparer" — survives a search for alternatives: the runtime's
  existing value validation (`lib/runtime/schema.ts:38`) takes a zod schema
  that only exists because compile-time codegen emitted it as a string
  (`typeToZodSchema.ts` returns schema *strings*), so there is no runtime
  path from a `VariableType` to a value check today. `isAssignable` plus a
  synthesizer is the smallest honest mechanism.
- The guide text the doc task targets says what the spec says it says
  (`docs/site/guide/template-agency.md:105,112` — "Hole types", "This is a
  runtime failure").

## Test list additions implied by the findings

Beyond the spec's list, which is otherwise thorough: the literal-fragment
no-regression pin and its alias-resolving upgrade (Finding 1), the splice
per-element case (Finding 2), the unexplainable-rejection fallback message
(Finding 3), a large-array cost case or dedupe unit test (Finding 4), and
the two-positions-first-wins pin (smaller points).
