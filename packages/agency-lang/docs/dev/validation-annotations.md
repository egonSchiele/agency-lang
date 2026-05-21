# `@validate` and `@jsonSchema` — internals

This document covers the implementation of the two type-annotation
features that landed together:

- **`@validate(fn1, fn2, ...)`** — attach one or more runtime validators
  to a type. The validators run at every `!` site whose resolved type
  reaches the annotation, including nested positions (object property,
  array element, nullable branch, union member).
- **`@jsonSchema({ ... })`** — attach JSON Schema metadata to a type so
  that structured-output LLM calls and downstream Zod consumers see it.
  Internally this becomes a Zod `.meta(...)` call.

The user-facing material lives in
[`docs/site/guide/type-validation.md`](../site/guide/type-validation.md); the
broader `!`-validation model is in
[`docs/site/guide/schemas.md`](../site/guide/schemas.md). This doc
focuses on how the implementation is wired up so future engineers can
change it safely.

---

## Pipeline overview

```
.agency source
   │
   ▼
parser  ─ tags parse as their own AgencyNode with name + arguments
   │     (arguments are arbitrary Expression nodes, not strings!)
   ▼
preprocessor.attachTags()
   │     moves standalone `tag` nodes onto the next attach-target
   │     node (typeAlias / functionDef / graphNode / assignment /
   │     functionCall). After this pass, `TypeAlias.tags`, etc. are
   │     populated.
   ▼
typeChecker.mergeTagSets()   ◄── only `validate` and `jsonSchema` merge.
   │     Other tags pass through verbatim per side. Called when a
   │     `typeAliasVariable` is resolved at a use-site that itself
   │     carries annotations.
   ▼
typescriptBuilder
   │     For each `!` site: decide whether to emit
   │         __validateType(value, zodSchema)               (zero-cost path)
   │     or
   │         await __validateChainRecursive(value, descriptor, __ctx)
   │     The gate is `hasAnyValidateTag(resolvedType)`.
   │
   │     For each `type Foo = ...` declaration whose body reaches any
   │     `@validate(...)` tag, the builder also emits
   │         (Foo as any).__agency_descriptor = <descriptor>;
   │     immediately after the Zod schema const. See the
   │     "`__agency_descriptor` contract" section below — this is the
   │     bit that future maintainers must be careful with.
   ▼
runtime/validateChain.ts
         __validateChain        — parse + linear validator chain
         __validateChainRecursive — walks the descriptor tree
```

---

## Tag arguments are `Expression[]`, not `string[]`

A tag in the AST is:

```ts
type Tag = {
  type: "tag";
  name: string;
  arguments: Expression[];  // ← arbitrary Agency expressions
};
```

Validators (`@validate(isEmail, somethingElse)`) are arbitrary
identifier expressions. `@jsonSchema({ ... })` takes an object literal
whose entries may contain spreads, identifiers, and literals.

[`lib/backends/typescriptGenerator/tagArgToTs.ts`](../../lib/backends/typescriptGenerator/tagArgToTs.ts)
prints a tag argument as a TS source string. Only the restricted subset
the tag parser accepts is handled (literals, identifiers, calls, object
literals, spreads). If you teach the parser to accept new expression
shapes inside tag args, extend `tagArgToTs` to match — otherwise codegen
will emit `/* unsupported tag arg: ... */ undefined`, which is loud but
not helpful at runtime.

---

## `mergeTagSets` — alias vs use-site

When a `typeAliasVariable` is resolved at a use-site that carries its own
tags, the alias's tags and the use-site tags need to be combined:

| Tag name      | Merge behavior                                                            |
| ------------- | -------------------------------------------------------------------------- |
| `validate`    | Concatenate argument lists. Validators run alias-first, use-site-last.     |
| `jsonSchema`  | Merge the two object literals; use-site keys win on conflict, **except** `description` whose plain-string values from both sides are concatenated with `\n`. Spreads are preserved verbatim. |
| _anything else_ | Pass through per side; not merged across alias/use-site.                  |

