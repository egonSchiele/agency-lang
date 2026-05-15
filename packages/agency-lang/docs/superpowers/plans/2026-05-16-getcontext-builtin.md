# Implementation plan — `getContext()` builtin

Replaces the module-level `currentContext._current` singleton with a
typechecker-aware `getContext()` builtin that lowers to the `__ctx`
reference at codegen time.

Resolves PR #141 review comment **#27** (`currentContext.ts`
singleton breaks concurrent users in a web-server context). Also
unblocks any future stdlib TS code that needs runtime ctx — once
this lands, no more singleton.

---

## Background

### What's there today

`lib/runtime/currentContext.ts` is a 22-line module that exposes
`get/setCurrentContext()` over a module-level `let _current`.
`lib/runtime/node.ts:runNode` sets it before each agent run and
clears it in `finally`. `lib/stdlib/memory.ts` reads it on every
call.

```ts
// lib/stdlib/memory.ts (today)
export async function _remember(content: string): Promise<void> {
  const ctx = getCurrentContext();
  if (!ctx?.memoryManager) return;
  await ctx.memoryManager.remember(content);
}
```

The race window: two `runNode` calls overlapping in the same Node
process trample `_current` for each other. The `await` boundary
inside `remember()` lets a second `setCurrentContext` slip in
between the `getCurrentContext()` and the `memoryManager` read.

### Why not just AsyncLocalStorage

`AsyncLocalStorage` would close the concurrency hole but:
- Leaves a hidden global; debugging "where did this ctx come from"
  is harder than a literal call site.
- Adds an async-hooks dependency the rest of the runtime doesn't
  use.
- Doesn't help user code that wants ctx for its own purposes.

### Why not expose `__ctx` directly

`__ctx` has a double-underscore convention reserved for compiler
internals. Letting it leak into user code:
- Forces the typechecker to special-case the identifier (skip
  declaration-required check, skip state-stack tracking, skip
  shadowing check).
- Makes `__ctx` ambiguous in greps — is this user code or
  compiler-generated?
- Couples user code to the exact runtime field shape.

### Why a builtin

Builtins are an established path:
- Typechecker has a `BUILTIN_FUNCTION_TYPES` registry
  ([lib/typechecker/builtins.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/memory-layer/packages/agency-lang/lib/typechecker/builtins.ts:76)).
