# Scoped Callbacks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Agency's `callback` keyword with a `callback(name, fn)` stdlib function whose registrations are scoped to the dynamic extent of the calling function/node, by storing them on stack frames so they clean up on frame pop and survive interrupts via existing frame serialization.

**Architecture:** Add a `scopedCallbacks: { name, fn }[]` field to each `State` (stack frame). A new `_callback` runtime function pushes onto the caller's frame. `callHook` is rewritten to walk the active stack collecting matching callbacks (innermost → outermost), then fire the TS-passed callback last; all return values are discarded (message-override capability is removed). The `callback` keyword is deleted from the parser and replaced by a `callback` Agency stdlib function in `std::agency`.

**Tech Stack:** TypeScript, vitest, Agency execution tests (`pnpm run a test <file>`).

**Spec reference:** `docs/superpowers/specs/2026-05-20-scoped-callbacks-design.md`

---

## File Structure

**Modified files:**
- `lib/runtime/state/stateStack.ts` — `State` class gets `scopedCallbacks` field + serialization
- `lib/runtime/hooks.ts` — `callHook` rewrite; `CallbackReturn` narrows to `void`
- `lib/runtime/state/context.ts` — delete `_registeredCallbacks` + `installRegisteredCallbacks`
- `lib/runtime/prompt.ts` — 4 callHook call sites, drop message-override consumption
- `lib/runtime/node.ts` — 2 callHook call sites, drop `installRegisteredCallbacks` call
- `lib/runtime/interrupts.ts` — drop `installRegisteredCallbacks` call
- `lib/runtime/rewind.ts` — drop `installRegisteredCallbacks` call
- `lib/parsers/parsers.ts` — remove `callback` keyword branch
- `lib/types/function.ts` — remove `callback?: boolean` field
- `lib/backends/typescriptBuilder.ts` — drop emission of `_registeredCallbacks` registration (~line 1650)
- `lib/backends/agencyGenerator.ts` — drop "callback" prefix in formatter (~line 658)
- `lib/stdlib/agency.ts` — add `_callback` export
- `stdlib/agency.agency` — add `callback` Agency function
- `tests/agency/callback-basic.agency` — migrate to new syntax
- `lib/agents/policy/agent.agency` — migrate two callbacks to new syntax
- `docs/site/appendix/callbacks.md`, `docs/misc/lifecycleHooks.md` — update

**Created files (test fixtures):**
- `tests/agency/callback-scoped.agency` + `.test.json` + `.js`
- `tests/agency/callback-nested.agency` + `.test.json` + `.js`
- `tests/agency/callback-toplevel.agency` + `.test.json` + `.js`
- `tests/agency/callback-recursion.agency` + `.test.json` + `.js`
- `tests/agency/callback-fork.agency` + `.test.json` + `.js`
- `tests/agency/callback-interrupt-handler.agency` + `.test.json` + `.js`
- `tests/agency/callback-resume.agency` + `.test.json` + `.js`
- `lib/runtime/state/stateStack.test.ts` (extend existing file)
- `lib/runtime/hooks.test.ts` (new)

---

## Notes for the implementer

Things to keep in mind throughout:

- **Agency stdlib build step.** Anytime you edit `stdlib/agency.agency` or the `lib/stdlib/*.ts` modules it imports, run `make` to regenerate `stdlib/agency.js`. The plan notes this at the appropriate steps; don't skip it.

- **Saving test output.** Per `CLAUDE.md`, when you run tests redirect output to a file so you don't waste expensive reruns. Use `pnpm test:run [pattern] 2>&1 | tee /tmp/test-output.log` for unit tests, and `pnpm run a test <file.agency> 2>&1 | tee /tmp/agency-output.log` for Agency execution tests.

- **Agency execution tests don't need an LLM.** All tests in this plan use pure logic — no `llm(...)` calls. They run against the real runtime, not mocked. See `tests/agency/callback-basic.agency` for the existing pattern.

- **Handlers are safety infrastructure.** If you find yourself touching anything related to handler registration during this work, stop and audit — handlers must NEVER be silently skipped. (This plan does not touch handlers; flagging just in case something surprises you.)

- **Stdlib function ctx access.** Agency stdlib functions get `__state: InternalFunctionState` as their last argument (the double-underscore is the actual convention; see `_run` in `lib/runtime/ipc.ts:428-436`). `__state.ctx` is the runtime context. Copy that signature shape for `_callback`.

- **Frame-targeting logic.** When `_callback` runs, the top frame on the stack is `callback`'s own frame (because Agency stdlib `callback` is an Agency `def`, which pushes a frame via `setupFunction` on entry). The caller's frame is `stack[stack.length - 2]`.

- **Top-level callback handling.** Top-level statements compile into `__initializeGlobals`, which runs BEFORE any node frame is pushed (see `lib/runtime/node.ts:133-135`). At that moment the stack is empty; the only frame `_callback` sees is `callback`'s own, which gets popped immediately after init. To make top-level callbacks survive for the whole run, the plan adds a separate `RuntimeContext.topLevelCallbacks` list. `_callback` routes there when `stack.length <= 1` (i.e., no real caller frame is present). `callHook` reads those alongside the stack-walked ones. Task 1 introduces the field, Task 2 wires the routing, Task 3 wires the read.

- **No early commits.** When working steps say "commit" they assume you can commit the work locally — don't push, don't force-push, don't amend. Follow the user's instruction to skip commits if they've asked for that this session.

---

## Task 1: Add scoped-callback storage and API to State / StateStack / RuntimeContext

