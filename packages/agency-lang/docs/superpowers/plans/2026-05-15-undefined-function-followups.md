# Follow-ups for the undefined-function diagnostic

> **Context:** This document is the hand-off after [PR #143](https://github.com/egonSchiele/agency-lang/pull/143) — the initial undefined-function diagnostic, JS globals registry, and `typechecker` config consolidation. The diagnostic ships at default `"silent"`. These follow-ups complete the picture.
>
> **Dependencies matter.** Several items below have ordering constraints; do them in roughly the order presented unless noted.

## Quick orientation

Read these first:

- [`docs/dev/typechecker.md`](../dev/typechecker.md) — bidirectional type checking + the new "Diagnostics" section.
- [`docs/dev/undefined-function-diagnostic.md`](../dev/undefined-function-diagnostic.md) — the diagnostic's architecture.
- [`lib/typeChecker/resolveCall.ts`](../../lib/typeChecker/resolveCall.ts) — pure registries (`JS_GLOBALS`, `RESERVED_FUNCTION_NAMES`) and the `resolveCall` / `lookupJsMember` helpers. The big block comment on `CallResolution` and the resolution-order comment above `resolveCall` explain the registries and how they interact.
- [`lib/typeChecker/builtins.ts`](../../lib/typeChecker/builtins.ts) — `BUILTIN_FUNCTION_TYPES` (a mix of language primitives + hardcoded stdlib signatures; see the `NOTE` in the file).

---

## Task 1 — Block `let`/`const` of reserved or built-in names

**Why:** Today `RESERVED_FUNCTION_NAMES` only blocks `def`/`node` redeclarations. A user can write `static const schema = 42` and it's accepted. The variable is then unusable as a function (`schema(Foo)` always parses as a `SchemaExpression` regardless of scope), so allowing it is a footgun — verified in the PR conversation.

**Scope question (resolve before implementing):** the user requested blocking "reserved OR built-in" names. Two interpretations:

- **(A) Reserved only.** Blocks `let schema`, `let interrupt`, `let debugger`, plus the names also in `BUILTIN_FUNCTION_TYPES` (the language primitives like `success`, `failure`, `approve`, etc.). Breaks no current code.
- **(B) Reserved + everything in `BUILTIN_FUNCTION_TYPES`.** Also blocks `let print`, `let fetch`, etc. **Breaks stdlib shadowing** — currently users can `def print() { ... }` and `let print = ...`. A backwards-incompatible change to userland code.

Recommend (A) for this task; (B) becomes natural after Task 3 (stdlib moves out of `BUILTIN_FUNCTION_TYPES`).

**Where:**

- Extend the loop at [`lib/typeChecker/index.ts:155-160`](../../lib/typeChecker/index.ts#L155-L160) to also walk top-level `assignment` nodes in `ctx.programNodes` and check `RESERVED_FUNCTION_NAMES.has(node.variableName)`.
- Decide whether to also walk per-scope assignments (inside `def`/`node` bodies). Probably yes for consistency; pull from `scopes` in `buildScopes`.
- Use `Object.prototype.hasOwnProperty.call` everywhere — see PR #143 fix for why `in` is unsafe.

**Tests:**

- `static const schema = 42` is now an error.
- `static const schemaForX = 42` is fine (substring match must NOT fire).
- `let interrupt = 5` inside a node body is an error.
- `def schema()` still errors (existing behavior unchanged).

---

## Task 2 — Move stdlib signatures out of `BUILTIN_FUNCTION_TYPES`

**Why:** This is existing tech debt flagged by the `NOTE` comment at [`builtins.ts:62-71`](../../lib/typeChecker/builtins.ts#L62-L71). Stdlib functions like `print`, `fetch`, `read`, `range`, `keys`, `values`, `entries`, `mostCommon`, `notify`, `sleep`, `round`, `printJSON`, `input`, `readImage`, `write`, `fetchJSON`, `emit` are defined as real Agency code in [`stdlib/index.agency`](../../stdlib/index.agency) but have hardcoded signatures in `BUILTIN_FUNCTION_TYPES` for typechecker convenience. Their signatures should come from the `SymbolTable` via `importedFunctions` instead.

**Why before Tasks 3–5:** Cleaning this up first means downstream tasks (signature lookups, hover, blocking declarations) only have to think about *true* built-ins.

**Where:**

- `SymbolTable` already resolves stdlib imports — see [`lib/symbolTable.ts`](../../lib/symbolTable.ts). The challenge is exposing typed parameter info (with parameter types) on `ImportedFunctionSignature` in the shape the typechecker's `checkSingleFunctionCall` already consumes (mirror what's done for non-stdlib imports today).
- Once stdlib signatures resolve through `importedFunctions`, the corresponding entries in `BUILTIN_FUNCTION_TYPES` can be deleted.
- `BUILTIN_FUNCTION_TYPES` after this change keeps only true language primitives: `success`, `failure`, `isSuccess`, `isFailure`, `restore`, `llm`, `approve`, `reject`, `propagate`, `checkpoint`, `getCheckpoint`. (Keep `llm` here — it's a primitive, not stdlib.)

**Tests:**

- Existing typechecker tests for stdlib calls (`print(123, "hi")`, `read("/tmp/x")`, etc.) still pass.
- Shadowing: `def print(x: number): void { ... }` is accepted and the user definition takes precedence over the stdlib one.

---

## Task 3 — Populate `sig` on `JS_GLOBALS` entries

**Why:** Today every `JS_GLOBALS` entry is a bare `callable()` with no signature. This means `JSON.parse(1, 2, 3, 4)` doesn't get an arity error and `Math.floor("hi")` doesn't get a type error. The registry shape already supports `sig?: BuiltinSignature` for exactly this reason — see [`resolveCall.ts:JsRegistryEntry`](../../lib/typeChecker/resolveCall.ts).

**Where:**

- `lib/typeChecker/resolveCall.ts` — populate `sig` on entries we want enforced. Start with high-traffic ones: `JSON.parse`, `JSON.stringify`, `Math.floor`, `Math.ceil`, `Math.round`, `Math.abs`, `Math.max`, `Math.min`, `Math.random`, `Math.sqrt`, `parseInt`, `parseFloat`, `Number.isInteger`, `Array.isArray`, `Object.keys`, `Object.values`, `Object.entries`, `Date.now`.
- The diagnostic and typechecker need a code path that consults `lookupJsMember(...)`, sees the resulting entry is `kind: "callable"` with a populated `sig`, and runs the existing `checkArity` / `checkArgsAgainstParams` logic against it. Today only `BUILTIN_FUNCTION_TYPES` flows through this path — extend it to JS globals as a parallel branch in `checker.ts:checkSingleFunctionCall` (mirror the `BUILTIN_FUNCTION_TYPES` branch).
- Pure addition: entries without a `sig` keep the Phase 1 existence-only behavior.

**Tests:**

- `JSON.parse("{}")` — no arity error.
- `JSON.parse()` — arity error (expects 1 arg).
- `Math.floor("not a number")` — type error.
- `console.log(1, 2, 3)` — no error (variadic / no `sig`).

---

## Task 4 — LSP: signature help / hover for built-ins and JS globals

**Why:** Once Tasks 2 and 3 are done, the typechecker has typed signatures for true built-ins, stdlib functions (via imports), and the most common JS globals. The LSP currently doesn't surface any of this on hover.

**Where:**

- LSP hover lives at [`lib/lsp/hover.ts`](../../lib/lsp/hover.ts). Today it hovers types for variables; needs new logic when the cursor is on a `functionCall.functionName` or a `valueAccess` member.
- Reuse `resolveCall` + `lookupJsMember` to identify what the cursor is pointing at.
- Format using existing `formatTypeHint` from [`lib/utils/formatType.ts`](../../lib/utils/formatType.ts).
- Consider also adding to [`lib/lsp/completion.ts`](../../lib/lsp/completion.ts) — when a user types `JSON.`, suggest the members from `JS_GLOBALS.JSON.members`.

**Tests:**

- LSP tests live in `lib/lsp/*.test.ts`. Add hover tests for `print`, `JSON.parse`, `Math.floor`, `success`, `approve`.

---

## Task 5 — Flip `typechecker.undefinedFunctions` default from `"silent"` to `"warn"`

**Why:** The diagnostic shipped silent so the initial PR wouldn't break any internal tests. Once the registries are accurate (Tasks 2 + 3), it's safe to default to warn.

**Where:**

- [`lib/typeChecker/undefinedFunctionDiagnostic.ts`](../../lib/typeChecker/undefinedFunctionDiagnostic.ts) — change `?? "silent"` to `?? "warn"`.
- Run `pnpm test:run` and `pnpm run agency test tests/agency` to surface any false positives. Likely candidates: tests that intentionally call missing functions, tests that use JS globals not yet in `JS_GLOBALS`.
- For each false positive: either add the missing entry to `JS_GLOBALS`, or add a `# typecheck-ignore` comment, or fix the test program.

**Tests:**

- `lib/typeChecker/undefinedFunctionDiagnostic.test.ts` — update the `"silent" (default)` test to expect `"warn"` behavior.
- Make sure no agency test files regress.

---

## Task 6 — Synth a structured `Schema<T>` type for `schemaExpression`

**Why:** Today `synthType(schemaExpression)` returns `"any"` (see the comment at [`synthesizer.ts:117`](../../lib/typeChecker/synthesizer.ts#L117-L132)). This means `.parse()` / `.safeParse()` calls on a schema lose all type info. A structured `Schema<T>` would let the typechecker validate that `schema(MyType).parse(x)` returns `MyType` (or a Result wrapping `MyType`).

**Where:**

- Add `Schema` to the type system — likely a new variant `{ type: "schemaType", inner: VariableType }` in [`lib/types/typeSystem.ts`](../../lib/types/typeSystem.ts) or wherever `VariableType` is defined.
- Update `synthType` for `schemaExpression` to return `{ type: "schemaType", inner: expr.typeArg }`.
- Update `synthValueAccess` to recognize `.parse(...)` and `.safeParse(...)` on a `schemaType` and return the appropriate type.
- Pretty-print in `formatTypeHint`.

**Tests:**

- `let s = schema(MyType); let x = s.parse(input)` — `x` should synth as `MyType`.
- `let r = s.safeParse(input)` — `r` should synth as `Result<MyType, any>` (Zod's actual return shape is `{ success: true, data: T } | { success: false, error: ... }`; matching that exactly may need more work).

---

## Task 7 — Symmetric undefined-variable diagnostic

**Why:** This PR catches `undefinedFunc()` but not `let x = undefinedVar`. They're the same kind of bug — a name reference that doesn't resolve to anything — and the same `resolveCall` / `lookupJsMember` infrastructure can power it.

**Where:**

- New module: `lib/typeChecker/undefinedVariableDiagnostic.ts`. Same shape as `undefinedFunctionDiagnostic.ts`: one public function `checkUndefinedVariables(scopes, ctx)`, walks AST with `walkNodes`, fires on `variableName` nodes whose `value` doesn't resolve.
- Need a parallel pure helper `resolveVariable(name, input)` in `resolveCall.ts` (or a new `resolveVariable.ts`) — same registries as `resolveCall` but the rules differ slightly (e.g., a function reference is OK as a variable name).
- Add `typechecker.undefinedVariables: "silent" | "warn" | "error"` to [`lib/config.ts`](../../lib/config.ts), default `"silent"` for the initial landing.
- Wire one call into `TypeChecker.check()`, alongside `checkUndefinedFunctions`.

**Tests:**

- `let x = doesNotExist` — emits diagnostic.
- `let x = myDef` (function reference) — does NOT emit.
- `for item in someArray` where `someArray` is undefined — emits.
- Respects the same `silent` / `warn` / `error` modes.

---

## Task 8 — Higher-order callback safety

**Why:** Today `map(items, doesNotExist)` slips through. The undefined name appears as a `variableName` argument, not a `functionCall`, so neither this PR's diagnostic nor a plain undefined-variable check (Task 7) is quite right — we want to know the name should resolve to something *callable*.

**Where:**

- Probably belongs in or right after Task 7. Walk arguments of `functionCall` and `methodCall`; for any `variableName` argument whose synthesized type is `functionRefType`, run `resolveCall` against the name. (See `interruptAnalysis.ts`'s `functionRefsInArgs` for how function-ref names are extracted.)
- Plug into the same `typechecker.undefinedFunctions` config knob — it's the same conceptual bug.

**Tests:**

- `map(items, doesNotExist)` — emits diagnostic.
- `map(items, myDef)` — no diagnostic.
- `map(items, \(x) -> x + 1)` — no diagnostic (lambda, not a name).

---

## Optional cleanup

- **Delete the dead `"reserved"` branch in `resolveCall`.** With the parser as-is, the three names listed there (`schema`, `interrupt`, `debugger`) never reach `resolveCall` as a `functionCall`. Branch is kept as belt-and-suspenders. Cheap to delete; up to taste. If deleted, also remove `kind: "reserved"` from `CallResolution` and update the doc comment.
- **Class methods get their own `ScopeInfo`.** Today methods on a `classDefinition` share the global scope, which is why this PR's diagnostic walks top-level (skipping nested `function`/`graphNode`) to cover them. Giving methods proper scopes would make the diagnostic walk more uniform and would benefit other passes (interrupt analysis, return-type inference).

---

## Suggested order of execution

1. **Task 1** (block reserved-name `let`/`const`) — small, isolated, high-value.
2. **Task 2** (stdlib via imports) — unblocks Tasks 3, 4, 5.
3. **Task 3** (`sig` on `JS_GLOBALS`).
4. **Task 4** (LSP hover) — depends on Tasks 2 + 3 for accurate signatures.
5. **Task 5** (flip default) — depends on accurate registries.
6. **Task 7** (undefined-variable diagnostic) — independent of Tasks 2–5; can be done in parallel.
7. **Task 8** (higher-order callback safety) — after Task 7.
8. **Task 6** (`Schema<T>` type) — independent; do whenever convenient.
