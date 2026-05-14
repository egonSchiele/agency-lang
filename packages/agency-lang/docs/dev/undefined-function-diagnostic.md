# Undefined Function Diagnostic

Warns when Agency code calls a function that doesn't exist. Recognizes a curated set of JavaScript globals (`parseInt`, `JSON.parse`, `Math.floor`, etc.) so genuine JS interop doesn't false-positive.

## Configuration

Controlled by `typechecker.undefinedFunctions` in `agency.json`:

| Value | Behavior |
|-------|----------|
| `"silent"` (default) | No diagnostic emitted |
| `"warn"` | Push as `severity: "warning"` |
| `"error"` | Push as `severity: "error"` (fatal under `typechecker.strict`) |

Default is `"silent"` for the initial landing. A follow-up will flip the
default to `"warn"` once any false positives in internal test code are
cleaned up.

## Implementation

The diagnostic is a self-contained module — it does NOT modify
`checker.ts` or `synthesizer.ts`. See the [Diagnostics
section](./typechecker.md#diagnostics) of the typechecker doc for the
overall pattern.

| File | Responsibility |
|------|----------------|
| [`lib/typeChecker/undefinedFunctionDiagnostic.ts`](../../lib/typeChecker/undefinedFunctionDiagnostic.ts) | The walker. Public function `checkUndefinedFunctions(scopes, ctx)`. Walks every scope's body once, handling `functionCall` nodes (bare names) and `valueAccess` nodes (namespace member chains). |
| [`lib/typeChecker/resolveCall.ts`](../../lib/typeChecker/resolveCall.ts) | **Pure** lookup data. Exposes `resolveCall()`, `lookupJsMember()`, the `JS_GLOBALS` registry, and `RESERVED_FUNCTION_NAMES`. No `ctx`, no side effects — just data and predicates. |

`TypeChecker.check()` invokes `checkUndefinedFunctions(scopes, ctx)` once,
alongside the existing `checkUnhandledInterruptWarnings` call.

### How resolution works

For a bare `functionCall`, `resolveCall` checks in order:

1. Local `def` or `node` definition
2. Imported function (cross-file)
3. Builtin (`BUILTIN_FUNCTION_TYPES`)
4. Reserved name (`RESERVED_FUNCTION_NAMES`)
5. Variable in scope (lambda, partial, etc.)
6. Flat callable JS global (`parseInt`, `setTimeout`, …)

If none match, the diagnostic emits.

For a `valueAccess` like `JSON.parse(...)`, the diagnostic only fires
when the chain's base is a `variableName`, the base is not in scope or
in any function/import map, and the base name appears in the JS namespace
registry. `lookupJsMember` walks the chain through `JS_GLOBALS`; if the
member isn't found, the diagnostic emits with the full dotted path
(`Function 'JSON.banana' is not defined.`).

Computed/optional/index access bails out — the typechecker handles those.

### `JS_GLOBALS` registry shape

`JS_GLOBALS` is a tagged-union tree of callables and namespaces:

```ts
export type JsRegistryEntry =
  | { kind: "callable"; sig?: BuiltinSignature }
  | { kind: "namespace"; members: Record<string, JsRegistryEntry> };
```

**Phase 1 (this implementation)** uses only structural existence — walk
the tree, verify the chain resolves, ignore `sig`. **Phase 2 (a
follow-up)** will start populating `sig` for entries we want
type-checked; the typechecker can then enforce arity/types when `sig` is
present. Pure addition; no breaking changes.

`BuiltinSignature` is reused (rather than introducing a parallel
JS-specific shape) so any future improvements to it benefit both Agency
builtins and JS globals.

## Follow-ups

1. **Flip the default from `"silent"` to `"warn"`** once any internal
   test agency files producing false positives are cleaned up.
2. **Populate `sig` on `JS_GLOBALS`** for high-traffic entries
   (`JSON.parse`, `JSON.stringify`, `Math.floor`, `parseInt`, …) so the
   typechecker can enforce arity/types on JS calls too.
3. **Symmetric undefined-variable diagnostic** for non-call references
   (e.g., `let x = doesNotExist`). A separate analysis on
   `variableName` lookups against scope.
4. **Higher-order callback safety** — a name passed by reference to
   `map(items, doesNotExist)` is a `variableName` argument, not a
   `functionCall`. Belongs with the undefined-variable work above.
