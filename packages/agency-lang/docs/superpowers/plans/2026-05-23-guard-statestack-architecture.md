# Guard StateStack Architecture Migration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the current PFA-on-scoped-callback implementation of `guard(limit, block)` with a runtime mechanism where guard state lives directly on the `StateStack`. This solves the "mutation does not survive serialize/deserialize" gap that makes the user's "raise the limit" response get silently dropped.

**Surfaced by:** the in-tree implementation of `guard()` (stdlib/index.agency) attempts to mutate a PFA-bound `state` object: `state.limit = interrupt(...)`. Within a single uninterrupted run the mutation works (JS object reference), but at interrupt time the PFA's `state` is serialized by value, and on resume a brand-new revived object replaces it. The mutation is lost. Subsequent callback fires see the original limit.

**Why a runtime StateStack stack instead of a different closure / serialization scheme:**
- The `StateStack` is **per-branch** in concurrent execution (each `BranchState` has its own stack). Guards naturally compose with fork.
- The `StateStack` already serializes through `toJSON`/`fromJSON` for interrupt + resume. Adding a guard list to it is the smallest possible change.
- It avoids needing to invent a "mutable shared state for callbacks" general feature, which is out of scope and likely the wrong abstraction.
- It matches the original spec (`docs/superpowers/specs/2026-05-20-cost-and-guard-tracking-design.md`), minus the thrown-error mechanism — we keep the interrupt-based mechanism that the just-shipped runBatch + callback-interrupts work makes possible.

**Out of scope:** timeout guards, depth guards, memory-layer cost coverage. All deferred per the original spec.

**Tech Stack:** TypeScript runtime (`lib/runtime/state/stateStack.ts`, `lib/runtime/prompt.ts`, `lib/codegenBuiltins/contextInjected.ts`), `stdlib/index.agency`.

**Depends on:** Plan `2026-05-23-callback-end-hook-substep-completion.md` is not strictly required but strongly recommended — without it, every guard breach still causes the LLM call to re-run on resume, compounding cost.

---

### Task 1: GuardEntry on StateStack

**Files:**
- Modify: `lib/runtime/state/stateStack.ts` — add `guards: GuardEntry[]` field, include in `toJSON`/`fromJSON`.
- Create: `lib/runtime/guard.ts` — `GuardEntry` type (`{ start: number; limit: number; id: string }`).
- Modify: `lib/runtime/guard.test.ts` — serialize/deserialize round-trips a guard list.

- [ ] **Step 1: Type and field**

```ts
// lib/runtime/guard.ts
export type GuardEntry = {
  /** Stable id so prompt.ts can refer to a specific guard when raising
   *  the interrupt (carries it in the interrupt payload so the user
   *  could in principle target a specific guard if there were ever a
   *  client UI that supports that). */
  id: string;
  /** getCost() snapshot when the guard was pushed. The "spent inside
   *  this guard" is `getCost() - start`. */
  start: number;
  /** Current limit. Mutated in place when the user raises it via
   *  interrupt response. */
  limit: number;
};
```

- [ ] **Step 2: StateStack changes**

Add `guards: GuardEntry[]` to the StateStack class. Initialize to `[]`. Add to `toJSON` and `fromJSON`. Branch stacks clone the array when seeded so fork branches each have their own copy (and don't mutate the parent's).

- [ ] **Step 3: Test**

`lib/runtime/state/stateStack-guard.test.ts` — push a couple of entries, JSON round-trip, verify mutations survive.

- [ ] **Step 4: Commit**

---

### Task 2: `__pushGuard` / `__popGuard` context-injected builtins

**Files:**
- Modify: `lib/codegenBuiltins/contextInjected.ts` — register two new builtins.
- Create: `lib/stdlib/guard.ts` — implementations (push/pop a `GuardEntry` on `ctx.stateStack.guards`).
- Modify: `lib/codegenBuiltins/contextInjected.test.ts` — coverage.

- [ ] **Step 1: Register builtins**

```ts
__pushGuard(limit: number): string  // returns the guard's id
__popGuard(id: string): void
```

Both take `(__ctx, __stateStack, __threads)` as the standard context-injected prefix. `__pushGuard` pushes a `{ id: nanoid(), start: __ctx.globals.getTokenStats().cost, limit }`. `__popGuard` removes by id.

- [ ] **Step 2: Defensive guard against mismatched push/pop**

If `__popGuard("xyz")` is called and the top of the guard stack is not "xyz", throw a clear error. Indicates a codegen bug or a user manually calling these builtins.

- [ ] **Step 3: Tests**

---

### Task 3: Per-LLM-call check in `prompt.ts`

**Files:**
- Modify: `lib/runtime/prompt.ts`

After every LLM call completes (the place where `onLLMCallEnd` fires), iterate the current `stateStack.guards`. For each guard, check `getCost() - guard.start > guard.limit`. If any is exceeded, raise `std::guard_exceeded` interrupt with payload `{ id, spent, limit }`.

The interrupt mechanism that just landed (runBatch + callback-interrupts) means the interrupt propagates up cleanly. The user responds with a new limit (number); on resume, the runtime updates `guard.limit = response` for the matching id BEFORE continuing.

- [ ] **Step 1: Identify the post-LLM-call commit point**

