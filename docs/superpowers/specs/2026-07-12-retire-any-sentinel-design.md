# Retire the `"any"` string sentinel in favor of `ANY_T`

**Issue:** #472. **Delivery:** one PR, built as an ordered stack of commits.

## The problem

The typechecker needs a way to say "I don't know this type." That stand-in is
called `any`. Today the checker writes `any` two ways.

One way is a proper type object:

```ts
const ANY_T = { type: "primitiveType", value: "any" };
```

The other way is the bare string `"any"`. A function that computes a type may
return either a real object or that string. Its signature reads
`VariableType | "any"`.

Two spellings of one idea tax every reader. Three symptoms recur:

1. **Every check asks the question twice.** The pattern `t === "any" ||
   isAnyType(t)` appears across the checker. It tests the string form, then
   the object form.
2. **A conversion helper exists only to bridge the two.** `maybeAny()` turns
   the string into `ANY_T` so it fits inside a structured type. It has no
   other reason to exist.
3. **The assignability check special-cases `any` twice, back to back.** One
   branch handles the string, another handles the object, with a comment
   admitting they do the same thing.

Only `any` has this problem. Every other keyword (`null`, `never`, `void`,
`boolean`, `string`, `number`, `regex`) lives purely as an object and never
appears as a string sentinel. `any` alone got infected because it is the
value the checker returns when inference gives up, and `return "any"` was
easier to type than `return ANY_T`.

## Goal and non-goals

**Goal.** Delete the string sentinel. Keep `ANY_T`. Every function returns a
plain `VariableType`. Every "is this any?" test becomes one call to
`isAnyType`. `maybeAny` and the duplicate local `isAnyType` in `inference.ts`
are deleted.

**This changes no behavior.** The checker already treats the string and the
object identically. The assignability code proves it: both forms return the
same answer. Swapping one for the other is invisible to every program the
checker runs. The test suite is the proof.

**Non-goals.**
- No other keyword changes. `null`, `never`, and the rest stay as they are.
- No new checker behavior. This is a pure representation change.
- Nothing outside `lib/typeChecker/` changes. The sentinel is fully contained
  there. It never reaches the backends, and `synthType` has no external
  callers. (Verified: zero `| "any"` signatures live outside `lib/typeChecker/`.)

## The spine: three central definitions

The sentinel radiates from three declarations. Narrow these, and the compiler
lists most of the remaining work for you.

1. **`ScopeType`** (`scope.ts:3`): `type ScopeType = VariableType | "any"`.
   The `Scope` stores every variable as a `ScopeType`, so `flow.ts` and
   `scopes.ts` carry the sentinel everywhere they read a variable. Once the
   sentinel is gone, `ScopeType` equals `VariableType` and the alias has no
   remaining purpose. Collapse it to `VariableType` and remove the alias.
2. **`synthType`** (`synthesizer.ts:252`): returns `VariableType | "any"`.
   This is the main producer. It holds 27 of the 35 `return "any"` sites in
   the checker.
3. **`inferredReturnTypes`** (`types.ts:99`):
   `Record<string, VariableType | "any">` on the checker context. This is why
   `synthPipeRhs` performs its awkward `!== "any"` narrowing dance.

`widenType` (`assignability.ts:341`) is a fourth, smaller anchor. It takes and
returns `VariableType | "any"` and carries `as VariableType` casts to paper
over the union. Those casts disappear once its signature narrows.

## Migration mechanics

The order is what makes this safe. We lean on one temporary widening so that
no intermediate state is ever half-broken.

**Step 1: Teach `isAnyType` to accept both forms.** Widen its parameter from
`VariableType` to `VariableType | "any"` (`utils.ts:48`). Every
`t === "any" || isAnyType(t)` then collapses to `isAnyType(t)`. Behavior is
unchanged, because both forms already count as `any`. This is the safety mat
for every later step.

**Step 2: Produce the object, not the string.** Change each `return "any"` to
`return ANY_T`. Both mean "I don't know," so the meaning is identical. Start
with the innermost helpers and work outward.

**Step 3: Narrow one signature; let the compiler find the fallout.** When a
function starts returning a real object, narrow its signature from
`VariableType | "any"` to `VariableType`. The compiler flags every caller that
still expected the string. Follow the errors outward, one function at a time,
until a file is clean. The compiler enumerates the work; we do not hunt by
hand.

