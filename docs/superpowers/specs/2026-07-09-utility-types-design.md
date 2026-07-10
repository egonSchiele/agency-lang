# Built-in utility types: Partial, Required, Pick, Omit, NonNullable

**Date:** 2026-07-09
**Status:** Approved design, ready for planning
**Related issues:** #470 (recursive types — interaction noted below, not addressed here)

## Context

Agency has three built-in generic types (`Array`, `Schema`, `Record`), normalized eagerly by `resolveTypeWithGuard` in `lib/typeChecker/assignability.ts`. This spec adds five more, modeled on TypeScript's utility types: `Partial`, `Required`, `Pick`, `Omit`, and `NonNullable`.

Two existing facts make these cheap:

1. **The parser is already done.** `genericTypeParser` (`lib/parsers/parsers.ts:1570`) is policy-free — it parses any `Name<typeArgs>` into a `genericType` node, and type args go through the full type parser, so `Pick<User, "name" | "email">` parses today. It fails at resolution with "Unknown generic type Pick".
2. **Optionality is already `| null`.** `p?: V` desugars at parse time to `p: V | null` (`objectPropertyParser`, `lib/parsers/parsers.ts:1084`). Agency has no `undefined`, only `null`. So `Partial<T>` applies exactly the desugaring the parser already performs, and its output is indistinguishable from a hand-written `p?:` type. No new runtime semantics exist anywhere in this feature.

**Design litmus test** (agreed during brainstorming): an Agency type feature must be eagerly evaluable to a concrete, JSON-schema-able shape at resolution time. All five utilities pass. Conditional types and mapped types fail and stay out of the language.

## Decisions made during brainstorming

