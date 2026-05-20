# Value-Parameterized Type Aliases — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the "value-parameterized type aliases" feature deferred from the original `@validate` / `@jsonSchema` spec (the "dependent types" idea). Users will be able to write:

```
@validate(min.partial(n: low), max.partial(n: high))
@jsonSchema({ minimum: low, maximum: high })
type NumberInRange(low: number, high: number) = number

type User = {
  age: NumberInRange(0, 150)
  score: NumberInRange(1, 100)
}
```

Each use-site `NumberInRange(0, 150)` resolves to `number` with the alias's tags fully **substituted** — every reference to the value parameters (`low`, `high`) in the alias's tag arguments is replaced with the literal/static-const argument at the use site. The substituted tags then flow through the existing `mergeTagSets` / `appendMeta` / `validationDescriptor` pipeline unchanged.

**Spec section:** [docs/superpowers/specs/2026-05-19-type-validation-and-json-schema-annotations-design.md § Future Work: Value-Parameterized Type Aliases](../specs/2026-05-19-type-validation-and-json-schema-annotations-design.md#L508-L606).

**Tech stack:** tarsec parsers, vitest, structural linter, Zod 4 `.meta()`, the existing `__validateChain` / `__validateChainRecursive` runtime helpers. **No new runtime code** — everything is compile-time substitution.

---

## Confirmed design decisions

1. **Syntax.** Value parameters use `()`, distinct from type parameters' `<>`. They may be combined: `type BoundedList<T>(n: number) = T[]` is valid. Value params come after type params.
2. **Argument restriction.** Use-site arguments may be:
   - String / number / boolean / null literals
   - Identifiers that resolve to a top-level `static const` (including const-bound imports)
   - Other value-param identifiers in scope (so a wrapper alias can forward its own value params)
   - Object literals built from the above (with `...` spread of allowed values)

   **Not allowed:** bare function calls, ternaries, binary operators (other than spread), member access, template strings, array literals. Identifiers that resolve to `let` bindings, function parameters, or local declarations are also rejected.

   **The same restriction applies to `@jsonSchema(...)` arguments and to the leaf-value positions inside `@validate(...)`** — i.e. the existing per-tag arg validator is now strict (no bare function calls). PFA references (`min.partial(n: 0)`) remain allowed because they are method calls on identifiers, not bare function calls.
3. **Defaults.** Value params may declare a default: `type NumberInRange(low: number = 0, high: number = 150) = number`. Default expressions follow the same restriction set.
4. **Type identity.** `NumberInRange(0, 150)` and `NumberInRange(1, 100)` share the alias name but are nominally distinct. They are mutually assignment-compatible because both bottom out at `number`; the validators they carry are independent and run only at `!` sites.
5. **Codegen strategy.** Inline the substituted Zod schema at every use site (the simplest correct path). Top-level dedupe (`NumberInRange__0_150` shared const) is a later optimization, not part of this plan.
6. **No runtime changes.** Substitution happens at type-check time; the descriptor walker and `__validateChain` already deal in `Expression[]` and don't need to know value parameters exist.

---

## Key Risks and Gotchas

1. **`__agency_descriptor` only exists for declared aliases, not for instantiations.** A use-site `age: NumberInRange(0, 150)` cannot reference an alias-level descriptor because the descriptor would need to encode the specific args. The codegen path here inlines the descriptor at every use-site (matching the inline-schema decision). This is a deliberate departure from the bare-alias `(Email as any).__agency_descriptor = ...` pattern — value-parameterized aliases simply do not emit an `__agency_descriptor`, and the use-site descriptor walker constructs the descriptor inline with the substituted tags.
2. **`hasAnyValidateTag` is the codegen gate.** When the walker hits a `typeAliasVariable` with `valueArgs` set, it must look up the alias entry, **substitute** its tags, and then check for `@validate`. Without substitution this works (the alias-side tags still contain a `@validate(...)` tag even with unresolved value-param references) but make sure the test passes through the substituted tags so the runtime descriptor actually sees the literal args.
3. **`mergeTagSets` is the merge surface.** It already handles per-side tag normalization and the alias-vs-use-site merge. The substitution pass must run *before* `mergeTagSets` is called, so the merged tag set sees substituted literals (and the description-concat / dedupe logic operates correctly).
4. **The tag-arg parser still owns the restriction.** Today `restrictedTagArgParser` uses `_valueAccessParser` which accepts a bare `functionCall` as its base when there is no chain. We need to tighten this for tag args: a bare function-call expression with no chain element is no longer a valid tag argument. PFA expressions (function call as base + method-call chain) stay allowed.
5. **Value-param identifiers MUST be in scope.** Inside an alias's tag arguments, references to value-param names (`low`, `high`) are permitted in addition to the normal restrictions. Outside the alias body's tags, those names mean nothing — they are not lexical names in the surrounding module. The substitution pass walks the tag-arg expression tree and replaces every `variableName` whose name is in the alias's value-param set; identifiers not in the set are left alone and must satisfy the normal scope rules at the use site.
6. **Combined `<T>` + `(n)` aliases.** The parser needs to accept `<T>(n: number)` in declaration position and `<T>(arg)` at the use site. Type substitution and value substitution are orthogonal, but both must be applied during resolution. Make sure the order is: substitute type params first (existing path), then value params, then resolve.
7. **Existing tests assume bare function calls in tag args.** None should, because we shipped PFA for parameterized validators, but the restriction tightening is a behavior change. Audit every Agency fixture under `tests/agency/validation/` and `stdlib/` for accidental `@validate(foo(bar))` patterns and convert to PFA before / as part of this PR.

---

## File Structure

**New files:**

| File | Purpose |
|------|---------|
| `lib/typeChecker/valueParamSubstitution.ts` | The substitution pass: walks a tag's `Expression[]` and replaces value-param `variableName` references with literal/static-const argument expressions from a binding map. Has dedicated unit tests. |
| `lib/typeChecker/valueParamSubstitution.test.ts` | Unit tests for the substitution pass: covers literals, static consts, nested objects, spreads, valueAccess (PFA), and rejection of disallowed expressions. |
| `tests/agency/validation/valueParamSimple.{agency,test.json}` | `type Age(min: number) = number` with a single arg, validating both pass and fail at a `!` site. |
| `tests/agency/validation/valueParamMultiArg.{agency,test.json}` | Two value params (`NumberInRange(low, high)`), exercising both validators. |
| `tests/agency/validation/valueParamDefaults.{agency,test.json}` | Default argument values: `type Age(min: number = 0) = number` used with and without the explicit arg. |
| `tests/agency/validation/valueParamStaticConst.{agency,test.json}` | Use-site arg is a `static const` identifier. |
| `tests/agency/validation/valueParamInJsonSchema.{agency,test.json}` | `@jsonSchema({ minimum: low })` substituted, verified via `schema(T).toJSONSchema()`. |
| `tests/agency/validation/valueParamWithGeneric.{agency,test.json}` | `type BoundedList<T>(n: number) = T[]` exercising the combined-parameter form. |
| `tests/agency/validation/valueParamWrappingAlias.{agency,test.json}` | Wrapper alias forwards its own value param to the inner alias: `type EvenInRange(low: number, high: number) = NumberInRange(low, high)`. |

**Files modified:**

| File | Purpose in this plan |
|------|----------------------|
| `lib/parsers/parsers.ts` | Extend `typeAliasParser` to accept `(valueParams)` after `<typeParams>`; extend the type-position parser so a type reference may have `(valueArgs)`; tighten `restrictedTagArgParser` to forbid bare function-call expressions (PFA via method-call chain remains allowed). |
| `lib/parsers/types.test.ts` (or wherever type-decl tests live) | Cover the new decl & use-site shapes plus error cases. |
| `lib/parsers/tag.test.ts` | Cover the new tag-arg restriction (bare `foo(bar)` is now a parse error). |
| `lib/types/typeHints.ts` | Add `valueParams?: ValueParam[]` to `TypeAliasEntry` and `TypeAlias`; add `valueArgs?: Expression[]` to `TypeAliasVariable` and `genericType` AST nodes; define `ValueParam = { name: string; type: VariableType; default?: Expression }`. |
| `lib/preprocessors/typescriptPreprocessor.ts` — `attachTags` (and the SymbolTable build pass) | Carry `valueParams` through from `TypeAlias` declarations into the `TypeAliasEntry` registered in the symbol table. No change to the tag-attachment logic itself. |
| `lib/typeChecker/assignability.ts` — `resolveType` / `attachAliasTags` | When resolving a `typeAliasVariable` (or `genericType`) reference that carries `valueArgs`, look up the alias's `valueParams`, build a binding map, substitute the alias-level tags through `valueParamSubstitution`, and merge those substituted tags with the use-site's via `mergeTagSets` (existing path). Apply defaults for omitted args. Reject arg-count mismatches and arg-type mismatches with location-aware errors. |
| `lib/typeChecker/jsonSchemaArgValidator.ts` | Generalize the arg-restriction check to (a) work for both `@jsonSchema(...)` and `@validate(...)` arg trees, and (b) accept value-param identifiers in scope while continuing to reject bare function calls. Rename / re-export as `validateTagArg` so it can serve both. |
| `lib/typeChecker/mergeTags.ts` | No behavior change. Verify that already-substituted tags continue to merge correctly (literal descriptions concat, etc.). |
| `lib/backends/typescriptGenerator/typeToZodSchema.ts` | When `mapTypeToSchemaInner` encounters a `typeAliasVariable` with `valueArgs`, inline the substituted alias body's Zod schema rather than emitting a bare `AliasName` reference. The substituted tags drive `appendMeta`. |
| `lib/backends/typescriptGenerator/validationDescriptor.ts` | When `descriptor()` encounters a `typeAliasVariable` with `valueArgs`, do NOT emit the `(Alias as any).__agency_descriptor` reference (the descriptor only exists for bare aliases). Instead inline the descriptor for the substituted alias body. Update `hasAnyValidateTag` to pass through `valueArgs`-aware substitution when checking for `@validate` reachability. |
| `lib/backends/typescriptGenerator/tagArgToTs.ts` | After substitution, the printer should never encounter a value-param identifier reference; if it does, throw with a clear "value param `X` left unsubstituted" error so a future bug surfaces loudly. |
| `lib/backends/typescriptBuilder.ts` — type-alias emission | A type alias declared with `valueParams` does NOT emit a top-level `const AliasName = z....` (there's no single schema for a parameterized alias). Its body is only emitted lazily at use sites. Keep the body parsed and tagged on the `TypeAliasEntry` so the substitution pass has something to work on. Reject `export`ing a value-parameterized alias that emits no usable runtime binding (or emit a stub `const AliasName = undefined` and document it). Open: see decision #5 below. |
| `lib/typeChecker/resolveType.ts` (and related) | Add an `applyValueArgs(entry, valueArgs)` helper that returns a fresh `TypeAliasEntry` with substituted tags and a body that has type-param substitution already applied. |
| `docs/site/guide/type-validation.md` | New "Value-Parameterized Aliases" section with the canonical example, the combined `<T>(n)` form, default args, the static-const story, and what's NOT allowed (bare function calls). |
| `docs/dev/validation-annotations.md` | New "Value parameters and substitution" section describing the substitution pass, the binding-map shape, when it runs in the resolve chain, and the `__agency_descriptor` divergence. |
| `stdlib/types.agency` | Add the stdlib parameterized types: `NumberInRange(low, high)`, `StringWithLength(min, max)`, `MatchesPattern(pattern)`, `BoundedArray<T>(min, max)`. |
| `docs/site/stdlib/types.md` | Auto-regenerated by `make`; verify the new types render correctly. |

---

## Track A — Parser changes

### A1. Parse value-parameter declarations

- [ ] Add `valueParamParser: Parser<ValueParam>` that accepts `name: TypeAnnotation` and an optional `= defaultExpr` where `defaultExpr` is restricted to the same arg subset (see A4).
- [ ] Extend `typeAliasParser` to accept an optional `( ... )` block after the optional `< ... >` block. Reject `< ... ()>` ordering (value params must come last).
- [ ] Update the AST: set `valueParams` on the produced `TypeAlias` node when present.
- [ ] Add fixture tests:
  - `type Age(min: number) = number`
  - `type NumberInRange(low: number, high: number) = number`
  - `type Age(min: number = 0) = number`
  - `type BoundedList<T>(n: number) = T[]`
- [ ] Error fixtures: `type Foo()(x: number) = ...`, `type Foo(x) = ...` (no annotation), `type Foo(x: number = foo()) = ...` (disallowed default expr).

### A2. Parse value-arg use-sites

- [ ] Extend the type-position parser so a type reference may be followed by `( ... )`. Combined with `<...>`: type args come first, value args second.
- [ ] AST: set `valueArgs: Expression[]` on the resulting `typeAliasVariable` / `genericType` node. The expressions are restricted to the same subset as tag-arg leaves.
- [ ] Test fixtures: `Age(18)`, `NumberInRange(0, 150)`, `BoundedList<string>(3)`, `Age(DEFAULT_AGE)` (identifier).
- [ ] Error fixtures: `Age(getDefault())` (bare function call), `Age({a: 1, b: 2})` would be allowed since object literals are in the subset — confirm against spec; today the spec example does not show object args, so we can keep them in the parser but the type checker can reject them at instantiation time if the type-checker can't substitute them into a tag scalar position.

### A3. Tighten `restrictedTagArgParser`

- [ ] Today `restrictedTagArgParser` accepts `_valueAccessParser`, whose base can be a bare `functionCall`. Tighten the tag-arg form so a bare function call (no chain) is **rejected**:
  - Continue to accept literals, identifiers, object literals.
  - Continue to accept PFA expressions: `valueAccess` with a `methodCall` chain element. The base is allowed to be a `functionCall` only if a chain follows.
  - Reject everything else with a `label(...)`-friendly message ("a tag argument: literal, identifier, PFA expression, or object literal").
- [ ] Add an explicit unit test: `tagParser("@validate(min(0))")` now FAILS with a useful error message pointing at `min(0)`. (And the existing `@validate(min.partial(n: 0))` test continues to pass.)
- [ ] Audit and update every existing fixture / example that still uses the bare-function-call form (none should exist after the PFA migration, but verify).

### A4. Share the arg-restriction grammar

- [ ] Extract a shared parser combinator (e.g. `staticTagArgParser`) that all three callers use:
  1. Tag arguments inside `@validate(...)` and `@jsonSchema(...)`.
  2. Default-value expressions for value params (`= 0`).
  3. Use-site value-arg expressions (`Age(18)`).
- [ ] The combinator returns an `Expression` from the restricted subset. All three callers wrap it with appropriate framing (commas + parens for arg lists, etc.).
- [ ] This ensures we have one place to maintain the rule "static consts and value-param identifiers are OK; bare function calls are not".

---

## Track B — AST and symbol table

### B1. Extend `TypeAliasEntry`

- [ ] Add `valueParams?: ValueParam[]` to [`lib/types/typeHints.ts`](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/types/typeHints.ts) for both `TypeAliasEntry` and `TypeAlias`.
- [ ] Define `ValueParam = { name: string; type: VariableType; default?: Expression }`.
- [ ] Add `valueArgs?: Expression[]` to `TypeAliasVariable` and the `genericType` variants that can be used as a reference.

### B2. Carry `valueParams` into the symbol table

- [ ] Update `SymbolTable.build` / the equivalent registration site to copy `valueParams` from `TypeAlias` AST nodes onto `TypeAliasEntry` registrations.
- [ ] Add a test: declaring `type Age(min: number) = number` produces a `TypeAliasEntry` whose `valueParams` array has length 1 with the expected shape.

### B3. Add cross-module propagation tests

- [ ] Re-exporting a value-parameterized alias from another module must carry `valueParams` through. Add a fixture and test that mirrors the existing alias re-export propagation tests.

---

## Track C — Type-checker substitution

### C1. The substitution pass

- [ ] Create `lib/typeChecker/valueParamSubstitution.ts` exporting:
  ```ts
  type ValueArgBindings = Record<string, Expression>;

  export function substituteValueArgsInTag(
    tag: Tag,
    bindings: ValueArgBindings,
  ): Tag;

  export function substituteValueArgsInExpression(
    expr: Expression,
    bindings: ValueArgBindings,
  ): Expression;
  ```
- [ ] The pass walks an `Expression` tree (literals, agencyObject entries / splats, valueAccess chains, function-call args inside PFAs) and replaces any `variableName` whose `value` is in the bindings map with a structural clone of the bound expression. All other nodes are returned unchanged.
- [ ] **Important:** the substitution clones rather than mutates so the original alias-level tag remains valid for other instantiations.
- [ ] Unit-test every branch: bare ident, ident inside object value, ident inside spread, ident inside PFA's `.partial(n: low)` arg, ident inside a nested object inside an object, and the no-substitution-needed case.

### C2. `applyValueArgs(entry, valueArgs)` helper

- [ ] Add a helper that takes a `TypeAliasEntry` + a `valueArgs: Expression[]` list and returns a fresh `TypeAliasEntry`:
  1. Validate argument count (using `valueParams` defaults to fill missing tail args).
  2. Build the `ValueArgBindings` map (param name → arg expression).
  3. Map every `entry.tags` element through `substituteValueArgsInTag`.
  4. Return a new entry with the substituted tags and the original `body` and `typeParams`.
- [ ] Errors:
  - Too many args: `${alias} expects N value arguments, got M`.
  - Required (defaultless) param omitted: `${alias} requires '${name}': ${type}`.
  - Arg type mismatch: `argument ${name} expected ${declaredType}, got ${argType}` (best-effort — for literals we can check, for static-const identifiers we look up the inferred type, otherwise we defer to runtime).
- [ ] Unit tests: one per error case plus the happy path.

### C3. Wire substitution into `resolveType`

- [ ] In [`assignability.ts`](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/typeChecker/assignability.ts) where `typeAliasVariable` and user-defined `genericType` references are resolved, plumb through `valueArgs` from the AST node into `applyValueArgs(entry, valueArgs)`. The substituted entry's tags then go through the existing `attachAliasTags` + `mergeTagSets` path.
- [ ] For the combined-parameter case (`BoundedList<string>(3)`), apply type substitution first (existing path), then value substitution.
- [ ] Add tests that exercise the resolved-type's tags carry the substituted literal values (e.g. `Age(18)` resolves to `{type: "primitiveType", value: "number", tags: [@validate(isAtLeast.partial(min: 18))]}`).

### C4. Validate tag-arg restriction at the type-checker

- [ ] Hook the now-shared arg-restriction validator (Track A4) into the type-checker for `@validate(...)` and `@jsonSchema(...)` so disallowed expressions surface with the same friendly error wording at type-check time, not just at codegen. (Today `validateJsonSchemaArg` is a standalone helper not actually invoked — this finally wires it in.)
- [ ] The check runs **after** substitution: a value-param identifier is allowed in the alias's raw tags, but after `applyValueArgs` it has been replaced with a literal/static-const reference. Any leftover non-substituted identifier that isn't a static const or value-param-in-scope is a type error.

---

## Track D — Codegen

### D1. Inline substituted schemas in `typeToZodSchema`

- [ ] In `mapTypeToSchemaInner`, when a `typeAliasVariable` carries `valueArgs`:
  - Look up the alias entry, run `applyValueArgs`, and recursively map the alias's body (with the substituted tags attached) instead of emitting a bare `AliasName` identifier.
  - Use the substituted tags for the `.meta(...)` call.
- [ ] Audit every existing test snapshot for incidental changes (none should change because the new code path only fires when `valueArgs` is present).

### D2. Inline substituted descriptors in `validationDescriptor`

- [ ] In `descriptor()`, when a `typeAliasVariable` carries `valueArgs`:
  - Do **not** emit the `(Alias as any).__agency_descriptor` reference (that descriptor doesn't exist).
  - Run `applyValueArgs` and emit the descriptor for the substituted body inline, threading the substituted tags through `validatorNodes(...)`.
- [ ] Update `hasAnyValidateTag` to call `applyValueArgs` (or its tag-substitution part) before checking for `@validate` tags reachable through a value-parameterized alias.

### D3. Skip top-level emission for value-parameterized aliases

- [ ] In [`typescriptBuilder.ts`](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/backends/typescriptBuilder.ts) where type-alias declarations emit their schema const, detect `valueParams` and skip the const emission. There is no useful single Zod schema for `NumberInRange` without args.
- [ ] If the alias is `export`ed, decide: (a) emit nothing and let users `import { NumberInRange } from ...` fail with a TS error (cleanest), or (b) emit a stub `export const NumberInRange = undefined` with an `// @internal` comment. Pick (a); the type-side import still works because the type generator emits the alias as a TS type with a runtime-only fallback.
- [ ] Add a test: declaring `export type NumberInRange(...) = ...` doesn't emit a runtime const, and a use-site in another module still works (because the use-site inlines the substituted schema).

### D4. Update `tagArgToTs` failure mode

- [ ] If `tagArgToTs` is asked to print an identifier whose name matches a value-param name (i.e. substitution didn't run), throw a clear "value param `X` left unsubstituted — substitution pass not invoked?" error. Cover with a unit test.

---

## Track E — Standard library

### E1. Add stdlib parameterized types

- [ ] In [`stdlib/types.agency`](file:///Users/adityabhargava/agency-lang/packages/agency-lang/stdlib/types.agency) add (and `export`):
  ```agency
  @validate(min.partial(n: low), max.partial(n: high))
  @jsonSchema({ minimum: low, maximum: high })
  type NumberInRange(low: number, high: number) = number

  @validate(minLength.partial(n: min), maxLength.partial(n: max))
  @jsonSchema({ minLength: min, maxLength: max })
  type StringWithLength(min: number, max: number) = string

  @validate(matches.partial(pattern: pat))
  @jsonSchema({ pattern: pat })
  type MatchesPattern(pat: string) = string

  @jsonSchema({ minItems: min, maxItems: max })
  type BoundedArray<T>(min: number, max: number) = T[]
  ```
- [ ] Run `make` to regenerate `docs/site/stdlib/types.md`.
- [ ] Verify the generated docs render the new parameterized types reasonably (extending `agency docs` may be required if the printer doesn't yet handle `valueParams`; if so, that becomes a sub-task here).

### E2. Update `agency docs` output for `valueParams`

- [ ] Update the type printer used by `agency docs` to render `Foo(low: number, high: number)` and the substituted tag examples. Mirror the existing handling of `<T>` parameters.

---

## Track F — Documentation

### F1. User-facing guide

- [ ] Add a "Value-Parameterized Aliases" section to [`docs/site/guide/type-validation.md`](file:///Users/adityabhargava/agency-lang/packages/agency-lang/docs/site/guide/type-validation.md) covering:
  - The canonical example (`NumberInRange`) and what it expands to.
  - Argument restrictions and the rationale (compile-time substitution requires statically-known values).
  - Defaults.
  - Combined `<T>(n)` shape.
  - The new "bare function calls aren't allowed in tag args" rule, with the PFA alternative.
  - Cross-link to `std::types` for the pre-baked parameterized types.

### F2. Dev internals doc

- [ ] Extend [`docs/dev/validation-annotations.md`](file:///Users/adityabhargava/agency-lang/packages/agency-lang/docs/dev/validation-annotations.md) with a "Value parameters and substitution" section documenting:
  - The substitution pass, its inputs and outputs, and where in the resolve chain it fires.
  - The shared `staticTagArgParser` and the unified arg-restriction validator.
  - The codegen divergence: value-parameterized aliases skip the top-level schema const and the `__agency_descriptor` side-channel, inlining at each use-site instead.
  - The `applyValueArgs` helper as the canonical entry point.

### F3. Update the spec

- [ ] Move the spec's "Future Work: Value-Parameterized Type Aliases" section into the body of the doc (no longer "future"). Note the v1 stdlib types that now exist.

---

## Track G — End-to-end Agency tests

All under `tests/agency/validation/`. Each has a paired `.test.json` with `evaluationCriteria: [{ type: "exact" }]`.

### G1. `valueParamSimple`

- [ ] `type Age(min: number) = number` validated with `@validate(min.partial(n: min))`. Use sites: `Age(0)`, `Age(18)`. Assert both pass for valid values and fail for values below the min.

### G2. `valueParamMultiArg`

- [ ] `type NumberInRange(low: number, high: number) = number`. Verify both bounds fire.

### G3. `valueParamDefaults`

- [ ] `type Age(min: number = 0) = number`. Use site with explicit arg `Age(18)` and without `Age()`. Verify the default kicks in.

### G4. `valueParamStaticConst`

- [ ] `static const DEFAULT_AGE = 18` and use-site `Age(DEFAULT_AGE)`. Verify substitution reads the static const.

### G5. `valueParamInJsonSchema`

- [ ] `@jsonSchema({ minimum: low })` substituted. Inspect `schema(T).toJSONSchema()` output to confirm the literal value made it through.

### G6. `valueParamWithGeneric`

- [ ] `type BoundedList<T>(n: number) = T[]`. Use as `BoundedList<string>(3)`. Verify both type and value substitution happen.

### G7. `valueParamWrappingAlias`

- [ ] One alias forwards its own value params to another: `type EvenInRange(low: number, high: number) = NumberInRange(low, high)`. Verify the outer instantiation `EvenInRange(0, 100)` produces validators with the literal 0 and 100.

### G8. Error fixtures

- [ ] A test (or a unit test on the type checker) that covers each error case from C2: too-many args, missing-required, type mismatch, disallowed arg expression (bare function call), unknown alias.

---

## Validation checklist for each track

Run after **each** track lands:

- [ ] `pnpm exec tsc --noEmit`
- [ ] `pnpm run lint:structure`
- [ ] `pnpm test:run`
- [ ] `pnpm run agency test tests/agency/validation -p 12`
- [ ] `make` (regenerates stdlib + docs)
- [ ] `make fixtures` (regenerates generator snapshots if codegen output changed)

---

## Suggested PR ordering

The substitution pass is the linchpin and depends on the parser + AST changes. Codegen and stdlib both depend on the substitution pass. A reasonable single-PR landing order:

1. **Track A (parser) + Track B (AST + symbol table)** — pure plumbing, no behavior change yet because no resolver looks at the new fields.
2. **Track C (substitution + resolver wiring)** — the feature becomes observable: a resolved `Age(18)` now carries `@validate(min.partial(n: 18))`.
3. **Track D (codegen)** — emit the substituted schemas / descriptors at use sites.
4. **Track E (stdlib types)** — drop in `NumberInRange`, `BoundedArray`, etc.
5. **Track F (docs)** — guide + dev internals, alongside or just after E.
6. **Track G (e2e tests)** — fold incrementally as each track lands; the final track delivers the comprehensive e2e coverage.

For a single-PR landing, run all tracks sequentially in one branch; the dependencies above are linear so partial work is testable at every step.

---

## Out of scope (explicitly deferred)

- **Top-level dedupe of identical instantiations** (`NumberInRange__0_150` shared const). Inline is simpler; only revisit if profiling shows the duplicated-schema cost matters.
- **Value-param types beyond primitives.** This PR supports `number`, `string`, `boolean` param types (matches the restricted-arg subset). Object-typed value params are deferred — there's no obvious use case yet.
- **Computed defaults referencing other value params.** `type Foo(a: number, b: number = a + 1) = number` is rejected. Defaults must be self-contained literal/static-const expressions.
- **Value-param identifiers inside the alias body itself** (not in tags). The alias `body` is a type, not an expression; value params are only meaningful inside tag arguments. We'll add a type-checker error if a value-param identifier appears in the body.

---

## Future work

### Static refinement / dependent-style checking over value args

The current plan treats value args as inert: they substitute into tag expressions, but two instantiations of the same alias are considered assignment-compatible based on their unfolded underlying type alone (decision #4). This means `BoundedArray<T>(0, 100)` flows freely into `BoundedArray<T>(0, 50)`, into `T[]`, and back — bounds info is preserved only as a label the user wrote, never enforced at assignment, and only checked at `!` sites.

A future pass could promote value args to first-class participants in assignability:

- **Canonicalize value args on the type reference.** During type checking, resolve static-const identifiers to their literal values and store them alongside the original AST so a refinement pass can do structural value-equality without re-walking scope. This is cheap to add to the v1 plan as a forward-compat measure.
- **Predicate registry for stdlib validators.** Give `min`, `max`, `minLength`, `maxLength`, `matches`, etc. a known logical interpretation (`min(n) ⇒ x ≥ n`, etc.) so the checker can reason about subset/superset relationships between two `NumberInRange(...)` instantiations.
- **Refinement subtyping.** `NumberInRange(0, 100) <: NumberInRange(0, 150)` should typecheck; the reverse should not. Built on the predicate registry.
- **Type-level arithmetic for collection bounds.** `concat: BoundedArray<T>(a, b) + BoundedArray<T>(c, d) -> BoundedArray<T>(a+c, b+d)`. Higher lift; only justified if the use cases (prompt-token budgets, batch sizing) start showing up frequently in real Agency programs.

None of this is in v1, but the v1 AST shape (`valueArgs: Expression[]` carried on the type reference) is deliberately the right substrate for it.

### Phantom-type / type-state soundness gap

Confirmed via a small Agency test: today, two instantiations of a generic alias whose type parameter does not appear in the body (`type Thread<S> = { id: string; messages: string[] }`) are treated as the same type. `Thread<Anonymous>` flows into a parameter typed `Thread<Authenticated>` with no warning. The type-checker is running (`number` → `string` correctly warns), it just unfolds aliases and compares structurally without consulting type-argument lists.

This blocks the entire family of capability / type-state patterns:

- `Thread<Authenticated | Anonymous>` — auth gating
- `Prompt<UserAuthored | SystemAuthored>` — prompt-injection defense
- `LLMClient<HasAPIKey | Unconfigured>` — config gating
- `File<Sanitized | Raw>` — input sanitization
- `Workflow<Pending | Running | Done>` — state machines
- `Currency<USD | EUR>` on `number` — unit safety

**Fix (sketch, separate ticket):** In the assignability rule for `genericType` / `typeAliasVariable`, when both sides reference the same alias by name, compare type-argument lists pairwise *before* falling back to structural comparison of the unfolded bodies. Two instantiations are assignable only if their type-arg lists are mutually assignable. This is a small surgical change in `lib/typeChecker/assignability.ts`.

**Reproducer for the fix's regression test:**
```agency
type Authenticated = "authenticated"
type Anonymous = "anonymous"

type Thread<S> = { id: string; messages: string[] }

def sendSecureMessage(t: Thread<Authenticated>, msg: string): void { print(msg) }

node main() {
  const anon: Thread<Anonymous> = { id: "1", messages: [] }
  sendSecureMessage(anon, "hello")  // should warn after the fix
}
```
After the fix, compiling this file should produce: `warning: Argument type 'Thread<Anonymous>' is not assignable to parameter type 'Thread<Authenticated>' in call to 'sendSecureMessage'`.

Once phantom types work, the **type-state pattern** (phantom param + matching discriminator field, with flow-sensitive narrowing on the field narrowing the parameter) is the natural follow-on. That second piece may need extra work in the narrowing pass, which would be a separate ticket on top of the assignability fix.