This task adds (a) the `scopedCallbacks` field on `State` with serialization, (b) `State.addScopedCallback(name, fn)`, (c) `StateStack.callerFrame()` and `StateStack.collectScopedCallbacks(name)`, and (d) a `topLevelCallbacks: Array<{name, fn}>` field on `RuntimeContext` for callbacks registered during `__initializeGlobals` (which has no surviving frame to attach to). We add all of them together because the API methods are the only sanctioned way the rest of the runtime should touch this data — defining the field without the API invites callers to reach in directly (the very leakage we're trying to avoid).

**Files:**
- Modify: `lib/runtime/state/stateStack.ts`
- Modify: `lib/runtime/state/context.ts` (add `topLevelCallbacks` field)
- Test: `lib/runtime/state/stateStack.test.ts`

- [ ] **Step 1: Write failing tests for the field, API methods, and serialization**

Add to `lib/runtime/state/stateStack.test.ts`:

```ts
import { State, StateStack } from "./stateStack.js";

describe("State.scopedCallbacks", () => {
  it("defaults to undefined when no callbacks are registered", () => {
    expect(new State().scopedCallbacks).toBeUndefined();
  });

  it("addScopedCallback initializes the array lazily and appends", () => {
    const state = new State();
    const fn = () => {};
    state.addScopedCallback("onNodeStart", fn);
    state.addScopedCallback("onNodeEnd", fn);
    expect(state.scopedCallbacks).toEqual([
      { name: "onNodeStart", fn },
      { name: "onNodeEnd", fn },
    ]);
  });

  it("serialize/deserialize round-trip preserves scopedCallbacks", () => {
    const state = new State();
    const fn = () => {};
    state.addScopedCallback("onNodeStart", fn);
    const restored = State.fromJSON(state.toJSON());
    expect(restored.scopedCallbacks).toHaveLength(1);
    expect(restored.scopedCallbacks![0].name).toBe("onNodeStart");
  });

  it("does not include scopedCallbacks in JSON when empty", () => {
    expect(new State().toJSON().scopedCallbacks).toBeUndefined();
  });
});

describe("StateStack.callerFrame / collectScopedCallbacks", () => {
  function stackWithFrames(n: number): StateStack {
    const stack = new StateStack();
    for (let i = 0; i < n; i++) stack.stack.push(new State());
    return stack;
  }

  it("callerFrame returns the second-from-top frame when stack has >= 2 frames", () => {
    const stack = stackWithFrames(2);
    expect(stack.callerFrame()).toBe(stack.stack[0]);
  });

  it("callerFrame falls back to the root frame when stack has 1 frame", () => {
    const stack = stackWithFrames(1);
    expect(stack.callerFrame()).toBe(stack.stack[0]);
  });

  it("callerFrame throws when stack is empty", () => {
    expect(() => new StateStack().callerFrame()).toThrow();
  });

  it("collectScopedCallbacks returns innermost → outermost matching the name", () => {
    const stack = stackWithFrames(3);
    const a = () => {}; const b = () => {}; const c = () => {};
    stack.stack[0].addScopedCallback("onNodeStart", a); // outermost
    stack.stack[1].addScopedCallback("onNodeStart", b);
    stack.stack[1].addScopedCallback("onNodeEnd", () => {}); // wrong name, ignored
    stack.stack[2].addScopedCallback("onNodeStart", c); // innermost
    expect(stack.collectScopedCallbacks("onNodeStart")).toEqual([c, b, a]);
  });

  it("collectScopedCallbacks preserves registration order within a single frame", () => {
    const stack = stackWithFrames(1);
    const a = () => {}; const b = () => {}; const c = () => {};
    stack.stack[0].addScopedCallback("onNodeStart", a);
    stack.stack[0].addScopedCallback("onNodeStart", b);
    stack.stack[0].addScopedCallback("onNodeStart", c);
    expect(stack.collectScopedCallbacks("onNodeStart")).toEqual([a, b, c]);
  });

  it("collectScopedCallbacks combines same-frame and cross-frame ordering", () => {
    // Frame layout: outer has two callbacks; inner has one. Result is
    // inner's callback first, then outer's two in registration order.
    const stack = stackWithFrames(2);
    const a = () => {}; const b = () => {}; const c = () => {};
    stack.stack[0].addScopedCallback("onNodeStart", a);
    stack.stack[0].addScopedCallback("onNodeStart", b);
    stack.stack[1].addScopedCallback("onNodeStart", c);
    expect(stack.collectScopedCallbacks("onNodeStart")).toEqual([c, a, b]);
  });

  it("collectScopedCallbacks returns empty when nothing matches", () => {
    expect(stackWithFrames(2).collectScopedCallbacks("onNodeStart")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
pnpm test:run lib/runtime/state/stateStack.test.ts 2>&1 | tee /tmp/test-step1.log
```
Expected: FAIL — methods don't exist.

- [ ] **Step 3: Add the field, API methods, and serialization in `lib/runtime/state/stateStack.ts`**

Add `scopedCallbacks?: Array<{ name: string; fn: unknown }>` to the `StateJSON` type (around line 212).

Add the field to the `State` class (after `private deletedBranches?`):
```ts
scopedCallbacks?: Array<{ name: string; fn: any }>;
```

Add the method to `State`:
```ts
/** The sanctioned way to register a scoped callback on this frame. Initializes
 *  the array on first call so frames with no callbacks pay no overhead. */
addScopedCallback(name: string, fn: any): void {
  if (!this.scopedCallbacks) this.scopedCallbacks = [];
  this.scopedCallbacks.push({ name, fn });
}
```

Update `toJSON` (inside `toJSON`, before the `if (this.branches)` block):
```ts
if (this.scopedCallbacks && this.scopedCallbacks.length > 0) {
  json.scopedCallbacks = this.scopedCallbacks.map(cb => ({
    name: cb.name,
    fn: deepClone(cb.fn),
  }));
}
```

Update `fromJSON` (after `state` is constructed, before the `if (json.branches)` block):
```ts
if (json.scopedCallbacks && json.scopedCallbacks.length > 0) {
  state.scopedCallbacks = json.scopedCallbacks.map(cb => ({
    name: cb.name,
    fn: cb.fn,
  }));
}
```

Add the methods to `StateStack` (alongside the other public methods on the class):
```ts
/** The frame one below the top. Top is the "current" frame for whatever code is
 *  running right now; the caller's frame is what owns scoped registrations made
 *  by the current call. Falls back to the root frame at the top level. */
callerFrame(): State {
  if (this.stack.length === 0) {
    throw new Error("callerFrame() called on empty stack");
  }
  return this.stack.length >= 2 ? this.stack[this.stack.length - 2] : this.stack[0];
}

/** All scoped callbacks registered anywhere in the active stack for this hook,
 *  ordered innermost first (deepest frame's callbacks come first). */
collectScopedCallbacks(name: string): any[] {
  const out: any[] = [];
  for (let i = this.stack.length - 1; i >= 0; i--) {
    const cbs = this.stack[i].scopedCallbacks;
    if (!cbs) continue;
    for (const cb of cbs) {
      if (cb.name === name) out.push(cb.fn);
    }
  }
  return out;
}
```

**Note on fork mechanics:** `forkStack()` in `lib/runtime/state/context.ts:311` is implemented as `StateStack.fromJSON(this.stateStack.toJSON())`, so adding `scopedCallbacks` to `State.toJSON`/`fromJSON` automatically propagates them through forks. No extra fork-specific changes are needed.

**Step 3b: Add the `topLevelCallbacks` field to `RuntimeContext`**

In `lib/runtime/state/context.ts`, add this field to the `RuntimeContext` class (alongside `stateStack` and `callbacks`):
```ts
/** Callbacks registered at module top-level (via `_callback` during `__initializeGlobals`,
 *  when no real caller frame exists yet). Persist for the whole run. */
topLevelCallbacks: Array<{ name: string; fn: any }> = [];
```

Initialize it in `createExecutionContext` so the execution context inherits an empty array:
```ts
execCtx.topLevelCallbacks = [];
```

(Note: this field is intentionally NOT serialized on the stateStack — it's an execCtx-level concern. If a run resumes from a checkpoint, top-level callbacks must be re-registered by re-running `__initializeGlobals`, which the existing isInitialized check already does on the post-resume entry into any function.)

- [ ] **Step 4: Run tests to verify pass**

```bash
pnpm test:run lib/runtime/state/stateStack.test.ts 2>&1 | tee /tmp/test-step1.log
```
Expected: PASS.

- [ ] **Step 5: Run full unit test suite**

```bash
pnpm test:run lib/runtime 2>&1 | tee /tmp/test-step1-full.log
```
Expected: All previously-passing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add lib/runtime/state/stateStack.ts lib/runtime/state/stateStack.test.ts
git commit -m "Add scoped-callback storage and API to State and StateStack"
```

---

## Task 2: Add `_callback` runtime function

`_callback` is a thin wrapper: validate the hook name, then either push onto `ctx.topLevelCallbacks` (when there is no real caller frame — i.e., we're inside `__initializeGlobals`, so `stack.length <= 1`) or hand off to `StateStack.callerFrame().addScopedCallback(...)`. It does not reach into stack internals beyond that.

**Files:**
- Modify: `lib/stdlib/agency.ts` (add `_callback` export)
- Test: `lib/runtime/state/stateStack.test.ts` (extend)

- [ ] **Step 1: Write a failing test for `_callback`**

Add to `lib/runtime/state/stateStack.test.ts`:

```ts
import { _callback } from "../../stdlib/agency.js";

describe("_callback", () => {
  function ctxWithFrames(n: number): any {
    const stack = new StateStack();
    for (let i = 0; i < n; i++) stack.stack.push(new State());
    return { stateStack: stack, topLevelCallbacks: [] };
  }

  it("registers on the caller frame when stack has >= 2 frames", () => {
    const ctx = ctxWithFrames(2); // [caller, callback's own frame]
    const fn = () => {};
    _callback("onNodeStart", fn, { ctx });
    expect(ctx.stateStack.stack[0].scopedCallbacks).toEqual([{ name: "onNodeStart", fn }]);
    expect(ctx.stateStack.stack[1].scopedCallbacks).toBeUndefined();
    expect(ctx.topLevelCallbacks).toEqual([]);
  });

  it("routes to ctx.topLevelCallbacks when stack length <= 1 (module init)", () => {
    const ctx = ctxWithFrames(1); // only callback's own frame — we're at top level
    const fn = () => {};
    _callback("onNodeStart", fn, { ctx });
    expect(ctx.topLevelCallbacks).toEqual([{ name: "onNodeStart", fn }]);
    expect(ctx.stateStack.stack[0].scopedCallbacks).toBeUndefined();
  });

  it("routes to ctx.topLevelCallbacks when stack is empty (defensive)", () => {
    const ctx = ctxWithFrames(0);
    _callback("onNodeStart", () => {}, { ctx });
    expect(ctx.topLevelCallbacks).toHaveLength(1);
  });

  it("throws on unknown callback name", () => {
    const ctx = ctxWithFrames(2);
    expect(() => _callback("notAHook", () => {}, { ctx })).toThrow(/Unknown callback/);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
pnpm test:run lib/runtime/state/stateStack.test.ts 2>&1 | tee /tmp/test-step2.log
```
Expected: FAIL — `_callback` is not exported.

- [ ] **Step 3: Add `_callback` to `lib/stdlib/agency.ts`**

Add to `lib/stdlib/agency.ts` (anywhere convenient):

```ts
import { VALID_CALLBACK_NAMES, type CallbackName } from "../types/function.js";
import type { InternalFunctionState } from "../runtime/types.js"; // adjust path if needed

const VALID_NAMES: ReadonlySet<string> = new Set(VALID_CALLBACK_NAMES);

export function _callback(name: string, fn: unknown, __state: InternalFunctionState): void {
  if (!VALID_NAMES.has(name)) {
    throw new Error(`Unknown callback '${name}'. Valid: ${VALID_CALLBACK_NAMES.join(", ")}`);
  }
  const ctx = __state.ctx;
  // Top-level: we're inside __initializeGlobals. The only frame on the stack
  // is `callback`'s own (or none, defensively). There is no caller frame to
  // attach to that would survive past init, so route to ctx.topLevelCallbacks.
  if (ctx.stateStack.stack.length <= 1) {
    ctx.topLevelCallbacks.push({ name, fn });
    return;
  }
  ctx.stateStack.callerFrame().addScopedCallback(name as CallbackName, fn);
}
```

If `InternalFunctionState` lives at a different path, grep for `InternalFunctionState` to find it (`grep -rn "InternalFunctionState" lib/runtime/`).

- [ ] **Step 4: Run test to verify pass**

```bash
pnpm test:run lib/runtime/state/stateStack.test.ts 2>&1 | tee /tmp/test-step2.log
```
Expected: PASS for the `_callback` tests.

- [ ] **Step 5: Commit**

```bash
git add lib/stdlib/agency.ts lib/runtime/state/stateStack.test.ts
git commit -m "Add _callback runtime function"
```

---

## Task 3: Rewrite `callHook` to walk the stack

**Files:**
- Modify: `lib/runtime/hooks.ts`
- Test: `lib/runtime/hooks.test.ts` (new)

- [ ] **Step 1: Write failing tests for new `callHook` behavior**

Create `lib/runtime/hooks.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { callHook } from "./hooks.js";
import { State, StateStack } from "./state/stateStack.js";

function ctxWithStack(
  stack: State[],
  tsCallbacks: any = {},
  topLevelCallbacks: Array<{ name: string; fn: any }> = [],
): any {
  const stateStack = new StateStack();
  stateStack.stack = stack;
  return { stateStack, callbacks: tsCallbacks, topLevelCallbacks };
}

describe("callHook (rewritten)", () => {
  it("fires scoped callbacks innermost → outermost", async () => {
    const calls: string[] = [];
    const outer = new State();
    outer.scopedCallbacks = [{ name: "onNodeStart", fn: () => { calls.push("outer"); } }];
    const inner = new State();
    inner.scopedCallbacks = [{ name: "onNodeStart", fn: () => { calls.push("inner"); } }];
    const ctx = ctxWithStack([outer, inner]);
    await callHook({ ctx, name: "onNodeStart", data: { nodeName: "x" } } as any);
    expect(calls).toEqual(["inner", "outer"]);
  });

  it("fires TS-passed callback last", async () => {
    const calls: string[] = [];
    const inner = new State();
    inner.scopedCallbacks = [{ name: "onNodeStart", fn: () => { calls.push("scoped"); } }];
    const ctx = ctxWithStack([inner], { onNodeStart: () => { calls.push("ts"); } });
    await callHook({ ctx, name: "onNodeStart", data: { nodeName: "x" } } as any);
    expect(calls).toEqual(["scoped", "ts"]);
  });

  it("ignores callback return values (no message override)", async () => {
    const inner = new State();
    inner.scopedCallbacks = [{ name: "onLLMCallEnd", fn: () => ["overridden"] }];
    const ctx = ctxWithStack([inner]);
    const result = await callHook({ ctx, name: "onLLMCallEnd", data: {} } as any);
    expect(result).toBeUndefined();
  });

  it("catches and logs ordinary errors, continues firing others", async () => {
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls: string[] = [];
    const inner = new State();
    inner.scopedCallbacks = [
      { name: "onNodeStart", fn: () => { throw new Error("boom"); } },
      { name: "onNodeStart", fn: () => { calls.push("after"); } },
    ];
    const ctx = ctxWithStack([inner]);
    await callHook({ ctx, name: "onNodeStart", data: { nodeName: "x" } } as any);
    expect(calls).toEqual(["after"]);
    expect(consoleErr).toHaveBeenCalled();
    consoleErr.mockRestore();
  });

  it("propagates interrupt errors", async () => {
    const interrupt = Object.assign(new Error("interrupt"), { __agencyInterrupt: true });
    const inner = new State();
    inner.scopedCallbacks = [{ name: "onNodeStart", fn: () => { throw interrupt; } }];
    const ctx = ctxWithStack([inner]);
    await expect(
      callHook({ ctx, name: "onNodeStart", data: { nodeName: "x" } } as any),
    ).rejects.toBe(interrupt);
  });

  it("TS-passed onLLMCallStart return value is discarded (message override removed)", async () => {
    // The most consequential breaking change: TS consumers that returned
    // MessageJSON[] to alter the conversation no longer have that effect.
    // This test is belt-and-suspenders against the type system already
    // narrowing CallbackReturn to void.
    const ctx = ctxWithStack(
      [new State()],
      { onLLMCallStart: () => [{ role: "system", content: "OVERRIDE" }] as any },
    );
    const result = await callHook({
      ctx,
      name: "onLLMCallStart",
      data: { messages: [{ role: "user", content: "original" }] } as any,
    } as any);
    expect(result).toBeUndefined();
  });

  it("fires scoped → top-level → TS-passed (in that order)", async () => {
    const calls: string[] = [];
    const inner = new State();
    inner.scopedCallbacks = [{ name: "onNodeStart", fn: () => { calls.push("scoped"); } }];
    const ctx = ctxWithStack(
      [inner],
      { onNodeStart: () => { calls.push("ts"); } },
      [{ name: "onNodeStart", fn: () => { calls.push("topLevel"); } }],
    );
    await callHook({ ctx, name: "onNodeStart", data: { nodeName: "x" } } as any);
    expect(calls).toEqual(["scoped", "topLevel", "ts"]);
  });

  it("filters topLevelCallbacks by name", async () => {
    const calls: string[] = [];
    const ctx = ctxWithStack(
      [new State()],
      {},
      [
        { name: "onNodeStart", fn: () => { calls.push("matching"); } },
        { name: "onNodeEnd",   fn: () => { calls.push("other");    } },
      ],
    );
    await callHook({ ctx, name: "onNodeStart", data: { nodeName: "x" } } as any);
    expect(calls).toEqual(["matching"]);
  });

  it("multiple distinct callbacks for the same event all fire in order", async () => {
    const calls: string[] = [];
    const frame = new State();
    frame.addScopedCallback("onNodeStart", () => { calls.push("a"); });
    frame.addScopedCallback("onNodeStart", () => { calls.push("b"); });
    frame.addScopedCallback("onNodeStart", () => { calls.push("c"); });
    const ctx = ctxWithStack([frame]);
    await callHook({ ctx, name: "onNodeStart", data: { nodeName: "x" } } as any);
    // Single frame, so within-frame registration order applies.
    expect(calls).toEqual(["a", "b", "c"]);
  });

  it("per-instance recursion guard skips re-entry of the same fn", async () => {
    let depth = 0;
    let maxDepth = 0;
    const fn = async (data: any) => {
      depth++;
      maxDepth = Math.max(maxDepth, depth);
      if (depth < 5) {
        await callHook({ ctx, name: "onNodeStart", data } as any);
      }
      depth--;
    };
    const inner = new State();
    inner.scopedCallbacks = [{ name: "onNodeStart", fn }];
    const ctx = ctxWithStack([inner]);
    await callHook({ ctx, name: "onNodeStart", data: { nodeName: "x" } } as any);
    expect(maxDepth).toBe(1);  // never recurses
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
pnpm test:run lib/runtime/hooks.test.ts 2>&1 | tee /tmp/test-step3.log
```
Expected: FAIL — current `callHook` signature is incompatible.

- [ ] **Step 3: Rewrite `callHook` in `lib/runtime/hooks.ts`**

We split the work across three small functions so each one reads as a single idea:

- `fireWithGuard` — owns the recursion guard, error-vs-interrupt distinction, and AgencyFunction-vs-plain-function dispatch
- `gatherCallbacks` — returns the ordered list of callbacks to fire for a given hook
- `callHook` — reads as the "what": gather, fire each with guards

Replace the entire `callHook` function and the `_activeHooks` WeakMap with this:

```ts
import { AgencyFunction } from "./agencyFunction.js";
import type { RuntimeContext } from "./state/context.js";

const _activeCallbacks = new WeakSet<object>();

function isAgencyInterrupt(e: unknown): boolean {
  return !!(e && typeof e === "object" && (e as any).__agencyInterrupt === true);
}

async function invokeCallback(fn: any, data: unknown, ctx: RuntimeContext<any>): Promise<void> {
  if (fn && typeof fn === "object" && fn.__agencyFunction) {
    await fn.invoke({ type: "positional", args: [data] }, { ctx });
    return;
  }
  await fn(data);
}

async function fireWithGuard(
  fn: any,
  data: unknown,
  ctx: RuntimeContext<any>,
  errorLabel: string,
): Promise<void> {
  const key = fn as object;
  if (_activeCallbacks.has(key)) return;
  _activeCallbacks.add(key);
  try {
    await invokeCallback(fn, data, ctx);
  } catch (error) {
    if (isAgencyInterrupt(error)) throw error;
    console.error(`[agency] ${errorLabel} callback error:`, error);
  } finally {
    _activeCallbacks.delete(key);
  }
}

function gatherCallbacks<K extends keyof CallbackMap>(
  ctx: RuntimeContext<any>,
  name: K,
): any[] {
  // Order: innermost stack-frame scoped callbacks → outermost → top-level
  // (registered during module init) → TS-passed callback. Top-level comes
  // after stack-walked because conceptually they are "the outermost scope".
  const scoped = ctx.stateStack.collectScopedCallbacks(name);
  const topLevel = ctx.topLevelCallbacks
    .filter((cb) => cb.name === name)
    .map((cb) => cb.fn);
  const tsCb = ctx.callbacks[name];
  const out = [...scoped, ...topLevel];
  if (tsCb) out.push(tsCb);
  return out;
}

export async function callHook<K extends keyof CallbackMap>(args: {
  ctx: RuntimeContext<any>;
  name: K;
  data: CallbackMap[K];
}): Promise<void> {
  const { ctx, name, data } = args;

  for (const fn of _globalHooks[name] ?? []) {
    await fireWithGuard(fn, data, ctx, `global ${name}`);
  }
  for (const fn of gatherCallbacks(ctx, name)) {
    await fireWithGuard(fn, data, ctx, name);
  }
}
```

Narrow the `CallbackReturn` type:
```ts
export type CallbackReturn<K extends keyof CallbackMap> = void;
```

Delete the old `_activeHooks` WeakMap declaration entirely.

Update the `AgencyCallbacks` type signature so it no longer references message-override returns:
```ts
export type AgencyCallbacks = {
  [K in keyof CallbackMap]?: (data: CallbackMap[K]) => void | Promise<void>;
};
```

**Note on the warn that's NOT here:** I considered emitting a `console.warn` when a callback returns a non-undefined value, to flag the breaking change for TS callers. Decided against it: it's not in the spec, it would fire on every LLM call for any consumer who hadn't migrated yet (creating noise more than signal), and it would have its own removal cost. The release notes already document the change.

- [ ] **Step 4: Run hooks tests to verify pass**

```bash
pnpm test:run lib/runtime/hooks.test.ts 2>&1 | tee /tmp/test-step3.log
```
Expected: PASS.

- [ ] **Step 5: Type-check the project**

```bash
pnpm run typecheck 2>&1 | tee /tmp/typecheck-step3.log
```
Expected: Will fail in places that still call `callHook({ callbacks, name, data })` instead of `({ ctx, name, data })`, or consume return values. That's OK — Task 4 fixes those call sites.

- [ ] **Step 6: Commit**

```bash
git add lib/runtime/hooks.ts lib/runtime/hooks.test.ts
git commit -m "Rewrite callHook to walk stack frames and drop message overrides"
```

---

## Task 4: Update `callHook` call sites

**Files:**
- Modify: `lib/runtime/prompt.ts` (lines ~57, ~189, ~481, ~607)
- Modify: `lib/runtime/node.ts` (lines ~153, ~201)

- [ ] **Step 1: Update `lib/runtime/node.ts` call sites**

Open `lib/runtime/node.ts`. There are two `callHook(...)` calls (lines ~153 and ~201). Change each from `callbacks: ctx.callbacks` to `ctx`:

```ts
// Before
await callHook({
  callbacks: ctx.callbacks,
  name: "onNodeStart",   // (or whichever)
  data: { ... },
});

// After
await callHook({
  ctx,
  name: "onNodeStart",
  data: { ... },
});
```

- [ ] **Step 2: Update `lib/runtime/prompt.ts` call sites**

Open `lib/runtime/prompt.ts`. There are four `callHook(...)` calls:

**Site 1 (~line 57, `onLLMCallStart`):** Currently:
```ts
const startHookResult = await callHook({
  callbacks: ctx.callbacks,
  name: "onLLMCallStart",
  data: { ... },
});
if (startHookResult) {
  messages = MessageThread.fromJSON(startHookResult);
}
```

Change to:
```ts
await callHook({
  ctx,
  name: "onLLMCallStart",
  data: { ... },
});
```

Delete the `if (startHookResult)` block entirely — message override is gone.

**Site 2 (~line 189, `onLLMCallEnd`):** Same pattern. The variable is `endHookResult` and it currently does `messages = MessageThread.fromJSON(endHookResult)`. Delete that block; change the call to use `ctx`.

**Site 3 (~line 481, `onToolCallStart`):** Just change `callbacks: ctx.callbacks` to `ctx`.

**Site 4 (~line 607, `onToolCallEnd`):** Same — change `callbacks: ctx.callbacks` to `ctx`.

Confirm there are no other call sites:
```bash
grep -rn "callHook(" lib/runtime 2>&1 | tee /tmp/call-sites.log
```
Expected output: exactly the 6 sites updated (4 in prompt.ts, 2 in node.ts).

- [ ] **Step 3: Type-check**

```bash
pnpm run typecheck 2>&1 | tee /tmp/typecheck-step4.log
```
Expected: PASS (or only errors unrelated to callHook).

- [ ] **Step 4: Run runtime unit tests**

```bash
pnpm test:run lib/runtime 2>&1 | tee /tmp/test-step4.log
```
Expected: PASS. (The old `callback-basic.agency` end-to-end test will still pass at this point because the `_registeredCallbacks` path still exists — we haven't removed it yet.)

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/prompt.ts lib/runtime/node.ts
git commit -m "Update callHook call sites to pass ctx and drop message overrides"
```

---

## Task 5: Add `callback` stdlib Agency function

**Files:**
- Modify: `stdlib/agency.agency`
- Build artifact: `stdlib/agency.js` (regenerated by `make`)

- [ ] **Step 1: Add the Agency wrapper to `stdlib/agency.agency`**

At the top of `stdlib/agency.agency`, add `_callback` to the existing import:

```
import { _compile, _compileFile, _callback } from "agency-lang/stdlib-lib/agency.js"
```

Then add this exported function (anywhere after the imports, e.g. just before the existing `compile` function):

```
export def callback(name: string, fn: (any) => any) {
  """
  Register a scoped callback for the dynamic extent of the calling function or node.
  When the caller returns, the callback is automatically removed.

  @param name - One of the Agency callback hook names (e.g. "onNodeStart", "onLLMCallEnd")
  @param fn - A function that receives the event data
  """
  _callback(name, fn)
}
```

**Note on name typing:** The spec proposes a literal-union overload on `name` for compile-time misspell detection. The Agency language may not natively support literal-string unions in parameter types today — verify with `pnpm run a test` on a small fixture, and if literal unions don't compile, accept `name: string` with runtime-only validation in `_callback` for v1. The runtime check raises a clear error, so safety isn't compromised, only ergonomics.

- [ ] **Step 2: Run `make` to regenerate `stdlib/agency.js`**

```bash
make 2>&1 | tee /tmp/make-step5.log
```
Expected: `stdlib/agency.js` is updated.

Inspect the diff briefly:
```bash
git diff stdlib/agency.js | head -80
```
Expected: A new compiled function `callback` and a setup block.

- [ ] **Step 3: Commit**

```bash
git add stdlib/agency.agency stdlib/agency.js
git commit -m "Add callback Agency stdlib function"
```

---

## Task 6: Agency execution test — scoped callback fires inside dynamic extent

**Files:**
- Create: `tests/agency/callback-scoped.agency`
- Create: `tests/agency/callback-scoped.test.json`
- Build: `tests/agency/callback-scoped.js` (via `make fixtures`)

- [ ] **Step 1: Write the failing test fixture**

Create `tests/agency/callback-scoped.agency`:

```
import { callback } from "std::agency"

let fireCount: number = 0

def helper(): string {
  return "hello"
}

def withCallback(): boolean {
  callback("onFunctionStart") as data {
    fireCount = fireCount + 1
  }
  helper()
  helper()
  return true
}

node main() {
  withCallback()
  helper()           // should NOT trigger the callback — outside the scope
  withCallback()     // re-enters the wrapper; previous callback must be gone,
                     // a fresh one registers and fires for the two inner helpers
  helper()           // should NOT trigger
  return fireCount
}
```

Create `tests/agency/callback-scoped.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "4",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "scoped callback fires only inside its scope; cleanup makes repeated wrapper calls behave independently"
    }
  ]
}
```

The expected count (4) verifies two things: (a) callbacks fire only inside the wrapper scope (not for the two outside `helper()` calls — otherwise we'd see 5 or 6), and (b) the cleanup on first return actually pops the callback (otherwise the second call's helpers would fire BOTH the old and new callbacks, giving 6).

- [ ] **Step 2: Generate the fixture .js file**

```bash
make fixtures 2>&1 | tee /tmp/fixtures-step6.log
```
Expected: `tests/agency/callback-scoped.js` is created.

- [ ] **Step 3: Run the test**

```bash
pnpm run a test tests/agency/callback-scoped.agency 2>&1 | tee /tmp/test-step6.log
```
Expected: PASS with output `4`.

If FAIL: the most likely causes are (a) `_callback` not attaching to the right frame, (b) `callHook` not walking the stack, or (c) `make fixtures` didn't pick up the changes. Re-read the logs and the implementation in Tasks 1–4.

- [ ] **Step 4: Commit**

```bash
git add tests/agency/callback-scoped.agency tests/agency/callback-scoped.test.json tests/agency/callback-scoped.js
git commit -m "Add scoped callback execution test"
```

---

## Task 7: Migrate existing `callback`-keyword usage to new syntax

**Files:**
- Modify: `tests/agency/callback-basic.agency`
- Build: `tests/agency/callback-basic.js` (via `make fixtures`)
- Modify: `lib/agents/policy/agent.agency`

- [ ] **Step 1: Migrate `tests/agency/callback-basic.agency`**

Replace the current file contents with:

```
import { callback } from "std::agency"

let callbackFired: boolean = false

def helper(): string {
  return "hello"
}

node main() {
  callback("onFunctionStart") as data {
    callbackFired = true
  }
  let result = helper()
  return callbackFired
}
```

- [ ] **Step 2: Migrate `lib/agents/policy/agent.agency`**

Open the file. At the top (after the existing imports), add:
```
import { callback } from "std::agency"
```

Replace lines 9-15 (the two file-level callbacks) with a placeholder: the existing callbacks fire on every tool call, so we want them active for the whole run. Add this at the start of `node main()` (around line 111):

```
  callback("onToolCallStart") as data {
    print("Calling ${data.toolName}...")
  }
  callback("onToolCallEnd") as data {
    print("Finished calling ${data.toolName}.")
  }
```

Delete the two old file-level callback declarations.

- [ ] **Step 3: Regenerate fixtures**

```bash
make fixtures 2>&1 | tee /tmp/fixtures-step7.log
```
Expected: `tests/agency/callback-basic.js` rebuilt.

- [ ] **Step 4: Run callback-basic test**

```bash
pnpm run a test tests/agency/callback-basic.agency 2>&1 | tee /tmp/test-step7-basic.log
```
Expected: PASS with output `true`.

- [ ] **Step 5: Verify the policy agent still compiles**

```bash
pnpm run compile lib/agents/policy/agent.agency 2>&1 | tee /tmp/test-step7-policy.log
```
Expected: PASS (compiles cleanly).

- [ ] **Step 6: Run full agency test suite**

```bash
pnpm test:run 2>&1 | tee /tmp/test-step7-full.log
```
Expected: All previously-passing tests still pass.

- [ ] **Step 7: Commit**

```bash
git add tests/agency/callback-basic.agency tests/agency/callback-basic.js lib/agents/policy/agent.agency
git commit -m "Migrate existing callback keyword usage to new function form"
```

---

## Task 8: Remove the `callback` keyword from the parser

**Files:**
- Modify: `lib/parsers/parsers.ts` (lines ~3233, ~3540-3577)
- Modify: `lib/types/function.ts` (remove `callback?: boolean` field)
- Modify: `lib/parsers/function.test.ts` (remove/update tests of the old syntax)

- [ ] **Step 1: Remove keyword from `_baseFunctionParser`**

In `lib/parsers/parsers.ts`, find the line:
```ts
capture(or(str("callback"), str("def")), "keyword"),
```
(currently around line 3233). Change to:
```ts
capture(str("def"), "keyword"),
```

- [ ] **Step 2: Remove the `isCallback` branch**

In the same file, around lines 3540–3577, delete the entire `if (isCallback) { ... }` block and the `const isCallback = keyword === "callback";` line. Also delete the `VALID_CALLBACK_NAMES` import at the top of `parsers.ts` (line 67) if no other code in the file uses it (grep to confirm: `grep -n VALID_CALLBACK_NAMES lib/parsers/parsers.ts`).

- [ ] **Step 3: Remove `callback?: boolean` from `FunctionDefinition`**

In `lib/types/function.ts`, delete the `callback?: boolean;` field from the `FunctionDefinition` type.

- [ ] **Step 4: Add a regression test — `callback X(data) { ... }` no longer parses**

In `lib/parsers/function.test.ts`, find any test that validates the old `callback` keyword. Delete those tests, or convert one into a "parser rejects callback keyword" test. The file already imports `functionParser` from `./parsers.js` and `parseAgency` from `@/parser.js` — use whichever shape the surrounding tests use:

```ts
it("rejects the old callback keyword syntax", () => {
  const src = "callback onNodeStart(data) { print(data) }";
  const result = functionParser(src);  // or parseAgency(src) for whole-program parsing
  expect(result.success).toBe(false);
});
```

If the existing test infrastructure makes this awkward, just delete the old tests.

- [ ] **Step 5: Type-check**

```bash
pnpm run typecheck 2>&1 | tee /tmp/typecheck-step8.log
```
Expected: Errors will surface in `lib/backends/typescriptBuilder.ts` (the `node.callback` reference) and `lib/backends/agencyGenerator.ts` (line 658). Those are fixed in the next task. Note them but proceed.

- [ ] **Step 6: Commit**

```bash
git add lib/parsers/parsers.ts lib/types/function.ts lib/parsers/function.test.ts
git commit -m "Remove callback keyword from parser and AST"
```

---

## Task 9: Remove keyword emission from backends

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts` (~line 1650)
- Modify: `lib/backends/agencyGenerator.ts` (~line 658)

- [ ] **Step 1: Drop the `_registeredCallbacks` emission**

In `lib/backends/typescriptBuilder.ts`, find:
```ts
if (node.callback) {
  return ts.statements([
    funcDecl,
    exportedConst,
    ts.raw(`__globalCtx._registeredCallbacks.${functionName} = ${functionName};`),
  ]);
}
```
Delete this entire `if` block. The next line (`return ts.statements([funcDecl, exportedConst]);`) becomes the only return path.

- [ ] **Step 2: Drop the `"callback"` prefix in the formatter**

In `lib/backends/agencyGenerator.ts`, find the line:
```ts
prefixes.push(node.callback ? "callback" : "def");
```
Change to:
```ts
prefixes.push("def");
```

- [ ] **Step 3: Type-check**

```bash
pnpm run typecheck 2>&1 | tee /tmp/typecheck-step9.log
```
Expected: PASS (no remaining `node.callback` references in these files).

- [ ] **Step 4: Run unit + agency tests**

```bash
pnpm test:run 2>&1 | tee /tmp/test-step9.log
```
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/backends/typescriptBuilder.ts lib/backends/agencyGenerator.ts
git commit -m "Drop callback keyword emission from typescript builder and formatter"
```

---

## Task 10: Remove `_registeredCallbacks` and `installRegisteredCallbacks`

**Files:**
- Modify: `lib/runtime/state/context.ts` (lines ~109-118 and ~342-352, plus line ~244)
- Modify: `lib/runtime/node.ts` (line ~136)
- Modify: `lib/runtime/interrupts.ts` (line ~378)
- Modify: `lib/runtime/rewind.ts` (line ~41)

- [ ] **Step 1: Delete `_registeredCallbacks` declaration in context.ts**

In `lib/runtime/state/context.ts`, delete:
- The `_registeredCallbacks: Partial<...> = {};` field declaration (around lines 109-118, including the surrounding comment block).
- The `execCtx._registeredCallbacks = {};` line in `createExecutionContext` (line ~244).
- The entire `installRegisteredCallbacks(source: RuntimeContext<T>): void { ... }` method (lines ~342-352).

- [ ] **Step 2: Delete calls to `installRegisteredCallbacks`**

In `lib/runtime/node.ts` line ~136: delete the `execCtx.installRegisteredCallbacks(ctx);` call.
In `lib/runtime/interrupts.ts` line ~378: same — delete the call.
In `lib/runtime/rewind.ts` line ~41: same — delete the call.

Verify nothing else references it:
```bash
grep -rn "installRegisteredCallbacks\|_registeredCallbacks" lib/ 2>&1 | tee /tmp/grep-step10.log
```
Expected output: zero matches.

- [ ] **Step 3: Type-check and run tests**

```bash
pnpm run typecheck 2>&1 | tee /tmp/typecheck-step10.log
pnpm test:run 2>&1 | tee /tmp/test-step10.log
```
Expected: Both PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/runtime/state/context.ts lib/runtime/node.ts lib/runtime/interrupts.ts lib/runtime/rewind.ts
git commit -m "Remove _registeredCallbacks and installRegisteredCallbacks"
```

---

## Task 11: Agency test — nested scope execution order

**Files:**
- Create: `tests/agency/callback-nested.agency` + `.test.json`

- [ ] **Step 1: Write the test fixture**

Create `tests/agency/callback-nested.agency`. This test exercises both cross-frame order (innermost → outermost) AND within-frame order (registration order on the same frame):

```
import { callback } from "std::agency"

let order: string = ""

def helper() {
  return "x"
}

def outer() {
  // Two callbacks on the SAME frame for the same event — should fire in
  // registration order (outerA then outerB) after any inner callbacks.
  callback("onFunctionStart") as data {
    if (data.functionName == "helper") {
      order = order + "outerA,"
    }
  }
  callback("onFunctionStart") as data {
    if (data.functionName == "helper") {
      order = order + "outerB,"
    }
  }
  inner()
}

def inner() {
  callback("onFunctionStart") as data {
    if (data.functionName == "helper") {
      order = order + "inner,"
    }
  }
  helper()
}

node main() {
  outer()
  return order
}
```

Create `tests/agency/callback-nested.test.json`:
```json
{
  "tests": [{
    "nodeName": "main",
    "input": "",
    "expectedOutput": "inner,outerA,outerB,",
    "evaluationCriteria": [{ "type": "exact" }],
    "description": "nested callbacks fire innermost-first across frames, registration-order within a frame"
  }]
}
```

Expected ordering proves:
- `inner` fires first (innermost frame)
- Then `outerA`, `outerB` (outer frame, in registration order)

If `outerB,outerA,` appears instead, within-frame iteration is backwards. If `outerA,outerB,inner,` appears, the cross-frame direction is wrong.

- [ ] **Step 2: Generate fixture and run test**

```bash
make fixtures && pnpm run a test tests/agency/callback-nested.agency 2>&1 | tee /tmp/test-step11.log
```
Expected: PASS with output `inner,outerA,outerB,`.

- [ ] **Step 3: Commit**

```bash
git add tests/agency/callback-nested.agency tests/agency/callback-nested.test.json tests/agency/callback-nested.js
git commit -m "Add nested scoped callback test (innermost-first ordering)"
```

---

## Task 12: Agency test — recursion guard

**Files:**
- Create: `tests/agency/callback-recursion.agency` + `.test.json`

- [ ] **Step 1: Write the fixture**

Create `tests/agency/callback-recursion.agency`:

```
import { callback } from "std::agency"

let fireCount: number = 0

def doWork(): string {
  return "x"
}

node main() {
  callback("onFunctionStart") as data {
    fireCount = fireCount + 1
    // Calling doWork inside the callback would normally re-fire onFunctionStart.
    // The recursion guard should skip the re-entry of this same callback.
    doWork()
  }
  doWork()
  return fireCount
}
```

Create `tests/agency/callback-recursion.test.json`:
```json
{
  "tests": [{
    "nodeName": "main",
    "input": "",
    "expectedOutput": "1",
    "evaluationCriteria": [{ "type": "exact" }],
    "description": "per-instance recursion guard prevents self-reentry"
  }]
}
```

- [ ] **Step 2: Generate fixture and run test**

```bash
make fixtures && pnpm run a test tests/agency/callback-recursion.agency 2>&1 | tee /tmp/test-step12.log
```
Expected: PASS with output `1`.

- [ ] **Step 3: Commit**

```bash
git add tests/agency/callback-recursion.agency tests/agency/callback-recursion.test.json tests/agency/callback-recursion.js
git commit -m "Add callback recursion guard test"
```

---

## Task 13: Agency test — fork inheritance

**Files:**
- Create: `tests/agency/callback-fork.agency` + `.test.json`

- [ ] **Step 1: Write the fixture**

Look at an existing fork-based fixture first to copy the syntax — try `tests/agency/fork-basic.agency` or grep for `fork`:

```bash
grep -ln "^[[:space:]]*fork\b" tests/agency/*.agency 2>&1 | head -3
```

Create `tests/agency/callback-fork.agency` (adjust for the exact fork syntax in the repo). Both branches register their own scoped callback, so we can verify each only sees its own — not the sibling's:

```
import { callback } from "std::agency"

let outerCount: number = 0
let aCount: number = 0
let bCount: number = 0

def helper(): string {
  return "x"
}

node main() {
  callback("onFunctionStart") as data {
    if (data.functionName == "helper") {
      outerCount = outerCount + 1
    }
  }
  // Both branches inherit `outerCount`'s callback. Each branch also registers
  // its own scoped callback. Branches must not see each other's registrations.
  fork {
    callback("onFunctionStart") as data {
      if (data.functionName == "helper") {
        aCount = aCount + 1
      }
    }
    helper()
  } and {
    callback("onFunctionStart") as data {
      if (data.functionName == "helper") {
        bCount = bCount + 1
      }
    }
    helper()
  }
  return [outerCount, aCount, bCount]
}
```

Expected behavior:
- `outerCount`: 2 — outer callback fires for the `helper()` in both branches
- `aCount`: 1 — only branch A's helper triggers A's own callback
- `bCount`: 1 — only branch B's helper triggers B's own callback

If branches shared state (the bug case), `aCount` or `bCount` would equal 2.

(If your `fork` syntax differs, adjust. The point is to assert callback isolation between siblings AND verify the outer callback is inherited by both.)

Create `tests/agency/callback-fork.test.json`:
```json
{
  "tests": [{
    "nodeName": "main",
    "input": "",
    "expectedOutput": "[2,1,1]",
    "evaluationCriteria": [{ "type": "exact" }],
    "description": "fork branches inherit pre-fork callbacks but isolate post-fork ones"
  }]
}
```

- [ ] **Step 2: Generate and run**

```bash
make fixtures && pnpm run a test tests/agency/callback-fork.agency 2>&1 | tee /tmp/test-step13.log
```
Expected: PASS.

If the test fails because forked branches don't share the parent stack frame's callbacks: this is the bug to chase. Check that `forkStack()` in `lib/runtime/state/context.ts` does NOT clear `scopedCallbacks` on the inherited frames. (See comment at line ~306 about how `forkStack` works.) If sibling isolation fails (aCount or bCount > 1), that means branches are sharing a callback array — investigate the JSON deep-clone in serialization.

- [ ] **Step 3: Commit**

```bash
git add tests/agency/callback-fork.agency tests/agency/callback-fork.test.json tests/agency/callback-fork.js
git commit -m "Add callback fork-inheritance test"
```

---

## Task 14: Agency test — top-level callback

**Files:**
- Create: `tests/agency/callback-toplevel.agency` + `.test.json`

- [ ] **Step 1: Write the fixture**

```
import { callback } from "std::agency"

let fireCount: number = 0

callback("onFunctionStart") as data {
  fireCount = fireCount + 1
}

def helper(): string {
  return "x"
}

node main() {
  helper()
  helper()
  return fireCount
}
```

Create `tests/agency/callback-toplevel.test.json`:
```json
{
  "tests": [{
    "nodeName": "main",
    "input": "",
    "expectedOutput": "2",
    "evaluationCriteria": [{ "type": "exact" }],
    "description": "top-level callback fires for the whole run"
  }]
}
```

- [ ] **Step 2: Generate and run**

```bash
make fixtures && pnpm run a test tests/agency/callback-toplevel.agency 2>&1 | tee /tmp/test-step14.log
```
Expected: PASS with output `2`.

This test exercises the `ctx.topLevelCallbacks` routing path added in Tasks 1–3. When `callback(...)` runs at module top-level, `__initializeGlobals` has not yet pushed a node frame, so `_callback` sees `stack.length <= 1` and routes the registration to `ctx.topLevelCallbacks` (which persists for the whole run) instead of the about-to-be-popped frame. `callHook`'s `gatherCallbacks` then includes those alongside stack-walked ones.

If FAIL: confirm `__initializeGlobals` actually ran (grep the generated `.js` for the call to `callback(...)` inside the init function). If init ran but the callback never fired, verify (a) `_callback` is pushing into `ctx.topLevelCallbacks` (add a `console.log` in `_callback`), and (b) `gatherCallbacks` is reading `ctx.topLevelCallbacks` and filtering by name correctly.

- [ ] **Step 3: Commit**

```bash
git add tests/agency/callback-toplevel.agency tests/agency/callback-toplevel.test.json tests/agency/callback-toplevel.js
git commit -m "Add top-level callback test"
```

---

## Task 15: Agency test — interrupt caught by handler inside callback

**Files:**
- Create: `tests/agency/callback-interrupt-handler.agency` + `.test.json`

- [ ] **Step 1: Write the fixture**

This test asserts: an interrupt thrown inside a callback body, caught by a `handle` block higher up, returns control normally.

Look at existing handler tests to copy syntax:
```bash
grep -ln "^handle\b\| handle " tests/agency/*.agency 2>&1 | head -3
```

Skeleton (adjust to actual interrupt syntax used in repo):

```
import { callback } from "std::agency"

let caught: boolean = false

def helper(): string {
  return "x"
}

node main() {
  handle BudgetExceeded {
    caught = true
  } default {
    callback("onFunctionStart") as data {
      interrupt BudgetExceeded("over budget")
    }
    helper()
  }
  return caught
}
```

Create the `.test.json`:
```json
{
  "tests": [{
    "nodeName": "main",
    "input": "",
    "expectedOutput": "true",
    "evaluationCriteria": [{ "type": "exact" }],
    "description": "interrupt thrown from callback body is caught by enclosing handle block"
  }]
}
```

- [ ] **Step 2: Generate and run**

```bash
make fixtures && pnpm run a test tests/agency/callback-interrupt-handler.agency 2>&1 | tee /tmp/test-step15.log
```
Expected: PASS.

If FAIL: check that the `try/catch` in `callHook` re-throws interrupts (`isAgencyInterrupt(e)` check from Task 3). Also confirm Agency's interrupt error class matches what `isAgencyInterrupt` looks for — grep `interrupt.*class\|__agencyInterrupt` in `lib/runtime/interrupts.ts` to find the actual flag name.

- [ ] **Step 3: Commit**

```bash
git add tests/agency/callback-interrupt-handler.agency tests/agency/callback-interrupt-handler.test.json tests/agency/callback-interrupt-handler.js
git commit -m "Add callback interrupt+handler test"
```

---

## Task 16: Agency test — serialization round-trip across interrupts

**Files:**
- Create: `tests/agency/callback-resume.agency` + `.test.json`

- [ ] **Step 1: Write the fixture**

This test asserts: when an interrupt fires (handled by the host/runner via standard serialization), and the run resumes, scoped callbacks are still active.

Look at existing resume tests:
```bash
grep -ln "interrupt\|approveInterrupt" tests/agency/*.agency 2>&1 | head -5
```

The danger here is a test that PASSES for the wrong reason — if the runtime never actually serialized, the in-memory callback survives trivially. We need a structural assertion that resume actually went through the deserialize path. The simplest way: capture data from the interrupt-response value (which only exists after deserialize) and verify the callback observed it.

Skeleton (adjust to actual interrupt + response syntax used in repo — grep `interruptResponses` in existing `tests/agency/*.test.json` files):

```
import { callback } from "std::agency"
import { interruptForInput } from "std::system"  // or whichever interrupt your repo uses

let fireCountAfterResume: number = 0
let observedInResume: string = ""

def helper(): string {
  return "x"
}

node main() {
  callback("onFunctionStart") as data {
    if (data.functionName == "helper") {
      fireCountAfterResume = fireCountAfterResume + 1
      // observedInResume is set BELOW the interrupt; if the test sees
      // this string survive into the callback firing, we know the
      // callback was invoked on the post-resume side and the local
      // var was rehydrated from the deserialized stack.
      observedInResume = observedInResume + "fired-after-resume,"
    }
  }
  // Trigger an interrupt the runner handles via serialize/resume
  let answer = interruptForInput("continue?")
  // Anything below this line only executes after deserialize.
  helper()
  return observedInResume
}
```

Expected output: `"fired-after-resume,"`. If the callback didn't survive the round trip, `observedInResume` stays empty.

The `.test.json` would specify the interrupt response (look at `tests/agency/<file>.test.json` examples that include `interruptResponses` for the format).

- [ ] **Step 2: Generate and run**

```bash
make fixtures && pnpm run a test tests/agency/callback-resume.agency 2>&1 | tee /tmp/test-step16.log
```
Expected: PASS — callback fires after resume.

If FAIL: verify that `State.toJSON`/`fromJSON` actually persist `scopedCallbacks`. Also verify the function-ref reviver round-trips the callback's `fn`. Check `lib/runtime/revivers/functionRefReviver.test.ts` for the existing function serialization tests.

- [ ] **Step 3: Commit**

```bash
git add tests/agency/callback-resume.agency tests/agency/callback-resume.test.json tests/agency/callback-resume.js
git commit -m "Add callback resume-across-interrupt test"
```

---

## Task 17: Agency test — non-block callback forms (named function + PFA)

Every test fixture so far uses `as data { ... }` block form. The spec also calls out named-function and partial-application forms. These exercise different paths through Agency's function-value infrastructure (block vs. plain `AgencyFunction` vs. `AgencyFunction` with bound args), and each could fail independently.

**Files:**
- Create: `tests/agency/callback-function-forms.agency` + `.test.json`

- [ ] **Step 1: Write the fixture**

```
import { callback } from "std::agency"

let blockCount: number = 0
let namedCount: number = 0
let pfaSeen: string = ""

def helper(): string {
  return "x"
}

// Named function used as a callback target.
def onNamed(data: any) {
  if (data.functionName == "helper") {
    namedCount = namedCount + 1
  }
}

// Function intended for partial application — the first arg is bound by
// the call site, the second is the actual hook data.
def onPfa(prefix: string, data: any) {
  if (data.functionName == "helper") {
    pfaSeen = pfaSeen + prefix
  }
}

node main() {
  // Form 1: as-block (already covered elsewhere; included as sanity)
  callback("onFunctionStart") as data {
    if (data.functionName == "helper") {
      blockCount = blockCount + 1
    }
  }

  // Form 2: named function
  callback("onFunctionStart", onNamed)

  // Form 3: partial application — `prefix` is bound, leaving a 1-arg fn
  callback("onFunctionStart", onPfa.partial(prefix: "[hit]"))

  helper()
  return [blockCount, namedCount, pfaSeen]
}
```

Create `tests/agency/callback-function-forms.test.json`:
```json
{
  "tests": [{
    "nodeName": "main",
    "input": "",
    "expectedOutput": "[1,1,\"[hit]\"]",
    "evaluationCriteria": [{ "type": "exact" }],
    "description": "callback accepts as-block, named function, and partial-application function forms"
  }]
}
```

- [ ] **Step 2: Generate and run**

```bash
make fixtures && pnpm run a test tests/agency/callback-function-forms.agency 2>&1 | tee /tmp/test-step17.log
```
Expected: PASS with output `[1,1,"[hit]"]`.

If the named-function form fails: check that `invokeCallback` in `lib/runtime/hooks.ts` correctly dispatches to `AgencyFunction.invoke` for callbacks that are AgencyFunctions (not just plain TS functions).

If the PFA form fails: the bound argument isn't being applied. Look at how `__call` and `AgencyFunction.partial` interact — the `data` arg the runtime passes should be slotted into the unbound parameter slot.

If the as-block form fails: blocks should compile to AgencyFunctions just like named functions, so a failure here likely indicates the same `invokeCallback` dispatch bug.

- [ ] **Step 3: Commit**

```bash
git add tests/agency/callback-function-forms.agency tests/agency/callback-function-forms.test.json tests/agency/callback-function-forms.js
git commit -m "Add test for callback non-block forms (named function, PFA)"
```

---

## Task 18: Update documentation

**Files:**
- Modify: `docs/site/appendix/callbacks.md`
- Modify: `docs/misc/lifecycleHooks.md`
- Modify: any of `docs/site/guide/llm.md`, `docs/site/guide/ts-interop.md`, `docs/site/guide/mcp.md` that mention `callback`

- [ ] **Step 1: Rewrite `docs/site/appendix/callbacks.md`**

Replace the section on "Callbacks in Agency files" with the new function-based form:

```markdown
## Callbacks in Agency files

```
import { callback } from "std::agency"

callback("onNodeStart") as data {
  print(`Node ${data.nodeName} started.`)
}
```

Callbacks are scoped to the dynamic extent of the function or node that called `callback(...)`. When that function/node returns, the callback is automatically unregistered. Top-level callbacks (outside any function or node) are active for the whole run.
```

Also remove every "can return a `MessageJSON[]` to override messages" note.

- [ ] **Step 2: Rewrite `docs/misc/lifecycleHooks.md`**

Delete the entire "Modifying Messages in LLM Hooks" section. Update the table to drop any "can return MessageJSON[]" notes.

- [ ] **Step 3: Grep for and update other doc mentions**

```bash
grep -rln "callback onNodeStart\|callback on[A-Z]" docs/ 2>&1 | tee /tmp/grep-docs.log
```

For each file in the output, update the example to use the new function form.

- [ ] **Step 4: Commit**

```bash
git add docs/
git commit -m "Update docs for scoped callback function syntax"
```

---

## Task 19: Final verification

- [ ] **Step 1: Build everything**

```bash
make 2>&1 | tee /tmp/make-final.log
```
Expected: clean build.

- [ ] **Step 2: Run the full test suite**

```bash
pnpm test:run 2>&1 | tee /tmp/test-final.log
```
Expected: all tests PASS.

- [ ] **Step 3: Run lint**

```bash
pnpm run lint:structure 2>&1 | tee /tmp/lint-final.log
```
Expected: no new violations.

- [ ] **Step 4: Spot-check generated outputs**

For one of the new test fixtures, verify the compiled `.js` looks reasonable:

```bash
cat tests/agency/callback-scoped.js | grep -A 3 "_callback\|callback(" | head -40
```
Expected: see `_callback` being called via `__call`, with `ctx: __ctx` in the state object.

- [ ] **Step 5: Confirm no dead references remain**

```bash
grep -rn "_registeredCallbacks\|installRegisteredCallbacks\|node.callback" lib/ 2>&1 | tee /tmp/grep-dead.log
```
Expected: zero matches.

- [ ] **Step 6: Final commit (if anything has changed)**

```bash
git status
# If anything is uncommitted that belongs to this work, commit it with a descriptive message.
```

---

## Done

When all 19 tasks are checked off:

- `callback` is an importable Agency stdlib function (no longer a keyword)
- Scoped callbacks live on stack frames, clean up on frame pop, and survive interrupts
- `callHook` walks the active stack (innermost → outermost), then TS callbacks
- Message-override capability is removed from `onLLMCallStart`/`onLLMCallEnd` across the board
- All existing callback usages in the repo are migrated
- Seven new Agency tests cover scoping (with cleanup across multiple wrapper calls), nested ordering across frames and within a frame, recursion, fork (with both branches registering), top-level, interrupt-with-handler, resume-across-serialization, and non-block forms (named function + PFA)
- Unit tests cover the State/StateStack API, `_callback`, `callHook` ordering and TS-return-discard, recursion guard, and interrupt propagation
- Docs reflect the new design

Open items deferred to follow-up work (per spec):
- Interrupt() escaping a callback body unhandled — currently undefined behavior
- Return-value-driven control flow (callback returns a `failure`) — see cost-and-guard-tracking spec
