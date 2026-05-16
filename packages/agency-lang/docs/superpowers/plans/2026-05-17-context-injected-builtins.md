# Implementation plan — Context-injected builtins

Replace the `getContext()` macro with a codegen-driven mechanism that
injects the runtime context (`__ctx`) into a registered set of
internal builtins at compile time. Users never see or hold a reference
to the runtime context.

This is a follow-up to the `getContext()` work
([2026-05-16-getcontext-builtin.md](file:///Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/memory-layer/packages/agency-lang/docs/superpowers/plans/2026-05-16-getcontext-builtin.md))
and to the round-3 PR review's `#27` deferred item — `getContext` is
deleted as part of this work.

---

## Background

### What's there today

`stdlib/memory.agency` looks like this:

```agency
import { _recall, _remember, _shouldRunMemory, ... } from "agency-lang/stdlib-lib/memory.js"

export def remember(content: string) {
  if (_shouldRunMemory(getContext())) {
    thread {
      const prompt = _buildExtractionPrompt(getContext(), content)
      const result: ExtractionResult = llm(prompt)
      _applyExtractionResult(getContext(), result)
    }
  }
}
```

`getContext()` is a builder macro
([typescriptBuilder.ts:2280](file:///Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/memory-layer/packages/agency-lang/lib/backends/typescriptBuilder.ts#L2280))
that lowers to the `__ctx` identifier in scope. The user-facing
`Context` type
([publicContext.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/memory-layer/packages/agency-lang/lib/runtime/publicContext.ts))
exposes a narrow shape (just `memoryManager?` today) so internal
context fields don't leak.

### Why change

The `getContext()` approach has three problems:

1. **It exposes the runtime context to user code.** Even with a narrow
   `Context` type, users could store the returned object in a global
   variable and reuse it across requests, recreating the original
   race-prone singleton.
2. **The narrow `Context` type has to be maintained forever** as new
   internal fields get added — and every addition is a decision about
   whether it's safe to expose.
3. **There's a known runtime bug** where binding `getContext()` to a
   `const` (e.g., `const ctx = getContext()`) causes the next runner
   step to be skipped. The current workaround is to inline
   `getContext()` everywhere it's needed, which is ugly.

### What we want instead

User-callable wrappers stay agency functions (`recall`, `remember`,
`forget`), but the underscore-builtins they call become
**context-injected** at codegen time:

```agency
export def remember(content: string) {
  if (__internal_shouldRunMemory()) {
    thread {
      const prompt = __internal_buildExtractionPrompt(content)
      const result: ExtractionResult = llm(prompt)
      __internal_applyExtractionResult(result)
    }
  }
}
```

The TypeScriptBuilder rewrites every call to a registered name,
prepending `__ctx` to the resolved positional argument list:

```ts
// generated TS
if (await __internal_shouldRunMemory(__ctx)) {
  // thread setup ...
  const prompt = await __internal_buildExtractionPrompt(__ctx, content)
  const result = ... llm call ...
  await __internal_applyExtractionResult(__ctx, result)
}
```

The TS implementations in `lib/stdlib/memory.ts` already take `ctx`
as the first arg — only their names change (`_recall` →
`__internal_recall`).

The `thread { ... }` blocks stay in the agency wrappers — they
isolate the memory LLM's prompt + tool messages from the user
agent's main message history. That's a hard requirement, not an
artifact of how memory is implemented.

---

## Design

### Naming

All context-injected builtins use the prefix `__internal_`:
`__internal_recall`, `__internal_remember`, etc.

Reasons (vs. single-underscore `_recall`):
- **Lower collision risk** with user-defined names. The Agency
  convention already reserves `__`-prefixed identifiers for compiler
  internals (`__ctx`, `__stack`, `__call`).
- **Naturally lands in the existing `__-prefixed` direct-call codepath**
  in `emitDirectFunctionCall`
  ([typescriptBuilder.ts:2289](file:///Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/memory-layer/packages/agency-lang/lib/backends/typescriptBuilder.ts#L2289))
  — single-underscore names go through `__call` runtime dispatch,
  which is the wrong shape for this.
- **Distinct from runtime plumbing identifiers** (`__ctx`, `__stack`)
  by the longer prefix, so a typo doesn't collide with internals.

We will also update the language docs to advise against user-defined
names beginning with two underscores.

### The registry

One registry, one entry per context-injected builtin:

```ts
// lib/codegenBuiltins/contextInjected.ts
export type ContextInjectedBuiltin = {
  /** Agency-side name (must start with `__internal_`). */
  name: string;
  /** User-visible parameter types — fed into the typechecker. */
  params: VariableType[];
  minParams?: number;
  restParam?: VariableType | "any";
  returnType: VariableType | "any" | "void";
};

export const CONTEXT_INJECTED_BUILTINS: Record<string, ContextInjectedBuiltin> = {
  __internal_setMemoryId:           { params: [string], returnType: "void" },
  __internal_shouldRunMemory:       { params: [],       returnType: boolean },
  __internal_buildExtractionPrompt: { params: [string], returnType: string },
  __internal_applyExtractionResult: { params: ["any"],  returnType: "void" },
  __internal_buildForgetPrompt:     { params: [string], returnType: string },
  __internal_applyForgetResult:     { params: ["any"],  returnType: "void" },
  __internal_remember:              { params: [string], returnType: "void" },
  __internal_recall:                { params: [string], returnType: string },
  __internal_forget:                { params: [string], returnType: "void" },
};
```

Both the typechecker and the builder consume this registry. Adding a
new context-injected builtin is one entry in this map and one TS
function in `lib/stdlib/`.

### Codegen lowering

In `generateFunctionCallExpression` (typescriptBuilder.ts), add a new
branch immediately before the existing `__-prefixed / DIRECT_CALL`
branch:

```ts
if (CONTEXT_INJECTED_BUILTINS[node.functionName]) {
  return this.emitContextInjectedCall(node, shouldAwait);
}
```

`emitContextInjectedCall` is `emitDirectFunctionCall` with `__ctx`
prepended to the resolved positional arg list. The injection happens
**after** named-arg / splat / variadic resolution (none of these
builtins use them today, but the abstraction should still compose
correctly).

The generated call is `await __internal_recall(__ctx, query)`. The
`await` is determined the same way as for any other async call —
`shouldAwait = !node.async && context !== "valueAccess"`.

### Typechecker integration

Fold the registry into `BUILTIN_FUNCTION_TYPES` at the top of
`lib/typeChecker/builtins.ts`:

```ts
import { CONTEXT_INJECTED_BUILTINS } from "../codegenBuiltins/contextInjected.js";

export const BUILTIN_FUNCTION_TYPES: Record<string, BuiltinSignature> = {
  print: { ... },
  // ...
  ...Object.fromEntries(
    Object.entries(CONTEXT_INJECTED_BUILTINS).map(([name, def]) => [name, {
      params: def.params,
      minParams: def.minParams,
      restParam: def.restParam,
      returnType: def.returnType,
    }]),
  ),
};
```

`getContext` is removed from `BUILTIN_FUNCTION_TYPES`. The narrow
`Context` type goes away with it.

### Prohibit value references

The typechecker raises an error when a context-injected builtin
appears anywhere except as the *callee* of a `functionCall` node.
Concretely:

```agency
let f = __internal_recall              // ERROR: cannot reference internal builtin as value
__internal_recall.bar                  // ERROR
[__internal_recall, __internal_remember]  // ERROR
```

The same restriction applies to the existing `getContext` — but since
we're deleting that entry, it goes away too.

Implementation: a small visitor that walks expressions and checks
whether any `variableName` whose `name` is in
`CONTEXT_INJECTED_BUILTINS` is being used in a non-callee position.
Lives in `lib/typeChecker/validation.ts` next to other shape
validations.

### Importless

`__internal_*` names are always available — no `import` needed at the
agency-source level. They're effectively builtins (like `print`).

The runtime side still has to wire the implementations. The
generated TypeScript needs an import of each `__internal_*` from
`agency-lang/stdlib-lib/memory.js` (or wherever the impl lives). We
have two options:

1. **Codegen always imports the full set** at the top of every
   generated file (cheap; one import block; tree-shaking removes
   unused).
2. **Codegen tracks which `__internal_*` names were called** in this
   module and emits only those imports (smaller diffs in
   user-readable generated code, more code in the builder).

Option 1 is simpler and cheaper to maintain. The generated output
already imports the full `agency-lang` runtime; one extra import block
per file is in the noise.

Pick option 1. Document on the registry that "adding a new entry
also means adding an export from `lib/stdlib/<module>.ts`."

### Drift safeguard

Add a vitest test that imports both the registry and every TS impl,
and asserts:

```ts
expect(__internal_recall.length).toBe(1 /* ctx */ + entry.params.length);
```

One test loop covers all entries. Failing this test on CI catches any
arity drift — e.g., adding a TS-impl param without updating the
registry — at PR time, before the codegen emits a malformed call.

This sits next to the registry, in
`lib/codegenBuiltins/contextInjected.test.ts`.

### What goes away

- [lib/runtime/publicContext.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/memory-layer/packages/agency-lang/lib/runtime/publicContext.ts) — deleted.
- The `contextType` constant and `getContext` entry in
  [lib/typeChecker/builtins.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/memory-layer/packages/agency-lang/lib/typeChecker/builtins.ts) — deleted.
- The `getContext` macro branch in
  [lib/backends/typescriptBuilder.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/memory-layer/packages/agency-lang/lib/backends/typescriptBuilder.ts) — deleted.
- `lib/runtime/currentContext.ts` if any references remain — deleted.

This is a breaking change for anyone calling `getContext()` outside
of stdlib. We're shipping it as one.

### Renaming

In `lib/stdlib/memory.ts`, every exported function gets renamed:

| old | new |
|---|---|
| `_setMemoryId` | `__internal_setMemoryId` |
| `_shouldRunMemory` | `__internal_shouldRunMemory` |
| `_buildExtractionPrompt` | `__internal_buildExtractionPrompt` |
| `_applyExtractionResult` | `__internal_applyExtractionResult` |
| `_buildForgetPrompt` | `__internal_buildForgetPrompt` |
| `_applyForgetResult` | `__internal_applyForgetResult` |
| `_remember` | `__internal_remember` |
| `_recall` | `__internal_recall` |
| `_forget` | `__internal_forget` |

`stdlib/memory.agency` updates to call the new names AND drops its
`import { ... }` statement at the top.

The agency-side wrappers (`setMemoryId`, `recall`, `remember`,
`forget`) keep their docstrings, their `thread { }` blocks, and
their public signatures. Only the body changes.

---

## Edge cases and risks

### `__-prefixed names skip declaration check in the typechecker

The typechecker treats `__`-prefixed identifiers as compiler
internals and doesn't flag missing declarations. Net effect: a typo
like `__internal_recll(...)` would currently silently compile and
fail at runtime.

The fix is to make the typechecker check `BUILTIN_FUNCTION_TYPES`
(which now includes the registry) BEFORE the "this is a magic
identifier, skip" rule, when the name starts with `__internal_`.
Concretely: in the call-resolution pipeline, if the name matches
`__internal_*` and is NOT in the registry, raise `unknown internal
builtin`.

This needs a tiny helper:

```ts
function isInternalBuiltin(name: string): boolean {
  return name in CONTEXT_INJECTED_BUILTINS;
}

function looksLikeInternalBuiltin(name: string): boolean {
  return name.startsWith("__internal_");
}
```

In `checker.ts:resolveCall`, after the existing
`BUILTIN_FUNCTION_TYPES` lookup, if `looksLikeInternalBuiltin(name)
&& !isInternalBuiltin(name)` → typecheck error.

### Documentation

Add a paragraph to `docs/site/guide/basic-syntax.md` or a related
page advising:

> Names starting with two underscores (`__name`) are reserved for the
> compiler and runtime. User code should not define functions or
> variables with names that start with `__`.

### Top-level / global init scope

`__ctx` is in scope inside every generated function body, every
`runner.step` closure, and the per-execution `__initializeGlobals`
function ([typescriptBuilder.ts:259](file:///Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/memory-layer/packages/agency-lang/lib/backends/typescriptBuilder.ts#L259)).

It is **not** in scope at:
- Module-level top-level statements outside `__initializeGlobals`.
- The static-vars `__getStaticVars` getter.

We need to verify a context-injected call from a global init
expression (the legitimate place where this could happen) lowers
correctly. Should be fine because global init runs inside
`__initializeGlobals(__ctx)`, but the implementation pass should
add a fixture test for it.

### Block arguments / variadics / splats

None of the current registry entries take blocks, variadics, or
splats. The codegen still resolves args first (named-arg unwrapping,
splat expansion) and THEN unshifts `__ctx` — so the existing
arg-resolution pipeline is unchanged.

If we ever add a context-injected builtin that takes a block, the
block is currently appended after the positional args by
`emitDirectFunctionCall`. With `__ctx` prepended, the order becomes
`(__ctx, arg1, arg2, blockArg)`, which matches the natural TS impl
shape `(ctx, arg1, arg2, block)`. Fine.

### Doc generator

`pnpm run agency doc stdlib` walks exported `def` functions for
docstrings. `__internal_*` names have no agency `def`, so they don't
appear in the generated docs. The agency-side wrappers (`recall`,
`remember`, `forget`) DO have `def`s, with their docstrings — those
remain the user-facing documentation surface. No changes needed in
the doc generator.

---

## Implementation steps

### Step 1 — Create the registry

**New file:** `lib/codegenBuiltins/contextInjected.ts`

Defines `ContextInjectedBuiltin` type and `CONTEXT_INJECTED_BUILTINS`
object with all nine entries. No behaviour yet — just data.

**New file:** `lib/codegenBuiltins/contextInjected.test.ts`

Drift-safeguard test: for each entry, asserts the corresponding TS
impl exists and has `length === 1 + entry.params.length`.

### Step 2 — Wire the registry into the typechecker

**File:** `lib/typeChecker/builtins.ts`

- Import `CONTEXT_INJECTED_BUILTINS`.
- Spread the registry into `BUILTIN_FUNCTION_TYPES`.
- Delete the `contextType` constant and the `getContext` entry.

**File:** `lib/typeChecker/checker.ts`

- After `BUILTIN_FUNCTION_TYPES` lookup, raise `unknown internal
  builtin` if the name starts with `__internal_` but isn't in the
  registry.

**File:** `lib/typeChecker/validation.ts` (or new file)

- Add a value-reference check that raises an error if any
  `__internal_*` name appears outside the callee position of a
  `functionCall`.

Verify: `pnpm tsc --noEmit`, run `lib/typeChecker/` tests.

### Step 3 — Wire the registry into the codegen

**File:** `lib/backends/typescriptBuilder.ts`

- Import `CONTEXT_INJECTED_BUILTINS`.
- In `generateFunctionCallExpression`, add a new branch (before the
  `__`-prefixed branch) that calls a new
  `emitContextInjectedCall(node, shouldAwait)`.
- `emitContextInjectedCall` mirrors `emitDirectFunctionCall` but
  unshifts `ts.id("__ctx")` onto `argNodes` before the call.
- Delete the `getContext` macro branch.

Verify: `pnpm tsc --noEmit`, run codegen tests in
`tests/typescriptGenerator/`.

### Step 4 — Generated import block

**File:** `lib/backends/typescriptBuilder.ts`

In the section that emits the file-level imports, always emit a
single import statement that pulls every `__internal_*` name from
`agency-lang/stdlib-lib/memory.js`. (The set is fixed by the
registry, so we generate it once at codegen-class init time.)

When more context-injected modules are added in future, the registry
entries grow a `from: string` field and the codegen groups by source
module. For now, all nine come from one module.

Verify: codegen output for `stdlib/memory.agency` contains the
import block; running an agency file that uses `recall()` works
end-to-end.

### Step 5 — Rename TS impls

**File:** `lib/stdlib/memory.ts`

Rename every `_x` → `__internal_x`. Signatures unchanged.

**File:** `lib/runtime/memory/index.ts` (re-exports if any)

Update names if re-exported.

Verify: `pnpm tsc --noEmit`. Manager tests should still pass — they
talk to `MemoryManager` directly, not the internal builtins.

### Step 6 — Update stdlib/memory.agency

**File:** `stdlib/memory.agency`

- Drop the `import { ... } from "agency-lang/stdlib-lib/memory.js"`
  line entirely — `__internal_*` are now builtin.
- Replace every `_x(getContext(), ...args)` with
  `__internal_x(...args)`.
- Replace `if (_shouldRunMemory(getContext()))` with
  `if (__internal_shouldRunMemory())`.

Verify: `pnpm run ast stdlib/memory.agency` parses;
`pnpm run agency compile stdlib/` succeeds.

### Step 7 — Delete dead code

- Delete `lib/runtime/publicContext.ts`.
- Delete `lib/runtime/currentContext.ts` if present.
- Remove the `getContext` doc references in any `.md` files.
- Remove `Context` re-exports from `lib/runtime/index.ts` if any.

Verify: `pnpm tsc --noEmit` clean; `pnpm exec vitest run` passes.

### Step 8 — Documentation

**File:** `docs/site/guide/basic-syntax.md` (or appropriate page)

Add a one-paragraph note that names beginning with two underscores
are reserved for the compiler/runtime and should not be used as
user-defined names.

### Step 9 — End-to-end verification

- `pnpm tsc --noEmit`
- `pnpm exec vitest run` (saved to `/tmp/full-tests.log`)
- `make` (rebuilds stdlib + templates + docs)
- `AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test tests/agency/memory/`
- Spot-check the generated TS for `stdlib/memory.agency` — confirm
  every memory call is `await __internal_x(__ctx, ...args)`, no
  `getContext()` references remain.

---

## Test coverage

New tests:

1. `lib/codegenBuiltins/contextInjected.test.ts` — arity-parity drift
   safeguard.
2. Codegen fixture: `tests/typescriptGenerator/internal-builtin-injection.agency`
   that calls `__internal_recall("foo")` and asserts the generated TS
   contains `await __internal_recall(__ctx, "foo")`.
3. Typecheck fixture (negative): a `.agency` file referencing
   `__internal_recall` as a value, expects a typecheck error with the
   "cannot reference internal builtin as value" message.
4. Typecheck fixture (negative): `__internal_recll(...)` (typo) is
   reported as `unknown internal builtin`, not silently accepted.

Existing tests that should keep passing without changes:

- All `lib/runtime/memory/*.test.ts` (76 tests) — they exercise the
  `MemoryManager` API directly.
- All `tests/agency/memory/*.agency` — they go through the agency
  wrappers (whose public surface is unchanged).

---

## Open questions

1. **Is `lib/codegenBuiltins/` the right home?** The directory doesn't
   exist yet. Alternatives: `lib/runtime/builtins/`, `lib/builtins/`,
   `lib/internal/`. I prefer `lib/codegenBuiltins/` because the name
   signals "rewritten by codegen, not just runtime helpers." Open to
   discussion.
2. **Should the registry entry's `params` use the full `VariableType`
   shape, or a friendlier mini-DSL?** Today `BUILTIN_FUNCTION_TYPES`
   uses the full type shape. Keeping parity is the path of least
   resistance.
3. **Handling future cross-module growth.** Today all nine entries
   come from `lib/stdlib/memory.ts`. When we add context-injected
   builtins from other modules, the codegen import block needs to
   group by source module. The registry will need a `from: string`
   field at that point. Not blocking for this work — add when the
   second source module appears.

---

## Effort estimate

Medium-large. Hard part is design (locked in). Implementation
spreads across:

- 1 new file + test (registry).
- 2-3 small edits to typechecker (registry hookup + missing-builtin
  diagnostic + value-reference check).
- 2-3 small edits to typescript builder (registry branch + delete
  `getContext` macro + import-block emission).
- 1 file rename pass (TS impls).
- 1 stdlib agency file rewrite (`stdlib/memory.agency`).
- 4 deletions.
- 4 new test fixtures + 1 doc paragraph.

One focused session, including verification.