- **Scope:** all five types in one increment (owner-approved).
- **`Record<K, V>` arguments error in v1** (owner-approved; YAGNI, easy to relax later).
- **Approach A** (owner-approved): eager evaluation in `resolveTypeWithGuard`, beside the existing `Array`/`Schema`/`Record` branches. Rejected alternatives: preprocessor desugaring (leaks expansions into formatter/doc/LSP output; preprocessor lacks the checker's alias resolution) and first-class pipeline survival like `Record` (N-consumer fan-out for no benefit, since these types are always fully evaluable).
- **One agency execution test per utility type** (owner-directed), since each type pins a distinct resolution-to-runtime contract.

## Semantics

All object transforms are **shallow** (top-level properties only), matching TypeScript. Optionality is `| null`. Property order is preserved from the source type. Property `description`s and `@validate`/`@jsonSchema` tags are preserved on surviving/modified properties.

### `Partial<T>`

`T` must resolve to an object type. Every property `p: V` becomes `p: V | null`. A property whose type already includes `null` (as `primitiveType("null")` or a union containing it) is left unchanged — no `V | null | null`.

```
type User = {
  name: string,
  age: number,
  email?: string,     // already string | null after parse; unchanged by Partial
}

def updateUser(id: string, changes: Partial<User>): User { ... }
```

`Partial<User>` resolves to `{ name: string | null, age: number | null, email: string | null }`.

### `Required<T>`

The inverse: `T` must resolve to an object type; `null` members are stripped from every property's type. Because `p?: V` and `p: V | null` are identical after parse, `Required` un-optionalizes both — Agency cannot distinguish them, and the docs say so plainly. A property whose type is exactly `null` becomes `never` (consistent with the bottom type; no special error).

### `Pick<T, K>`

`T` must resolve to an object type. `K` must resolve to a string literal type or a union of string literal types. The result keeps the named properties in `T`'s declaration order. A key in `K` that is not a property of `T` is an **error** listing the available keys (TS parity).

```
type Contact = Pick<User, "name" | "email">
```

### `Omit<T, K>`

Same `T` and `K` rules; removes the named properties. Keys not present on `T` are **allowed** (TS parity — deliberate asymmetry with `Pick`).

### `NonNullable<T>`

Accepts any type, not just objects. Strips `null` members from a union; no-op when there is no `null`; `NonNullable<null>` resolves to `never` (TS parity). Composes with the null-narrowing idiom: it is the type-level counterpart of `if (x != null)`.

## Error rules

| Case | Behavior |
|---|---|
| Wrong arity (`Partial<A, B>`) | Located diagnostic from `validateTypeReferences` via `BUILTIN_GENERIC_ARITY` (`lib/typeChecker/validate.ts`), same as `Record` arity today. |
| Non-object argument to `Partial`/`Required`/`Pick`/`Omit` (includes `Record`, arrays, primitives, unions, `Result`) | `TypeError` thrown from the resolver naming the utility and the received type — same surfacing as `Record`'s key-type error today (`validateRecordKeyType` precedent). |
| `K` not a literal / union of literals (`Pick<T, string>`) | Same `TypeError` path. |
| `Pick` key not on `T` | Same `TypeError` path; message lists `T`'s available keys. |
| User-defined `type Partial = ...` (any of the five names) | Rejected via `RESERVED_TYPE_NAMES` (`lib/typeChecker/index.ts`), same as `Result`/`Success`/`Failure`. **Breaking** for any existing alias with one of these exact names; silent shadowing would be worse. |

Recursive alias arguments get no special handling: `Partial<Tree>` transforms the top level and leaves inner self-references nominal, so it works exactly as well as recursive types generally — which today means the #470 bugs apply. Out of scope here.

Follow-up (not v1): upgrading resolver-thrown argument errors (including `Record`'s key error) into located diagnostics in `validateTypeReferences`.

## Implementation

- **New module `lib/typeChecker/utilityTypes.ts`** exporting `evalUtilityType(name, typeArgs, aliases, resolve)`:
  - `name`: one of the five (caller has already matched).
  - `typeArgs`: raw type args from the `genericType` node.
  - `resolve`: callback to `resolveTypeWithGuard` with the in-progress guard bound, so alias arguments resolve without a circular import and self-reference guarding matches `Record`'s behavior.
  - Returns the transformed `VariableType`; throws `TypeError` per the table above.
  - Contains the shared null-strip/null-add helpers (a union-aware add-null and strip-null; `synthesizer.ts` has a private `stripNullable` with the same shape — do not export/reuse it across module boundaries, keep the type-level copy here where it can also handle `never`).
- **One call site** in `resolveTypeWithGuard` (`lib/typeChecker/assignability.ts`, beside the `Record` branch at ~line 122): if `vt.name` is one of the five, delegate to `evalUtilityType`.
- **`BUILTIN_GENERIC_ARITY`** (`lib/typeChecker/validate.ts:7`): add `Partial: 1, Required: 1, NonNullable: 1, Pick: 2, Omit: 2`.
- **`RESERVED_TYPE_NAMES`** (`lib/typeChecker/index.ts:60`): add the five names.
- **Nothing else changes.** Verified consequences:
  - The AST keeps `Partial<User>` as a plain `genericType`, so the formatter and `agency doc` render what the user wrote; `formatTypeHint` already prints `genericType` generically.
  - Codegen resolves generics through `resolveType` (`resolveTypeDeep`/`deepResolveNode` in `assignability.ts`; `typeToZodSchema.ts` throws on any unresolved generic except `Record`), so the transforms land in zod output automatically. `Partial<T>` produces the identical `z.object` a hand-written `p?:` type produces, including both `optionalKeyMode` behaviors (`required-nullable` for the LLM structured-output path, `optional-coalesce` for validation/parse).
  - Validators on now-nullable properties behave exactly as on hand-written `p?:` properties — no new runtime semantics.
  - Narrowing composes for free: the result is an ordinary object type with union-typed properties, so `if (changes.name != null)` narrows via the existing presence engine.

### Tag handling

The transform runs on the already-resolved object type, after `attachAliasTags` has merged alias-level tags onto it. Property-level tags and descriptions carry through untouched on surviving/modified properties. No new merge logic.

## Testing

- **Unit** (`lib/typeChecker/utilityTypes.test.ts`): per-type resolution semantics; every error case in the table; the no-double-null rule; tag/description preservation; the `never` edges (`Required` of an exactly-null property, `NonNullable<null>`).
- **Typecheck integration** (existing typechecker test style): diagnostics for bad `Pick` key, non-object argument, arity, reserved-name redefinition; narrowing composition (`if (x.p != null)` on a `Partial` property narrows).
- **Codegen fixture**: a `Partial`-annotated type whose generated zod schema matches the hand-written `p?:` equivalent.
- **Formatter round-trip**: `pnpm run fmt` preserves `Partial<User>` as written.
- **Agency execution tests** (`tests/agency/`, no LLM calls), one per type, each asserting parse-accept and parse-reject:
  - `Partial`: `schema(Partial<User>).parse({})` succeeds with keys null-coalesced (`optional-coalesce` mode).
  - `Required`: parse rejects an object missing a formerly-optional key (proves null-stripping reached the schema).
  - `Pick`: parse accepts the picked keys; schema has no entry for unpicked keys.
  - `Omit`: complementary key set (exercises the opposite key-set construction).
  - `NonNullable`: the one non-object transform — a scalar/union schema, not `z.object`: `schema(NonNullable<string | null>).parse(null)` fails, `parse("x")` succeeds.

## Documentation

- Guide: a "Utility types" section on the types page (`docs/site/guide/`), examples using the null idiom, including the `Required` un-optionalizes-explicit-nulls caveat.
- `docs/dev/typechecker/README.md`: extend the built-in generics list; state the eager-evaluation rule and the litmus test.

## Non-goals / future work

- `keyof`, indexed access (`T["prop"]`), tuple types, intersection (`&`): separate specs, agreed roadmap.
- `Record` arguments to the object transforms (relax the v1 error if demand appears).
- Mapped and conditional types: permanently out, per the litmus test.
- Located diagnostics for resolver-thrown argument errors (shared follow-up with `Record`).
- Recursive-type fixes: #470.