`@jsonSchema(...)` accepts one or more object-literal arguments per
tag, and may be stacked on the same target. Both forms flatten through
the same merge pass in `mergeJsonSchemaArgs`, which collects every
entry / splat from every object-literal argument before running the
description-concat and dedupe passes.

A malformed `@jsonSchema(...)` (no arguments at all, or an argument
that is not an object literal) throws from
[`mergeTags.ts`](../../lib/typeChecker/mergeTags.ts) with a
location-aware error. The parser doesn't reject this earlier because
the tag-argument grammar is intentionally permissive — see
[`jsonSchemaArgValidator.ts`](../../lib/typeChecker/jsonSchemaArgValidator.ts)
for the dedicated check.

`appendMeta` in `typeToZodSchema.ts` calls `mergeJsonSchemaArgs`
itself whenever it sees more than one `jsonSchema` tag on a single
type, so the stack-or-multi-arg shape is uniformly merged before being
emitted as a single `.meta({...})` call.

---

## `hasAnyValidateTag` — the codegen gate

Lives in
[`lib/backends/typescriptGenerator/validationDescriptor.ts`](../../lib/backends/typescriptGenerator/validationDescriptor.ts).

This is the predicate that decides which validation path the builder
takes:

- **No `@validate` anywhere in the resolved type** → emit
  `__validateType(value, zodSchema)` (the existing, zero-cost path).
- **At least one `@validate` somewhere** → emit
  `await __validateChainRecursive(value, descriptor, __ctx)`.

`hasAnyValidateTag` walks the resolved type structurally and, crucially,
follows non-generic `typeAliasVariable` references via the
`aliasesFull` map. `resolveTypeDeep` leaves those references intact for
"codegen-by-name" purposes, so without this manual lookup, an
`@validate` reachable only through a named alias would be silently
dropped from gating.

---

## `__agency_descriptor` contract — the part that bites

This is the most important section of this document. If you change how
type aliases are emitted, **read this section first**.

### The problem

`@validate(isEmail)` references an identifier (`isEmail`) that lives in
some specific module's scope. If a use-site says `const e: Email! = ...`
and we naïvely inlined `Email`'s validator chain at the use-site, we'd
emit something like:

```ts
await __validateChainRecursive(e, {
  kind: "leaf",
  schema: z.string(),
  validators: [isEmail],   // ← but `isEmail` isn't imported here!
}, __ctx);
```

The consumer doesn't import `isEmail`. The validators (and any
schema-helper consts like `emailFormat`) live in the alias-defining
module.

### The solution

When the type alias is emitted, the builder attaches the runtime
descriptor to the schema const itself:

```ts
export const Email = z.string().meta({ format: "email" });
export type Email = z.infer<typeof Email>;
(Email as any).__agency_descriptor = { kind: "leaf", schema: Email, validators: [isEmail] };
```

`__agency_descriptor` is a non-enumerable side-channel between the
Zod schema and the validation runtime. It's:

- attached unconditionally to any alias whose body has any `@validate`
  reachable (per `hasAliasValidate` in
  [`validationDescriptor.ts`](../../lib/backends/typescriptGenerator/validationDescriptor.ts));
- read at the use-site via `(Email as any).__agency_descriptor`;
- combined with use-site validators when the use-site adds its own
  `@validate(...)` (see the `typeAliasVariable` branch in
  `descriptor()`):
  ```ts
  { ...ref, validators: [...(ref?.validators ?? []), ...useSiteValidators] }
  ```

### What you must never do

- **Don't skip emitting `__agency_descriptor`.** The assignment is the
  bridge between the alias's module-local validator identifiers and any
  downstream consumer. Without it, validation silently no-ops.
- **Don't serialize it.** `__agency_descriptor` is not part of the
  checkpoint state and must never be. It's a runtime-only handle that
  recovers on every fresh module load.
