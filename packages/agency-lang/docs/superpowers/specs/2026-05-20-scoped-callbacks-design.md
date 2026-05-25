# Scoped Callbacks

## Summary

Replace Agency's `callback` keyword with a `callback` stdlib function whose registrations are scoped to the dynamic extent of the function or node that called it. Callbacks live on stack frames, so cleanup is automatic when the frame is popped, and they survive interrupts via the same serialization that already preserves frame `locals` and `args`.

## Motivation

Today, Agency has two ways to register a callback:

- File-level declarations in Agency: `callback onNodeStart(data) { ... }`
- TypeScript callbacks passed when invoking a node: `runNode(..., { callbacks })`

Both are run-global — they fire for every event during the entire execution. There is no way to say "fire this callback only for events that happen inside this block of code."

That gap matters because most useful callback patterns (cost tracking, scoped logging, rate limiting, event-driven guardrails) want to apply to a specific region of code, not the whole run. Today users either restructure their code to thread a flag through every function or split logic across files to control scope. Scoped callbacks let those patterns be expressed as plain Agency functions.

## Design

### Surface syntax

`callback` is removed as a keyword. It becomes a regular function exported from `std::agency`:

```
def callback(name: string, fn: (any) => any) {
  __internal_callback(name, fn)
}
```

The type signature uses a literal-union overload on `name` so misspellings are caught at compile time:

```
def callback(
  name: "onAgentStart" | "onAgentEnd" | "onNodeStart" | "onNodeEnd"
      | "onLLMCallStart" | "onLLMCallEnd" | "onFunctionStart"
      | "onFunctionEnd" | "onToolCallStart" | "onToolCallEnd"
      | "onStream" | "onTrace" | "onOAuthRequired" | "onEmit",
  fn: (any) => any
): void
```

Usage forms (all equivalent — `as` blocks, inline blocks, named functions, and PFAs are existing Agency features):

```
import { callback } from "std::agency"

// as-block
callback("onLLMCallEnd") as data {
  print(data.cost.totalCost)
}

// inline block
callback("onLLMCallEnd", \data -> print(data.cost.totalCost))

// named function
callback("onLLMCallEnd", logCost)

// partial application
callback("onToolCallEnd", logTool.partial(prefix: "[tool]"))
```

### Scope rules

