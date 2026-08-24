# Type Checker

The type checker (`lib/typeChecker/`) uses **bidirectional type checking** to catch type errors in Agency programs before they are compiled to TypeScript. It can be run standalone via `agency typecheck` or integrated into the compile/run pipeline via config flags.

This document explains what bidirectional type checking is, how it's implemented for Agency, the special cases required by the language, and how it gets triggered.

**Flow-sensitive narrowing and exhaustiveness checking** have their own subtree: [`narrowing/`](./narrowing/). That work is large and growing, so it lives separately from this overview.

## What is bidirectional type checking?

Traditional type checkers work in one direction: they look at an expression and try to figure out what type it is (bottom-up). Bidirectional type checking adds a second direction: sometimes we already _know_ what type an expression should be, and we push that expectation _down_ into the expression (top-down).

These two directions are called **synth mode** and **check mode**:

- **Synth mode** (bottom-up, also called "synthesis"): Given an expression with no context, figure out what type it produces. For example, `1 + 2` synthesizes to `number`, and `greet("Alice")` synthesizes to whatever `greet`'s return type is.

- **Check mode** (top-down): Given an expression _and_ an expected type, verify they're compatible. For example, in `x: number = greet("Alice")`, we check that the return type of `greet` is compatible with `number`.

The key insight is that some expressions are easier to handle in one mode than the other. `llm(...)` calls are the best example in Agency. In synth mode an `llm()` call can only be inferred as `string`. In check mode we know the call will produce structured output matching the expected type, so we skip the check entirely. This is what makes bidirectional checking more powerful than pure bottom-up inference.

## Architecture overview

The `TypeChecker` class (`lib/typeChecker/index.ts`) drives everything. Its constructor takes a `CompilationUnit`, which already holds the type aliases, function definitions, graph nodes, and imported signatures. It also desugars `guard` constructs before anything is checked, so every later rule sees the plain `_guard(...)` call shape.

`check()` then runs, in order:

```
1. name/alias validation   — reserved names, shadowed imports, type-alias references
2. inferReturnTypes()      — infer return types for defs without an annotation
3. buildScopes()           — walk each scope body and declare every binding
4. analyzeInterruptsFromScopes() + refineInlineHandlerParams()
5. buildFlowGraphs()       — the flow graph the narrowing subtree uses
6. computeMatchExprTypes() — the value type of each expression-position `match`
7. checkScopes()           — calls, return types, expressions, assignments
8. the diagnostic passes   — see Diagnostics below
```

Ordering matters and the comments in `check()` say why. Handler parameters are retyped before the flow build so the flow oracle is seeded with the refined type, and match expression types are computed after the flow build so yields see narrowed bindings.

### Scopes

The checker builds a `ScopeInfo` for each independent scope in the program:

- **Top-level scope**: all nodes at the program root
- **Function scopes**: one per `def` block, seeded with parameter types
- **Graph node scopes**: one per `node` block, seeded with parameter types

Each scope is a `Scope` object (`lib/typeChecker/scope.ts`) mapping names to a `VariableType`. There is no `"any"` string sentinel any more. It was retired in issue #472, and `ANY_T` from `lib/typeChecker/primitives.ts` is the real `any` type. `lib/typeChecker/anySentinelRetired.test.ts` is the tripwire that keeps it retired.

A def scope chains to the module scope for lookups, so top-level bindings are visible inside a function without leaking declarations back out.

### Variable type collection

`walkScopeBody` (`lib/typeChecker/scopes.ts`) makes one pass over the body in source order and declares every binding into the scope. `declareVariable` handles assignments:

| Situation | What happens |
|-----------|-------------|
| Assignment has a type annotation | Validate that the annotation's references exist, report a conflict if the variable was already typed, then bind the variable to the annotated type. A `@validate`d binding is bound to `Result<T, string>`, matching what the runtime produces. |
| Reassignment or a property/index write on an existing binding | Nothing is declared. The value-vs-target check runs later in the flow-aware `checkAssignmentsInScope`. |
| No annotation and no existing binding | Synth the value's type, widen it, and bind. In `strictTypes` mode this also reports `missingAnnotationStrictMode`. |

The value-vs-annotation check deliberately does NOT run here. It runs in Phase B (`checkAssignmentValue`, called from `checkAssignmentsInScope`) so it can see flow-narrowed types.