- **Don't rename `__agency_descriptor` without grepping for it.** Both
  the writer (`typescriptBuilder.ts`) and the reader
  (`validationDescriptor.ts`) name it as a magic string.

### Why not export the descriptor instead?

We could export a second const (`Email_descriptor`) alongside `Email`
and have the use-site import it. We don't, because:

1. It doubles the import surface of every annotated alias.
2. It breaks `import { Email }` patterns (the user would have to
   remember a parallel import for validation).
3. It pushes work onto every consumer file's import management.

Attaching to the schema const is a one-time emission with no consumer
overhead.

---

## `TypeValidationDescriptor` — the recursive shape

Defined in [`lib/runtime/validateChain.ts`](../../lib/runtime/validateChain.ts):

```ts
type TypeValidationDescriptor =
  | { kind: "leaf"; schema; validators }
  | { kind: "object"; schema; validators; properties: Record<string, _> }
  | { kind: "array"; schema; validators; element: _ }
  | { kind: "union"; schema; validators; branches: Array<{ test; descriptor }> }
  | { kind: "nullable"; schema; validators; inner: _ };
```

`walk()` recurses on `descriptor` and `value` in lockstep:

- `array` → run own validators on the array, then recurse into each
  element with `element` descriptor;
- `object` → run own validators, then recurse into each property with
  `properties[key]`;
- `union` → run own validators, then dispatch to the first branch whose
  `test(v)` passes (the test is a Zod `safeParse` predicate);
- `nullable` → if value is null/undefined, success unchanged; else
  recurse into `inner`;
- `leaf` → run own validators only.

The walker is depth-capped (default 64, configurable via
`opts.maxDepth`). On overflow we return a structured failure payload:

```ts
{ reason: "validation recursion depth exceeded", limit, kind, valuePreview }
```

`valuePreview` is a cycle-safe, length-bounded JSON snippet.

---

## Validator dispatch

A validator is either an Agency `def` (`AgencyFunction`) or a plain JS
function:

```ts
type AgencyValidator =
  | ((value: unknown) => Promise<ResultValue> | ResultValue)
  | AgencyFunction;
```

`callValidator(v, ctx, value)` dispatches:

- **`AgencyFunction`** → `.invoke({ type: "positional", args: [value] }, { ctx })`.
  This is the same machinery as a regular Agency call, so the validator
  gets a real ctx and can interrupt / call other Agency functions.
- **plain function** → called as `v(value)`. No ctx is threaded through.
  Users wanting ctx should write the validator as an Agency `def`.

Plain JS validators are first-class: users can import `success` /
`failure` from `agency-lang/runtime` and write any validator they want
in TS, then reference it from `@validate(...)`. See
[`tests/agency/validation/validatePlainJsFunction.agency`](../../tests/agency/validation/validatePlainJsFunction.agency)
for the end-to-end test that proves this works.

### Transforming validators

Each validator receives the value the previous validator returned with
success. A validator can therefore transform the value:

```agency
def trim(value: string): Result {
  return success(value.trim())
}

@validate(trim)
type Trimmed = string
```

The bound variable receives the transformed value. See
[`tests/agency/validation/validateTransform.agency`](../../tests/agency/validation/validateTransform.agency).

### Parameterized validators via PFA

`std::validators` ships parameterized validators (`min`, `max`,
`minLength`, `maxLength`, `matches`) as ordinary two-argument Agency
`def` functions where the configuration parameter comes first and the
value comes last. Users bind the configuration via Agency [partial
application](../site/guide/partial-application.md) inside the tag:

```agency
@validate(min.partial(n: 0), max.partial(n: 150))
type Age = number
```

The restricted tag-argument grammar accepts
[`valueAccess`](../../lib/parsers/parsers.ts) expressions (see
`restrictedTagArgParser`), so `min.partial(n: 0)` parses inline.
[`tagArgToTs`](../../lib/backends/typescriptGenerator/tagArgToTs.ts)
prints it as `min.partial({ n: 0 })` — `AgencyFunction.partial` takes a
single `Record<string, unknown>` of bindings at runtime, and the
all-named-args shape of a PFA tag arg is collapsed into that object
literal.

