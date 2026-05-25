# onNodeEnd + onFunctionEnd Deferred-Return Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `onNodeEnd` and `onFunctionEnd` callbacks able to raise interrupts that propagate cleanly to the user, *including* for value-returning nodes and functions. On resume, the original return value must be preserved and delivered to the caller.

**Architecture:** Both hooks currently fire *after* the body has produced a return value but *before* (or, for `onFunctionEnd`, inside) machinery that hands the value back to the caller. The fix is symmetric across both: stash the about-to-be-returned value on the runner frame in a dedicated slot, fire the hook as a regular `runner.hook` substep, and only after the hook completes without interrupts retrieve the stashed value and perform the actual return/halt. On resume the hook re-fires at its substep; the stashed value survives via the checkpoint; the post-hook return uses the restored value. This is the same shape as `onLLMCallEnd` preserving the LLM response across resume cycles via `runPrompt`'s state machine. Depends on Plan 2 (fork-style multi-callback resume) if multi-callback `onNodeEnd`/`onFunctionEnd` is in scope.

**Tech Stack:** TypeScript runtime (`lib/runtime/runner.ts`), codegen (`lib/builders/`, `lib/templates/`), Agency execution tests, Vitest.

---

### Task 1: Map the current codegen for node and function exits

**Files:**
- Read: `lib/runtime/runner.ts` (halt, hook methods)
- Read: `lib/builders/` — node body builder, function body builder (find via `grep -rn "onNodeEnd\|onFunctionEnd" lib/`)
- Read: `lib/templates/*.mustache` for any function-exit or node-exit templates

- [ ] **Step 1: Find every emission site of `onNodeEnd` and `onFunctionEnd`**

```bash
grep -rn "onNodeEnd\|onFunctionEnd" lib/ tests/agency/__golden__/ 2>/dev/null > /tmp/end-hooks.txt
```

Inspect `/tmp/end-hooks.txt`. Read the generated TypeScript in fixture golden files for representative nodes and functions to see the current shape:

- For a void-returning node: where in the body does the `runner.hook(N, "onNodeEnd", ...)` appear?
- For a value-returning node: where does `runner.halt({...})` appear relative to the hook call?
- For a function: where does the `finally { await callHook({name: "onFunctionEnd", ...}); }` block sit relative to the `return` statement?

Write a one-page summary to `docs/notes/end-hook-codegen.md` (delete in Task 7). This is the map that drives Tasks 2–4.

- [ ] **Step 2: Confirm the failure mode with fixtures**

Read `docs/site/appendix/callbacks.md` table rows for `onNodeEnd` and `onFunctionEnd`. Read whatever existing tests cover these hooks (probably only the working void-node and silent-drop cases).

---

### Task 2: Write failing fixtures

**Files:**
- Create: `tests/agency/callback-interrupt-resume-onnodeend-value.agency` (+ `.test.json`, `.js`)
- Create: `tests/agency/callback-interrupt-resume-onfunctionend.agency` (+ `.test.json`, `.js`)
- Create: `tests/agency/callback-interrupt-resume-onnodeend-void.agency` (+ `.test.json`, `.js`) — regression coverage for the currently-working void path
- Create: `tests/agency/callback-interrupt-resume-onfunctionend-error.agency` (+ `.test.json`, `.js`) — regression coverage that JS errors in `onFunctionEnd` still log and don't crash

- [ ] **Step 1: Value-returning node with onNodeEnd interrupt**

Node returns `{ count: 42 }`. Top-level `onNodeEnd` callback interrupts with `interrupt("review", data.data)`. Driver resumes with `"approved"`. Assert:
- one interrupt surfaces with `{ count: 42 }` as payload,
- after resume the agent's final result is `{ count: 42 }` (NOT recomputed),
- the node body's side effects fired exactly once.

- [ ] **Step 2: Function with onFunctionEnd interrupt**

Function `compute()` returns `100`. Top-level `onFunctionEnd` callback interrupts. Caller is another node that returns `compute() * 2`. Assert:
- one interrupt surfaces,
- after resume the caller observes `compute() == 100` and the agent returns `200`,
- the function body fires exactly once.

- [ ] **Step 3: Void-node regression**

A void-returning node with `onNodeEnd` interrupt — currently working. Locks in that the refactor doesn't break it.

- [ ] **Step 4: JS-error regression**

`onFunctionEnd` callback throws a real JS error. Assert it's logged to `console.error` and the function returns normally (current `fireWithGuard` behavior preserved).

- [ ] **Step 5: Run all four, capture failures**

```bash
pnpm test:run -- callback-interrupt-resume-onnodeend callback-interrupt-resume-onfunctionend > /tmp/end-hooks-fail.log 2>&1
```

The two new failing fixtures fail; the two regression fixtures should already pass.

- [ ] **Step 6: Commit**

```bash
git add tests/agency/
git commit -F .git/COMMIT_MSG.txt
```

---