The same walk also handles:
- **`importStatement`**: an imported Agency function gets a `functionRefType` built from its real signature in `ctx.importedFunctions`. A name from a JS import, or one with no known signature, gets `ANY_T`.
- **`forLoop`**: `for (item, second in x)` binds two variables. Over an array, `item` is the element type and `second` is `number`. Over a record or object literal, `item` is the key and `second` is the value. `recordLikeKeyValue` is the shared helper so this and index-access synthesis agree.
- Nested blocks (`ifElse`, `whileLoop`, `matchBlock`, `handleBlock`, `finalizeBlock`, `parallelBlock`, `seqBlock`, `messageThread`) recurse into the same scope, which is why declarations leak out of nested blocks today.

### Checking phase

After variable types are collected, `checkScopes` (`lib/typeChecker/checker.ts`) runs four passes over each scope:

1. **Function call checking** (`checkFunctionCallsInScope`): walks every function call in the scope and validates arity and argument types.
2. **Return type checking** (`checkReturnTypesInScope`): for scopes with a declared return type, checks every `return` statement's value against the expected return type using **check mode**.
3. **Expression checking** (`checkExpressionsInScope`): conditions, regex match operands, catch defaults, pipe arguments, block returns, and JS namespace member calls.
4. **Assignment checking** (`checkAssignmentsInScope`): the flow-aware value-vs-annotation check deferred from scope building.

## Synth mode: `synthType`

`synthType(expr, scope, ctx)` takes an AST node, the current `Scope`, and the checker context, and returns a `VariableType`. Here is how each expression type is handled:

