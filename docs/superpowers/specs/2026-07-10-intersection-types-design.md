# Intersection types (`&`)

**Date:** 2026-07-10
**Status:** Approved design, ready for planning
**Prior art in this repo:** utility types (PR #478), recursive aliases (PR #485), keyof + indexed access (PR #496). This spec reuses their machinery, conventions, and the variant-addition playbook in `docs/dev/adding-features.md`. It is the LAST feature on the type-system roadmap.

## What we are building

`A & B` combines two object types into one:

```ts
type Named = {
  id: string,
  name: string,
}

type Aged = {
  id: string,
  age: number,
}

type Person = Named & Aged
// Person is { id: string, name: string, age: number }
```

The use case is mixins: shared shape fragments combined at the type
level instead of copied. Like every operator in this family, `&`
evaluates eagerly to a plain object type, so the LLM providers only
ever see ordinary object schemas. There is no provider question.

## Decisions made during brainstorming

- **Shared keys intersect recursively** (owner-approved). Identical
  types merge to one copy. Two object types merge recursively. Anything
  else errors, naming the key.
- **Object-only in v1**, matching the whole operator family: `Record`,
  arrays, primitives, unions, and `never` operands all error.
- **No user-facing guide section**, following the owner's revert on the
  keyof PR. Dev docs only. Open offer stands: if user docs are wanted
  on a dedicated page, say where.

## Semantics

### Precedence

`&` binds tighter than `|` and looser than postfix and `keyof`, matching
TypeScript:

| Written | Means |
|---|---|
| `A & B \| C` | `(A & B) \| C` |
| `A \| B & C` | `A \| (B & C)` |
| `keyof A & B` | `(keyof A) & B` |
| `A[] & B` | `(A[]) & B` |
| `(A \| B) & C` | parenthesized union as an operand |

`&` is punctuation, not a keyword — no reserved-name concerns.

### The merge

Every operand must resolve to an object type. Then:

1. **Disjoint keys concatenate.** Left operand's keys first, in their
   declared order, then the right operand's new keys in theirs.
2. **Shared keys intersect recursively:**
   - Identical types (by `typeKey`) keep one copy.
   - Two object types merge by the same rules, recursively.
   - Any other combination — `string & number`, an object against a
     primitive — errors: `cannot intersect key 'id': 'string' and
     'number' have no overlap`.
3. **Property tags on a shared key merge via `mergeTagSets`.** This is
   the semantically correct reading of intersection: a value of `A & B`
   must satisfy BOTH sides, so both sides' `@validate` chains apply.
   Descriptions concatenate per the existing `mergeTagSets` rules.
4. **Property descriptions**: the shared-key survivor keeps the merged
   tags' description behavior; nothing new.

`A & B & C` is n-ary in the AST (one node, three members) and merges
left to right — which, with rule 2, is associative.

### Errors

| Case | Behavior |
|---|---|
| Non-object operand (`Record`, array, primitive, union, `never`) | `TypeError` per operand: `intersection expects an object type, got '...'` — via the shared `resolveObjectArg` with `"intersection"` as the operator name, so the wording stays one family. |
| Conflicting shared key | `TypeError` naming the key and both types. |
| Surfacing | Same as the whole family: swallowed by `safeResolveType` at typecheck time, fatal at codegen via `resolveTypeDeep`. Pin with a tripwire test; located diagnostics remain the standing follow-up. |

Note the `never` divergence from TypeScript: TS says `A & never` is
`never`. Agency v1 errors instead, because the object-only rule wins and
a silent `never` result would be a debugging trap in a schema-producing
language. Document in the dev notes.

### Composition

All of these fall out of eager evaluation through the existing
recursive resolver, with tests but no special code:

```ts
Partial<A & B>           // merge first, then null every property
keyof (A & B)            // all keys of the merge
(A & B)["id"]            // the merged property type
type Mix<T> = T & Stamp  // generic alias delegation, evaluated at use
Tree & { extra: string } // recursive alias operand; nominal self-refs
                         // survive into the merged object
```

Generic alias bodies validate without evaluating (`type Mix<T> = T &
Stamp` must not error at declaration where `T` is a stubbed nominal
reference) — same story as `PartialOf<T>` and `Keys<T>`, verified by
test.

## Implementation

### AST

One new variant, n-ary like `unionType`:

```ts
export type IntersectionType = {
  type: "intersectionType";
  types: VariableType[];
  tags?: Tag[];
};
```

Exists only between parse and resolution. Occurrence tags thread
through `withUseSiteTags` in the resolver branch, like the operator
branches next to it.

### Parser

One new precedence level between the union parser and its items:

- `unionTypeParser`'s items become intersection EXPRESSIONS.
- An intersection expression is `sepBy1("&", <current union-item
  alternatives>)`; a single member passes through unchanged (no node),
  two or more build an `intersectionType`.
- Whitespace around `&` tolerated, like the union's `|`.

The existing union-item alternatives (keyof, postfix/array/indexed,
object literals, literals, parens) become the intersection's items, so
all the precedence rows above fall out of the level structure rather
than special cases.

### Evaluation

`evalIntersection(members, resolve)` joins the other operators in
`lib/typeChecker/typeOperators.ts`, consuming `resolveObjectArg` and
`mergeTagSets`. One branch in `resolveTypeWithGuard` delegates, with
the injected resolver carrying the in-progress guard (recursive alias
operands degrade nominally, as everywhere).

### The fan-out (per docs/dev/adding-features.md)

Compiler-enforced: `typeKey` (`canonical` — members SORTED, intersection
is commutative), `valueParamSubstitution` (both switches).

Hand-maintained: `mapTypes` + `visitTypes` (the pair), `formatTypeHint`
+ `variableTypeToString` (print `A & B`; parenthesize a UNION member —
`(A | B) & C` — since `&` binds tighter; an intersection inside a union
needs no parens for the same reason), `validateTypeReferences` (walks
members via the walker cases), `hasAnyValidateTag` (descend members),
**`deepResolveNode`** (route the variant; red-first non-string codegen
pin per the playbook rule).

## Testing

The established recipe:

- **Parse**: every precedence row above, n-ary flattening, whitespace
  tolerance, parenthesized-union operands.
- **Unit** (`typeOperators.test.ts`): disjoint merge with order pinned;
  identical shared key; recursive object merge (nested level actually
  asserted); conflicting-key error naming the key; tag merge on shared
  keys (both validate chains present); every non-object operand error
  including `never`; no input mutation; n-ary associativity — the
  RESOLVED merge of `(A & B) & C` equals that of `A & (B & C)`,
  compared by `typeKey` (the parenthesized form nests an intersection
  node as an operand, which the injected resolver evaluates first).
- **Pipeline**: assignment accept/reject against a merged type; the
  composition table above including `Mix<T>` delegation and the
  recursive-alias operand; the swallowed-error tripwire.
- **Codegen**: fallback-proof pins (a merged alias emits the full
  `z.object` with a non-string property; `@validate` on a shared key
  reaches the descriptor); fixture with the zero-churn gate.
- **Execution** (no LLM): `schema(Named & Aged)` parse-accepts a
  complete object and parse-rejects one missing a right-side key.
- **Formatter round-trips**: `A & B`, `A & B | C`, `(A | B) & C`, and
  alias-position.

## Non-goals

- Non-object operands (primitives, unions-of-objects distribution,
  `never` absorption). All error in v1; TS-style distribution is
  permanently unlikely given the litmus test.
- Located diagnostics for resolver errors — the standing family-wide
  follow-up.
- User-facing guide docs — per the keyof-PR decision, pending an owner
  call on where such docs should live.
