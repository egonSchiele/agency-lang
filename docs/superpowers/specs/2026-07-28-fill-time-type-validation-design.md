# Fill-time type validation: checking a filler against the hole's real type

**Revision 2 (2026-07-28).** Revised after review
(`2026-07-28-fill-time-type-validation-design-REVIEW.md`). Three changes of
substance: the synthesizer now absorbs the literal-fragment check instead of
silently dropping it, the splice path is specified rather than ignored, and
the error-explanation pass is given a containment rule. See "Response to
review" at the end.

`fill` accepts a record that is missing a required field. It accepts a string
where a `Name` alias wants a string, and a number there too. The failure shows
up much later, when the completed program is compiled by `runCode`, with a
message about generated source the caller never wrote.

This spec closes that gap for plain values. It does not attempt to check
`Code` fragments, which need a checker entry point that does not exist.

---

# What happens today

## The reported case

```ts
static const template = [|
  type Person = {
    name: string;
    age: number
  }

  node main(): string {
    const person: Person = #person
    return "ok ${person.name}"
  }
|]

node main() {
  const filled = fill(template, { person: { name: "Alice" } })   // succeeds
  print(toSource(filled.value))
}
```

`age` is required and absent. `fill` returns success. The printed program is:

```ts
type Person = {
  name: string;
  age: number
}

node main(): string {
  const person: Person = {
    name: "Alice"
  }
  return "ok ${person.name}"
}
```

which fails only when `runCode` compiles it.

## A second case with the same cause

```ts
static const t = [|
  type Name = string
  node main(): string {
    const n: Name = #who
    return n
  }
|]

fill(t, { who: 42 })   // succeeds
```

A number filling a hole whose type is an alias for `string`. This one is worth
holding onto, because it shows the problem is not really "records are hard" —
it is that the expected type is never resolved at all.

## Why

`assertFillerType` (`lib/runtime/template/fill.ts:215`) is four lines:

```ts
const actual = certainTypeOf(value);
if (actual === null) return;
const primitives = ["string", "number", "boolean"];
if (!primitives.includes(expectedType)) return;
if (actual !== expectedType) { throw ... }
```

Two things stop it from seeing either case.

**The expected type is a printed string.** By the time it arrives here it has
been through `variableTypeToString`, so the record type is the string
`"Person"` and the alias is the string `"Name"`. Neither is in the primitive
list, so the function returns before comparing anything. The `VariableType`
that was available upstream — on `hole.typeAnnotation`, or on the assignment's
`typeHint` — has been flattened to text and cannot be resolved or compared
structurally.

**`certainTypeOf` only recognizes three shapes.** Strings, numbers, booleans,
and literal expression fragments. Every object and every array returns `null`,
which means "unknowable", which means skip.

So the two halves fail independently: even given a resolvable expected type,
there is nothing to compare it against for a record.

---

# What this should become, and what it should not

The current comment calls this "validation, not a guarantee", and that framing
is right and should survive. The question is only where the line sits.

The honest line is: **when both sides are certainly known, check them.** A
plain JS value's type is certainly known — that is the whole point of it being
plain data. A hole's declared type is certainly known when it is written down
in the template. Today the second half is thrown away by stringification, so
the check does far less than its own principle allows.

What stays out is unchanged: a `Code` fragment's type is not knowable without
checking it against the completed program's module scope, and there is still
no entry point for that. A fragment continues to pass fill-time validation and
be judged at compile.

---

# The machinery already exists

This should not introduce a new type comparer. The type checker has one, it
operates on `VariableType`, and it already handles the hard parts.

- **`isAssignable(source, target, typeAliases)`** (`lib/typeChecker/assignability.ts:485`)
  — structural comparison, with a cycle guard for recursive aliases.
- **`resolveType(vt, typeAliases)`** (same file, line 31) — resolves named
  aliases, generics, and value-parameterized aliases. `isAssignable` resolves
  internally, so callers hand it the unresolved type and the alias table.
- **`TypeAliasEntry`** (`lib/types/typeHints.ts:152`) — `{ body: VariableType, typeParams?, ... }`,
  which is what the alias table holds.

