# Callback Interrupts — Phase 0: Plumbing

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `callHook` and its inner helpers so that callbacks can return interrupts back to their caller instead of having them swallowed. Add concurrent-interrupt batching so multiple callbacks on the same hook can each raise an interrupt and have them all collected. No user-visible behavior change — every existing call site is migrated to a fire-and-forget wrapper that preserves today's "log + drop" semantics.

**Architecture:** Change `callHook`'s return type from `Promise<void>` to `Promise<Interrupt[] | undefined>`. Have `invokeCallback` and `fireWithGuard` return interrupts instead of throwing. Loop over all registered callbacks in `callHook`, collecting their interrupts into a single batch (mirroring `runForkAll`'s shape, minus the per-branch state machinery — callbacks are sequential, not parallel). Introduce a `callHookAndDrop(args, label)` helper that wraps `callHook` for callers that aren't yet ready to handle propagation, and migrate all six existing call sites in `lib/runtime/node.ts` and `lib/runtime/prompt.ts` to use it. Phase 1 will replace the codegen-emitted call sites with a different wrapper that actually propagates.

**Tech Stack:** TypeScript runtime (`lib/runtime/hooks.ts`, `lib/runtime/node.ts`, `lib/runtime/prompt.ts`), vitest unit tests.

**Prerequisites:** None. This phase touches only `lib/runtime/` — no codegen, no template, no AST, no preprocessor changes. Phase 1 depends on this PR being merged.

---

## File Structure

- **Modify:** `lib/runtime/hooks.ts` — change return types of `callHook` / `invokeCallback` / `fireWithGuard`, add interrupt collection loop, add `callHookAndDrop` export.
- **Modify:** `lib/runtime/node.ts` — replace 2 existing `await callHook(...)` calls with `await callHookAndDrop(...)`.
- **Modify:** `lib/runtime/prompt.ts` — replace 4 existing `await callHook(...)` calls with `await callHookAndDrop(...)`.
- **Create:** `lib/runtime/hooks.test.ts` — new unit tests for interrupt collection, multiple-callback batching, error vs. interrupt distinction in `fireWithGuard`.

The codegen-emitted `ts.callHook(...)` builder in `lib/ir/builders.ts` is NOT touched in Phase 0. It continues to emit `await callHook(...)` which now returns a value that the generated code ignores. That's fine — Phase 0 maintains backward compatibility specifically so existing compiled output keeps working unchanged.

---

## Task 1: Add `Interrupt[]` plumbing to `invokeCallback`

**Files:**
- Modify: `lib/runtime/hooks.ts:98-125` (`invokeCallback`)
- Test: `lib/runtime/hooks.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `lib/runtime/hooks.test.ts` with this content:

```ts
import { describe, it, expect, vi } from "vitest";
import { callHook, callHookAndDrop } from "./hooks.js";
import { AgencyFunction } from "./agencyFunction.js";

// Minimal fake context shape. Only the fields callHook touches.
function fakeCtx(): any {
  return {
    topLevelCallbacks: [],
    callbacks: {},
    stateStack: { collectScopedCallbacks: () => [] },
  };
}

// Build an AgencyFunction stub whose `.invoke(...)` returns the given value.
function fakeAgencyFn(invokeResult: any): AgencyFunction {
  const fn = {
    name: "fake-cb",
    invoke: vi.fn(async () => invokeResult),
  } as unknown as AgencyFunction;
  (fn as any).__isAgencyFunction = true;
  return fn;
}