### Task 3: Add a `Runner.haltWith` deferred-return primitive

**Files:**
- Modify: `lib/runtime/runner.ts` (add `haltWith`, `getDeferredReturn`, `stashDeferredReturn` methods)

The runtime primitive that lets generated code say "stash this value as the to-be-returned value, then later halt with it after the hook step completes."

- [ ] **Step 1: Design the deferred-return slot**

Stash on `this.frame.locals` under `__deferred_return_${this.scopeName}` (function-level uniqueness; one deferred return per call frame). Persists across the resume cycle via the frame's normal checkpoint serialization.

- [ ] **Step 2: Add the helper methods**

```ts
private deferredReturnKey(): string {
  return `__deferred_return_${this.scopeName}`;
}

stashDeferredReturn(value: any): void {
  this.frame.locals[this.deferredReturnKey()] = { value };
}

getDeferredReturn(): { value: any } | undefined {
  return this.frame.locals[this.deferredReturnKey()];
}

clearDeferredReturn(): void {
  delete this.frame.locals[this.deferredReturnKey()];
}
```

The wrapping object `{ value: ... }` lets `undefined` and explicit-`null` returns be distinguished from "no deferred return present."

- [ ] **Step 3: Write a unit test for the primitive**

`lib/runtime/__tests__/runner-deferred-return.test.ts`:
- stash + get round-trips arbitrary values (including `undefined`, `null`, objects),
- stash survives checkpoint serialize / restore.

```bash
pnpm test:run -- runner-deferred-return > /tmp/deferred-return-unit.log 2>&1
```

- [ ] **Step 4: Commit**

---

### Task 4: Refactor node codegen for value-returning `return`

**Files:**
- Modify: `lib/builders/<node builder file>` (located in Task 1)
- Modify: golden fixtures touched by codegen change (`make fixtures` will regenerate)

Current shape for a value-returning node:

```ts
// body steps...
await runner.halt({ ...state, data: 42 });
// onNodeEnd hook is dead code here — runner is halted
```

New shape:

```ts
// body steps...
runner.stashDeferredReturn(42);
await runner.hook(N, "onNodeEnd", { nodeName: "...", data: 42 });
if (runner.halted) return runner.haltResult;
const __ret = runner.getDeferredReturn()!;
runner.clearDeferredReturn();
return { ...state, data: __ret.value };
```

- [ ] **Step 1: Locate the node-return codegen**

From Task 1's map. The change is local to wherever `runner.halt({...data: <returnValue>})` is emitted.

- [ ] **Step 2: Emit `stashDeferredReturn` before the hook**

Rather than halting first.

- [ ] **Step 3: Emit `runner.hook(N, "onNodeEnd", ...)` as the next step**

This is a normal substep — it gets a stable step id like any other.

- [ ] **Step 4: Emit the post-hook return**

```ts
if (runner.halted) return runner.haltResult;
const __ret_N = runner.getDeferredReturn()!;
runner.clearDeferredReturn();
return { ...state, data: __ret_N.value };
```

- [ ] **Step 5: Regenerate fixtures**

```bash
make fixtures > /tmp/fixtures.log 2>&1
```

Inspect the diff. Should affect every node fixture that has a `return value` statement — the hook now appears *before* the return rather than as dead code.

- [ ] **Step 6: Run all callback and node tests**

```bash
pnpm test:run -- callback nodes > /tmp/node-end-tests.log 2>&1
```

The new `callback-interrupt-resume-onnodeend-value` fixture must pass. The void-regression fixture must still pass.

- [ ] **Step 7: Commit**

---

### Task 5: Refactor function codegen to move `onFunctionEnd` out of `finally`

**Files:**
- Modify: `lib/builders/<function builder file>`
- Modify: golden fixtures

Current shape:

```ts
async function helper(...) {
  await runner.hook(0, "onFunctionStart", {...});
  try {
    // body steps...
    return result;
  } finally {
    await callHook({ ctx, name: "onFunctionEnd", data: {...} }); // interrupts dropped
  }
}
```

The `finally`-after-`return` shape is the core obstacle: the function has already committed to a return value when `finally` runs, so there is no way for an interrupt raised in the `finally` to alter control flow. Move the end hook to *before* the return, using the deferred-return primitive.

New shape:

```ts
async function helper(...) {
  await runner.hook(0, "onFunctionStart", {...});
  if (runner.halted) return runner.haltResult;
  const __startTime = performance.now();
  try {
    // body steps...
    const __result = /* whatever the body produced */;
    runner.stashDeferredReturn(__result);
  } catch (err) {
    // existing error handling
    throw err;
  }
  // end hook fires OUTSIDE the try, after the body has produced a value
  await runner.hook(N, "onFunctionEnd", {
    functionName: "helper",
    timeTaken: performance.now() - __startTime,
  });
  if (runner.halted) return runner.haltResult;
  const __ret = runner.getDeferredReturn()!;
  runner.clearDeferredReturn();
  return __ret.value;
}
```