At descriptor-construction time, `min.partial({n: 0})` evaluates to an
`AgencyFunction` (the imported `min` is an eager Agency `def` export, so
the binding is live). The descriptor stores that AgencyFunction. When
validation fires, `callValidator` dispatches the AgencyFunction through
`invoke({ type: "positional", args: [value] })` — the same machinery as
any other Agency call — and `n` is already bound, so the underlying
two-arg `min` runs with `(n, value)`.

This means there is no runtime factory helper and no static-init
race: the cost of "make this work for `static const` imports" is paid
once in the parser/printer and never again at runtime. If you add new
parameterized validators, just add a normal `def`, put the config
parameter(s) first and the value last, and document the PFA call shape.

---

## `@jsonSchema` — Zod `.meta(...)`

Implemented in
[`lib/backends/typescriptGenerator/typeToZodSchema.ts`](../../lib/backends/typescriptGenerator/typeToZodSchema.ts)
as `appendMeta(...)`. It looks up the `jsonSchema` tag on a type,
renders the single object-literal argument via `tagArgToTs`, and tacks
on a `.meta({...})` to the Zod schema. This must be the **last** call
in the chain because Zod's API requires it.

The metadata becomes available at runtime via:

- `Email.meta()` — Zod's meta accessor;
- `z.toJSONSchema(Email)` — emits a JSON Schema object that includes the
  metadata (so structured-output LLM calls pick it up).

Runtime tests in
[`lib/backends/typescriptGenerator/jsonSchemaAnnotation.test.ts`](../../lib/backends/typescriptGenerator/jsonSchemaAnnotation.test.ts)
compile a small Agency program, dynamically import the generated TS,
and assert that the metadata appears both via `.meta()` and via
`toJSONSchema`. That's the closest thing to a real end-to-end test
since `.meta()`'s semantics only matter at runtime.

---

## Files of record

| File                                                                                  | Role                                                                  |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `lib/preprocessors/typescriptPreprocessor.ts` — `attachTags()`                        | moves standalone `tag` nodes onto their target nodes                  |
| `lib/typeChecker/mergeTags.ts`                                                        | merges `@validate` / `@jsonSchema` across alias-and-use-site          |
| `lib/typeChecker/jsonSchemaArgValidator.ts`                                           | shape-checks `@jsonSchema(...)` arguments                              |
| `lib/backends/typescriptGenerator/validationDescriptor.ts`                            | builds the descriptor TS IR + `hasAnyValidateTag` predicate           |
| `lib/backends/typescriptGenerator/typeToZodSchema.ts` — `appendMeta()`                 | attaches `.meta(...)` for `@jsonSchema`                               |
| `lib/backends/typescriptGenerator/tagArgToTs.ts`                                      | prints a tag argument as a TS source string                            |
| `lib/backends/typescriptBuilder.ts`                                                    | emits `(Alias as any).__agency_descriptor = ...` and `!`-site validation calls |
| `lib/runtime/validateChain.ts`                                                        | `__validateChain` / `__validateChainRecursive` / `previewValue`        |
| `stdlib/validators.agency` / `stdlib/schemas.agency` / `stdlib/types.agency`          | the pre-baked validators, schema fragments, and opaque-string aliases  |

---

## Things to remember when changing this code

1. **Tag argument types are `Expression[]`.** Never assume a single-arg
   string. Use `tagArgToTs` or destructure carefully.
2. **`__agency_descriptor` is the only path from an alias's
   module-local validator to a downstream consumer.** Never break the
   `(Alias as any).__agency_descriptor = ...` emission.
3. **`hasAnyValidateTag` is the gate.** Adding new wrapper types
   (alongside `arrayType`, `objectType`, `unionType`, etc.) requires a
   case in this function or `@validate` will silently disappear.
