# Callback Rejection Propagation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When a callback body raises an interrupt and the user **rejects** that interrupt, the rejection must propagate up the runner chain and halt the enclosing function or node with a failure. Today the rejection is silently dropped.

**Surfaced by:** the in-tree `guard()` stdlib function. When the user rejects the `std::guard_exceeded` interrupt, the callback's generated code halts with `failure("interrupt rejected", ...)`. That failure is invisible to the caller — the LLM call (and the surrounding `block()`) keeps running, exactly as if the user had approved.

**Root cause:** the `__guardCheck` lifted-callback codegen at the reject branch:

```js
} else if (__response.type === "reject") {
  runner3.halt(failure("interrupt rejected", { ...checkpoint }));
  return;
}
```

The callback's Runner halts with a `failure` value. The callback returns. Up the chain in `lib/runtime/hooks.ts` (`invokeCallback` → `fireWithGuard`), the return value is only inspected for `hasInterrupts(...)`. A failure is not an interrupt, so it's returned to the caller as `undefined`. The caller (`Runner.hook` via `runBatch`) sees the callback as "succeeded with value undefined" and continues execution. The failure is dropped on the floor.

This is a real correctness bug independent of guard — any user-written `callback("onX") as data { ... interrupt(...) ... }` body that the user rejects has the same silent-drop behavior.

**Tech Stack:** TypeScript runtime (`lib/runtime/hooks.ts`, `lib/runtime/runner.ts`, `lib/runtime/runBatch.ts`).

---

### Task 1: Failing fixture

**Files:**
- Create: `tests/agency/callback-rejection-halts-caller.agency` + `.test.json` + `.js`

- [ ] **Step 1: Minimal reproducer**

```
let bodyContinued: boolean = false

callback("onNodeStart") as data {
  interrupt myapp::abort("really continue?", {})
}

node main() {
  bodyContinued = true
  return "should not reach here"
}
```

Test driver supplies `{ "action": "reject" }`. Expected: the run halts with a failure; `bodyContinued` remains `false`.

Today: `bodyContinued == true`, run completes with `"should not reach here"`.

- [ ] **Step 2: Confirm failure**

```bash
pnpm run agency test tests/agency/callback-rejection-halts-caller.agency > /tmp/cb-reject.log 2>&1
```

- [ ] **Step 3: Commit**

---

### Task 2: Distinguish "callback completed normally" from "callback halted with failure"

**Files:**
- Read: `lib/runtime/hooks.ts` — `invokeCallback`, `fireWithGuard`, `invokeOneCallback`.
- Read: `lib/runtime/runner.ts` — `Runner.hook` (the path that delegates to runBatch).

- [ ] **Step 1: Map the current return-value flow**

Trace: `Runner.hook` → builds `BatchChild.invoke` that calls `invokeOneCallback(...)` → `fireWithGuard` → `invokeCallback` → `AgencyFunction.invoke(...)`. The leaf result is either:
- `Interrupt[]` — surfaces as a halt-with-interrupts (already handled).
- A normal value (including `undefined` from a void-returning callback).
- A `failure(...)` value when the callback halted with `runner.halt(failure(...))`.

The current path treats the second and third the same. We need to distinguish them.

- [ ] **Step 2: Decide the contract**

Recommended: a callback that halts with a `failure` value should be treated as "the caller should halt with this failure." Mirrors how interrupts propagate. This means `invokeOneCallback` returns a discriminated union — interrupts, failure, success — and `Runner.hook` halts the enclosing runner with the failure when it surfaces.

Alternative: convert the failure into a synthesized interrupt. Probably the wrong call — failures and interrupts are different things (failures are terminal, interrupts are pauseable).

---

### Task 3: Plumb failure-propagation through hooks.ts and Runner.hook

**Files:**
- Modify: `lib/runtime/hooks.ts`
- Modify: `lib/runtime/runner.ts`
- Modify: `lib/runtime/runBatch.ts` if the leaf-return discrimination needs adjusting there too.

- [ ] **Step 1: Change `invokeCallback`'s return type**

```ts
type CallbackResult =
  | { kind: "success" }
  | { kind: "interrupts"; interrupts: Interrupt[] }
  | { kind: "failure"; failure: Failure };

async function invokeCallback(...): Promise<CallbackResult> { ... }
```

`AgencyFunction.invoke` already returns a value; if `isFailure(result)`, surface it as `{ kind: "failure", failure: result }`.

- [ ] **Step 2: Propagate through `fireWithGuard` and `invokeOneCallback`**

These pass `CallbackResult` through. The recursion guard is unaffected.

- [ ] **Step 3: `Runner.hook` halts on failure**

When `invokeOneCallback` returns `{ kind: "failure" }`, `Runner.hook` calls `this.halt(failure)`. The enclosing function/node's normal "if (runner.halted) return runner.haltResult" check propagates it up.

- [ ] **Step 4: Multi-callback batch semantics**

If callback A halts with a failure and callback B raises an interrupt, what happens? Recommended: failures take precedence. The batch surfaces the first failure; later callbacks don't fire. Matches how regular JS errors propagate inside `Runner.step` today.

- [ ] **Step 5: Top-level callbacks (`onAgentStart`/`onAgentEnd`)**

These fire outside any Runner via `callHookAndDrop`. If a top-level callback halts with a failure, what propagates? Recommended: log + drop (same as the current interrupt behavior for these hooks). Document the limitation.

---

### Task 4: Verify with the fixture and broader callback tests

- [ ] **Step 1: Re-run the rejection fixture**

```bash
pnpm run agency test tests/agency/callback-rejection-halts-caller.agency
```

Must pass: `bodyContinued == false`, run halts with a failure.

- [ ] **Step 2: Broader callback fixtures**

```bash
pnpm test:run -- callback > /tmp/cb-suite.log 2>&1
```

No regressions in approve / resolve paths.

- [ ] **Step 3: `guard()` rejection fixture**

Add `tests/agency/guard-cost-reject.agency` — reject the guard's interrupt, verify the `block()` halts with a failure that propagates up to `main()`.

- [ ] **Step 4: Commit**

---

### Task 5: Docs

**Files:**
- Modify: `docs/dev/callback-hooks.md` — document the failure-propagation contract; reject ≡ halt-caller-with-failure.
- Modify: `docs/site/appendix/callbacks.md` — per-hook table: which hooks support failure propagation (everything except top-level `onAgentStart`/`onAgentEnd`).

---

### Validation checklist

- [ ] `callback-rejection-halts-caller` fixture passes; body never executed past the rejecting callback.
- [ ] `guard-cost-reject` fixture passes; rejection halts the `block()` with a failure.
- [ ] No regressions in the broader callback / fork-callback fixture families.
- [ ] `make` succeeds, `pnpm run lint:structure` clean.

---

### Risks and dependencies

- **Multi-callback failure precedence** (Task 3 Step 4) needs a clear decision before implementation. Recommend "first failure wins; later callbacks skipped" — matches how a JS error inside a `Runner.step` short-circuits the rest of that step.
- **Top-level callback failures** can't propagate (no caller to halt). Same fundamental limitation that the current callback-interrupts design already documents for `onAgentStart`/`onAgentEnd`.
- **Backward compat with existing rejections:** today, rejecting a callback interrupt silently no-ops. If any users rely on that (unlikely but possible), they'll see new failure halts. Note in the changelog.
- **Interaction with handlers:** if the enclosing function has a `handle` block, the rejected-callback failure should be visible to the handler — same path as any other failure. Verify with a fixture.