Coordinate with Plan `2026-05-23-callback-end-hook-substep-completion.md` — the `commitStep` should fire BEFORE this guard check so a guard-exceeded interrupt doesn't cause LLM re-run on resume.

- [ ] **Step 2: Raise the interrupt**

Use `interruptWithHandlers("std::guard_exceeded", ...)` — same shape as the current stdlib pattern.

- [ ] **Step 3: Plumb the user's response into the matching `GuardEntry.limit`**

On resume, the runtime sees the interrupt response. Update the entry in the StateStack's guard list whose id matches. Since the StateStack already serializes the guard list and is restored on resume, the mutation persists naturally.

- [ ] **Step 4: Tests**

Fixture: nested guards. Inner exceeds, user raises inner, work continues, outer exceeds later, user raises outer. Assert correct interrupt sequence and exact cost accounting.

---

### Task 4: Rewrite `guard()` in stdlib

**Files:**
- Modify: `stdlib/index.agency`

Replace the existing PFA-based implementation with:

```
export def guard(limit: number, block: () => any): any {
  """
  Run a block with a cost limit. After every LLM call inside the
  block, the cumulative cost since `guard` started is compared to
  `limit`. If the spend exceeds the limit, an `std::guard_exceeded`
  interrupt is raised with `{ id, spent, limit }`.

  The user responds with a new (raised) limit as a number to
  continue; the runtime updates the guard's limit in the StateStack
  before resuming.

  Nested guards each push their own entry; ALL active guards are
  checked after each LLM call. Inside fork branches each branch
  inherits its own copy of the guard list at branch-creation time
  and mutates it independently.

  @param limit - Maximum cost in dollars (USD)
  @param block - The block to execute
  """
  const id = __pushGuard(limit)
  const result = try block()
  __popGuard(id)
  return result
}
```

Delete `__guardCheck` (no longer needed — the check lives in `prompt.ts`).

- [ ] **Step 1: Rewrite guard**

- [ ] **Step 2: Delete `__guardCheck`**

- [ ] **Step 3: Remove `__guardCheck` from the auto-import list**

`lib/templates/backends/agency/template.mustache` and `lib/lsp/diagnostics.ts`. Run `pnpm run templates`. `guard` stays auto-imported (or move it to `std::thread` per the original spec — discuss with the user before deciding).

- [ ] **Step 4: Promote `tests/agency/guard-cost.agency` to a real fixture**

Add `.test.json` with one interrupt handler. Run.

```bash
pnpm run agency test tests/agency/guard-cost.agency
```

Must pass.

- [ ] **Step 5: Commit**

---

### Task 5: Cleanup on interrupt path

**Files:**
- Modify: `lib/runtime/state/stateStack.ts` — ensure `guards` is properly carried through any "branch creation" / "branch teardown" code paths so race losers, fork siblings, etc. all see the right list.
- Modify: `lib/runtime/runBatch.ts` if applicable — when seeding a child branch stack, clone the parent's guards.

- [ ] **Step 1: Audit `seedBranchCost` and similar** in `lib/runtime/runner.ts` — that's the existing pattern for "seed per-branch state from parent." Add a `seedBranchGuards` helper alongside it.

- [ ] **Step 2: Race-loser teardown**

When a race loser branch is deleted, its guard list is dropped (correct — its mutations were on its own slice and never propagated). The winner's guards propagate back to the parent when the winner completes. Test this.

- [ ] **Step 3: Tests**

`tests/agency/guard-fork.agency` (or similar) — fork inside a guard, both branches doing LLM work that together exceed the parent's limit. Decide the user-facing semantics:
- The parent's limit applies; either branch tripping it interrupts. **OR**
- Each branch has its own independent copy of the limit. (The latter is simpler and what the per-branch clone gives us; the former needs a shared atomic accumulator which is a separate larger design.)

Document the chosen semantics in the `guard` docstring.

---

### Task 6: Docs

**Files:**
- Update: `docs/superpowers/specs/2026-05-20-cost-and-guard-tracking-design.md` — mark the "Mechanism" section as superseded by this plan; the chosen mechanism is interrupt (not thrown error). Cross-reference both this plan and the deferred-return / substep-completion plan.
- Update: `docs/dev/runtime-state.md` or wherever `StateStack` is documented — add `guards` field.

---

### Validation checklist

- [ ] `tests/agency/guard-cost` passes with one interrupt handler.
- [ ] Nested-guards fixture passes — both inner and outer trip in the right order.
- [ ] Fork-with-guard fixture passes with documented per-branch semantics.
- [ ] `lib/runtime/state/stateStack.toJSON` includes `guards`; round-trips cleanly.
- [ ] No regressions in the existing test suite.
- [ ] `make` succeeds, `pnpm run lint:structure` clean.

---

### Risks and dependencies

- **Fork merge semantics for guard limits** (Task 5 Step 3) is genuinely undecided. Pick the simpler one (per-branch independent) for v1 unless the user has a strong preference for shared.
- **Memory-layer LLM calls** still bypass `prompt.ts` and therefore the guard check. Documented; out of scope.
- **Cross-plan ordering:** if this plan ships BEFORE `2026-05-23-callback-end-hook-substep-completion.md`, every guard-exceeded interrupt causes the LLM call to re-run on resume. That's painful but not catastrophic — user sees repeated prompts with growing cost. Ship the substep-completion plan first or in the same release.