4. **`__agency_descriptor` is not serialized.** It re-attaches on
   module load. Don't add it to checkpoint state.
5. **`mergeTagSets` only merges `validate` and `jsonSchema`.** Other
   tags (`@goal`, `@optimize`, etc.) flow through per side and must not
   be combined across alias/use-site.
6. **Malformed `@jsonSchema(...)` throws synchronously** from
   `mergeTagSets` — keep that loud, don't swallow it.
7. **Validators may be async and may transform the value.** The walker
   threads `success.value` into the next validator. Tests in
   `tests/agency/validation/` cover the boundary cases (array element,
   nested object, nullable, transform).

---

## Value parameters and substitution

Value-parameterized type aliases — `type NumberInRange(low: number, high: number) = number`
— let users lift a tag's numeric (or string) literals out to the alias
declaration and re-supply them at every use site. Substitution is purely
compile-time; the runtime walker, descriptor format, and `__validateChain`
helpers are unchanged.

### The substitution pass

`lib/typeChecker/valueParamSubstitution.ts` is the single source of
truth. It exports:

- `substituteValueArgsInExpression(expr, bindings)` — walks the
  restricted tag-arg expression subtree (literals, identifiers, object
  literals + spreads, `valueAccess` chains incl. PFA method-call args)
  and replaces any `variableName` whose `value` matches a key in
  `bindings` with a structural clone of the bound `Expression`. Nodes
  outside the restricted subset pass through unchanged. The input tree
  is never mutated.
- `substituteValueArgsInTag(tag, bindings)` — convenience wrapper that
  maps the substitution over `tag.arguments`.
- `substituteValueArgsInType(vt, bindings)` — walks a `VariableType`
  tree and rewrites any inner `typeAliasVariable` / `genericType` whose
  own `valueArgs` reference a name in `bindings`. Required so wrapping
  aliases (`type EvenInRange(low, high) = NumberInRange(low, high)`)
  can forward their value parameters to inner instantiations.
- `applyValueArgs(entry, valueArgs, aliasName)` — the canonical entry
  point: validates arity (filling missing tail args from
  `valueParams[i].default`, throwing on missing-required or
  too-many-args), builds the bindings map, then returns a fresh
  `TypeAliasEntry` whose `tags` and `body` are both substituted. Best-
  effort literal type-check on each argument; non-literal args are
  accepted and deferred.

### Where it fires

In `lib/typeChecker/assignability.ts`, `resolveType` calls
`applyValueArgs` whenever it resolves a `typeAliasVariable` or
`genericType` whose entry has `valueParams`. Type-param substitution
happens first (existing path); value-arg substitution runs on the
result. The substituted entry's tags then flow through the existing
`attachAliasTags` + `mergeTagSets` chain unchanged.

### The shared `staticTagArgParser`

A single combinator backs every place that needs the restricted
expression subset:

1. Tag arguments inside `@validate(...)` and `@jsonSchema(...)`.
2. Default-value expressions for value params (`= 0`).
3. Use-site value-arg expressions (`Age(18)`).

Centralizing the rule keeps "static consts and value-param identifiers
are OK; bare function calls are not" defined exactly once. PFA
(`min.partial(n: low)`) stays allowed because it's a method call on an
identifier, not a bare function call.

### Codegen divergence

Value-parameterized aliases are deliberately *not* emitted as top-level
Zod schemas:

- **No top-level `const AliasName = z....` emission.**
  `typescriptBuilder.ts` skips the const for aliases with
  `valueParams`. There's no single schema for `NumberInRange` without
  arguments.
- **No `(AliasName as any).__agency_descriptor` side-channel.** The
  descriptor would have to encode the specific value args; instead,
  the descriptor is constructed *inline at the use site* with the
  substituted tags.
