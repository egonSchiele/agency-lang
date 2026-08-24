# Undefined Function Diagnostic

Warns when Agency code calls a function that doesn't exist. Recognizes a curated set of JavaScript globals (`parseInt`, `JSON.parse`, `Math.floor`, etc.) so genuine JS interop doesn't false-positive.

## Configuration

Controlled by `typechecker.undefinedFunctions` in `agency.json`:

| Value | Behavior |
|-------|----------|
| `"silent"` | No diagnostic emitted |
| `"warn"` (default) | Push as `severity: "warning"` |
| `"error"` | Push as `severity: "error"` (fatal under `typechecker.strict`) |

The default is `"warn"`. The registries the check consults are accurate
enough now that false positives are rare, so users who still hit one opt
back out with `{ typechecker: { undefinedFunctions: "silent" } }`.

## Implementation

The diagnostic is a self-contained module — it does NOT modify
`checker.ts` or `synthesizer.ts`. See the [Diagnostics
section](./typechecker/README.md#diagnostics) of the typechecker doc for the
overall pattern.

| File | Responsibility |
|------|----------------|
| [`lib/typeChecker/undefinedFunctionDiagnostic.ts`](../../../lib/typeChecker/undefinedFunctionDiagnostic.ts) | The walker. Public function `checkUndefinedFunctions(scopes, ctx)`. Walks every scope's body once, handling `functionCall` nodes (bare names) and `valueAccess` nodes (namespace member chains). |
| [`lib/typeChecker/resolveCall.ts`](../../../lib/typeChecker/resolveCall.ts) | **Pure** lookup data. Exposes `resolveCall()`, `lookupJsMember()`, `isJsGlobalBase()`, the `JS_GLOBALS` registry, and `RESERVED_FUNCTION_NAMES`. No `ctx`, no side effects — just data and predicates. |

`TypeChecker.check()` invokes `checkUndefinedFunctions(scopes, ctx)` once,
alongside `checkUnhandledInterruptWarnings` and the sibling
`checkUndefinedVariables`.

### How resolution works

For a bare `functionCall`, `resolveCall` checks in order:

1. Local `def` or `node` definition
2. Imported function or node from another file (this is also how stdlib names such as `print` resolve, via the auto-injected `std::index` import)
3. JS-imported name (`import { foo } from "./helpers.js"`)
4. Builtin (`BUILTIN_FUNCTION_TYPES`)
5. Variable in scope (lambda, partial, `for` variable, etc.)
6. Callable JS global (`parseInt`, `setTimeout`, …), including namespaces that are themselves callable such as `String`

If none match, the diagnostic emits.

`RESERVED_FUNCTION_NAMES` is not part of that order. The typechecker uses it
earlier, in `lib/typeChecker/index.ts`, to refuse user definitions that would
shadow a reserved name.

For a `valueAccess` like `JSON.parse(...)`, the diagnostic only fires
when the chain's base is a `variableName` and `isJsGlobalBase` says that
name is a JS global that nothing user-defined shadows. `lookupJsMember`
walks the chain through `JS_GLOBALS`; if the member isn't found, the
diagnostic emits with the full dotted path
(`Function 'JSON.banana' is not defined.`).

Computed/optional/index access bails out — the typechecker handles those.

Two contexts get special treatment. A file containing holes is a template,
and AG8015 already owns bare call names there, so the bare-call check skips
it. The namespace-chain check keeps running, because AG8015 treats `nosuch`
in `Math.nosuch()` as a method rather than a lexical name. Separately, the
block keywords `thread` and `subthread` get a tailored message when the
parser falls back to the generic call form, instead of the confusing
"Function 'thread' is not defined."

### `JS_GLOBALS` registry shape

`JS_GLOBALS` is a tagged-union tree of callables and namespaces:

```ts
export type JsRegistryEntry =
  | { kind: "callable"; sig?: BuiltinSignature }
  | { kind: "namespace"; members: Record<string, JsRegistryEntry>; callableSig?: BuiltinSignature };
```

Existence checking only needs the tree structure. Many entries now also
carry a `sig`, and `lib/typeChecker/checker.ts` validates argument counts
and types against it for both flat globals and namespace members. Entries
without a `sig` are still existence-checked only.

`BuiltinSignature` is reused (rather than introducing a parallel
JS-specific shape) so any future improvements to it benefit both Agency
builtins and JS globals.

## Related

A sibling pass, `checkUndefinedVariables` in
[`lib/typeChecker/undefinedVariableDiagnostic.ts`](../../../lib/typeChecker/undefinedVariableDiagnostic.ts),
does the same for non-call references such as `let x = doesNotExist`. It is
controlled by `typechecker.undefinedVariables` and still defaults to
`"silent"`. It resolves through `resolveVariable.ts` rather than
`resolveCall.ts`, and it is the pass that covers a name passed by reference,
as in `map(items, doesNotExist)`.