- TS builder has a precedent for builder macros that bypass
  `__call` dispatch — `system()` is special-cased at
  [lib/backends/typescriptBuilder.ts:2269](file:///Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/memory-layer/packages/agency-lang/lib/backends/typescriptBuilder.ts#L2269).
  `getContext()` follows the exact same shape but emits an
  identifier reference instead of a synthesized expression.
- Magic stays inside one builtin's lowering rule. Everything else
  treats `getContext()` as a normal typed function call.

---

## Design

### User-facing surface

```agency
import { getContext } from "std::runtime"   // or auto-imported

node main() {
  const ctx: Context = getContext()
  // ctx.memoryManager?.recall("...") — etc.
}
```

`getContext()` takes no arguments and returns the public `Context`
type defined in `std::runtime` (see "Type exposure" below).

### Type exposure

We do **not** expose the full `RuntimeContext` (dozens of internal
fields: debugger state, statelog client, abort controller, callbacks,
trace writer, ...). Instead, a narrow public type:

```ts
// lib/runtime/publicContext.ts
export type Context = {
  /** Active memory manager, if memory is configured. */
  memoryManager?: MemoryManager;
  // Future: traceWriter, coverageCollector, etc. as we surface them.
};
```

`RuntimeContext` already has these fields, so the lowered `__ctx`
reference is structurally compatible — no wrapping or copying at
runtime. The narrow type just hides everything else from the
agency type system.

The agency-side type alias goes into the typechecker's
`BUILTIN_FUNCTION_TYPES` entry (see implementation step 2) so users
get autocomplete / type errors when they touch the wrong field.

### Lowering

`getContext()` is a builder macro, exactly like `system()`. The TS
builder's `generateFunctionCallExpression` already has the
short-circuit at line 2269; we add a peer:

```ts
// lib/backends/typescriptBuilder.ts (additions)
if (node.functionName === "getContext") {
  return ts.id("__ctx");
}
```

That's it for codegen. No `await`, no `__call` dispatch — the
result of the macro is the literal `__ctx` identifier already in
scope of every compiled function (`runNode` and friends bind it).

This also means `getContext()` has zero runtime cost: it's a
compile-time rewrite, not a function call.

---

## Implementation

### Step 1 — Define the public Context type

**File (new):** `lib/runtime/publicContext.ts`

```ts
import type { MemoryManager } from "./memory/index.js";

/**
 * Narrow, user-facing view of `RuntimeContext`. Returned by the
 * `getContext()` builtin. Only fields safe for user code go here;
 * anything internal (debugger, statelog, abort controller, ...)
 * stays off this type and remains accessible only to runtime code
 * that has the full `RuntimeContext`.
 */
export type Context = {
  memoryManager?: MemoryManager;
};
```

Re-export from `lib/runtime/index.ts` so user TS code (and the
generated stdlib bindings) can import it.

### Step 2 — Add typechecker entry

**File:** `lib/typechecker/builtins.ts`

Add the agency-level type alias and the builtin signature:

```ts
// Public shape returned by getContext(). Mirrors lib/runtime/publicContext.ts
const contextType: VariableType = {
  type: "objectType",
  properties: [
    { key: "memoryManager", value: optional(ANY_T) },
    // Future fields go here.
  ],
};

export const BUILTIN_FUNCTION_TYPES: Record<string, BuiltinSignature> = {
  // ... existing entries ...
  getContext: { params: [], returnType: contextType },
};
```

Two design decisions to lock in here:
- `memoryManager` is typed as `optional(ANY_T)` rather than a deep
  `objectType` for `MemoryManager` because the agency type system
  doesn't model class instances. Users access methods through the
  runtime side (TS bindings), not directly. If someone writes
  `getContext().memoryManager.remember(...)` in agency, that's not
  a typed path today and shouldn't be — it goes through the agency
  stdlib functions instead.
- We deliberately don't add `getContext` to `BUILTIN_FUNCTIONS` in
  `lib/config.ts`. That registry is for builtins whose names map
  to TS implementations (e.g. `print` → `_print`). `getContext` has
  no TS implementation; it's pure codegen.

### Step 3 — Add TS-builder lowering

**File:** [lib/backends/typescriptBuilder.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/memory-layer/packages/agency-lang/lib/backends/typescriptBuilder.ts)

Inside `generateFunctionCallExpression` (the method that already
handles the `system` macro at line 2269), add a peer branch:

```ts
// getContext() — compile-time rewrite to the __ctx identifier
// already in scope of every compiled function. No runtime cost.
if (node.functionName === "getContext") {
  if (node.arguments.length > 0) {
    throw new Error("getContext() takes no arguments");
  }
  return ts.id("__ctx");
}
```

Place this BEFORE the `__-prefixed helpers and DIRECT_CALL_FUNCTIONS`
branch so it short-circuits before any other dispatch logic.

The same handler covers all three call contexts (`valueAccess`,
`functionArg`, `topLevelStatement`) because the lowered form is
just an identifier — it works as an rvalue anywhere.

### Step 4 — Migrate `lib/stdlib/memory.ts`

**File:** [lib/stdlib/memory.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/memory-layer/packages/agency-lang/lib/stdlib/memory.ts)

Drop the `getCurrentContext` import. Take `ctx: Context` (or
`RuntimeContext` — see "API choice" below) as the first argument
of every `_*` function:

```ts
import type { RuntimeContext } from "../runtime/state/context.js";
import type {
  ExtractionResult,
  ForgetResult,
} from "../runtime/memory/index.js";

export async function _setMemoryId(
  ctx: RuntimeContext<any>,
  id: string,
): Promise<void> {
  if (!ctx.memoryManager) return;
  ctx.memoryManager.setMemoryId(id);
}

export function _shouldRunMemory(ctx: RuntimeContext<any>): boolean {
  return ctx.memoryManager !== undefined;
}

export async function _buildExtractionPrompt(
  ctx: RuntimeContext<any>,
  content: string,
): Promise<string> {
  if (!ctx.memoryManager) return "";
  return ctx.memoryManager.buildExtractionPromptFor(content);
}
// ... same shape for the other 6 helpers.
```

**API choice — `Context` vs `RuntimeContext`.** The TS-side stdlib
binding receives the *real* `__ctx` (the lowered ref is structurally
the full `RuntimeContext`). It's safer to type the parameter as
`RuntimeContext<any>` so internal code retains access to private
fields. The narrow `Context` is what the agency type system sees,
not what the TS implementation sees.

### Step 5 — Update `stdlib/memory.agency`

**File:** [stdlib/memory.agency](file:///Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/memory-layer/packages/agency-lang/stdlib/memory.agency)

Each agency wrapper grabs ctx once at the top and forwards it to
the TS helpers:

```agency
export def remember(content: string) {
  const ctx = getContext()
  if (_shouldRunMemory(ctx)) {
    thread {
      const prompt = _buildExtractionPrompt(ctx, content)
      const result: ExtractionResult = llm(prompt)
      _applyExtractionResult(ctx, result)
    }
  }
}

export def forget(query: string) {
  const ctx = getContext()
  if (_shouldRunMemory(ctx)) {
    thread {
      const prompt = _buildForgetPrompt(ctx, query)
      const result: ForgetResult = llm(prompt)
      _applyForgetResult(ctx, result)
    }
  }
}

export def setMemoryId(id: string) {
  _setMemoryId(getContext(), id)
}

export safe def recall(query: string): string {
  return _recall(getContext(), query)
}
```

Run `make` afterwards to regenerate `stdlib/memory.js`.

**Naming note.** Inside the agency code, `ctx` is just a normal
`const`. The typechecker treats it as a value of the public `Context`
type. The TS builder lowers `getContext()` to `__ctx` — so by the
time the JS executes, `ctx` is bound to the actual runtime context
and forwarded into every `_*` call.

### Step 6 — Delete `currentContext.ts` and its caller

**File:** delete `lib/runtime/currentContext.ts`.

**File:** [lib/runtime/node.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/memory-layer/packages/agency-lang/lib/runtime/node.ts) — drop the
`setCurrentContext` import and the two call sites (the `try` setup
and the `finally` clear).

A `grep -rn 'currentContext\|getCurrentContext\|setCurrentContext' lib/`
should return nothing after this step.

### Step 7 — Add a `getContext` smoke test

**File (new):** `tests/agency/runtime/getContext.agency`

```agency
node main(): boolean {
  const ctx = getContext()
  // We can't assert much about the runtime shape from agency code,
  // but we CAN assert the call returns a non-null value — the
  // codegen has rewritten getContext() to __ctx, which is always
  // bound inside a node body.
  return ctx != null
}
```

Plus a corresponding `getContext.test.json` asserting `"true"`.

For a deeper unit test of the typechecker entry, add to
`lib/typechecker/builtins.test.ts` (or similar):

```ts
it("typechecks getContext as a zero-arg function returning Context", () => {
  // ... assert the inferred type of `const c = getContext()` matches
  // the `Context` shape defined above.
});
```

For TS-builder lowering, snapshot test:

```ts
it("lowers getContext() to the __ctx identifier", () => {
  const tsCode = compileSnippet("const c = getContext()");
  expect(tsCode).toContain("const c = __ctx");
  expect(tsCode).not.toContain("__call(");
});
```

### Step 8 — Concurrency regression test

A test that proves the singleton race is gone:

**File (new):** `tests/agency-js/runtime/concurrent-runs-share-no-ctx.test.ts`

Spawn two `runNode` calls concurrently, each with its own
`MemoryManager`. Inside each agent, call `setMemoryId("scope-A")`
or `"scope-B"`. After both finish, assert each manager only saw
its own id. Today this would race; after the change it can't
because each `runNode` operates on its own `__ctx` argument and
nothing reads from a shared singleton.

---

## Migration of any other singleton readers

There aren't any — `grep -rn 'getCurrentContext' lib/` shows only
`lib/stdlib/memory.ts` (handled in step 4). If a future PR adds a
new TS-side stdlib helper that needs ctx, it follows the same
pattern: take `ctx: RuntimeContext<any>` as the first arg, and the
agency wrapper passes `getContext()`.

Document this in `docs/dev/stdlib.md` (create if missing) under a
"Accessing runtime state from a TS binding" section.

---

## Open questions to lock in before merging

1. **Lowering site.** Two valid places:
   - In `generateFunctionCallExpression` next to `system()` — tightly
     scoped, no risk of conflict, but couples to the call-expression
     emission path.
   - In a preprocessor pass (`lib/preprocessors/`) that rewrites
     `getContext()` AST nodes to a special `RuntimeCtxRef` node before
     the TS builder runs — keeps the TS builder generic.

   Recommendation: start with the call-expression site (simpler,
   matches `system()` precedent). Migrate to a preprocessor only if
   we end up with several similar macros.

2. **Naming.** `getContext()` vs `ctx()` vs `runtimeContext()`. I
   lean `getContext()` for greppability and verb-style consistency
   with `getCheckpoint()`.

3. **Public type evolution.** Today `Context` only needs
   `memoryManager`. As we surface more internals (e.g. for #13 trace
   tagging), we add fields. Backward-compatible since adding optional
   fields is non-breaking.

---

## Verification

After implementing all steps, run in order:

1. `pnpm tsc --noEmit` — clean.
2. `make` — rebuilds stdlib + templates without errors.
3. `pnpm test:run` — all existing tests pass; new tests from steps
   7 and 8 pass.
4. `AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test
   tests/agency/memory/` — the existing memory tests still pass
   (they exercise the new ctx-passing path end-to-end).
5. `grep -rn 'currentContext' lib/ stdlib/` — empty.

The success signal is "no behavior change visible to users; the
race-prone module is gone; the agent-test surface is unchanged."

---

## File-by-file diff summary

| File | Change |
|---|---|
| `lib/runtime/publicContext.ts` | NEW — `Context` type. |
| `lib/runtime/index.ts` | Export `Context`. |
| `lib/typechecker/builtins.ts` | Add `getContext` entry + `contextType`. |
| `lib/backends/typescriptBuilder.ts` | Add `getContext` macro branch. |
| `lib/stdlib/memory.ts` | Take `ctx` as first arg; drop `getCurrentContext` import. |
| `stdlib/memory.agency` | `const ctx = getContext()` at top of each function; pass to `_*` helpers. |
| `lib/runtime/currentContext.ts` | DELETE. |
| `lib/runtime/node.ts` | Drop `setCurrentContext` import + two call sites. |
| `tests/agency/runtime/getContext.agency` | NEW — smoke test. |
| `tests/agency/runtime/getContext.test.json` | NEW — assertion. |
| `tests/agency-js/runtime/concurrent-runs-share-no-ctx.test.ts` | NEW — race regression test. |
| `lib/typechecker/builtins.test.ts` | Add typecheck assertion for `getContext`. |
| Some snapshot test under `tests/typescriptBuilder/` | Asserts `getContext()` lowers to `__ctx`. |
| `docs/dev/stdlib.md` | Document the ctx-passing pattern. |

---

## Effort estimate

Small. The hard part is the design (locked in above). Implementation
is roughly:
- Steps 1–3: ~60 lines across three files.
- Step 4: mechanical rewrite of 8 functions.
- Step 5: mechanical rewrite of 4 agency functions.
- Step 6: 1 file delete + 3 lines removed from node.ts.
- Steps 7–8: ~80 lines of tests.

One focused half-day session, including verification.