| Expression type | Synthesized type |
|----------------|-----------------|
| `variableName` | Look up in scope. If a flow node is attached to this reference, resolve through `typeAt` so narrowing applies. Returns `ANY_T` if unknown |
| `number` | `number` |
| `string`, `multiLineString` | `string` |
| `boolean` | `boolean` |
| `llm(...)` | `string` (in synth mode; see check mode for the special case) |
| `binOpExpression` | See [Binary operators](#binary-operators) below |
| `functionCall` | The function's declared return type, then its inferred return type (see [Return type inference](#return-type-inference)), or `ANY_T` if unknown |
| `agencyArray` | See [Arrays](#arrays) below |
| `agencyObject` | See [Objects](#objects) below |
| `valueAccess` | See [Value access chains](#value-access-chains) below |
| `tryExpression`, `schemaExpression`, `typeTestExpression`, `hole`, `codeLiteral`, `regex`, `unitLiteral` | Each has its own case in `synthesizer.ts` |
| anything else | `ANY_T` |

### Binary operators

The operator determines the result type:

- **Comparison and logical operators** (`==`, `!=`, `<`, `>`, `<=`, `>=`, `&&`, `||`): always `boolean`
- **`+` operator**: `string` if either operand synthesizes to `string` (string concatenation), otherwise `number`
- **All other arithmetic** (`-`, `*`, `/`, `+=`, `-=`, `*=`, `/=`): always `number`

### Arrays

Array type inference works as follows:

1. Empty array `[]` returns `any[]`, an array type with an `any` element type.
2. If any item is a splat expression (`...x`), bail out and return `ANY_T`. Splat types are not decomposed.
3. Synth each item's type and drop the `any` results.
4. If all concrete types are mutually assignable, checked both directions with `isAssignable`, return an array of that element type. For example, `[1, 2, 3]` returns `number[]`.
5. If types are mixed, as in `[1, "hello"]`, return `ANY_T`.

### Objects

Object type inference synthesizes each entry's value type:

1. If any entry is a splat expression, bail out and return `ANY_T`.
2. If any entry's value synthesizes to `any`, bail out and return `ANY_T`.
3. Otherwise, return an `objectType` with the inferred property types. For example, `{name: "Alice", age: 30}` returns `{name: string, age: number}`.

### Value access chains

`synthValueAccess` walks the access chain step by step, starting from the base expression's synthesized type:

| Chain element | Resolution |
|--------------|-----------|
| `.property` on an `objectType` | Look up the property name; return its type, or `ANY_T` if not found |
| `.length` on an `arrayType` | Return `number` |
| `[index]` on an `arrayType` | Return the element type |
| `.methodCall(...)` | Primitive members resolve through `primitiveMembers.ts`; everything else returns `ANY_T` |
| Any step on an unresolvable type | Return `ANY_T` |

Type aliases are resolved at each step via `resolveType`, so a variable typed as `User` (where `type User = {name: string}`) will correctly resolve `user.name` to `string`.

## Check mode: `checkType`

`checkType(expr, expectedType, scope, context, ctx, fallbackLoc?)` lives in `lib/typeChecker/utils.ts` and verifies that an expression is compatible with an expected type. It works by:

1. If the expression is an `llm(...)` call, reject a `regex` anywhere in the expected type and then **skip** (see [LLM calls](#llm-calls) below).
2. Synth the expression's type.
3. If the synth result is `any`, skip. There is nothing useful to say.
4. Otherwise check assignability through `emitAssignabilityError`, and for an object literal also report excess properties.

Check mode runs in several places, chiefly:
- **Annotated assignments**: `let x: number = someExpr()` checks `someExpr()` against `number`.
- **Return statements**: `return someExpr()` checks `someExpr()` against the function's declared return type.
- Conditions, catch defaults, regex operands, block returns, and the `saveDraft()` draft value.

## Builtin function signatures

Agency has two conceptually distinct categories of function:

- **Built-in functions** are language primitives with no `def` source. Their semantics are hardcoded in the type checker and runtime, and users cannot redefine them. `RESERVED_FUNCTION_NAMES` in `lib/typeChecker/resolveCall.ts` is the list.
- **Stdlib functions** such as `print`, `read`, and `fetch` are ordinary Agency code in `stdlib/`. They reach the checker through the symbol table as `importedFunctions`, exactly like any user import, and users may shadow them.

`BUILTIN_FUNCTION_TYPES` in `lib/typeChecker/builtins.ts` holds typed signatures for the first category only. Stdlib signatures are no longer duplicated there.

The current entries are `llm`, `success`, `failure`, `isSuccess`, `isFailure`, `throw`, `_emit`, `restore`, `approve`, `reject`, `propagate`, `pass`, `checkpoint`, `getCheckpoint`, `fork`, `race`, and `callback`. Two sibling registries cover the rest: `BUILTIN_VARIABLE_TYPES` for names like `__dirname`, and `AGENCY_FUNCTION_METHOD_TYPES` for methods on function values.

A `BuiltinSignature` (`lib/typeChecker/types.ts`) carries more than a parameter list:

- `minParams` makes the trailing parameters optional, otherwise arity is exact.
- `restParam` accepts unlimited extra arguments of one type.
- `acceptsBlock` permits a block argument, which is how `fork` and `race` work.
- `acceptsNamedArgs` is an allowlist of named arguments and their types, so `fork(items, shared: true)` is legal but a typo is not.
- `description` is the one-line markdown shown on LSP hover.

Calls are checked just like user-defined functions for arity and argument types. The signature simply comes from the registry rather than from AST parameter nodes.

Some reserved names never reach `resolveCall` as a `functionCall` at all. `schema`, `interrupt`, `debugger`, `thread`, and `subthread` parse into their own AST node types.

## Type assignability: `isAssignable`

`isAssignable(source, target)` determines whether a value of type `source` can be used where `target` is expected. The rules, checked in order:

1. If either side is `"any"`, return `true` (any is compatible with everything)
2. Resolve type aliases on both sides
3. **Union as target**: source must be assignable to _at least one_ member
4. **Union as source**: _every_ member must be assignable to target
5. **Literal to primitive**: `"hello"` (string literal type) is assignable to `string`, `42` (number literal type) to `number`, etc.
6. **Same-kind matching**: two primitive types match if their values are equal; two literal types match if their values are equal; two array types match if their element types are assignable; two object types use structural matching (source must have all target properties with compatible types)
7. Otherwise, return `false`

### Coinduction: recursive aliases are comparable

Assignability is **coinductive** (issue #470). The private
`isAssignableGuarded` helper keeps an in-progress stack of comparison
pairs, keyed by `typeKey` from `lib/typeChecker/typeKey.ts`. That is the
canonical structural identity, and the union-dedup sites use it too.
Re-encountering a pair already on the stack means the walk is inside the
very comparison that would prove or refute it, so the walk assumes it
holds. This is exactly how `resolveTypeWithGuard`'s `inProgress` set and
TypeScript's relation stack work.

Two details are load-bearing. Entries are removed on exit in a
`try`/`finally`, so a pair refuted in one sibling position is recomputed
in another rather than assumed. And the pair key is only computed when a
named reference (`typeAliasVariable` or `genericType`) is involved. That
is sound because a cycle can only re-enter through a named reference, and
it keeps `typeKey` off the hot path for plain structural comparisons.

This is what makes `type Tree = { children: Tree[] }` comparable to
itself instead of a stack overflow. The public `isAssignable` signature
still takes three arguments.

### The `never` type

`never` is Agency's bottom type, represented as `{ type: "primitiveType", value: "never" }` rather than as its own AST node. That mirrors how `any`, `unknown`, `void`, and `null` are modeled. Its rules:

- **Assignable to every type; nothing is assignable to it except `never` (and `any`).** The "assignable to everything" half is one early rule in `isAssignable` (right after the `any` short-circuit). The converse — what is assignable *to* `never` — is only `never` itself (falls out of same-kind matching, rule 6, since `never`'s value equals only `never`'s) plus `any`, which the universal `any` rule treats as assignable to everything (standard TypeScript behavior).
- **Member access on `never` yields `never`** with no diagnostic (`synthValueAccess`), so a provably-unreachable value never flags spurious missing-member errors.
- `formatType` prints `never`; the type parser accepts `never` as an annotation. Use `isNever` (`assignability.ts`) to test for it.

Several places now produce `never`. `flow.ts` returns it when a union join has no concrete members left, which is a fully-excluded discriminant narrowing. `NonNullable<null>` and `keyof {}` return it from the eager type evaluators. An explicit `: never` annotation still works too.

## Special cases for Agency

### LLM calls

`llm(...)` is the most important special case. An LLM call's output type depends on context. When it is assigned to a variable with a type annotation, the compiler instructs the model to produce structured output matching that type. So:

- In **synth mode**, an `llm()` call synthesizes to `string`. There is no annotation to ask the model for.
- In **check mode**, the call is **skipped**. It is always compatible with the expected type, because the code generator turns that type into a JSON schema for structured output.

So `let result: {name: string} = llm("What is your name?")` passes type checking. Meanwhile `greet(llm("pick a name"))` synthesizes the call as `string` and checks it against `greet`'s parameter type.

There is one check that still fires in check mode. A `regex` is not representable in JSON, so `rejectRegexInLlmType` reports `regexInStructuredOutput` when the expected type contains one anywhere.

### Splat expressions

Splat expressions (`...x`) in arrays and objects cause the type checker to bail out and return `ANY_T`. Tracking what types a splat contributes would require knowing the full type of the splatted expression and decomposing it, which isn't implemented.

### Imported names

An imported Agency function gets a real `functionRefType` built from the signature the `CompilationUnit` resolved for it. A name from a plain JavaScript import, or one the compilation unit could not resolve, falls back to `ANY_T`. See `importedValueType` in `lib/typeChecker/scopes.ts`.

### For loops

For loop variables are inferred from the iterable:

```
let names: string[] = ["Alice", "Bob"]
for (name, i in names) {
  // name is inferred as string, the element type of string[]
  // i is inferred as number
}
```

Over a record or object literal the two variables are the key and the value instead. If the iterable's type is unknown, both variables are `any`.

### `schema(Type)`

`schema(Type)` is a language built-in that bridges *type space* and *value
space*: the parser captures `Type` as a `VariableType` (not a value
expression — see `schemaExpressionParser` in `lib/parsers/parsers.ts`),
and at runtime the resulting `SchemaExpression` AST node compiles to a
zod schema constructed from that type.

The type checker currently synthesizes its result as `"any"` — populating
it with a structured `Schema<T>` type is future work that would let
downstream code see e.g. `Schema<MyType>` and validate `.parse()` /
`.safeParse()` return types.

`schema` is listed in `RESERVED_FUNCTION_NAMES` so users can't define
their own `def schema()` (which would create parse ambiguity).

### Built-in generic types

ALL built-in generics — `Array`, `Schema`, `Record`, and the utility types
`Partial`, `Required`, `Pick`, `Omit`, `NonNullable` — live in one
registry (`lib/typeChecker/builtinGenerics.ts`) and are evaluated EAGERLY
by `resolveTypeWithGuard`: each resolves to a plain type at resolution
time (`Record` alone keeps its `genericType` wrapper for `z.record`
lowering), so no downstream pass knows the forms exist. This is the litmus
test for Agency type features: a type must be eagerly evaluable to a
concrete, JSON-schema-able shape (which is why mapped and conditional
types are permanently out of scope). Adding a built-in generic is one
table entry; `BUILTIN_GENERIC_ARITY` (validate.ts) and
`RESERVED_GENERIC_NAMES` (index.ts) are derived from the table. The five
utility names are reserved; `Array`/`Schema`/`Record` keep their
historical silently-shadowable behavior via the `reserved` flag. Semantic
argument errors throw `TypeError` from the resolver: swallowed by
`safeResolveType` at typecheck time (the annotation degrades to `any`),
fatal at codegen via `resolveTypeDeep`. Located diagnostics for those errors are still a follow-up.

### Type operators: keyof and indexed access

`keyof T` and `T["key"]` are prefix/postfix type operators. Like the
built-in generics, they evaluate EAGERLY in `resolveTypeWithGuard` (see
`lib/typeChecker/typeOperators.ts`, which shares the argument helpers in
`builtinGenerics.ts`), so no downstream pass sees the operator nodes.
`keyof` yields a closed literal union, which plugs straight into match
exhaustiveness and discriminant narrowing. The `keyof` keyword is in
`RESERVED_TYPE_NAMES`.

`A & B` joins the family: `evalIntersection` merges object types in a
group-combine-build pipeline (all operands grouped by key at once, so
n-ary merging is associative by construction), with shared keys
intersecting recursively and both sides' `@validate` chains applying.
Operands are object-only. One deliberate TypeScript divergence:
`A & never` ERRORS here rather than absorbing to `never` — a silently
never-typed schema would be a debugging trap in a schema-producing
language. Structural equality for shared keys is INJECTED into the
evaluator (a `typeKey`-based comparator built on the real alias table)
so `typeOperators.ts` keeps its no-assignability-import cycle rule.

## Type narrowing

Flow-sensitive narrowing and exhaustiveness checking have their own subtree:
**[`narrowing/`](./narrowing/)**. That is where the `analyzeCondition` fact engine,
Result / discriminated-union narrowing, post-guard narrowing, the in-progress
flow-typed model, and a capabilities/limitations matrix are documented. It is
broken out because it is the fastest-growing part of the checker.

See [`narrowing/README.md`](./narrowing/README.md) for the current implementation
and the planned architecture.

## Diagnostics

Every diagnostic the checker emits comes from one registry: `DIAGNOSTICS` in
`lib/typeChecker/diagnostics.ts`. The registry owns the stable `AG####` code,
the default severity, and the message template. The `diagnostic(name, params, loc)`
factory renders one into a `TypeCheckError`. Nothing hand-builds an error object.
A config-driven site may pass a `severity` override, which is how the
`silent`/`warn`/`error` knobs work.

Most diagnostics live in their own module, invoked once from `TypeChecker.check()`
after scopes are built and the core synth/check passes have run. This keeps the
core synth/check code focused on type correctness, lets each diagnostic be
enabled, disabled, and tested as a unit, and makes it cheap to add a new one.

### Existing diagnostic passes

| Module | Public function | Purpose |
|---|---|---|
| `interruptAnalysis.ts` | `checkUnhandledInterruptWarnings` | Warn when a function calls something that may throw an interrupt outside a handler. |
| `interruptAnalysis.ts` | `checkCallbackBodyInterrupts` | Reject `interrupt` inside a callback body. A callback fires as a side effect and cannot pause execution. |
| `finalizeChecks.ts` | `checkFinalizeBlocks` | Validate `finalize` blocks. |
| `functionTypeRaises.ts` | `checkAllRaises` | Verify a declared `raises` clause is not exceeded by the inferred effect set. |
| `effectPayloadCheck.ts` | `checkEffectPayloads` | Check interrupt payloads against their `effect` declarations. |
| `matchExhaustiveness.ts` | `checkMatchExhaustiveness` | Match exhaustiveness over closed value types. |
| `definiteReturns.ts` | `checkDefiniteReturns` | A function with a non-void return type must return on every path. |
| `conflictingMarkers.ts` | `checkConflictingMarkers` | A function cannot be both `destructive` and `idempotent`. |
| `paramDefaultOrder.ts` | `checkParamDefaultOrder` | Defaulted parameters must come last. |
| `templateHoles.ts` | `checkTemplateHoles` | An expression hole in an untyped position needs an inline annotation (AG8002). |
| `templateNames.ts` | `checkTemplateNames` | A template may only use names it declares or imports (AG8015). |
| `topLevelStatements.ts` | `checkTopLevelStatements` | Top-level code initializes; it does not control (AG3017, AG3018). |
| `undefinedFunctionDiagnostic.ts` | `checkUndefinedFunctions` | A call that resolves to nothing known. Severity from `typechecker.undefinedFunctions`. |
| `missingImportDiagnostic.ts` | `checkMissingImports` | A plain import that does not resolve to a real export. |
| `undefinedVariableDiagnostic.ts` | `checkUndefinedVariables` | A variable reference that resolves to nothing. Severity from `typechecker.undefinedVariables`. |
| `toolBlockBinding.ts` | `checkToolBlockBindings` | At each `llm(...)` with a known tools array, require every function-typed parameter to be bound. |
| `validateStaticInit.ts` | `validateStaticInit` | Validate static initializers and `static <bare>` statements. |

All modules are under `lib/typeChecker/`.

### Suppression

`lib/typeChecker/suppression.ts` reads two source directives. `// @tc-nocheck` in
the file's leading directive region silences every diagnostic in the file.
`// @tc-ignore` on the line before a diagnostic silences it. A bare `@tc-ignore`
suppresses everything on that line; naming codes (`// @tc-ignore AG2001`)
suppresses only those. A malformed code fails closed and suppresses nothing.

### Adding a new diagnostic

Follow the existing module shape:

1. Add an entry to `DIAGNOSTICS` with a fresh `AG####` code, a default severity, and a message template.
2. One module under `lib/typeChecker/`.
3. One public function taking `(scopes: ScopeInfo[], ctx: TypeCheckerContext): void`.
4. Walk the AST with `walkNodes` from `lib/utils/node.ts`.
5. Build errors with `diagnostic()` and push them to `ctx.errors`.
6. Add one call from `TypeChecker.check()` after the existing diagnostic calls.
7. Add a config knob under `typechecker.<name>` if the diagnostic should be opt-in or opt-out.

Keep the public surface narrow at one function, keep lookup data in a separate
pure module so it can be reused, and do not reach into `checker.ts` or
`synthesizer.ts` from the diagnostic. They have a different job.

### Resolving call sites

`lib/typeChecker/resolveCall.ts` exports `resolveCall(name, input)` and
`lookupJsMember(path)`, pure functions answering "what does this call site refer
to?" `resolveCall` returns a tagged union of `def | imported | jsImported |
builtin | scopeBinding | jsGlobal | unresolved`. The undefined-function
diagnostic uses these, and any future analysis asking the same question should
use them too.

## Return type inference

Functions and graph nodes without an explicit return type annotation have their return types inferred from `return` statements. This happens in the `inferReturnTypes()` phase, before scopes are checked, so that call sites get proper type checking.

For each function/node without a `returnType`, the inference works as follows:

1. Build the scope's variable types (parameters + body assignments)
2. Collect all `return` statements from the body, skipping returns inside nested function/node definitions
3. Synth the type of each return value
4. Apply these rules:

| Situation | Inferred type |
|-----------|--------------|
| No return statements | `void` |
| Any return value synths to `"any"` | `"any"` (conservative — avoids cascading false errors) |
| All return values have the same type | That type |
| Return values have different types | `"any"` (could be union in the future) |

**Recursion guard**: If function A calls function B which calls function A, the inference detects the cycle via an `inferringReturnType` set and returns `"any"` for the recursive call, preventing infinite loops.

**Explicit annotations take precedence**: If a function has a declared `returnType`, inference is skipped entirely and the declared type is used.

## When the type checker runs

There are three ways the type checker gets triggered:

### 1. Standalone command: `agency typecheck`

Run directly via the CLI:

```bash
pnpm run agency typecheck myfile.agency
pnpm run agency typecheck --strict myfile.agency
```

`tc` and `check` are aliases. With no input the command reads from stdin.

`--strict` here sets `typechecker.strictTypes` only, so variables without type annotations become errors. It deliberately does NOT set `typechecker.strict`. This command calls the checker unconditionally and computes its own exit code, so `typechecker.strict` would be inert, and an inert setting that looks meaningful is a trap. `--strict` on `run` and `compile` means both flags. See `applyCliFlags` in `lib/config.ts`.

If any errors are found, the process exits with code 1.

### 2. Compile/run pipeline via config

Add to your `agency.json`:

```json
{
  "typechecker": { "enabled": true }
}
```

With `typechecker.enabled: true`, type errors are printed as **warnings** during compilation (and by extension during `run`, since `run` calls `compile`). Compilation continues and the output file is still generated. This is useful during development when you want to see type issues without blocking your workflow.

```json
{
  "typechecker": { "strict": true }
}
```

With `typechecker.strict: true`, type errors are **fatal**. They print to stderr, and the process exits with code 1 as soon as any diagnostic has `severity: "error"`. A strict run that produces only warnings still continues. This is useful for CI or for catching errors before deployment.

`runTypecheck` in `lib/compiler/buildSession.ts` reads both flags. It runs after parsing and before code generation, so a fatal error means no output file. Either flag turns the checker on.

### 3. Programmatic API

You can call the type checker directly from TypeScript:

```typescript
import { typeCheck, formatErrors, formatDiagnosticsHint } from "./lib/typeChecker/index.js";

const result = typeCheck(parsedProgram, config, compilationUnit);
if (result.errors.length > 0) {
  console.error(formatErrors(result.errors));
  const hint = formatDiagnosticsHint(result.errors);
  if (hint) console.error(hint);
}
```

`typeCheck` returns a `TypeCheckResult`: the `errors`, the built `scopes`, the
`interruptEffectsByFunction` map, the `interruptCallGraph` that `agency
interrupts` renders, and the `flowEnv` flow graph. Passing the `CompilationUnit`
is optional; without it the checker builds one from the program.

## Error messages

Each error is a `TypeCheckError` (`lib/typeChecker/types.ts`):

```typescript
type TypeCheckError = {
  code: string;            // stable AG#### code from the registry
  name: DiagnosticName;    // the registry key, the programmatic identity
  message: string;         // the rendered template
  severity: "error" | "warning";
  params: Record<string, string | number>;  // the structured payload
  loc: SourceLocation | null;               // null = deliberate file-level diagnostic
  file?: string;           // stamped once in TypeChecker.check()
};
```

`formatErrors` renders errors for the terminal. Each line is the file position,
then the severity in color, then the code, then the message:

```
greet.agency:4:11 - error AG2001: Type 'string' is not assignable to type 'number' (assignment to 'response').
greet.agency:9:3 - error AG6016: Expected 2 argument(s) for 'write', but got 1.
```

Line and column are 1-indexed for display, while `loc` stores them 0-indexed.
See [`../locations.md`](../locations.md). If a diagnostic came from generated
code, `formatErrors` appends the generator's name, for example
`(in code generated by \`makeHandlers\`)`.

`formatDiagnosticsHint` returns one extra line naming the first error-severity
code, so a reader knows to run `agency explain AG2001`. It is deliberately kept
out of `formatErrors` so programmatic consumers are untouched.

Message shapes come from the registry, not from the call sites. A few examples:

| Registry name | Message |
|---|---|
| `typeNotAssignableInContext` | `Type '{actual}' is not assignable to type '{expected}' ({context}).` |
| `conditionNotBoolean` | `Type '{actual}' is not assignable to type 'boolean' (condition).` |
| `unknownProperty` | `Unknown property '{key}' on type '{expected}' ({context}).` |
| `reassignToConst` | `Cannot reassign to constant '{name}'.` |
| `callArityExact` | `Expected {expected} argument(s) for '{fn}', but got {count}.` |
| `missingAnnotationStrictMode` | `Variable '{name}' has no type annotation (strict mode).` |
| `regexInStructuredOutput` | `'regex' cannot appear in an llm() structured-output type ({context}).` |

Type names in messages are formatted by `formatTypeHint` from
`lib/utils/formatType.ts`, which renders types in Agency syntax such as
`number`, `string[]`, and `{name: string}`.