- A scoped callback is active for the **dynamic extent** of the function or node whose body called `callback(...)`. Dynamic extent means every function this scope calls, transitively.
- When the enclosing function/node returns (normally or via error), the callback is automatically unregistered.
- Multiple scoped callbacks can be active simultaneously for the same event; all of them fire.
- Top-level `callback(...)` calls (outside any function/node) attach to the entry node's outermost frame, giving them run-wide lifetime. This replaces today's file-level `callback` keyword semantics. Mechanically: top-level statements in a compiled Agency module are emitted into a module-init function that runs when the entry node first pushes its frame, so by the time `__internal_callback` runs there *is* a frame at `stack[0]` to attach to. The compiler must ensure top-level `callback(...)` calls execute after the entry frame is pushed, not before (i.e. they are deferred into the entry node's prelude rather than executed at import time).

### Execution order

When an event fires, all registered callbacks for that event run, in this order:

1. Scoped callbacks, **innermost → outermost** (the most recently registered fires first).
2. Then any TypeScript-passed callback for that event (from `runNode(..., { callbacks })`).

All callbacks fire for every event. Ordinary errors in one callback do not prevent others from firing — they are caught and logged. Interrupts (Agency's structured control-flow errors) are *not* ordinary errors: an interrupt thrown from a callback propagates immediately, skipping any callbacks that would have fired after it. See "Interrupts" below for the full rules.

### No return values

Callbacks are observational. The previous capability for `onLLMCallStart` / `onLLMCallEnd` to return a `MessageJSON[]` and override messages is removed across the board, including for TypeScript-passed callbacks. The `CallbackReturn` type narrows to `void`.

This is a breaking change for TypeScript consumers that depended on message overriding. Users who need to mutate message history should do it explicitly before calling the LLM, not by piggy-backing on a callback hook.

### Concurrency

When `fork` or `parallel` creates branches, each branch gets its own forked state stack (existing behavior — see `lib/runtime/state/context.ts`). A callback registered before the fork lives on a frame that exists in both branches' stacks, so both branches see it. A callback registered inside one branch only attaches to that branch's frame, so siblings do not see it.

### Threads

Threads (`thread`, `subthread`) only affect message history, not callback registration. A callback registered outside a thread block still fires for LLM calls inside it. A callback registered inside a thread block dies when the enclosing function/node returns, regardless of where the `thread` block ends.

### Interrupts

`scopedCallbacks` serialize with each stack frame. On resume, the frame deserializes and callbacks come back automatically. No re-registration logic is needed at the `callback(...)` call site, and no special handling is needed in the runner.

A callback body may call `interrupt()`, but with one caveat for v1:

- If a `handle` block inside the callback body (or anywhere in the callback's call chain) catches the interrupt, control returns to the handler normally.
- If the interrupt escapes the callback unhandled, behavior is **undefined** for v1. The runner cannot meaningfully resume from inside a callback body, so attempting this is a known limitation. Full support for resumable callback bodies will be a follow-up spec.

In practice, this means callbacks can use handler-based control flow today (e.g., a cost-tracking callback that throws a `BudgetExceeded` interrupt caught by a `handle BudgetExceeded { ... }` block higher up), but they cannot trigger a host-level serialize/resume round trip.

### Recursion guard

Callbacks can recursively trigger themselves: a callback on `onFunctionStart` that calls a function will re-fire `onFunctionStart`, which would re-enter the callback, ad infinitum.

`callHook` guards against this with a per-function-instance `WeakSet`:

- While callback `fn` is on the call stack, additional firings that would re-enter `fn` are skipped.
- Other callbacks for the same event still fire normally — the guard is per-instance, not per-event.

This replaces today's `_activeHooks` recursion guard, which keyed on `(callbacks object, hook name)` and would have incorrectly blocked sibling callbacks in the new design.

## Implementation

### Runtime: stack-frame-resident callbacks

Each stack frame gets an optional `scopedCallbacks` field:

```ts
type StackFrame = {
  args: Record<string, any>;
  locals: Record<string, any>;
  line?: number;
  scopedCallbacks?: Array<{ name: CallbackName; fn: AgencyFunction }>;
  // ... existing fields
};
```

The field is undefined when no scoped callbacks are registered, so the vast majority of frames pay no overhead.

### Runtime: `__internal_callback`

A new runtime builtin:

```ts
function __internal_callback(
  ctx: RuntimeContext<any>,
  name: string,
  fn: AgencyFunction,
): void {
  if (!VALID_CALLBACK_NAMES.includes(name)) {
    throw new Error(`Unknown callback name '${name}'`);
  }
  const stack = ctx.stateStack.stack;
  // The caller of `callback(...)` is one frame below the current frame
  // (which is the `callback` stdlib function's own frame). If we're at
  // the top level there is no caller frame; attach to the entry frame.
  const target = stack.length >= 2 ? stack[stack.length - 2] : stack[0];
  if (!target.scopedCallbacks) target.scopedCallbacks = [];
  target.scopedCallbacks.push({ name: name as CallbackName, fn });
}
```

The frame-targeting logic assumes the `callback` stdlib function pushes a frame, so `stack[stack.length - 1]` is `callback`'s own frame and `stack[stack.length - 2]` is the caller's. This matches how every other Agency-defined function works (see `lib/runtime/state/context.ts` and the stateStack docs — `getNewState()` is called at function entry). If `callback` were implemented as a raw TS builtin that skips frame allocation, this index would be off; the stdlib wrapper must therefore stay as an Agency `def`, not a direct TS export.

### Runtime: `callHook` rewrite

Currently `callHook` takes `ctx.callbacks` and dispatches the one matching entry. It changes to take `ctx`, walk the stack, then call the TS-passed callback last:

```ts
const _activeCallbacks = new WeakSet<Function>();

export async function callHook<K extends keyof CallbackMap>({
  ctx, name, data,
}: { ctx: RuntimeContext<any>; name: K; data: CallbackMap[K] }) {
  const fns: Array<(d: any) => any> = [];

  // 1. Scoped callbacks: innermost → outermost
  for (let i = ctx.stateStack.stack.length - 1; i >= 0; i--) {
    const frame = ctx.stateStack.stack[i];
    if (!frame.scopedCallbacks) continue;
    for (const cb of frame.scopedCallbacks) {
      if (cb.name === name) fns.push(cb.fn);
    }
  }

  // 2. TS-passed callback last (most authoritative)
  const tsCb = ctx.callbacks[name];
  if (tsCb) fns.push(tsCb);

  for (const fn of fns) {
    if (_activeCallbacks.has(fn)) continue;
    _activeCallbacks.add(fn);
    try {
      await invoke(fn, data, ctx);
    } catch (e) {
      if (isAgencyInterrupt(e)) {
        _activeCallbacks.delete(fn);
        throw e;
      }
      console.error(`[agency] ${name} callback error:`, e);
    } finally {
      _activeCallbacks.delete(fn);
    }
  }
}
```

Return values are discarded — observational only.

### Stdlib: `std::agency`

Add `callback` to `lib/stdlib/agency.ts`:

```ts
export function _callback(
  ctx: RuntimeContext<any>,
  name: string,
  fn: AgencyFunction,
): void {
  __internal_callback(ctx, name, fn);
}
```

Expose it through the `std::agency` module so users can `import { callback } from "std::agency"`.

### Parser: simplification

`lib/parsers/parsers.ts` currently parses `callback` as a keyword alongside `def` (around line 3233). The branch-specific logic that follows (lines ~3319–3340) validates callback names, bans `export`/`safe`, requires single parameter, etc.

Changes:
- Remove `callback` from the `_baseFunctionParser` keyword choice — leave only `def`.
- Remove the `isCallback` branch and all its validations.
- `callback` becomes an ordinary identifier.

### AST changes

- Remove the `callback?: true` field from `FunctionDefinition`.
- No new AST nodes. `callback("name") as data { ... }` parses as a function call with a block argument via existing infrastructure.

### Removed paths

- `RuntimeContext._registeredCallbacks` map (`lib/runtime/state/context.ts`).
- `installRegisteredCallbacks` method (`context.ts:342-352`).
- Any compile pipeline step that collected file-level `callback` definitions and emitted registration calls.
- The `callback` field on `FunctionDefinition` and downstream handling in the type checker and TypeScript builder.

### Serialization

Stack-frame serialization already handles `args` and `locals`. `scopedCallbacks` is added to the serialized shape and treated symmetrically. Function values inside use Agency's existing function-ref reviver (the same mechanism that lets first-class functions and PFAs survive interrupts).

No special handling is required for resume: when the frame deserializes, its `scopedCallbacks` are already populated, and the next `callHook` walk picks them up.

### Migration of in-repo code

Files using the old syntax that need updating:
- Agency test fixtures under `tests/agency/`, `tests/agency-js/`, `tests/typescriptGenerator/`
- Built-in Agency code, e.g. `lib/agents/policy/agent.agency`
- Documentation: `docs/site/appendix/callbacks.md`, `docs/misc/lifecycleHooks.md`, `docs/site/guide/llm.md`, `docs/site/guide/ts-interop.md`, `docs/site/guide/mcp.md`

Each existing `callback X(data) { ... }` declaration becomes:
```
import { callback } from "std::agency"

callback("X") as data { ... }
```

at the top of whatever node or function is the run's entry point.

## Breaking changes

1. **`callback` keyword removed.** File-level `callback X(data) { ... }` no longer parses.
2. **Message overrides removed.** `onLLMCallStart` / `onLLMCallEnd` are observation-only. The `CallbackReturn` type narrows to `void`. The two call sites in `lib/runtime/prompt.ts` that today consume `startHookResult` / `endHookResult` and rebuild `MessageThread` from them (lines 57–69 and 189-ish) are deleted. TypeScript users whose callbacks returned `MessageJSON[]` to alter messages will silently lose that effect — surfaced via a release note and a temporary warning in `callHook` when a callback returns a non-undefined value (drop the warning after one release).

A grep of this repo (`grep -rn "onLLMCallStart\|onLLMCallEnd" lib tests | grep -i "return.*messages\|MessageJSON"`) finds no in-repo callers that rely on the override. The risk is therefore confined to external TypeScript consumers; the planner should still re-run this grep when starting work to catch anything added in the interim.
3. **`callback` as identifier.** Local variables named `callback` will shadow the stdlib import in scope. Not a hard break, but worth documenting.

## Implementation order

1. Add `scopedCallbacks` field to stack frame, including serialization plumbing.
2. Add `__internal_callback` runtime builtin.
3. Rewrite `callHook` to walk stack frames; remove return-value handling; switch recursion guard to per-instance.
4. Update every `callHook` call site to pass `ctx` instead of `ctx.callbacks`, and drop the message-override return-value consumption. As of writing there are six call sites:
   - `lib/runtime/node.ts:153` (`onAgentStart` / `onNodeStart` family)
   - `lib/runtime/node.ts:201` (`onAgentEnd` / `onNodeEnd` family)
   - `lib/runtime/prompt.ts:57` (`onLLMCallStart`, currently consumes `startHookResult` to override messages — delete the override path)
   - `lib/runtime/prompt.ts:189` (`onLLMCallEnd`, currently consumes `endHookResult` to override messages — delete the override path)
   - `lib/runtime/prompt.ts:481` (`onToolCallStart`)
   - `lib/runtime/prompt.ts:607` (`onToolCallEnd`)
   Future call sites can be located with `grep -rn 'callHook(' lib/runtime`.
5. Add `callback` stdlib function in `std::agency` with typed `name` overload.
6. Remove `callback` keyword from parser + AST + type checker + TS builder.
7. Remove `_registeredCallbacks` / `installRegisteredCallbacks`.
8. Migrate test fixtures and in-repo Agency files.
9. Update documentation (`docs/site/appendix/callbacks.md`, `docs/misc/lifecycleHooks.md`, plus referenced guide pages).
10. Add tests: scoped lifetime, nested scopes, fork inheritance, interrupt + handler, recursion guard, top-level registration.

## Open / deferred

- **Interrupt() escaping a callback body** is undefined behavior for v1. A follow-up spec will define how the runner serializes and resumes inside callback bodies.
- **Return-value-driven control flow** (e.g., a callback returning a `failure` to replace an LLM result) is not part of this design. It is discussed in the cost-and-guard-tracking spec.

## Files to modify

- `lib/parsers/parsers.ts` — remove callback keyword
- `lib/runtime/hooks.ts` — rewrite `callHook`, narrow `CallbackReturn`
- `lib/runtime/state/context.ts` — remove `_registeredCallbacks` / `installRegisteredCallbacks`; possibly add `scopedCallbacks` accessor helpers
- `lib/runtime/state/stateStack.ts` (or equivalent) — extend frame shape, serialization
- `lib/runtime/prompt.ts` — update `callHook` call sites; remove message-override consumption
- `lib/runtime/node.ts` — update `callHook` call sites if any; remove `installRegisteredCallbacks` invocation
- `lib/stdlib/agency.ts` — add `callback` export
- `lib/typeChecker/synthesizer.ts` — remove `callback`-specific typing logic; add literal-union typing for stdlib `callback`
- `lib/backends/typescriptBuilder.ts` — remove emission for `callback` keyword
- `lib/backends/agencyGenerator.ts` — remove formatter case for `callback` keyword
- `lib/runtime/runner.ts` — remove `installRegisteredCallbacks` call if present
- Test fixtures, docs (listed above)