**Step 4: Delete the dead machinery.** Once nothing produces the string:
- Delete `maybeAny` (`synthesizer.ts:236`). Nothing is left to convert.
- Delete the duplicate `isAnyType` in `inference.ts:129`. Use the shared one.
- Narrow `isAnyType`'s parameter back to `VariableType`. The string no longer
  exists, so the helper should stop pretending it might.
- Remove the `as VariableType` casts in `widenType`.
- Collapse `ScopeType` to `VariableType` and remove the alias.

After the final narrowing, the string `"any"` is not a valid type anywhere in
the checker. Any attempt to reintroduce it fails to compile.

## The control-signal sites need hands

A few functions use `"any"` as a **signal**, not a type. There the string
travels next to `null` or `undefined`, which carry their own meanings. These
cannot be blind-swapped. Each one gets read and rewritten deliberately:

- `synthesizer.ts:75` and `synthesizer.ts:199` return
  `VariableType | "any" | null`. Here `"any"` means "caller should return
  any," and `null` means "no resolution, keep looking." `resolveResultFieldType`
  is the clearest case.
- `checker.ts:50`, `:74`, `:979` return `VariableType | "any" | undefined`,
  where `undefined` means "absent."
- `functionTypeRaises.ts:38` and `:131` carry
  `VariableType | "any" | null | undefined`.

For each site the rule is the same. Keep `null` and `undefined` with their
current meanings. Fold only the `"any"` disjunct into `VariableType` as
`ANY_T`. Before folding, confirm the caller treated the `"any"` case the same
way it treats any other unknown-type result. Where it did, the fold is safe.
Where it branched on `"any"` specifically, rewrite the branch by hand.

## Suggested commit order

Innermost first, so each commit compiles and the compiler guides the next.

1. Widen `isAnyType` to accept both forms; collapse every
   `t === "any" || isAnyType(t)`.
2. `synthesizer.ts` internals: `return ANY_T`, narrow `synthType` and its
   helpers. Handle the two `| null` signal sites here.
3. `scope.ts` / `flow.ts`: collapse `ScopeType`, narrow the flow walker.
4. `checker.ts` / `scopes.ts`: narrow, including the `| undefined` signal sites.
5. `resolveCall.ts` / `builtins.ts` / `inference.ts`: narrow; delete the
   duplicate `isAnyType`.
6. Remaining consumers: `matchExprTypes.ts`, `typeCases.ts`,
   `interruptAnalysis.ts`, `functionTypeRaises.ts`, `functionValueEffects.ts`,
   `effectSets.ts`, `effectPayloadCheck.ts`, `matchExhaustiveness.ts`,
   `narrowing.ts`, `flowBuilder.ts`, `index.ts`, `types.ts`.
7. Cleanup: delete `maybeAny`; narrow `isAnyType` back to `VariableType`;
   remove `widenType`'s casts; update `types.ts` `inferredReturnTypes`.

The counts are a guide, not a contract. The compiler decides when a step is
done: a file is finished when it type-checks with the narrowed signatures.

## Testing and the safety net

This change must alter no behavior, so the existing suite is the gate.

- Run the full `lib/typeChecker/` unit suite. Every test passes unchanged.
- Run the fixture integration tests. Diagnostics stay byte-identical.
- If any test flips, stop. A flip means the string and the object were **not**
  treated identically somewhere. That is a real asymmetry, and it needs a look
  before the migration continues.

Add one cheap regression guard so the sentinel cannot creep back: a test that
scans `lib/typeChecker/` source and asserts no `VariableType | "any"`
signature and no bare `return "any"` remain. The type system already blocks
production of the sentinel; this guard documents the intent and catches a
stray reintroduction in review.

## Risks

- **Hidden asymmetry.** The whole plan rests on the string and the object
  being interchangeable. The assignability code and the test suite support
  that, but a rarely-hit path could differ. The test suite is the detector,
  and the "stop on a flip" rule is the response.
- **Signal sites.** The `| null` and `| undefined` sites are the one place a
  mechanical swap could change control flow. They are enumerated above and get
  per-site review.
- **Size.** The change touches roughly 283 spots across 30 files. It is wide.
  It is also mechanical and compiler-guarded, so width is low-risk. One PR
  keeps it atomic and avoids a lingering half-migrated state.