describe("invokeCallback / fireWithGuard interrupt return", () => {
  it("returns the interrupt array when an AgencyFunction callback halts with interrupts", async () => {
    const ctx = fakeCtx();
    const intr = { kind: "myapp::test", message: "hi", data: null, origin: "x", interruptId: "i-1" };
    const cb = fakeAgencyFn([intr]);
    ctx.topLevelCallbacks = [{ name: "onNodeStart", fn: cb }];

    const out = await callHook({ ctx, name: "onNodeStart", data: { nodeName: "n" } });
    expect(out).toEqual([intr]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run lib/runtime/hooks.test.ts`
Expected: FAIL — `callHook` currently returns `undefined`/`Promise<void>`, not the interrupt array.

- [ ] **Step 3: Change `invokeCallback` to return interrupts instead of throwing**

In `lib/runtime/hooks.ts:98-125`, replace the existing `invokeCallback` with:

```ts
async function invokeCallback(
  fn: any,
  data: unknown,
  ctx: RuntimeContext<any>,
  errorLabel: string,
): Promise<Interrupt[] | undefined> {
  if (AgencyFunction.isAgencyFunction(fn)) {
    const result = await (fn as AgencyFunction).invoke(
      { type: "positional", args: [data] },
      { ctx },
    );
    // The callback body completed with an unhandled `interrupt` statement.
    // Surface the interrupts so the caller can decide what to do — Phase 0
    // callers (`callHookAndDrop`) log them; Phase 1+ codegen sites stamp a
    // checkpoint and propagate them up the runner.
    if (hasInterrupts(result)) {
      return result as Interrupt[];
    }
    return undefined;
  }
  // Plain JS callbacks (from AgencyCallbacks TS arg) have no interrupt
  // mechanism — they're just async functions. Errors thrown by them still
  // get caught by fireWithGuard below.
  await fn(data);
  return undefined;
}
```

Add `import type { Interrupt } from "./interrupts.js";` at the top if not already present (it already imports `hasInterrupts`).

Then update `fireWithGuard` to thread the return through:

```ts
async function fireWithGuard(
  fn: any,
  data: unknown,
  ctx: RuntimeContext<any>,
  errorLabel: string,
): Promise<Interrupt[] | undefined> {
  const key = fn as object;
  if (_activeCallbacks.has(key)) return undefined;
  _activeCallbacks.add(key);
  try {
    return await invokeCallback(fn, data, ctx, errorLabel);
  } catch (error) {
    if (error instanceof RestoreSignal) throw error;
    if (error instanceof AgencyCancelledError) throw error;
    // Real JS errors (e.g. a callback body crashed) still get logged here.
    // Interrupts no longer flow through this path — they return normally
    // from invokeCallback now.
    console.error(`[agency] ${errorLabel} callback error:`, error);
    return undefined;
  } finally {
    _activeCallbacks.delete(key);
  }
}
```

- [ ] **Step 4: Update `callHook` return type to thread the array through**

Replace `callHook` at `lib/runtime/hooks.ts:165-180`:

```ts
export async function callHook<K extends keyof CallbackMap>(args: {
  ctx: RuntimeContext<any>;
  name: K;
  data: CallbackMap[K];
}): Promise<Interrupt[] | undefined> {
  const { ctx, name, data } = args;

  // Single shared collector. Mirrors the runForkAll pattern of "let every
  // sibling run to completion, batch all interrupts together at the end"
  // (see docs/dev/concurrent-interrupts.md). Callbacks are sequential
  // here (not parallel like fork branches), but the batching semantics
  // are the same: an interrupt from callback A must not short-circuit
  // callback B.
  const collected: Interrupt[] = [];

  // Fire global hooks (from external packages) first. They cannot raise
  // agency interrupts (they're plain JS), so we don't collect from them.
  for (const fn of _globalHooks[name] ?? []) {
    await fireWithGuard(fn, data, ctx, `global ${name}`);
  }

  for (const fn of gatherCallbacks(ctx, name)) {
    const result = await fireWithGuard(fn, data, ctx, name);
    if (result) collected.push(...result);
  }

  return collected.length > 0 ? collected : undefined;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run lib/runtime/hooks.test.ts`
Expected: PASS for the one test.

- [ ] **Step 6: Commit**

```bash
git add lib/runtime/hooks.ts lib/runtime/hooks.test.ts
git commit -m "Phase 0: callHook returns Interrupt[] when callbacks halt"
```

---

## Task 2: Add multi-callback batching test + verify collection order

**Files:**
- Modify: `lib/runtime/hooks.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `lib/runtime/hooks.test.ts`:

```ts
it("collects interrupts from every callback even when earlier ones halt", async () => {
  const ctx = fakeCtx();
  const intrA = { kind: "a::k", message: "A", data: null, origin: "x", interruptId: "i-a" };
  const intrB = { kind: "b::k", message: "B", data: null, origin: "x", interruptId: "i-b" };
  const cbA = fakeAgencyFn([intrA]);
  const cbB = fakeAgencyFn([intrB]);
  ctx.topLevelCallbacks = [
    { name: "onNodeStart", fn: cbA },
    { name: "onNodeStart", fn: cbB },
  ];

  const out = await callHook({ ctx, name: "onNodeStart", data: { nodeName: "n" } });
  expect(out).toEqual([intrA, intrB]);
  // Both callbacks must have been invoked — an interrupt in A must not
  // short-circuit B. This is the concurrent-batching invariant that
  // mirrors runForkAll: every sibling runs to completion, all halts
  // are batched together.
  expect((cbA as any).invoke).toHaveBeenCalledTimes(1);
  expect((cbB as any).invoke).toHaveBeenCalledTimes(1);
});

it("returns undefined when no callback halts", async () => {
  const ctx = fakeCtx();
  ctx.topLevelCallbacks = [{ name: "onNodeStart", fn: fakeAgencyFn(undefined) }];
  const out = await callHook({ ctx, name: "onNodeStart", data: { nodeName: "n" } });
  expect(out).toBeUndefined();
});

it("real JS errors in a callback do NOT appear in the returned interrupts", async () => {
  const ctx = fakeCtx();
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const cbCrash = {
    invoke: vi.fn(async () => { throw new Error("boom"); }),
  } as unknown as AgencyFunction;
  (cbCrash as any).__isAgencyFunction = true;
  ctx.topLevelCallbacks = [{ name: "onNodeStart", fn: cbCrash }];
  const out = await callHook({ ctx, name: "onNodeStart", data: { nodeName: "n" } });
  expect(out).toBeUndefined();
  expect(errSpy).toHaveBeenCalled();
  errSpy.mockRestore();
});
```

- [ ] **Step 2: Run tests to verify all pass**

Run: `pnpm vitest run lib/runtime/hooks.test.ts`
Expected: PASS for all four tests.

- [ ] **Step 3: Commit**

```bash
git add lib/runtime/hooks.test.ts
git commit -m "Phase 0: cover multi-callback batching, no-interrupt, and crash cases"
```

---

## Task 3: Add `callHookAndDrop` helper for fire-and-forget callers

**Files:**
- Modify: `lib/runtime/hooks.ts`
- Modify: `lib/runtime/hooks.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `lib/runtime/hooks.test.ts`:

```ts
describe("callHookAndDrop", () => {
  it("returns void and logs to console.error when interrupts come back", async () => {
    const ctx = fakeCtx();
    const intr = { kind: "x::y", message: "", data: null, origin: "x", interruptId: "i-1" };
    ctx.topLevelCallbacks = [{ name: "onNodeStart", fn: fakeAgencyFn([intr]) }];
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const out: void = await callHookAndDrop({ ctx, name: "onNodeStart", data: { nodeName: "n" } });
    expect(out).toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("[agency] onNodeStart callback raised an unhandled interrupt"),
      expect.anything(),
    );
    errSpy.mockRestore();
  });

  it("returns void with no logging when no interrupts are raised", async () => {
    const ctx = fakeCtx();
    ctx.topLevelCallbacks = [{ name: "onNodeStart", fn: fakeAgencyFn(undefined) }];
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await callHookAndDrop({ ctx, name: "onNodeStart", data: { nodeName: "n" } });
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run lib/runtime/hooks.test.ts`
Expected: FAIL — `callHookAndDrop` does not exist yet.

- [ ] **Step 3: Add the helper**

At the bottom of `lib/runtime/hooks.ts`, add:

```ts
/**
 * Fire a hook with the today-style "log + drop" interrupt behavior.
 *
 * Existing TS-side runtime call sites (in `lib/runtime/node.ts` and
 * `lib/runtime/prompt.ts`) wrap `callHook` with this helper because
 * they cannot propagate callback interrupts up the agency runner: they
 * sit either outside any agency frame (onAgentStart / onAgentEnd) or
 * inside `runPrompt`'s internal state machine which has no resumable
 * substep machinery yet. Phase 2 of the callback-interrupts work will
 * give those sites real propagation; until then they continue to log
 * and drop, matching the pre-refactor behavior.
 *
 * Codegen-emitted hook sites (the `ts.callHook(...)` builder) get
 * actual propagation in Phase 1 by emitting `callHook` directly and
 * checking the return value inline.
 */
export async function callHookAndDrop<K extends keyof CallbackMap>(args: {
  ctx: RuntimeContext<any>;
  name: K;
  data: CallbackMap[K];
}): Promise<void> {
  const result = await callHook(args);
  if (result) {
    console.error(
      `[agency] ${args.name} callback raised an unhandled interrupt ` +
        `(kind="${result[0].kind}") at a runtime call site that does not ` +
        `support interrupt propagation. The interrupt is being dropped. ` +
        `Move the hook firing into an agency-controlled scope, or wait for ` +
        `Phase 2 of the callback-interrupts work.`,
      result,
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run lib/runtime/hooks.test.ts`
Expected: PASS for all six tests.

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/hooks.ts lib/runtime/hooks.test.ts
git commit -m "Phase 0: add callHookAndDrop for fire-and-forget callers"
```

---

## Task 4: Migrate `lib/runtime/node.ts` call sites

**Files:**
- Modify: `lib/runtime/node.ts:4` (import), `lib/runtime/node.ts:174` (onAgentStart), `lib/runtime/node.ts:222` (onAgentEnd)

- [ ] **Step 1: Update the import**

Change line 4 of `lib/runtime/node.ts` from:

```ts
import { callHook } from "./hooks.js";
```

to:

```ts
import { callHookAndDrop } from "./hooks.js";
```

- [ ] **Step 2: Replace the two `callHook` call sites**

At `lib/runtime/node.ts:174`, change `await callHook({ ... })` to `await callHookAndDrop({ ... })`. Same at `lib/runtime/node.ts:222`. The argument shape is unchanged.

Verify with: `grep -n "callHook\b\|callHookAndDrop" lib/runtime/node.ts`
Expected: only `callHookAndDrop` references, no bare `callHook`.

- [ ] **Step 3: Run the existing agency tests touching node lifecycle hooks**

Run:
```bash
node ./dist/scripts/agency.js test tests/agency/callback-toplevel.agency
node ./dist/scripts/agency.js test tests/agency/callback-basic.agency
```
Expected: both PASS. These exercise the runtime hook path and prove that swapping in `callHookAndDrop` didn't change observable behavior.

- [ ] **Step 4: Commit**

```bash
git add lib/runtime/node.ts
git commit -m "Phase 0: migrate node.ts hook sites to callHookAndDrop"
```

---

## Task 5: Migrate `lib/runtime/prompt.ts` call sites

**Files:**
- Modify: `lib/runtime/prompt.ts:6` (import), `lib/runtime/prompt.ts:57`, `:194`, `:483`, `:609`

- [ ] **Step 1: Update the import**

Change line 6 of `lib/runtime/prompt.ts` from:

```ts
import { callHook } from "./hooks.js";
```

to:

```ts
import { callHookAndDrop } from "./hooks.js";
```

- [ ] **Step 2: Replace the four `callHook` call sites**

In `lib/runtime/prompt.ts`, change each of these `await callHook({ ... })` to `await callHookAndDrop({ ... })`:
- Line 57: `onLLMCallStart`
- Line 194: `onLLMCallEnd`
- Line 483: `onToolCallStart`
- Line 609: `onToolCallEnd`

Argument shape is unchanged.

Verify with: `grep -n "callHook\b\|callHookAndDrop" lib/runtime/prompt.ts`
Expected: only `callHookAndDrop` references.

- [ ] **Step 3: Run the broader test suite as a regression check**

Run: `pnpm vitest run 2>&1 | tail -5`
Expected: 4373+ tests pass (whatever the current count is — Phase 0 should not change any test outcome).

Run: `node ./dist/scripts/agency.js test tests/agency/callback-resume.agency`
Expected: PASS. This is the resume-roundtrip test and is the single best smoke test that the runtime hook path still works end-to-end.

- [ ] **Step 4: Commit**

```bash
git add lib/runtime/prompt.ts
git commit -m "Phase 0: migrate prompt.ts hook sites to callHookAndDrop"
```

---

## Task 6: Update the `ts.callHook` builder to await the result (no propagation yet)

**Files:**
- Modify: `lib/ir/builders.ts:515-524`

This task is technically optional in Phase 0 — the existing generated code calls `await callHook(...)` and ignores the returned `Interrupt[] | undefined`, which is exactly today's "drop" behavior. But it's worth adding a comment in the builder that points future contributors at the Phase 1 work.

- [ ] **Step 1: Add a docstring + leave the implementation unchanged**

Replace `lib/ir/builders.ts:515-524` with:

```ts
/**
 * Emit `await callHook({ ctx, name, data })`.
 *
 * Phase 0 (the migration that introduced `Interrupt[]` returns from
 * `callHook`) preserves the codegen-side behavior: the generated `await`
 * expression evaluates to `Interrupt[] | undefined`, but the surrounding
 * statement context discards it. That matches the today-style behavior
 * of "interrupts raised by callbacks fire-and-forget at codegen-emitted
 * sites" — see `lib/runtime/hooks.ts` `callHookAndDrop` for the
 * equivalent at TS-side runtime call sites.
 *
 * Phase 1 will replace this builder (or add a sibling like
 * `ts.callHookPropagating(...)`) that emits the interrupt-propagation
 * pattern: substep guard, return-the-interrupts-and-halt, stamp a
 * checkpoint at the firing site. See
 * `docs/superpowers/plans/2026-05-22-callback-interrupts-phase-1-codegen-sites.md`.
 */
callHook(hookName: string, data: Record<string, TsNode> | TsNode): TsNode {
  const dataNode = "kind" in data ? data as TsNode : ts.obj(data as Record<string, TsNode>);
  return ts.awaitCall(ts.id("callHook"), [
    ts.obj({
      ctx: ts.runtime.ctx,
      name: ts.str(hookName),
      data: dataNode,
    }),
  ]);
},
```

- [ ] **Step 2: Build + run the agency test suite**

Run:
```bash
make
pnpm vitest run 2>&1 | tail -5
```
Expected: build clean, all tests still pass.

- [ ] **Step 3: Commit**

```bash
git add lib/ir/builders.ts
git commit -m "Phase 0: document ts.callHook builder; Phase 1 will replace it"
```

---

## Task 7: Document the hook-callback-interrupt contract

**Files:**
- Create: `docs/dev/callback-hooks.md`

- [ ] **Step 1: Create the doc**

```markdown
# Callback hooks and interrupts

Agency lets user code register callbacks for runtime events
(`onFunctionStart`, `onNodeStart`, `onLLMCallStart`, `onToolCallStart`,
etc.) via the stdlib `callback()` function. A callback body can call
`interrupt(...)` like any other agency code. This doc explains what
happens to that interrupt and where it ends up.

## Two paths through `callHook`

`callHook(...)` in `lib/runtime/hooks.ts` is the single dispatcher that
fires every callback for a given hook name. It now returns
`Interrupt[] | undefined`:

- **`undefined`** — no callback raised an interrupt; the hook fired and
  every callback completed normally.
- **`Interrupt[]`** — at least one callback halted with an `interrupt`
  statement that wasn't caught by a `handle` block on the live call
  stack. *All* callbacks still ran (interrupts from callback A do not
  short-circuit callback B); the returned array contains every
  interrupt that bubbled out.

There are two kinds of call site:

### Codegen-emitted (`ts.callHook(...)`)

These fire from inside compiled agency code (function entry/exit, node
entry/exit, `emit`). The runner, `__stack`, and `__stateStack` are in
scope at the firing point. After Phase 1, these sites check the return
value of `callHook` and propagate it through the same interrupt-return
mechanism the rest of the runner uses — the user can respond to the
interrupt via `respondToInterrupts` and resume the program.

### TS-side runtime (`callHookAndDrop(...)`)

These fire from `lib/runtime/node.ts` and `lib/runtime/prompt.ts`,
outside any agency frame. They cannot pause/resume cleanly because
either there's no agency state to checkpoint (onAgentStart/onAgentEnd)
or the surrounding TS code (runPrompt's internal state machine) has no
substep machinery to skip already-fired hooks on resume. These sites
use `callHookAndDrop` which fires the hook, logs any returned
interrupts to `console.error`, and continues. Phase 2 will migrate the
LLM/tool hooks to a proper propagation path.

## Errors vs. interrupts in callback bodies

`fireWithGuard` distinguishes the two:

- A real JS `throw` inside a callback body is caught and
  `console.error`-logged. It never propagates further.
- An `interrupt(...)` statement in a callback body returns
  `Interrupt[]` from `AgencyFunction.invoke`. `invokeCallback` returns
  the array; `fireWithGuard` returns the array; `callHook` collects it
  into its batch. The interrupt does NOT go through the `catch` block.

`RestoreSignal` and `AgencyCancelledError` are special — they always
re-throw, since they're internal control-flow signals the runtime
relies on.

## Multiple callbacks on the same hook

`gatherCallbacks` returns callbacks in this order:
1. Innermost stack-frame scoped callbacks
2. Outer stack-frame scoped callbacks (walking up)
3. Top-level callbacks (registered at module init), in registration order
4. The TS-passed `ctx.callbacks[name]` callback, if any

`callHook` invokes them in that order and collects interrupts as it
goes. The returned `Interrupt[]` preserves the firing order.

## Why the batch-and-return shape

This mirrors `runForkAll` / `runRace` from
`docs/dev/concurrent-interrupts.md`. Callbacks are sequential rather
than parallel, but the invariant is the same: each callback runs to
completion regardless of what its siblings did, and the caller gets
every halt batched together so the user can respond to all of them in
one cycle of `respondToInterrupts`.
```

- [ ] **Step 2: Commit**

```bash
git add docs/dev/callback-hooks.md
git commit -m "Phase 0: document callback hook + interrupt contract"
```

---

## Final validation

- [ ] **Step 1: Full validation pass**

```bash
make
pnpm run typecheck
pnpm run lint:structure
pnpm vitest run
for t in tests/agency/callback-*.agency; do
  node ./dist/scripts/agency.js test "$t" 2>&1 | grep -E "passed|FAIL" | tail -1
done
```

Expected: every command succeeds; every callback test still passes; no regression in `pnpm vitest run` (same count as `main` plus the new tests in `hooks.test.ts`).

- [ ] **Step 2: Push the branch and open PR**

PR description should explicitly note:
- Zero user-visible behavior change.
- Internals refactored to enable Phase 1 (codegen propagation) and eventual Phase 2 (LLM/tool hook propagation).
- All existing callers (`lib/runtime/node.ts`, `lib/runtime/prompt.ts`) migrated to `callHookAndDrop` to preserve today's swallow-and-log semantics.
- New tests in `lib/runtime/hooks.test.ts` cover the interrupt-collection mechanism, multi-callback batching, and the error-vs-interrupt distinction.

## Out of scope for Phase 0

- Codegen-emitted call sites (`ts.callHook`) keep dropping interrupts. Phase 1 fixes those.
- LLM/tool hooks in `lib/runtime/prompt.ts` keep dropping interrupts. Phase 2 fixes those (and is harder because `runPrompt` has no substep machinery today).
- `onAgentStart`/`onAgentEnd` callbacks fundamentally cannot propagate interrupts (no agency frame exists). Leaving these on `callHookAndDrop` permanently — Phase 2 should add an explicit reject when these specific hooks return interrupts, so users get an actionable error rather than a silent log.
- No changes to `respondToInterrupts`. The existing batched-interrupt resume machinery already handles arrays of interrupts; Phase 1 just produces them from a new source.