And the alias definitions are already in hand: a template's `Code.nodes`
contains its own `typeAlias` nodes (`{ type: "typeAlias", aliasName, aliasedType }`,
`lib/types/typeHints.ts:285`). `type Person = { … }` inside the template is
right there in the value being filled. Nothing needs to be looked up
elsewhere, which is what makes this tractable at run time.

**Layering.** `fill.ts` lives under `lib/runtime/` and would import from
`lib/typeChecker/`. That direction already exists in production code
(`lib/runtime/toolBlockDiagnostics.ts` imports `../typeChecker/diagnostics.js`),
and nothing in `lib/typeChecker/` imports `lib/runtime/` outside test files, so
this adds no cycle. Worth confirming at implementation time rather than
assuming, since it is the one structural risk in the change.

---

# The design

Four pieces. The first two are the actual fix; the last two are what keeps it
honest.

## 1. Carry the `VariableType`, not the printed string

`fillOne` currently computes:

```ts
const expectedType =
  hole.typeAnnotation !== undefined
    ? variableTypeToString(hole.typeAnnotation, {}, true)
    : expected[hole.name];
```

Both branches start from a `VariableType` and throw it away.
`positionInferredTypes` (`lib/utils/holes.ts:60`) does the same, stringifying
`parent.typeHint` on the way out.

Change the internal path to carry `VariableType`. Printing stays where it is
needed — `HoleInfo.type` is a public, model-facing string and must keep its
current shape, and error messages want a printed form — but the value that
reaches validation should be the type itself.

That means `positionInferredTypes` needs a sibling that returns
`Record<string, VariableType>`, with the existing function either built on it
or kept alongside for `holesOf`. Deciding which is an implementation call; the
requirement is that exactly one place decides what type a position supplies,
so the string and the structured form cannot drift.

## 2. Synthesize a `VariableType` from a plain value

A new function — the natural home is next to `liftValue` in
`lib/runtime/template/lift.ts`, since it answers a question about the same
values, or its own small module if that file starts doing two jobs.

The shape of it:

| Value | Synthesized type |
| --- | --- |
| `"abc"` | `string` |
| `42` | `number` |
| `true` | `boolean` |
| `null` / `undefined` | the null type |
| `[1, 2]` | array of the union of element types, **deduplicated** |
| `[]` | array of `any` |
| `{ a: 1 }` | object type with property `a: number` |
| a `Code` fragment of kind `expr` holding one uninterpolated literal | that literal's primitive type |
| anything else | **unknowable** — return null, skip validation |

"Anything else" carries weight. It must include every other `Code` value —
including one found nested inside a record or array — and functions and
symbols, which `liftValue` rejects outright. The synthesizer must not guess.
Returning null preserves today's fail-open behavior for cases nobody has
thought about, which is the right default for a check that runs on
model-supplied data.

**The literal-fragment row is not new behavior — it is the existing check,
absorbed.** `certainTypeOf` already maps a single-literal expression fragment
to its primitive type (`fill.ts:232-241`), which is why this is rejected
today, verified by repro:

```ts
fill(t, { who: [| 42 |] })   // hole annotated `: string` → rejected
```

If the synthesizer returned null for every `Code`, that rejection would stop
firing and the change would smuggle a regression inside an improvement. Moving
the logic into the synthesizer also upgrades it for free: `[| 42 |]` against
`type Name = string` starts being caught, because the expected type now
resolves. Both need tests — the bare-primitive case as a no-regression pin,
the alias case as the new win.

An interpolated string literal stays unknowable, exactly as today: its runtime
value depends on the generated program's scope.

Empty arrays synthesize as `any[]` deliberately: `any` is assignable in both
directions (`assignability.ts:562`), so `[]` passes against `number[]` rather
than being rejected for having no elements to inspect.

**Deduplicate array member types.** Fills run at run time on model-supplied
data, and "array of the union of element types" is unbounded as written: a
10,000-element array of records would synthesize 10,000 object types and hand
`isAssignable` a union that wide. Collapsing structurally identical members
during synthesis keeps the common case — a homogeneous array — at one member,
and stays sound, which sampling a prefix would not.

## 3. Compare with `isAssignable`

