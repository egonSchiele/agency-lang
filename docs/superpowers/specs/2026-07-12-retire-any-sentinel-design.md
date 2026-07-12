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

1. **Comparisons test the string by hand.** About 65 sites compare against the
   literal, as `t === "any"` (56 sites) or `t !== "any"` (9 sites). Each one
   knows only the string form. Four of them pair the check with the object
   form as `t === "any" || isAnyType(t)`, spelling out the redundancy in a
   single line.
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

## The core invariant

One rule makes this safe, and breaking it is the main hazard:

> **Change a function's returns and narrow its signature in the same commit.
> Never change returns ahead of the narrowing.**

Here is why. Suppose a producer changes `return "any"` to `return ANY_T` but
keeps its wide `VariableType | "any"` signature. A consumer that does
`if (t === "any")` still type-checks, because the signature still allows the
string. But `t` now holds the object, so the comparison is `false` at runtime
and the any-handling branch silently dies. Behavior changes and nothing fails
to compile.

The narrowing is what protects us. Once the signature is `VariableType`, a
leftover `t === "any"` becomes a "no overlap" compile error (TS2367). The
return change alone protects nothing. So the two always travel together.

## Migration mechanics

Four moves, in order. The first two are behavior-preserving and
compiler-clean. The third does the retirement under the invariant above.

**Move 1: Teach `isAnyType` to accept both forms.** Widen its parameter from
`VariableType` to `VariableType | "any"` (`utils.ts:48`). This is small, and
it lets the next move rewrite every check to a single helper call.

**Move 2: Route every comparison through `isAnyType`.** Replace all 65 literal
comparisons. `t === "any"` becomes `isAnyType(t)`. `t !== "any"` becomes
`!isAnyType(t)`. The four paired sites collapse to one call. This move is the
bulk of the change, and it is behavior-preserving: `isAnyType` on the string
returns exactly what `=== "any"` did. After it, no code reads the literal by
hand. That is what closes the silent-break window. When producers switch to
`ANY_T` in the next move, no string comparison is left to go quietly false.

**Move 3: Retire the string, producer by producer.** For each producer, in one
commit: change its `return "any"` to `return ANY_T`, narrow its signature from
`VariableType | "any"` to `VariableType`, and fix whatever the compiler then
flags. Because Move 2 already converted the comparisons, the fallout is small
and mechanical. Any comparison Move 2 missed surfaces here as a TS2367 error
the moment its producing signature narrows. That is the invariant working as a
backstop. Start with the spine (`synthType`, `ScopeType`,
`inferredReturnTypes`) and let the compiler pull in each producer's consumers.

**Move 4: Delete the dead machinery.** Once nothing produces the string:
- Delete `maybeAny` (`synthesizer.ts:236`). Nothing is left to convert.
- In `inference.ts`, delete the local `const ANY_T` (`:126`) and the duplicate
  `isAnyType` (`:129`). Import both from `primitives.js` and `utils.js`.
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

Commits follow the moves above, not the file layout. Moves 1 and 2 are global
sweeps. Move 3's commits are scoped by *a producer signature plus the
consumers the compiler flags when it narrows*, because those cannot be split:
narrowing `synthType` alone turns every `=== "any"` on its result across
`checker.ts`, `flow.ts`, and `scopes.ts` into a compile error at once. A
file-scoped commit could not compile in isolation. Each commit here does
compile and pass tests on its own.

1. **Widen `isAnyType`** to accept `VariableType | "any"` (Move 1). Collapse
   the four paired sites while here.
2. **Route all comparisons through `isAnyType`** (Move 2). All 65 sites. No
   producer changes yet, so this is behavior-preserving and compiles green.
3. **Narrow the spine and its fallout** (Move 3). `synthType`,
   `ScopeType`, and `inferredReturnTypes` are interlinked; narrowing one drags
   in the others plus their consumers. Expect one large, atomic commit here,
   including the `| null` signal sites in `synthesizer.ts` and the `ScopeType`
   collapse in `scope.ts` / `flow.ts`.
4. **Narrow the remaining producers**, each with its consumers, as the
   compiler surfaces them: `checker.ts` (with its `| undefined` signal sites),
   `scopes.ts`, `resolveCall.ts`, `builtins.ts`, `inference.ts`,
   `matchExprTypes.ts`, `typeCases.ts`, `interruptAnalysis.ts`,
   `functionTypeRaises.ts`, `functionValueEffects.ts`, and the rest. Split into
   as many commits as compile cleanly on their own.
5. **Cleanup** (Move 4): delete `maybeAny`; fold `inference.ts`'s local
   `ANY_T` and duplicate `isAnyType` into imports; narrow `isAnyType` back to
   `VariableType`; remove `widenType`'s casts; collapse the `ScopeType` alias.

The counts are a guide, not a contract. The compiler decides when a commit is
done: it is finished when it type-checks with the narrowed signatures and the
suite passes.

## Testing and the safety net

This change must alter no behavior, so the existing suite is the gate.

- Run the full `lib/typeChecker/` unit suite. Every test passes, with one
  expected exception below.
- Run the fixture integration tests. Diagnostics stay byte-identical.
- If a test flips for any other reason, stop. A flip means the string and the
  object were **not** treated identically somewhere. That is a real asymmetry,
  and it needs a look before the migration continues.

**One test file changes on purpose: `flow.test.ts`.** It asserts on the
sentinel *value* at nine sites, as `expect(...).toBe("any")`. Those functions
return `ANY_T` after Move 3, so `.toBe("any")` would fail. Migrate each to an
object check, `expect(isAnyType(...)).toBe(true)`, in the commit that narrows
the producing signature. This is an assertion update, not a behavior change.
No other test asserts on a `| "any"` signature, so the rest of the suite needs
nothing beyond passing.

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
- **Size.** The change spans 23 non-test files in `lib/typeChecker/`: 65
  comparison sites, 35 `return "any"` producers, and roughly 240 sentinel-
  related occurrences in all. It is wide. It is also mechanical and
  compiler-guarded, so width is low-risk. One PR keeps it atomic and avoids a
  lingering half-migrated state.