Note the `try` no longer has a `finally` — the only thing that lived there was the end hook. JS errors in the body still propagate via `throw err` and the body's own error-handling. (Verify the function builder doesn't rely on `finally` for anything else like span ends or pendingPromises bookkeeping — if it does, those stay in a smaller `finally` that does NOT include the end hook.)

- [ ] **Step 1: Locate the function-return codegen**

- [ ] **Step 2: Check whether `finally` does anything besides the end hook**

If yes (e.g., `statelogClient.endSpan`, `popHandler`, `pendingPromises` flush), keep those in a smaller `finally`. Only the end hook moves.

- [ ] **Step 3: Apply the refactor**

- [ ] **Step 4: Handle the early-return case**

If the function has multiple `return` statements (early returns), each one needs to stash + jump to a single end-hook block. Cleanest: rewrite each `return value` to `runner.stashDeferredReturn(value); return runner.haltResult;` no — that doesn't work. Instead, push the body inside a labelled IIFE pattern or use a synthetic local `__earlyReturn` flag. **This is the highest-risk part of the plan.** Recommend: in this task, add a label-and-break or sentinel-based control-flow rewrite. The exact shape depends on what the builder already does for early returns (Task 1 should have surfaced this); if early-return is rare in idiomatic Agency, an acceptable narrower scope is "only single-`return` functions get the end-hook interrupt support; functions with multiple returns continue to use the dropping `finally` path." Decide with the user before committing.

- [ ] **Step 5: Regenerate fixtures**

```bash
make fixtures > /tmp/fixtures-func.log 2>&1
```

Wide diff. Every generated function changes.

- [ ] **Step 6: Run the full callback + function test family**

```bash
pnpm test:run -- callback function > /tmp/func-end-tests.log 2>&1
```

The new `callback-interrupt-resume-onfunctionend` fixture must pass. JS-error regression must still pass.

- [ ] **Step 7: Run the entire test suite once**

```bash
pnpm test:run > /tmp/full-test-after-funcend.log 2>&1
```

Expect a wide blast radius (every function fixture's generated TS changes). Inspect failures carefully — distinguish "test data needs regenerating via `make fixtures`" from "real regression."

- [ ] **Step 8: Commit**

---

### Task 6: Multi-callback resume composition test

**Files:**
- Create: `tests/agency/callback-multi-onnodeend.agency` (+ `.test.json`, `.js`) — only if Plan 2 is merged

If Plan 2 (sequential multi-callback fork-style resume) is merged first, add a test for two `onNodeEnd` callbacks both interrupting on the same value-returning node. Assert the same exactly-once semantics Plan 2 establishes for `onNodeStart`, plus the return-value preservation this plan establishes.

If Plan 2 is NOT yet merged, skip this task and add a note in the plan's completion checklist.

---

### Task 7: Documentation cleanup

**Files:**
- Modify: `docs/dev/callback-hooks.md`
- Modify: `docs/site/appendix/callbacks.md`
- Delete: `docs/notes/end-hook-codegen.md`

- [ ] **Step 1: Update the per-hook table in `callbacks.md`**

`onNodeEnd`: change `⚠️ Only on void-returning nodes` to `✅ Yes` and remove the void-only caveat.

`onFunctionEnd`: change `❌ Silently dropped` to `✅ Yes` (or to a narrower row if Task 5 Step 4 settled on the narrower scope — in which case document the early-return caveat).

- [ ] **Step 2: Update `docs/dev/callback-hooks.md`**

Replace the "**`onFunctionEnd` is still a raw `callHook` in a `finally` block**" paragraph with a description of the deferred-return primitive and how it's used by both `onNodeEnd` and `onFunctionEnd`.

- [ ] **Step 3: Delete the scratch codegen-map file**

- [ ] **Step 4: Commit docs**

---

### Validation checklist

- [ ] All four new fixtures pass.
- [ ] All existing callback, function, and node tests pass.
- [ ] `pnpm run lint:structure` clean.
- [ ] `make` succeeds.
- [ ] `make fixtures` no-op after the fixtures commit (no further drift).
- [ ] Generated-TS readability not significantly worse (spot-check 2–3 representative golden fixtures).
- [ ] If early-return narrowing was chosen in Task 5 Step 4: documented in the appendix table.

---

### Risks and dependencies

- **Depends on Plan 2** only if multi-callback semantics for the end hooks are in scope. Single-callback works without Plan 2.
- **Highest risk:** Task 5 Step 4 (early-return rewrite for `onFunctionEnd`). Confirm scope with the user before committing to a strategy.
- **Wide fixture churn:** Task 5 regenerates every function fixture. Use `git status` to spot-check the diff is uniform (only the end-hook position changed) before staging.
- **Span/handler bookkeeping in `finally`:** Task 5 Step 2 must verify nothing else relied on the `finally` block. Missing this would be a real bug (handlers are safety infrastructure — never accidentally skip them).
