# keyof and indexed access types

**Date:** 2026-07-10
**Status:** Approved design, ready for planning
**Prior art in this repo:** utility types (PR #478), recursive aliases (PR #485). This spec reuses their machinery and conventions throughout.

## What we are building

Two type operators, modeled on TypeScript.

**`keyof T`** gives you the key names of an object type, as a type:

```ts
type User = {
  name: string,
  email: string,
  age: number,
}

type UserField = keyof User
// UserField is "name" | "email" | "age"
```

**`T["key"]`** gives you the type of one field:

```ts
type Address = User["address"]           // the nested object type
type City = User["address"]["city"]      // string
```

Both replace hand-copied types that silently drift when the source type
changes. `keyof` has a second payoff: it produces a closed literal union,
so Agency's existing enforcement applies. A `match` over a `keyof User`
value gets exhaustiveness checking. Add a field to `User`, and every
match that handles "all fields of User" reports a missing case.

## Decisions made during brainstorming

- **Object-only in v1** (owner-approved): both operators error on
  `Record<K, V>`, arrays, primitives, and unions-of-objects. This matches
  the utility-types v1 stance. Relaxing later is easy.
- **Two new `VariableType` variants** (`keyofType`, `indexedAccessType`).
  These operators cannot ride the `genericType` node the way `Partial`
  did: `keyof` is a prefix operator and `T["key"]` is postfix. Neither
  parses as `Name<args>`.
- **`typeof` is excluded** (owner-approved). See non-goals for the
  reasoning; it is an architecture change, not a sibling feature.
- **The `deepResolveNode` checklist gap gets fixed as part of this PR**
  (owner-requested). See the documentation section.

## Semantics

Evaluation is eager, like the utility types: the resolver computes the
result during type resolution, and nothing downstream ever sees the
operator nodes. This passes the litmus test (every Agency type must
eagerly evaluate to a concrete, JSON-schema-able shape), and it means
there is no provider question. Providers only ever receive ordinary
unions and object types.

### keyof

| Input | Result |
|---|---|
| `keyof { a: string, b: number }` | `"a" \| "b"` |
| `keyof {}` | `never` |
| `keyof SomeAlias` | resolve the alias first, then apply |
| `keyof Tree` (recursive alias) | works; keys are top-level, one resolution step suffices |
| `keyof number`, `keyof string[]`, `keyof Record<K,V>` | error: `keyof expects an object type, got '...'` |

### Indexed access

| Input | Result |
|---|---|
| `User["name"]` | the property's type |
| `User["address"]["city"]` | chains left to right |
| `User["name" \| "age"]` | union of the property types |
| `User[keyof User]` | union of ALL property types (composition, free) |
| `User["nope"]` | error listing available keys, same wording family as Pick |
| `User[number]`, `User[SomeNonLiteral]` | error: index must be a string literal or union of string literals |
| Non-object base | error, same as keyof |

The index may be any type expression that RESOLVES to string literals.
`User[keyof User]` works because `keyof User` evaluates first.

### Composition

These all work through the existing recursive resolver, with no special
code:

```ts
Pick<User, keyof User>          // same as User
Partial<User["address"]>        // nulls the nested object's fields
type Keys<T> = keyof T          // generic alias; evaluates at use sites
Tree["children"]                // Tree[] — recursion machinery unchanged
```

Generic alias declarations validate without evaluating. `type Keys<T> =
keyof T` must not error at declaration, where `T` is a stubbed nominal
reference. This falls out of the existing design: `validateTypeReferences`
walks bodies without resolving, exactly as it does for `PartialOf<T>`.
The spec calls it out so the executor adds the declaration-and-use-site
test rather than discovering the subtlety.

### Precedence

Postfix binds tighter than prefix. `keyof User["address"]` means
`keyof (User["address"])`. Parentheses group: `(keyof A) | (keyof B)`.
A union of keyofs needs no parens (`keyof A | keyof B` parses as a union
because `keyof` binds to the immediately following non-union type).

### The keyword is reserved

`keyof` becomes a keyword in type position. A user alias literally named
`keyof` would stop parsing as before. Handle it the way the utility
types handled their five names: add `keyof` to `RESERVED_TYPE_NAMES` so
declaring `type keyof = ...` is a clear error rather than a silent
parse change. Breaking in principle; no stdlib or test code uses the
name (verify with a grep during execution).

### Tags

An indexed access returns the property's type WITH its property-level
tags, so `@validate` annotations on the field ride along to the new use
site. `keyof` results carry no tags (key names have no annotations).

### Error surfacing

Same as `Record` keys and the utility types: the resolver throws
`TypeError`, which `safeResolveType` swallows at typecheck time and
`resolveTypeDeep` surfaces fatally at codegen. This is the known,
documented gap (located diagnostics are the standing follow-up). Pin it
with a test, as the utility-types PR did.

## Implementation

### Parser

- `keyof` — a prefix parser slotted into the `variableTypeParser`
  or-chain: the keyword, whitespace, then a non-union type expression.
- `T["key"]` — extends the existing postfix bracket handling where `T[]`
  arrays parse. Disambiguate by bracket contents: empty brackets mean
  array, a string literal means index. Loop for chains. The executor must
  find the exact array-suffix parser and integrate there; array-of-result
  (`User["tags"][]`) and index-of-array-element are decided by the same
  loop.
- Formatter: `AgencyGenerator` prints both forms as written.

### Type tree

Two variants in `lib/types/typeHints.ts`:

```ts
export type KeyofType = {
  type: "keyofType";
  operand: VariableType;
  tags?: Tag[];
};

export type IndexedAccessType = {
  type: "indexedAccessType";
  objectType: VariableType;
  index: VariableType;
  tags?: Tag[];
};
```

Both exist only between parse and resolution.

### Evaluation

Two branches in `resolveTypeWithGuard` (`lib/typeChecker/assignability.ts`),
next to the alias and generic branches. Each resolves its operand(s) with
the in-progress guard threaded through, so recursive aliases degrade the
same way they do everywhere else. Implementation lives in a small pure
module (`lib/typeChecker/typeOperators.ts`) following the
`builtinGenerics.ts` pattern: resolver injected, no import cycle.

### The fan-out checklist

Adding variants touches a known list. Most sites are compiler-enforced
(`never`-typed defaults); the two that are not get explicit attention:

| Site | Enforced? |
|---|---|
| `typeKey` canonical cases | yes (never-default) |
| `valueParamSubstitution` switches | yes (never-default) |
| `mapTypes` / `visitTypes` walkers | check; add cases |
| `formatTypeHint` | no; add cases |
| `AgencyGenerator` printing | no; add cases + round-trip tests |
| `validateTypeReferences` | no; validate operands without evaluating |
| **`deepResolveNode`** | **no — the trap.** See below. |
| zod mapper | nothing to add once deepResolveNode routes correctly |

**The `deepResolveNode` trap.** `deepResolveNode`
(`lib/typeChecker/assignability.ts`) prepares alias bodies for codegen,
and today routes only `genericType` and `typeAliasVariable` through
`resolveType`. Without new cases, `type K = keyof User` reaches the zod
mapper unresolved and silently becomes the `z.string()` fallback. No
error, wrong schema. The fix is two more routed cases plus a codegen
fixture pinning the emitted literal-union schema, so any future
regression fails a test instead of shipping.

## Testing

The recipe from the last three PRs:

- **Unit** (`lib/typeChecker/typeOperators.test.ts`): every semantics-table
  row above, every error, union indices, chained access, `T[keyof T]`,
  composition with `Pick`/`Partial`, recursive-alias operands, tag
  ride-along on indexed access, no-mutation of resolver inputs.
- **Pipeline** (`typecheckSource`): a `match` over a `keyof`-typed value
  gets exhaustiveness checking (add-a-field scenario); generic alias
  `type Keys<T> = keyof T` declares clean and evaluates at use; the
  swallowed-semantic-error pin (`keyof number` produces zero typecheck
  diagnostics today).
- **Codegen unit tests** (the `generate()` harness): `type K = keyof User`
  emits a union of literal schemas, NOT `z.string()`; an indexed-access
  alias emits the property's schema; both compose with the pending/z.lazy
  machinery when the operand is a forward reference.
- **Formatter round-trips**: `keyof User` and `User["name"]` survive
  `fmt` as written, in parameter and alias positions.
- **Execution test** (no LLM): `schema(keyof User)` parse-accepts a key
  string and parse-rejects a non-key. Bind the schema to a variable
  first (#480).
- **Fixture**: both operators in alias bodies, checked into
  `tests/typescriptGenerator/` with the zero-churn gate for existing
  fixtures.

## Documentation

- `docs/site/guide/types.md`: a short section with the drift-prevention
  example and the match-exhaustiveness payoff. Keep it tight.
- `docs/dev/typechecker/README.md`: one paragraph on the operators and
  eager evaluation.
- **The checklist fix (owner-requested):** update the header comment in
  `lib/types/typeHints.ts` — the designated "adding a variant" checklist —
  to include `deepResolveNode` and `typeKey`, both missing today because
  they postdate the comment. Add a short "adding a `VariableType`
  variant" section to `docs/dev/adding-features.md` pointing at that
  checklist. Rationale to state there: most switches are never-enforced,
  but `deepResolveNode` cannot be (passing nodes through unchanged is its
  correct behavior for most variants), so the checklist is the only
  guard.

## Non-goals

- **`Record<K, V>` support** for either operator (v1 decision; relax
  later if demand appears).
- **`typeof`** (owner-approved exclusion). It looks like a sibling but
  crosses a boundary these operators do not: `keyof` asks a question
  about a type and needs only the alias table, while `typeof config`
  asks about a VALUE and needs the checker's variable scopes. Those
  scopes do not exist when aliases resolve. Adding it means threading a
  scope and synthesizer through `resolveType` and every caller, solving
  a pipeline-ordering problem (aliases resolve before scopes are built),
  and teaching the builder to infer value types (compilation runs with
  the typechecker disabled). Separate spec if ever wanted. Note the
  keyword also collides with the planned runtime `typeof` narrowing
  guard in the narrowing docs; the two can coexist as in TypeScript, but
  that is a discussion for the typeof spec.
- **`T[number]`** (array element extraction) and numeric indices: no
  tuples exist (killed by the provider gate), so numeric indexing has no
  v1 use case.
- **Located diagnostics** for the resolver errors: standing follow-up
  shared with `Record` and the utility types.
