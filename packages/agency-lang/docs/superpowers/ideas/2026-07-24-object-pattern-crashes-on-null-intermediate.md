# A nested object pattern crashes instead of failing to match

## Status (2026-07-24)

**Implemented**, pending review. Found while designing the safeBash command
matcher (see [safeBash command-to-tool matching](2026-07-24-safebash-command-to-tool-matching.md)),
where the natural shape for a lowered bash command has an optional
`redirect` field.

Two decisions came out of implementation, both recorded in Resolution
below: the check is the strong one (a full shape test, not just `!= null`),
and it is emitted as a PAIR — `!= null` first, then the coarse test —
because `is object` narrowing loses union members. That second half is a
workaround for a separate gap:
[is object narrowing loses union members](2026-07-24-is-object-narrowing-loses-union-members.md).

## The Problem

A pattern that reads a field of a field lowers to a bare member-access
chain with nothing checking the intermediate. When the intermediate is
`null`, the arm does not fail to match — it throws.

```ts
type Redirect = { op: string, path: string }
type Cmd = { words: string[], redirect: Redirect | null }

def run(c: Cmd): string {
  return match (c) {
    { words: ["echo", ...rest], redirect: { op: ">", path } } => "write ${path}"
    _ => "fallback"
  }
}

run({ words: ["echo", "hi"], redirect: null })
// expected: "fallback"
// actual:   failure("Cannot read properties of null (reading 'op')")
```

The same thing happens with no nesting at all, when the scrutinee itself
is null:

```ts
match (x) {          // x is null
  { a: 1 } => "one"
  _        => "fallback"
}
// actual: failure("Cannot read properties of null (reading 'a')")
```

An array pattern has the identical shape (`null.length`).

This is worse than a wrong answer: a pattern's whole job is to decide
whether a value matches, and "this value does not match" is the case that
crashes. Today it is masked by luck — `&&` short-circuits, so an earlier
check in the same arm that happens to fail first hides the problem. Reorder
the arms, or make the earlier checks pass, and it surfaces.

### The typechecker already reports this

The checker is right and worth listening to:

```
error AG2008: Property 'op' is not available on every member of
  'Redirect | null'; narrow the value before accessing it.
```

It is describing the generated condition exactly. That means the fix
below also silences the diagnostic, rather than needing separate work:
`&&` narrowing already handles the guarded form
(`r != null && r.op == ">"` typechecks clean today).

## Cause

`collectChecks` (`lib/lowering/patternLowering.ts:1042`) walks a pattern
and pushes one boolean check per constraint, joined with `&&` by
`patternToCondition` (`:1035`). The `objectPattern` case recurses
straight into `fieldAccess(source, prop.key)` (`:1047`) without first
requiring that `source` is a non-null object. `arrayPattern` (`:1052`)
likewise reads `source.length` (`:1056`) before establishing that
`source` is an array.

## Proposed Behavior

Before an object pattern reads any field, require that the value is a
non-null object. Before an array pattern reads `length`, require that the
value is an array.

```ts
// { redirect: { op: ">" } } against `c`
c != null && c.redirect != null && c.redirect.op == ">"
```

Emit the guard for the pattern's own source, not only for nested ones —
the top-level null scrutinee above is the same bug one level up.

Open question for design: how strict should the guard be? A `!= null`
check is the minimum that fixes the crash. An `is object` / `is any[]`
test is stronger and matches what the pattern actually asserts (an object
pattern should not match the number `3`), but it is a behavior change
beyond the crash — a pattern that currently matches a non-object by
reading `undefined` fields off it would start failing to match. Decide
during design; lean toward the stronger check, since the weaker one
leaves `match (3) { { a: 1 } => ... }` still reading `(3).a`.

Redundant guards are acceptable: `patternToCondition` already joins with
`&&`, so a duplicate `c != null` costs one cheap comparison. Prefer
correctness over minimal output; if the noise matters, dedupe checks by
their printed source in a later pass.

## Touch Points

- `lib/lowering/patternLowering.ts:1042` `collectChecks` — push the
  existence guard in the `objectPattern` and `arrayPattern` cases before
  recursing / reading `length`.
- `lib/lowering/patternLowering.ts:1035` `patternToCondition` — nothing
  needed if the guards are pushed as ordinary checks, since the reduce
  already joins them left to right and `&&` short-circuits in the right
  order.
- Fixture expectations under `tests/typescriptGenerator/` that pin the
  generated condition for object/array patterns will need regenerating
  (`make fixtures`).

## Tests

Agency execution tests (`tests/agency/`), no LLM calls needed:

- Nested object pattern where the intermediate is `null` → falls through
  to `_`, no failure.
- Top-level object pattern against `null` → falls through.
- Array pattern against `null` → falls through.
- Nested pattern where the intermediate is present → still matches, and
  the binding is correct.
- Arm ordering: the crashing arm placed FIRST (so no earlier `&&` can
  short-circuit it away) — this is the case that fails today.
- A typecheck test asserting the AG2008 above is gone for the guarded
  form.

## Resolution

`collectChecks` now pushes a `shapeCheck` at the head of the
`objectPattern` and `arrayPattern` cases:

```ts
source != null && __coarseTypeTest(source, "object")   // object patterns
source != null && __coarseTypeTest(source, "array")    // array patterns
```

**Why the strong check.** The crash was one symptom; the wrong matches
were the other. A bare `!= null` would have fixed only the crash and left
`{ a }` matching `3` and `[a, b]` matching `"abc"` — the kind of thing a
safeBash rule must not do.

**Why the pair.** The coarse test alone suffices at runtime. The `!= null`
in front is for the type checker: `is object` narrowing lands on opaque
`object`, so a pattern reading through a `Redirect | null` field would
report AG2011. `!= null` filters the union properly and the coarse test
does not clobber it. Remove the `!= null` half once the narrowing gap is
fixed.

**Behavior changes beyond the crash**, each covered by a test:

- `{ a }` no longer matches a non-object; `[a, b]` no longer matches a
  string.
- An object pattern does not match an array, since Agency's `object` is
  defined as non-null and non-array. `[a, b]` is the spelling for arrays.
- `match (3 is { s, b })` now reports the head-pattern mismatch as a
  failure instead of binding `undefined` and running an arm. A binder-only
  head pattern previously produced no condition at all, so it had nothing
  to gate on.

One fixture line changed across the whole fixture set
(`tests/typescriptGenerator/type-patterns.mjs`): a `{name, age}: Person`
arm now carries the object test after its schema validation. Redundant
there, and left in — one mechanism beats a special case.

## Related

- `docs/site/guide/pattern-matching.md` — "Failure semantics" currently
  says destructuring a `null` surfaces as a `failure` Result. That is
  about `const { name } = null`, a declaration. Match arms should be
  different: a non-matching value is not an error. Worth a doc note once
  fixed.
- [safeBash command-to-tool matching](2026-07-24-safebash-command-to-tool-matching.md)
  — the consumer that needs this.