```
synthesized = synthesizeType(value)          // null → skip, as today
aliases     = aliasTableFrom(template.nodes) // the template's own type aliases
if (!isAssignable(synthesized, expected, aliases)) → throw
```

The `Person` case: synthesized `{ name: string }`, expected the alias
`Person`, which resolves to `{ name: string, age: number }`. Not assignable —
a required property is missing. Rejected, at fill time, with the caller's own
data in hand.

The `Name` case: synthesized `number`, expected `Name`, resolves to `string`.
Rejected.

Note what this gives for free: unions, optional properties, nested records,
arrays of records, and recursive aliases all work, because they work in
`isAssignable`. That is the argument for reuse over a hand-rolled comparer —
not that it is less code, but that a second implementation would disagree with
the checker in exactly the cases nobody tests.

## 4. Splices: the annotation means the element type

`fillOne` has a third path (`fill.ts:168-173`) the first draft of this spec
ignored. A splice hole (`#...name`) requires an array and validates **each
element separately** against the hole's expected type:

```ts
return value.flatMap((item) => nodesFor(hole, item, expectedType));
```

Today that distinction is invisible, because only primitive expected types
fire. Under structural checking it stops being academic: is the annotation the
element type or the array type?

It is reachable, and it is the element type. Verified by repro — an annotated
splice in argument position, which is where splices are legal (they are
rejected in expression position, so the annotated-assignment position cannot
carry one):

```ts
[| print(#...items: string) |]

fill(t, { items: ["a", "b"] })   // passes
fill(t, { items: ["a", 1] })     // "The hole `#items` expects `string`,
                                 //  but the fill supplies `number`."
```

**Keep that meaning.** It is what the code already does, and it is the more
useful reading: a splice's job is to expand into several nodes, so describing
one of them is what an author wants to say.

The trap this creates should be stated rather than discovered. Someone
splicing a list of records will reasonably write `#...items: Person[]`, and
under structural checking every element is then rejected for not being an
array — a confusing failure that reads as if the data were wrong. Two things
follow:

- The guide should say explicitly that a splice annotation describes one
  spliced element, not the array.
- Worth considering, though not required by this spec: when a splice
  rejection's expected type is an array type and the *value as a whole* would
  be assignable to it, say so in the message — "`#...items` describes one
  element; try `Person`". That is a message improvement, not a semantic
  change, and it turns the trap into a signpost.

## 5. Say what is wrong, specifically

The current message names the two types:

```
The hole `#topic` expects `string`, but the fill supplies `number`.
```

For a record, that is not enough — `expects Person, but the fill supplies { name: string }`
makes the reader diff two types by eye. The message should name the actual
problem where it can:

```
The hole `#person` expects `Person`, but the fill is missing the required property `age`.
```

Falling back to the general form when the mismatch is not a single missing
property. Whether `isAssignable` can report *why* it failed is the open
question here — it returns a boolean today. Options, in order of preference:

1. A small explanatory pass that runs **only on failure**: re-walk the
   resolved expected type against the value and find the first missing or
   mismatched property. Costs nothing on the success path and needs no change
   to `isAssignable`.
2. Report the general form only, and treat better messages as a follow-up.

Option 1 is worth the effort. The whole value of moving this check earlier is
that the caller learns what is wrong with the data they supplied, and "expects
Person" does not tell them.

**But the explanatory walk is itself a second comparer**, which is what this
spec argues against everywhere else. Running it only on failure contains the
damage; it does not remove it. So the containment rule has to be explicit and
enforced by the code's shape:

> The explanatory walk may never change the accept/reject decision. It
> annotates a rejection `isAssignable` has already made. When it cannot
> localize the problem — a union mismatch, an alias it resolves differently,
> anything it does not understand — the general two-types message is the
> fallback.

Structurally: `isAssignable` decides, then the walk is asked for a detail
string, and a null answer means "use the general message". It is never
consulted about whether to throw.

That disagreement path needs a test of its own: a rejection the walker cannot
explain — a union is the easy one to construct — asserting the general message
appears, rather than nothing or a confidently wrong specific.

The existing `originSuffix` must be preserved: when the hole arrived through a
graft, the message still ends with ``(in code grafted by the fill for `#helpers`)``.

