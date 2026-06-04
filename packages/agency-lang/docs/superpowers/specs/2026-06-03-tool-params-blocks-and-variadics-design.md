# Tool parameters: blocks and variadic args

Date: 2026-06-03

## Problem

In Agency, every function is also a tool: any function can be passed to an `llm(...)` call and the runtime auto-generates a JSON schema for it. Two kinds of parameters cannot be represented in a tool schema:

1. **Block (function-typed) parameters** — an LLM cannot supply code for a block.
2. **Variadic parameters** (`...xs: T[]`) — there is no way today to bind a variadic from a named-argument call, so they cannot be expressed as a JSON schema field.

Today this either fails at runtime when the LLM picks the tool or silently misbehaves. We want a deterministic, well-defined story for both.

## Part 1: Variadic parameters

### Generalized calling convention

Allow named-argument calls of the form `foo(rest: [1, 2, 3])` for any variadic parameter, from **any caller** — hand-written Agency or LLM-driven. This is a general language feature, not a tool-only convention.

- Inside `foo`, `rest` is the same spread array it would be when called positionally.
- Existing positional spread `foo(1, 2, 3)` continues to work.
- Mixed named-arg calls with a variadic are allowed: `def foo(a: number, ...rest: number[])` may be called as `foo(a: 1, rest: [2, 3])`. (This combination is not supported today.)
- **PFA extension.** This convention also extends to PFA: `foo.partial(rest: [2, 3])` binds the variadic. Today PFA explicitly disallows binding variadics (`partial-application.md`); this lifts that restriction in the same uniform way as the call-site form.
  - **PFA-binding a variadic is atomic.** Once a variadic is bound via the named-array form in `.partial()`, the resulting function takes no further positional arguments that would feed it. There is no notion of "appending more elements at the call site." If you need to combine arrays, do so at the `.partial(rest: [...a, ...b])` site.

### Disambiguation note

A named-arg call `foo(rest: [1, 2, 3])` looks identical whether `rest` is declared as `...rest: number[]` or `rest: number[]`. There is no caller-side ambiguity: the parameter declaration determines the binding, and from inside `foo` the value is the same array either way. No new parser disambiguation rule is required.

One subtlety worth noting in docs: when the variadic's element type is itself an array, the named-array form passes the *whole* array as the spread. For `def foo(...xs: number[])`, `foo(xs: [1,2,3])` binds `xs = [1,2,3]` (three elements), not `xs = [[1,2,3]]` (one element). To get a single-element variadic containing an array, pass `foo(xs: [[1,2,3]])`.

### Mixed positional + named-variadic rule

If a variadic parameter is bound by name, **no positional arguments may be supplied past the fixed (non-variadic) parameters**. For `def foo(a: number, ...rest: number[])`:

- `foo(1, 2, 3)` — OK (all positional).
- `foo(a: 1, rest: [2, 3])` — OK.
- `foo(1, rest: [2, 3])` — OK (positional fills `a`, named binds `rest`).
- `foo(1, 2, rest: [3])` — **error**: positional `2` would feed `rest`, which is also bound by name.

The type checker rejects the last form with a clear message; the runtime resolver also rejects it as a backstop.

### Tool schema for variadics

A variadic parameter `...nums: number[]` generates a JSON schema field named `nums` with type `number[]`. The LLM invokes the tool using the named-array call form. The LLM path is not a special case: it is simply one more caller using the named-array calling convention.

`@param nums - description` docstring extraction applies unchanged; authors should write the description in collection terms (e.g., "the values to sum") since the schema field is an array, not a single element.

## Part 2: Block (function-typed) parameters

### Rule

When a function is registered as a tool for an LLM call, every parameter whose declared type is a function type is **omitted** from the generated JSON schema. This includes "block" parameters (e.g., `block: (X) => Y`) and any other parameter declared with a function type.

### What counts as "function-typed"

A parameter is function-typed if its declared type is:
- A direct function type, e.g., `(X) => Y`, including zero-arg `() => Y`.
- A union where **any** arm is a function type (e.g., `((x: X) => Y) | string`). Conservative: such params are dropped from the schema even though the LLM could supply the non-function arm. (See "Out of scope" — supporting union-with-function in schemas is deferred.)

Recursive function types are still function types; the same rule applies.

Agency does not have generics over functions, so the function-typed determination is always made against a fully concrete parameter type at the `llm(...)` site. No "resolve generic constraint at tool registration" logic is needed.

