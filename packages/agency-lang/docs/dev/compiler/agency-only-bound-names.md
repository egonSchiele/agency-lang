# Bound names under `--agency-only`

Agency compiles to JavaScript, and an identifier the compiler does not know
is emitted verbatim. So before this check, pure Agency code under
`--agency-only` could name any JavaScript global — `process`, `fetch`,
`eval`, `new Function` — and reach the host with no interrupt. This check
refuses those names at compile time.

It is **defense in depth and clearer errors, not the security boundary.** A
runtime-computed property key (`m[a + b]`) defeats any syntactic check, so
the real backstop for reaching `Function` and calling it with a string is
disabling code generation from strings (roadmap A1 layer 2). The whole arc
and its layers are in `docs/dev/security/roadmap.md` (item A1) and
`docs/dev/security/goal.md`.

## What it does

When `typechecker.jsGlobals` is `"sandbox"` (set by `--agency-only` in
`compileValidatedClosure.ts`, alongside `undefinedFunctions`/
`undefinedVariables: "error"`), an unqualified name must resolve to an
Agency declaration, an import, a builtin, or the reviewed allowlist
`SANDBOX_JS_GLOBALS`. Anything else is a compile error.

`SANDBOX_JS_GLOBALS` (`lib/typeChecker/resolveCall.ts`) is a **separate,
reviewed** allowlist, not a filter over the interop registry `JS_GLOBALS`.
Writing it out in full means a name added to `JS_GLOBALS` for interop never
silently becomes allowed in the sandbox. It is not a subset: it adds
constructor names (`Set`, `Map`, `RegExp`, `Intl`) that `new X()` resolves
against but `JS_GLOBALS` never listed. An entry here is a promise the name
cannot reach the host — review every addition against that.

## The rule is shared; the positions differ

Name resolution goes through the same `resolveCall` / `resolveVariable`
(now registry-parametric, defaulting to `JS_GLOBALS` so non-sandbox
behaviour is byte-identical). Four positions have to be checked, and they
are covered by two walks that share that one rule:

1. **Bare names, calls, namespace members, value-access bases** — the two
   general passes (`undefinedFunctionDiagnostic`, `undefinedVariableDiagnostic`)
   already walk scope bodies for these. Under the sandbox they select
   `SANDBOX_JS_GLOBALS` and emit at error severity. `process.env.HOME` is
   caught here via its base `process`.
2. **`new` callees** (`new Function`/`Proxy`/`WebSocket`) — `checkSandboxNames`
   (`lib/typeChecker/sandboxNameCheck.ts`). Sound and complete: the class
   name is a grammar literal (no `new (x + y)()`), so the registry lookup
   settles it. This is the layer that closes `new Proxy`/`new WebSocket`,
   which the code-generation-from-strings flag does not.
3. **The `constructor`/`prototype`/`__proto__` walk** — `checkSandboxNames`,
   AG4011. Best-effort: spelled or string-literal-computed keys only; a
   runtime-computed key gets through and is layer 2's job. The three names
   are in a named constant `SANDBOX_FORBIDDEN_PROPERTIES`.
4. **Declaration-hanging expressions** — `@validate`/`@jsonSchema` tag
   arguments and non-scalar default parameter values (arrays, objects, and
   interpolated strings like `"${process.env.HOME}"`). These sit outside the
   scope bodies the general passes walk, so `checkSandboxNames` finds them
   with `collectDeclHangingExpressions` and checks every name inside. Each
   carries the scope where it hangs: module-level bindings plus the owning
   declaration's value parameters (type alias) or parameters (function/node),
   so a top-level `const` or a value parameter used in a tag argument
   resolves rather than being falsely refused. Tags are paired with their
   owner via `tagsAbove`, because at type-check time the preprocessor has not
   attached them yet (they are standalone nodes before the declaration).

## Coverage equals the traversal's reach

The completeness of this check is exactly the set of positions the walks
reach. `walkNodes` is a hand-written descent that has been caught missing
positions before, which is why the arc found five escapes by hand (bare
identifiers, `new` callees, the constructor walk, tag arguments, default
values). Two design choices bound that risk:

- **Positions 1–3** ride `walkNodes`, so a future AST node with an
  expression slot `walkNodes` descends into is covered automatically.
- **Position 4** does NOT use a `walkNodes` flag. Tags can hang on a type
  property, which `walkNodes` does not reach at all, so
  `collectDeclHangingExpressions` is a structural walk that finds every
  `.tags` array and array/object `defaultValue` wherever it hangs — more
  complete than a `walkNodes` extension would be. Each collected expression
  is then descended with `walkNodes`, so the traversal of the expression
  itself is still shared, not reimplemented.

If a new capability position turns up, the fix is to feed it to the same
resolver, not to write a second rule. The security guarantee still does not
rest here — it rests on layer 2 and, ultimately, on removing ambient
authority (roadmap).

## Note on a pre-existing gap

Template hygiene (AG8015) rides the same body walk and is likely blind to
default parameter values too. That is a separate, pre-existing gap, noted
here because a fix to either should consider both.

## Files

- `lib/typeChecker/resolveCall.ts` — `SANDBOX_JS_GLOBALS`, registry-param on
  `resolveCall`/`lookupJsMember`/`isJsGlobalBase`.
- `lib/typeChecker/resolveVariable.ts` — registry-param.
- `lib/typeChecker/undefinedFunctionDiagnostic.ts`,
  `undefinedVariableDiagnostic.ts` — registry + error severity under sandbox.
- `lib/typeChecker/sandboxNameCheck.ts` — new-callee, forbidden-property, and
  declaration-hanging-expression checks.
- `lib/compiler/compileValidatedClosure.ts` — sets `jsGlobals: "sandbox"`.
- Tests: `lib/typeChecker/sandboxRegistry.test.ts`,
  `lib/compiler/compileSandboxed.test.ts` (bound-names describe),
  `tests/agency-js/test-cli-agency-only`.