---

# Boundaries, and the ones that need a decision

**Extra properties.** `{ name, age, nickname }` against `{ name, age }`.
Structural typing normally permits this and `isAssignable` will decide it;
whatever it decides, fill should not add its own rule. Worth an explicit test
so the behavior is recorded rather than incidental.

**A `Code` value nested inside a plain object.** Today `nodesFor` checks
`isCode` only at the top level, so a `Code` sitting inside a record is lifted
by `liftValue` as ordinary data — it becomes an object literal with `type`,
`kind`, and `nodes` keys in the generated program. That is almost certainly a
caller mistake, and it is silent today. Under this change the synthesizer
returns unknowable for it, so validation skips and the behavior is unchanged.
**Recommendation: keep it that way in this change** and file the "nested Code
is lifted as data" oddity separately — it is a different bug with a different
fix, and bundling it would make this change's blast radius harder to reason
about.

**Type aliases declared inside a body.** Aliases are legal in bodies as well
as at the top level. The alias table should be built by walking the template's
nodes rather than reading only the top level, but a body-scoped alias is not
really in scope at the hole. Simplest defensible rule for v1: collect
top-level aliases only, and treat an unresolvable alias name as unknowable —
skip, do not reject. Rejecting on a name we failed to resolve would turn a
lookup gap into a user-facing error.

**Position-inferred types stay as they are.** Only the annotated-assignment
position supplies a type today, and first occurrence wins. Widening that is a
separate improvement; this spec should not change which positions supply
types, only what happens with the type once supplied.

**First occurrence winning gets more surprising, not less.** The existing rule
(`lib/utils/holes.ts:49-59`) means a hole used at two positions of different
types is validated against the first only. That is unchanged here, but it sits
worse next to validation that is otherwise thorough: a caller who sees records
checked properly will reasonably assume the second position was checked too.
Pin it with a test so the behavior is recorded, and leave widening to the
follow-up that adds more inferring positions.

**Building the alias table needs the whole entry, not just the body.** A
`typeAlias` node carries `typeParams`, `valueParams` and `tags`
(`lib/types/typeHints.ts:285-299`), and `TypeAliasEntry` has fields for all
three (`typeHints.ts:152-166`). Generic and value-parameterized aliases are
legal inside templates, so dropping those fields would make a generic alias
resolve wrongly rather than not at all — the worse failure.

---

# What deliberately does not change

- **`Code` fragments are still not type-checked, with one exception that
  already exists.** A fragment holding a single uninterpolated literal keeps
  being checked — that logic moves into the synthesizer rather than
  disappearing (see the table above). Every other fragment passes, and is
  judged when the completed program compiles. The seam noted in `fill.ts`
  remains the right place for that work when a checker entry point exists.
- **`@validate(...)` tags do not run at fill.** The alias table carries `tags`
  so resolution behaves correctly, but this is an assignability check and
  nothing more: a value can pass fill and still fail its validator in the
  completed program. Saying so prevents an overclaim, since "fill checks the
  type" will otherwise be read as "fill checks the constraints".
- **`HoleInfo.type` stays a printed string.** It is the model-facing surface
  and its shape is depended on.
- **Fill-time validation stays validation.** A fill that passes is not
  promised to compile. The completed program is still checked in full by
  `runCode`.
- **No compile-time checking of `fill(...)` calls.** Requires the checker to
  know which holes a `Code` value has and to check a literal argument against
  them. Much larger, genuinely useful, and out of scope here.

---

# Tests

In `lib/runtime/template/fill.test.ts`, alongside the existing type-validation
cases:

- The reported case: a record missing a required property is rejected, and the
  message names the property.
- A record with all properties present is accepted.
- An alias for a primitive (`type Name = string`) rejects a number and accepts
  a string. This is the case that shows aliases resolve at all.
- A nested record: a property whose type is itself an alias, missing a field
  inside it.
- An array of records: one element missing a field.
- A union type accepts each arm and rejects something outside it.
- An optional property may be absent.
- Extra properties: whatever `isAssignable` decides, pinned.
- An empty array against `number[]` is accepted.
- A recursive alias does not hang — the cycle guard is why `isAssignable` is
  being reused rather than reimplemented, so this is a test about the choice.