#### Variadic whose element type is a function type

A variadic such as `def foo(...handlers: ((x: number) => number)[])` is treated as **function-typed** for the purpose of this spec — i.e., the whole variadic parameter is dropped from the tool schema and is subject to the same required-vs-optional rules as a single function-typed parameter. This is the consistent extension of the union-with-function rule: if the element type is a function type, the LLM cannot meaningfully fill the array.

If the variadic is required (the function declares it with no fallback) and unbound, the compile-time check errors at the `llm(...)` site; if it's optional (declared with default `= []` or similar), it is silently dropped with the standard warning.

#### `any`-typed parameters

If a parameter is declared `any`, it is **not** considered function-typed by either the static check or the runtime backstop. Such a parameter is exposed in the tool schema with whatever encoding the schema generator uses for `any` (today: a permissive JSON schema). If the function body internally calls the `any` parameter as a block, and the LLM does not supply a callable, the call will crash mid-invocation — exactly the failure mode this spec otherwise avoids.

This is an accepted limitation, documented for users:

- Rationale: detecting "this `any` param is invoked as a function" would require body-level escape analysis, which is disproportionate effort for a niche pattern. `any` is already an opt-out of type-checking guarantees throughout Agency.
- Mitigation: the docs section that introduces tool-as-function will include a "don't put callable `any` parameters in tool functions" caution and point users to declaring the parameter with an explicit function type (which then benefits from the static check) or PFA-binding it.

### Required vs optional

- **Optional** function-typed parameter, unbound: dropped from the schema; passed as `undefined` at runtime. The function body is responsible for handling `undefined`. The type checker emits a **warning** at the `llm(...)` site listing dropped optional function-typed params, so this is visible rather than silent. A warning (not an error) keeps the path ergonomic for stdlib-style functions whose blocks are genuinely optional.
- **Required** function-typed parameter: must be bound via partial application (PFA) before the function is passed as a tool.

Block parameters are already named, function-typed parameters in Agency (see `docs/site/guide/blocks.md`), and the existing PFA syntax already binds them: `mapWithIndex.partial(block: someFn)`. No new PFA syntax is introduced.

### Enforcement: two-layer, by design

This is a deliberate design choice and is documented as such.