- **Use-site inlining.** `typeToZodSchema.ts` and
  `validationDescriptor.ts` both branch on
  `isValueParamInstantiation(vt, entry)` (defined in
  `valueParamSubstitution.ts`) — the single canonical predicate for
  "this reference needs inline-at-use-site emission". When it matches,
  they call `applyValueArgs` and recursively map the substituted entry.
  The substituted tags drive `appendMeta` and `validatorNodes`.
- **Object-property merge also substitutes.** The object-property branch
  of `mapTypeToSchemaInner` looks up alias-level tags to merge them onto
  the property. When the property is a value-parameterized
  instantiation (e.g. `age: NumberInRange(0, 150)`), the alias tags it
  pulls in are run through `applyValueArgs` *first* — otherwise the
  outer `.meta(...)` chain on the property would emit out-of-scope
  value-param identifiers (e.g. `low`, `high`).

The codegen divergence rule is expressed in exactly one predicate
(`isValueParamInstantiation`), used at three sites. Adding a new
emission site that handles `typeAliasVariable` should consult the same
predicate to stay consistent.

### Why inline-at-use-site instead of a schema factory function?

A natural alternative is to emit a factory:

```ts
const NumberInRange = (low: number, high: number) =>
  z.number().meta({ minimum: low, maximum: high });
```

We chose inline-at-use-site instead. Trade-off:

| Concern | Factory emission | Inline at use site (chosen) |
|---|---|---|
| Generated TS size | Smaller (one definition per alias) | Duplicated per instantiation |
| Single place to debug | ✓ | ✗ |
| Object-property merge | Complex — must *call* the factory and then mergeTagSets the result | Plugs into existing pipeline directly |
| Descriptor side-channel | Needs `Alias.descriptor = (...) => ({...})`, a new runtime mechanism | Inline reuses the descriptor walker |
| Tag-merge symmetry with bare aliases | Diverges (bare alias is a value, parameterized is a factory) | Same code path for both |
| Use-site tag composition | Needs runtime composition (`NumberInRange(0, 150).pipe(z.refine(...))`) | `mergeTagSets` at codegen, single chain |

Every other piece of the validation infrastructure
(`mergeTagSets`, `appendMeta`, descriptor walker,
`__agency_descriptor` lookup) deals in *values*, not factories.
Switching to factories would mean touching all of them — a much larger
surface change for a smaller-generated-code win. If the duplication
ever shows up as a real cost (large programs with many instantiations),
the factory pattern is the natural follow-up.

### Substitution-time safety net

The TypeScript printer should never see an unsubstituted value-param
identifier. There are two layers of defense:

1. **Substitution-time assertion (primary).** `applyValueArgs` walks
   the substituted tags + body looking for any `variableName` whose
   value is still in the alias's `valueParams` set. If any are found
   it throws `value param 'X' left unsubstituted in @<tag> on <alias>`
   immediately, with the alias and tag names in the message. Triggers
   for missing substitution at the substitution boundary itself, not
   downstream at codegen.
2. **`tagArgToTs` guard (secondary).** Accepts an optional
   `valueParamNames` set and throws the same error if a leftover
   identifier matches. Currently the production call sites all go
   through `applyValueArgs` first, so this guard exists as a
   belt-and-suspenders check.

### Files of record (value-parameterized additions)

| File | Role |
|------|------|
| `lib/typeChecker/valueParamSubstitution.ts` | The substitution pass + `applyValueArgs` |
| `lib/typeChecker/valueParamSubstitution.test.ts` | Unit tests for every branch |
| `lib/typeChecker/assignability.ts` | Calls `applyValueArgs` during `resolveType` |
| `lib/backends/typescriptGenerator/typeToZodSchema.ts` | Inlines substituted schemas at use sites |
| `lib/backends/typescriptGenerator/validationDescriptor.ts` | Inlines substituted descriptors at use sites |
| `lib/backends/typescriptBuilder.ts` | Skips top-level emission for value-parameterized aliases |
| `stdlib/types.agency` | Pre-baked `NumberInRange`, `StringWithLength`, `MatchesPattern`, `BoundedArray<T>` |