- Unknowable values still skip: a non-literal `Code` fragment, and a record
  containing one.
- The origin suffix survives on a rejection through a grafted hole.

From the review's findings, each pinning something that would otherwise
regress or surprise silently:

- **Literal fragment, no regression.** `[| 42 |]` into a hole annotated
  `string` is still rejected. This is the pin that stops the rewrite dropping
  the one fragment check that exists.
- **Literal fragment, the upgrade.** `[| 42 |]` into a hole annotated with an
  alias for `string` is now rejected too — impossible under the old
  primitive-list check.
- **Splice, per element.** An annotated splice in argument position: an array
  of records through `#...items` annotated with the record type, one element
  missing a field, rejected with the offending element identified. Different
  from the "array of records" case above, which is an array *value* against an
  array *type* through an ordinary hole.
- **Splice, the trap.** `#...items` annotated `Person[]` and given an array of
  `Person` — records what happens, so the confusing failure is a decision
  rather than an accident.
- **Unexplainable rejection.** A union mismatch, where the explanatory walk
  cannot localize: the general two-types message appears, not nothing and not
  a wrong specific.
- **Array dedupe.** A large homogeneous array synthesizes one member type, not
  one per element — a unit test on the synthesizer, since the cost is
  invisible from the outside.
- **Two positions, first wins.** A hole used at two positions of different
  types is validated against the first only.

An execution fixture under `tests/agency/templates/`: the guide's `Person`
example, asserting the fill fails with a message naming `age`. This is the
user-visible shape of the whole change, and it is the example in the docs. No
LLM call needed.

Documentation: `docs/site/guide/template-agency.md` shows a `Person` fill under
"Hole types". It says a type mismatch is "a runtime failure" and shows the
primitive example. It should gain the missing-property case, since that is now
caught and is the one people will hit.

---

# Risk

The change makes `fill` reject inputs it previously accepted. That is the
point, but it means a template and a filler that happen to work today —
because the missing field is never read on the path the generated program
takes — will start failing at fill. That is the correct trade, and it is the
same trade the type checker makes everywhere else, but it should be stated in
the PR rather than discovered.

The narrower risk is over-rejection from the synthesizer guessing at a value
it should have called unknowable. Every "anything else" case returning null is
what contains that, and the tests above pin the ones we know about.

The splice trap is the one place where a *reasonable* annotation now fails.
`#...items: Person[]` is what a careful author writes, and it rejects
everything. The message work in section 4 is what turns that from a bad
experience into a corrected one, and it should not be deferred.

---

# Response to review

Review: `2026-07-28-fill-time-type-validation-design-REVIEW.md`. All findings
were re-verified against the code before acting; all held.

- **Finding 1 (literal-fragment regression): accepted, and it was a real
  contradiction.** The spec said any `Code` is unknowable *and* said
  `certainTypeOf`'s fragment handling stays — no implementation satisfies
  both. Confirmed by repro that `fill(t, { who: [| 42 |] })` against a
  `string` hole is rejected today, so the first draft would have dropped a
  live check. The synthesizer now absorbs it, which also makes it
  alias-aware.
- **Finding 2 (splice path): accepted.** Confirmed by repro that an annotated
  splice validates each element against the annotation —
  `[| print(#...items: string) |]` rejects `["a", 1]` naming `number`. My
  first attempt to reproduce this failed because I put the splice in
  expression position, where splices are illegal; argument position is where
  it is reachable. Now specified, with the `Person[]` trap named and a message
  proposed for it.
- **Finding 3 (explanatory pass is a second comparer): accepted.** The
  containment rule is now stated as an invariant with a structural
  consequence — `isAssignable` decides, the walk only annotates, null means
  fall back — plus a test for the disagreement path.
- **Finding 4 (array cost): accepted**, dedupe rather than sampling, on the
  review's reasoning that dedupe stays sound.
- **Smaller points: all taken.** Alias entries carry `typeParams`,
  `valueParams` and `tags` (verified those fields exist on both the node and
  the entry); `@validate` not running at fill is now stated in "what
  deliberately does not change"; first-occurrence-wins has a boundary
  paragraph and a test.