1. **Compile-time check (type checker, primary).** Passing a function as a tool to an `llm(...)` call is a type error if any required function-typed parameter is unbound. The error names the offending parameter(s) and suggests `.partial(name: ...)`.
2. **Runtime check (backstop).** Each `llm(...)` call finalizes its tool array immediately before issuing the request. At that point — not at any earlier tool-array-construction site — the runtime re-verifies, for each tool, that every required function-typed parameter (per the function's runtime descriptor) is bound. If not, throw before the LLM ever sees the schema. This handles cases the static checker cannot prove, principally dynamically assembled tool arrays (e.g., `llm(..., { tools: [...base, validate] })`) where the static checker has no single concrete list to walk.

   The runtime check uses the same param descriptor (`AgencyFunction.params`) that the schema generator consults; `isBound` and the declared type are both already tracked there (see `lib/runtime/agencyFunction.ts`). No new metadata is added.

**Why not silently drop required block params?** Silent drops would produce confusing late failures: the LLM picks the tool, the call begins, and the function crashes mid-body when it tries to invoke the missing block. Both layers above ensure failures surface at the registration boundary, not deep inside an invocation.

## Part 3: Schema generation details

- Parameter ordering in the schema follows declaration order. Dropped function-typed parameters are simply absent.
- Mixed signature example. Given:
  ```ts
  def foo(a: number, onDone: () => void, ...rest: number[])
  ```
  (Variadic must be last — see "Out of scope".) If `onDone` is optional or PFA-bound, the schema is `{ a: number, rest: number[] }`.
- `@param name - description` extraction is skipped for dropped function-typed params.

## Part 4: Where the work lands

### 4.1 Parser / named-arg resolution

- The parser already accepts `name: expr` named arguments. No grammar change.
- The named-arg *binder* (both compile-time in the typescript builder's `resolveNamedArgs` and runtime in `resolveNamed`) currently forbids a named arg from targeting a variadic. Lift that restriction in both places: when the name matches a variadic parameter, the supplied value is bound directly as the spread array (no element-wise wrapping).
- The two binders must agree on the rules. Extract a single predicate/classifier helper (see 4.6) that both consult, so they cannot drift. If, for genuine cross-package reasons, the helper cannot be shared in code, add a `// keep in sync with X` comment on both sides AND a test that exercises both code paths on the same input.
- Splat-after-named is already rejected (`checker.ts` ~lines 383–404). Extend the same pass to reject **positional-after-named-variadic** (the new mixed-rule).

### 4.2 Type checker — detailed changes

Concrete code touchpoints (all paths are inside `lib/typeChecker/`):

**(a) `checker.ts :: paramListSignature` (~lines 50–101) — variadic becomes nameable; slot resolution moves into the signature itself.**

Today the `isNameable` predicate is `!p.variadic && p.typeHint?.type !== "blockType"`. Change to: `isNameable = (p) => p.typeHint?.type !== "blockType"`. (Block-typed params remain non-nameable from the LLM/named-arg perspective in the *schema-generation* sense, but they already accept named binding via `block: fn` in normal Agency calls; the existing `nameableParams` filter at line 411 already includes them. The two filters serve different purposes; do not conflate them in the refactor.)

The slot exposed for a variadic via named arg must have type `T[]` (the array type), not the per-element `T` that positional-spread uses. **Do not** patch this in the consumer (`checkArgsAgainstParams`) by overriding `paramType` after the fact — that leaks the variadic-handling rule into every caller. Instead, return a slot-resolver from `paramListSignature` so callers ask, not compute:

```ts
type SlotRequest =
  | { kind: "positional"; index: number }
  | { kind: "named"; name: string };

type ParamSignature = {
  minArgs: number;
  maxArgs: number;
  resolveSlot(req: SlotRequest): ParamSlot | undefined;
};
```

`resolveSlot({ kind: "named", name })` returns a slot whose `type` is the array form when the param is variadic; `resolveSlot({ kind: "positional", index })` returns the element-typed slot. `checkArgsAgainstParams` only ever calls `resolveSlot` and runs the assignability check — it does not know about variadics. This is the declarative shape: the rule lives in one place, every consumer is identical.

The existing `slots` array can remain as an internal implementation detail of `paramListSignature` (or be removed if it has no other consumer).

**(b) `checker.ts :: checkNamedArgStructure` (~lines 380–435) — accept named binding of variadic; reject mixed-rule violations.**

- Drop the `!p.variadic` filter at line 411: `const nameableParams = params` (or keep the filter only excluding params that genuinely cannot be named, which after this change is the empty set).
- Update the comment at lines 406–410 to reflect that variadics may now be passed by name with the whole-array form.
- After the existing pass-2 loop, add a pass that detects positional-after-named-variadic. Concretely: if any named arg targets a variadic param at index `i`, then no positional arg at index `> i_last_fixed` (i.e., any positional that would feed the variadic) may exist. Emit: `"Positional argument cannot feed variadic parameter '<name>' when it is also bound by name in call to '<fn>'."`

**(c) `checker.ts :: checkArgsAgainstParams` (~lines 480–538) — consume the slot resolver.**

Replace `slots.find((s) => s.name === arg.name)` with `sig.resolveSlot({ kind: "named", name: arg.name })`, and `slots[argIndex]` with `sig.resolveSlot({ kind: "positional", index: argIndex })`. After this change, `checkArgsAgainstParams` contains no variadic-specific logic at all; the per-arg branch is uniform.

**(d) `synthesizer.ts :: validateAgencyFunctionMethod` (~lines 468–501) — `.partial()` accepts variadic.**

Lines 494–499 currently reject binding a variadic in `.partial()`. Replace with:

- If the param is variadic, type-check the named-arg value against the array type (`T[]`), not the element type. Emit the same "wrong element type" error if it doesn't match.
- Keep the rest of the `.partial()` validation (unknown name, duplicate, non-named arg) untouched.

**(e) New: tool-position function-binding check (new file, e.g., `lib/typeChecker/toolBlockBinding.ts`).**

The validator must be a *composition of named pieces*, not a procedural script. Each piece below is a small, individually testable function that lives in one place and is reused by both this validator and (where applicable) the schema generator and runtime backstop.

```ts
// Predicate. Used by this validator, the schema generator (4.3),
// and the runtime backstop (4.4). Single source of truth.
function isFunctionTyped(param: FunctionParameter): boolean;

// Resolve "the bound-ness of param <name> on this tool expression."
// Handles bare identifier, `.partial(...)`, `.describe(...)`,
// `.preapprove()` chains. Reuses the chain-walking machinery already
// in synthesizer.ts (validateAgencyFunctionMethod path) — do not
// re-implement chain unwrapping.
function isBound(toolExpr: AgencyNode, paramName: string): boolean;

// Per-param classifier. Total over the three possible outcomes;
// every param contributes exactly one classification.
type ParamClassification =
  | { kind: "ok"; param: FunctionParameter }
  | { kind: "required-unbound"; param: FunctionParameter }
  | { kind: "optional-unbound"; param: FunctionParameter };

function classifyToolParam(
  param: FunctionParameter,
  toolExpr: AgencyNode,
): ParamClassification;

// Resolve a `tools:` option value to the list of statically-known
// tool expressions. Spread/identifier/dynamic returns []
// (intentionally; runtime backstop handles those).
function resolveStaticTools(opt: AgencyNode): AgencyNode[];

// Resolve a tool expression to its declared parameter list, looking
// in `ctx.functionDefs` and `ctx.importedFunctions`.
function paramsOfTool(toolExpr: AgencyNode, ctx: TypeCheckerContext):
  FunctionParameter[] | undefined;
```

With those, the validator body is a one-pass declarative pipeline (the "what"):

```ts
for (const call of llmCalls) {
  for (const toolExpr of resolveStaticTools(call.toolsOpt)) {
    const params = paramsOfTool(toolExpr, ctx) ?? [];
    const classifications = params
      .filter(isFunctionTyped)
      .map((p) => classifyToolParam(p, toolExpr));
    emitDiagnostics(call, toolExpr, classifications);
  }
}
```

`emitDiagnostics` is the only place that knows the diagnostic format:

- One **error** per `required-unbound` classification: `"Tool '<fn>' has unbound required function-typed parameter '<name>: <type>'. Bind it with .partial(<name>: <value>) before passing as a tool."`
- One aggregated **warning** per `llm(...)` call when any `optional-unbound` classifications exist: `"Tool '<fn>' will be exposed to the LLM without optional function-typed parameter(s): <names>. The function body must handle them as undefined."`

The diagnostic-text-builder is a separate small function (`formatRequiredUnboundError`, `formatOptionalUnboundWarning`) so the runtime backstop (4.4) can call the same builders to guarantee unified wording.

**(f) Tests for the type checker.** Co-located, following the existing pattern (`<feature>.test.ts`):
- New `variadicNamedBinding.test.ts`: named-array call form, mixed positional+named, mixed-rule violation, wrong element type, PFA-bound variadic with correct/incorrect array type.
- New `toolBlockBinding.test.ts`: required-function-typed unbound → error; optional-function-typed unbound → warning; PFA-bound required → ok; union-with-function required → error (with the conservative drop note); spread-into-tools (`tools: [...base]`) → silently skipped at compile time.
- New unit tests for each named helper (`isFunctionTyped`, `isBound`, `classifyToolParam`, `resolveStaticTools`, `paramsOfTool`) in isolation, so regressions in the helpers are localized rather than diffused across integration tests.

### 4.3 Tool schema generator

File: `lib/backends/typescriptBuilder.ts :: buildToolDefinition` (~lines 1395–1450).

Today the generator has two scattered concerns: filter out `blockType` params, and (separately, untreated) emit fields per-param. With variadics and function-of-arrays added, the rules interact (a variadic-of-function must be dropped, not emitted as array). Implementing this as two filters or a chain of `if`s scatters the rules and makes future additions error-prone.

**Replace the scattered filters with a single declarative classifier** that returns one decision per parameter:

```ts
type SchemaContribution =
  | { kind: "drop" }                              // function-typed, function-union,
                                                   //  variadic-of-function, etc.
  | { kind: "scalar"; zod: string; description?: string }
  | { kind: "array"; element: string; description?: string };  // variadics

function paramSchemaContribution(
  param: FunctionParameter,
): SchemaContribution;
```

`paramSchemaContribution` is the *single source of truth* for "what does this parameter contribute to a tool schema?" It internally consults `isFunctionTyped` (the same predicate from 4.2(e)) and the variadic flag. `buildToolDefinition` becomes:

```ts
const contributions = parameters.map(paramSchemaContribution);
const fields = parameters
  .map((p, i) => ({ name: p.name, contribution: contributions[i] }))
  .filter((c) => c.contribution.kind !== "drop");
// emit fields in declaration order
```

Result: every "should this param appear in the schema?" decision lives in one function. Adding a new dropped case later (e.g., when the union-with-function out-of-scope item gets revisited) is a one-line addition to `paramSchemaContribution`, not a hunt across `buildToolDefinition`.

Per-parameter doc text (`@param name - description`) is read inside `paramSchemaContribution` and attached to the `scalar`/`array` contributions; `drop` contributions discard the doc, satisfying test 34.

The early-return path for "no parameters" remains (test 32). The "all params dropped" case (test 33) naturally falls out because `fields` is empty and the existing empty-schema branch handles it.

### 4.4 Runtime tool registration backstop

- File: `lib/runtime/agencyFunction.ts` and the `llm()` runtime entry point (smoltalk-side; see `lib/runtime/llmClient.ts` per `builtins.ts:26`).
- In `agencyFunction.ts`:
  - Relax the existing `Variadic parameter '<name>' cannot be bound` check (line ~142) so it accepts a binding whose declared type matches the variadic's array type. (Today it rejects unconditionally.)
- New helper, e.g., `validateToolForLLM(fn: AgencyFunction): void`, that throws if any required function-typed param is unbound. Invoked once per tool in the array, **immediately before** the request is issued.
- Error message format: `"Tool '<name>' cannot be passed to llm(): required function-typed parameter '<param>' is unbound. Use <fn>.partial(<param>: <value>) before passing."`. Match the compile-time error so users see one consistent message.

### 4.5 Calling convention (PFA path)

`agencyFunction.ts :: partial(...)` currently throws for variadic. After the relaxation in 4.4, the bound value must be stored as the spread array. The existing `boundValue` mechanism already supports this — no new shape needed. `buildReducedSchema` (called from `partial`) will then naturally omit the variadic from the post-PFA schema.

### 4.6 Implementation discipline: named abstractions, not procedures

This spec deliberately avoids describing the implementation as a sequence of steps. Three classifiers and a slot resolver carry the whole specification of "what" the change does:

| Name | Lives in | Consumers |
|------|----------|-----------|
| `isFunctionTyped(param)` | `lib/typeChecker/utils.ts` (or new module) | tool-binding validator (4.2e), schema generator (4.3), runtime backstop (4.4) |
| `isBound(toolExpr, paramName)` | tool-binding validator module | tool-binding validator, runtime backstop |
| `classifyToolParam(param, toolExpr)` | tool-binding validator module | tool-binding validator only |
| `paramSchemaContribution(param)` | schema generator module | schema generator (4.3); consults `isFunctionTyped` internally |
| `ParamSignature.resolveSlot(req)` | `checker.ts :: paramListSignature` | `checkArgsAgainstParams`, any future arg-checking consumer |
| `formatRequiredUnboundError`, `formatOptionalUnboundWarning` | shared diagnostic module | tool-binding validator, runtime backstop |

Hard rules:

1. **Every classification or rule listed above has exactly one definition site.** If two consumers want to ask "is this param function-typed?", they call the same `isFunctionTyped` — never reimplement, never inline.
2. **No consumer of `paramListSignature` may inspect `param.variadic` directly to decide a slot type.** Ask `resolveSlot`. This is the test of whether the slot-resolver refactor was applied correctly.
3. **No consumer of `buildToolDefinition` may filter parameters with an ad-hoc predicate.** All "should this param appear?" logic goes through `paramSchemaContribution`.
4. **Diagnostic text is built by the format helpers, not inlined at error sites.** This is what makes test #42 (unified runtime/compile-time wording) pass without coordination overhead.

If a reviewer sees an inlined predicate, an ad-hoc filter, or a duplicated diagnostic string, that is a correctness concern — the abstraction has been re-leaked. Fix at the call site by routing back through the named helper; do not paper over with a comment.

## Part 5: Testing

Every test below names the *assertions* it must make, not just the scenario. A test is only valuable if its failure mode is "the code under test broke." When a test claims "no error," the test must also assert any positive behavior the feature promises (warning fires, schema field present/absent, runtime value is correct), or a regression that silently drops the positive behavior will not be caught.

### 5.1 Binder / type checker — named-arg targeting variadic

All in a new file `lib/typeChecker/variadicNamedBinding.test.ts`, unless otherwise noted.

1. **Named-array form is accepted and well-typed.** Source: `def foo(...xs: number[]) { ... }; foo(xs: [1,2,3])`. Assert: zero type errors, zero warnings.
2. **Mixed positional + named variadic.** Source: `def foo(a: number, ...rest: number[]) { ... }; foo(1, rest: [2,3])`. Assert: zero diagnostics.
3. **Pure named form with fixed param.** `foo(a: 1, rest: [2,3])`. Assert: zero diagnostics.
4. **Positional-after-named-variadic violation (compile time).** `foo(1, 2, rest: [3])`. Assert: exactly one error; message contains both the parameter name (`rest`) and the function name (`foo`); error location points at the call.
5. **Wrong outer shape.** `foo(rest: 5)` for `...rest: number[]`. Assert: assignability error reporting expected type `number[]`, actual type `number`.
6. **Wrong element type.** `foo(rest: ["a","b"])` for `...rest: number[]`. Assert: assignability error reporting expected `number[]`, actual `string[]`.
7. **Right element, wrong nesting.** `foo(rest: [[1,2]])` for `...rest: number[]`. Assert: assignability error; ensures slot type is `T[]` (the spec's invariant) not `T`.
8. **Array-of-array variadic disambiguation (type level).** `def foo(...xs: number[][]); foo(xs: [[1,2],[3]])`. Assert: zero diagnostics. (Locks in the doc subtlety at the type-checker layer.)
9. **`.partial()` with named-array binds variadic.** `min.partial(rest: [1,2])`. Assert: zero diagnostics, no longer emits the legacy "Variadic parameter '<n>' cannot be bound" error.
10. **`.partial()` with wrong array type rejects.** `min.partial(rest: ["a"])` for `...rest: number[]`. Assert: assignability error.
11. **Block-typed param remains non-variadic-nameable.** Confirm the refactor of `paramListSignature` did not accidentally re-classify block params. A function `def foo(block: () => void)` called with the normal `block: fn` named arg still works (existing behavior).

### 5.2 Type checker — tool-position binding check

In a new file `lib/typeChecker/toolBlockBinding.test.ts`.

12. **Required function-typed param unbound, literal tools array → error.** `def deploy(block: () => void) { ... }; node main() { llm("x", { tools: [deploy] }) }`. Assert: exactly one error at the `llm(...)` site; message contains `deploy`, `block`, and the substring `.partial(`.
13. **Optional function-typed param unbound → warning, no error.** `def deploy(block: () => void = noop) { ... }; llm("x", { tools: [deploy] })`. Assert: zero errors AND exactly one warning naming `deploy` and `block`; warning location is the `llm(...)` site.
14. **PFA-bound required block → no diagnostics.** `llm("x", { tools: [deploy.partial(block: real)] })`. Assert: zero errors, zero warnings.
15. **Union-with-function required, unbound → error.** `def foo(block: ((x: number) => number) | string) {...}; llm(tools: [foo])`. Assert: error mirrors test 12.
16. **Union-with-function optional → warning.** Assert: zero errors, one warning.
17. **Variadic-of-function required, unbound → error.** `def foo(...handlers: ((x: number) => number)[]); llm(tools: [foo])`. Assert: error mirrors test 12.
18. **Variadic-of-function optional → warning.** Assert: zero errors, one warning.
19. **Imported function as tool.** Function declared in another module, imported, passed as tool with unbound required block → error. Assert: error fires, proving the validator consults `ctx.importedFunctions`, not only `ctx.functionDefs`.
20. **PFA chain `.partial(...).preapprove()`.** Assert: no error for the bound block; `.preapprove()` does not undo the binding signal.
21. **PFA chain `.preapprove().partial(...)`.** Same expectation. (If the language disallows this ordering, the test asserts the parse/type error instead, and the spec must say so.)
22. **Spread-into-tools `tools: [...base, validate]` with an unbound required block → no compile-time diagnostic.** Assert: zero diagnostics at this call site (this case is intentionally deferred to the runtime backstop, tested in 5.4).
23. **Identifier-as-tools `tools: tools` → no compile-time diagnostic.** Same rationale; runtime backstop owns it.
24. **Error + warning coexistence.** Function with both an unbound required block and an unbound optional block. Assert: exactly one error (for the required one) AND exactly one warning (for the optional). Pins down the "both fire independently" semantics.
25. **All function-typed params bound (PFA + optional combo).** `def foo(req: () => void, opt?: () => void)` called as `llm(tools: [foo.partial(req: real)])`. Assert: zero errors AND one warning for `opt` being dropped (the warning still fires because `opt` is unbound).
26. **Function with only function-typed params, all bound.** `def foo(req: () => void); llm(tools: [foo.partial(req: real)])`. Assert: zero diagnostics. (Pairs with the empty-schema runtime test in 5.3.)

### 5.3 Schema generator (snapshot + explicit assertions)

In `lib/backends/typescriptBuilder.test.ts` (or co-located).

27. **Variadic emits array field.** Snapshot the generated `toolDefinition` for `def foo(...nums: number[])`. *In addition to* the snapshot: explicit assertion that `properties.nums` is present and its zod expression contains `z.array(z.number())`.
28. **Function-typed param dropped (single).** For `def foo(a: number, block: () => void)`: snapshot + explicit assertion that `properties` has key `a` and does **not** have key `block`.
29. **Function union dropped.** `def foo(a: number, cb: ((x: number) => number) | string)`: explicit assertion that `cb` is absent.
30. **Variadic-of-function dropped.** `def foo(a: number, ...handlers: ((x: number) => number)[])`: explicit assertion that `handlers` is absent (per Part 2's new clarification) and `a` is present.
31. **Mixed signature ordering preserved.** `def foo(a: number, block: () => void, b: string, ...rest: number[])`: schema keys appear in order `a, b, rest`. Assert the iteration order of `properties` matches.
32. **No params → empty `{}` schema.** Verify `buildToolDefinition` still returns the empty-schema form (current early-return path) and the runtime accepts it as a tool.
33. **All function-typed params dropped → empty schema.** `def foo(req: () => void)` after PFA. Assert: schema is `{}`, tool is registerable.
34. **`@param` docstring extraction is skipped for dropped params.** For a function with a `@param block - ...` docstring on a dropped block param, the resulting tool description must not include the `block` description, and the absence of the schema field must not produce a stray "missing description" warning.
35. **`@param nums - ...` is preserved for variadic.** Assert the schema field's description matches the docstring text (with the collection-terms wording the spec requires authors to use).

### 5.4 Runtime tool-registration backstop

In `lib/runtime/agencyFunction.test.ts` or a new sibling, plus an agency-js test for end-to-end coverage.

36. **`validateToolForLLM` rejects unbound required function-typed param.** Direct unit test: construct an `AgencyFunction` with one unbound function-typed param, call the validator. Assert: throws; message contains the function name, parameter name, and a `.partial(<name>: <value>)` suggestion identical in structure to the compile-time error.
37. **`validateToolForLLM` accepts when bound.** PFA-bind the same param, call validator. Assert: no throw.
38. **`validateToolForLLM` ignores optional unbound function-typed params.** Assert: no throw. (The compile-time warning is the only signal for the optional case; the runtime is silent.)
39. **Backstop runs before any LLM request.** Agency-js test: stub/mock the smoltalk client to record invocations. Pass a dynamically-assembled tool array (`tools: [...base, badTool]`) where `badTool` has an unbound required block. Assert: `llm()` throws; the smoltalk mock recorded zero requests.
40. **Dynamically assembled array passes when all tools are bound.** Same setup, `badTool` replaced with `badTool.partial(block: real)`. Assert: no throw at registration; smoltalk receives the tool array exactly once.
41. **PFA of variadic with mismatched element type at runtime.** `foo.partial(rest: "not-an-array")` where the static type was `any` so it slipped through. Assert: throw at `partial(...)` time with a clear "expected array" message.
42. **Unified runtime/compile-time error wording.** Pick the canonical phrase (e.g., `"required function-typed parameter '<name>' is unbound"`) and assert both the type checker test (12) and the runtime test (36) emit a message containing that exact substring.

### 5.5 Agency execution tests (named-array calling convention)

In `tests/agency/`.

43. **Named-array form matches positional.** Two test bodies invoking the same function once positionally (`foo(1,2,3)`) and once by name (`foo(rest: [1,2,3])`). Assert: both produce the same observable result (e.g., sum or length).
44. **Mixed positional+named.** `foo(1, rest: [2,3])` for `def foo(a: number, ...rest: number[])`. Assert inside the body: `a == 1`, `len(rest) == 2`, `rest[0] == 2`, `rest[1] == 3`.
45. **Pure named form with fixed param.** `foo(a: 1, rest: [2,3])`. Assert the same body invariants as 44.
46. **Array-of-array variadic (runtime).** `def foo(...xs: number[][]); foo(xs: [[1,2],[3]])`. Assert: `len(xs) == 2`, `xs[0] == [1,2]`, `xs[1] == [3]`. Locks in the doc subtlety at runtime.
47. **Positional-after-named-variadic violation (runtime).** A compiled call site (forced through generated TS, since the type checker rejects this) — assert the runtime `resolveNamed` throws. Belt-and-suspenders for the case where source-bypass paths (e.g., generated code, hand-written TS using the runtime) attempt this.
48. **PFA-bound variadic produces correct spread inside the body.** `let bound = foo.partial(rest: [1,2]); bound(a: 10)` for `def foo(a, ...rest)`. Assert: body sees `a == 10`, `rest == [1,2]`.
49. **PFA-bound block is invoked.** `let bound = foo.partial(block: \-> 42); bound()` for `def foo(block: () => number) { return block() }`. Assert: result is `42`.
50. **Optional block dropped from schema is invoked as undefined.** Hand-crafted scenario (no LLM): call the agency function via its tool entry point with the optional block omitted. Assert: body receives `undefined` for `block`; body's `if (block !== undefined) { ... }` branch is taken correctly.
51. **Trailing-block syntax `as { ... }` from a normal Agency caller.** Function with a block param dropped from the *tool* schema is still callable as `foo(x: 1) as { ... }` from inside a node body. Assert: the block executes. Guards against the schema-generator refactor breaking the named-arg resolver.

### 5.6 Backend / round-trip

52. **`buildReducedSchema` after PFA-binding a variadic.** Unit test in `lib/runtime/agencyFunction.test.ts`: construct a tool with a variadic, apply `.partial(rest: [1,2])`, assert the resulting `schema` no longer contains the variadic field.
53. **Round-trip formatter.** Run `AgencyGenerator` (`pnpm run fmt`) on source containing both `foo(rest: [1,2])` and `foo.partial(rest: [1,2])`. Assert: re-parsing the formatter output yields a structurally-equivalent AST. Goes in the existing formatter round-trip test suite.

### 5.7 Coverage matrix

To make gaps visible, this is the explicit coverage matrix the suite must satisfy:

| Dimension | Cases |
|-----------|-------|
| Param kind | function-typed, function-union, variadic-of-function, plain variadic, plain scalar, `any` |
| Required vs optional | required, optional (with default) |
| Binding state | unbound, PFA-bound (single), PFA-chain bound, optional left unbound |
| Tools-array shape | literal array, identifier, spread, single-element |
| Tool source | local def, imported def |
| Diagnostic site | compile-time error, compile-time warning, runtime throw |
| Caller of variadic | positional, named-array, mixed |

If a row is added to either dimension by future work, a corresponding test row is expected.

## Warning ergonomics

The compile-time warning for dropped optional function-typed params (Part 4.2(e)) is emitted at the `llm(...)` site, listing the offending tool and parameter names. No opt-out mechanism is provided in this design — if a stdlib author finds the warning genuinely noisy at a call site, the right response is to either PFA-bind the optional param explicitly or revisit the function's signature. We can add a per-site suppression later if real usage shows a need; introducing one preemptively would invite cargo-culted suppression of a signal that's meant to be visible.

## Migration

This is not a breaking change. Today, every code path that this spec addresses is either:

- An outright runtime crash (a function with a function-typed parameter is passed to `llm(...)`, the LLM picks the tool, and the call fails when the missing block is invoked), or
- A statically rejected construct (`.partial(rest: [...])` against a variadic; named arg targeting a variadic).

No working program currently relies on the prohibited behavior. After this change:

- The compile-time error for unbound required function-typed params will surface earlier on programs that previously crashed at LLM-invocation time. Affected users get a clear actionable error pointing at `.partial(...)`.
- Programs that pass variadic-bearing functions as tools today either don't work (no schema field for the variadic) or work by accident with a malformed schema; both become well-defined.

## Handler-safety note

Per `CLAUDE.md`, handlers are critical safety infrastructure. Handlers are installed by `handle { ... }` blocks in the calling code, not by passing a block parameter into a function. Dropping a function-typed parameter from a tool schema therefore does **not** bypass any handler that would otherwise have been installed. No stdlib function is expected to rely on a caller-supplied block to install a handler; if one does, that is a separate bug. We call this out explicitly so future changes do not weaken this guarantee.

## Out of scope (YAGNI)

- Representing blocks to the LLM by encoding code as strings.
- Auto-PFA for unbound block parameters. The user binds them.
- Changes to the inline-block syntax (`\x -> ...`).
- Reordered or rest-after-variadic signatures. Variadic must remain the last parameter.
- Supporting `((x) => y) | string`-style union schemas where the non-function arm is exposed. Such parameters are conservatively dropped; revisit if a real use case emerges.
