# Abort Taxonomy — Increment 1 (Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn CI green by fixing the three time-guard fixtures that crash, by carrying a structured `AbortCause` on every abort so guard trips are recognized at boundaries instead of escaping as unhandled rejections — and lay the carrier foundation that Increment 2 (full unification) builds on.

**Architecture:** Every abort carries a tagged `AbortCause` (`signal.reason` stays an `AgencyCancelledError`, with the cause on its `agencyCause` field; `readCause()` reads it back from either a signal or an error). A time-guard trip that surfaces as an aborted leaf op (an in-flight `sleep`) now carries `kind: "guardTrip"`, so the stdlib `guard`'s `try` (`__tryCall`) converts it to a `Failure` — checked **before** the blanket `isAbortError → throw`. A shared mutable `delivered` flag on the cause de-dups the two trip-delivery paths (leaf-op vs runner `shouldSkip`) so the guard's own `_popGuard` step never re-throws.

**Tech Stack:** TypeScript runtime (`lib/runtime/*`), stdlib JS (`lib/stdlib/*`). No codegen template changes, no fixture regeneration.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-21-abort-taxonomy-design.md` (Increment 1, §4).
- **No codegen template change; no `make fixtures` regeneration.** The generated catch ladders still only *propagate* aborts — they need no change in Increment 1.
- **`AgencyCancelledError` and `GuardExceededError` stay distinct types.** Unification is Increment 2.
- **Preserve the propagate-never-swallow contract** (CLAUDE.md: handlers are safety infrastructure). A user cancel / race-loser abort must still propagate; only a `guardTrip` cause converts to a `Failure`.
- **`signal.reason` must stay an `Error`** — `runBatch.ts:513` does `throw signal.reason`; aborting with a bare cause object would throw a non-Error. Producers abort with an `AgencyCancelledError` *carrying* the cause.
- **Build:** `make` (not `pnpm run build`) before running fixtures — only `make` copies `lib/agents` into `dist`, which the interrupt-harness fixtures (race-multi-cycle, etc.) need.
- **Test runner:** agency fixtures run via `pnpm run a test <file.agency>`; unit tests via `pnpm test:run <file>`.

---

## Task 1: `AbortCause` carrier + `readCause`

**Files:**
- Modify: `lib/runtime/errors.ts`
- Test: `lib/runtime/errors.test.ts`

**Interfaces:**
- Produces: `type AbortCause` (tagged union); `makeAbortCause(c): AbortCause` (brands the object); `readCause(source: unknown): AbortCause | undefined` (reads from an `AbortSignal`, an `AgencyCancelledError`, or a bare branded cause); `AgencyCancelledError` gains an optional 2nd ctor arg `cause?: AbortCause` exposed as `readonly agencyCause?`.

- [ ] **Step 1: Write failing tests** in `errors.test.ts`: round-trip each `AbortCause` variant through (a) `AbortController.abort(makeAbortCause(c))` → `readCause(signal)` and (b) `new AgencyCancelledError("x", makeAbortCause(c))` → `readCause(err)`; assert `readCause` returns `undefined` for a bare string reason / plain Error / null; assert a `guardTrip`-carrying `AgencyCancelledError` still satisfies `isAbortError`.

- [ ] **Step 2: Run, verify fail** (`pnpm test:run lib/runtime/errors.test.ts`) — `makeAbortCause`/`readCause` undefined.

- [ ] **Step 3: Implement** in `errors.ts`: the `AbortCause` union (`userInterrupt | userKill | guardTrip{dimension,limit,spent,guardId,delivered?} | raceLoser | cleanup`), a `__agencyAbortCause` brand, `makeAbortCause`, `isAbortCause`, `readCause` (signal → recurse on `.reason`; `AgencyCancelledError` → `.agencyCause`; bare branded → itself), and the `agencyCause` ctor arg/field on `AgencyCancelledError`.

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Commit.**

---

## Task 2: `TimeGuard` emits a `guardTrip` cause

**Files:**
- Modify: `lib/runtime/guard.ts`
- Test: `lib/runtime/guard.test.ts`

**Interfaces:**
- Consumes: `makeAbortCause`, `AgencyCancelledError` (Task 1).
- Produces: `nextGuardId(): string`; `TimeGuard.guardId: string`. On timer fire, `TimeGuard` aborts its controller with `new AgencyCancelledError(msg, makeAbortCause({ kind:"guardTrip", dimension:"time", limit, spent, guardId }))`.

- [ ] **Step 1: Write failing test** (`guard.test.ts`, fake timers): install a `TimeGuard(500)`, `vi.advanceTimersByTime(500)`, assert `readCause(stack.abortSignal)` matches `{ kind:"guardTrip", dimension:"time", limit:500, guardId: g.guardId }`.

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement:** add module-level `nextGuardId`, a `guardId` field on `TimeGuard`, and rewrite `startWindow`'s `setTimeout` callback to compute `spent = elapsedMs + (now - windowStart)` and `controller.abort(new AgencyCancelledError(..., makeAbortCause({...})))`.

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Commit.**

---

## Task 3: Leaf ops propagate the cause

**Files:**
- Modify: `lib/stdlib/abortable.ts`

**Interfaces:**
- Consumes: `readCause`, `AgencyCancelledError` (Task 1).
- Produces: `leafCancel(message, signal)` → `new AgencyCancelledError(message, readCause(signal))`. Every reject-on-abort site in `abortableSleep`/`abortableSpawn`/`abortableExec` uses it.

- [ ] **Step 1: Implement** `leafCancel` and replace each `reject(new AgencyCancelledError(\`${command} cancelled\`))` / `reject(new AgencyCancelledError("sleep cancelled"))` with `reject(leafCancel(msg, <signal-in-scope>))`. (Spawn/close/error sites use `options.signal`; exec/sleep use `signal`.)

- [ ] **Step 2:** `grep -n "new AgencyCancelledError" lib/stdlib/abortable.ts` — only the one inside `leafCancel` remains.

- [ ] **Step 3:** `pnpm run build` clean; `pnpm test:run lib/stdlib/abortable.test.ts` green (no behavior change when no cause present).

- [ ] **Step 4: Commit.**

---

## Task 4: `__tryCall` converts a `guardTrip` cause — BEFORE `isAbortError`

**Files:**
- Modify: `lib/runtime/result.ts`

**Interfaces:**
- Consumes: `readCause` (Task 1).
- Produces: a `guardFailureData(dimension, limit, spent)` helper (shared by the cause path and the existing `GuardExceededError` path).

- [ ] **Step 1: Implement** in `__tryCall`'s catch, **above** `if (isAbortError(error)) throw error`:
  ```ts
  const guardCause = readCause(error);
  if (guardCause?.kind === "guardTrip") {
    guardCause.delivered = true; // de-dup with the runner path (Task 5)
    return failure(guardFailureData(guardCause.dimension, guardCause.limit, guardCause.spent), opts);
  }
  ```
  Refactor the existing `GuardExceededError` branch to reuse `guardFailureData`.

  **Why the order matters:** `isAbortError` returns `true` for the cause-carrying `AgencyCancelledError` too. If this check ran after the `isAbortError → throw`, the conversion would be dead code and the crash would remain. This ordering IS the fix (spec Concern 1).

- [ ] **Step 2:** `make`; run all three guard-time fixtures — the bare-cancel crash is gone (they may still fail on the runner path until Task 5).

- [ ] **Step 3: Commit.**

---

## Task 5: `shouldSkip` honors the `delivered` flag

**Files:**
- Modify: `lib/runtime/runner.ts`

**Interfaces:**
- Consumes: `readCause` (Task 1).

**Background (the second trip path):** A time-guard trip can be delivered by EITHER the leaf-op path (Task 4) OR the runner's `shouldSkip` → `check()` → `throw GuardExceededError`. In the no-leaf case, the block's own `shouldSkip` calls `check()` (which sets the guard's `consumed` flag), so the later `_popGuard` step falls through. The leaf path bypasses `check()`, leaving `consumed=false` — so the guard's own `_popGuard` step's `shouldSkip` re-throws an **unhandled** `GuardExceededError`. The shared `delivered` flag on the cause (set by Task 4) closes this.

- [ ] **Step 1: Implement** at the top of `shouldSkip`'s `aborted` branch:
  ```ts
  const cause = readCause(this.stack.abortSignal);
  if (cause?.kind === "guardTrip" && cause.delivered) {
    return this.halted || this._break || this._continue; // fall through; let _popGuard run
  }
  ```
  Leave the existing innermost-first `check()` loop and `guardOwnsAbort` logic below it (the no-leaf path still relies on `check()`/`consumed`).

- [ ] **Step 2: Run all three guard-time fixtures** — now pass (no unhandled rejection):
  ```bash
  for f in guard-time-trip guard-time-nested guard-time-and-cost; do pnpm run a test tests/agency/guards/$f.agency; done
  ```

- [ ] **Step 3:** Regression — full guards dir + race fixtures:
  ```bash
  pnpm run a test tests/agency/guards   # 20 passed
  for f in tests/agency/fork/race/*.agency; do pnpm run a test "$f"; done
  ```

- [ ] **Step 4: Commit.**

---

## Task 6: `context.cancel` / REPL Esc carry user causes

**Files:**
- Modify: `lib/runtime/state/context.ts`, `lib/stdlib/cli.ts`

**Interfaces:**
- `RuntimeContext.cancel(reason?: string, cause?: AbortCause)` — defaults the cause to `userKill` (TS `cancel()` / external abort). `ctx.cleanup()` aborts with a `cleanup` cause. The REPL's Esc handler passes `makeAbortCause({ kind: "userInterrupt" })`.

- [ ] **Step 1: Implement** the optional `cause` arg on `cancel` (default `userKill`), the `cleanup` cause in `cleanup()`, and `userInterrupt` at the `cli.ts` Esc handler. Widen `activeCtxOrNull`'s local `cancel` type to `(r?: string, cause?: AbortCause) => void`.

- [ ] **Step 2:** `make` clean; `pnpm test:run` (full unit suite) green.

- [ ] **Step 3: Commit.**

---

## Task 7: Full verification

- [ ] **Step 1:** `make` clean.
- [ ] **Step 2:** Full unit suite: `pnpm test:run` → all green (the 3 new error tests + 1 new guard test included).
- [ ] **Step 3:** The 3 originally-failing fixtures pass; guards dir (20) + race fixtures green.
- [ ] **Step 4:** `pnpm run lint:structure` clean.
- [ ] **Step 5: Commit; open PR to `main`.**

---

## Deferred to follow-ups (NOT in this increment)

- **`prompt.ts` cause-driven thread repair** (gate `markThreadCancelled` to `user*` causes) and the **`prompt.ts` normalization** preferring `readCause` over the `isCancelled` heuristic. These change the agent-cancel cleanup path and want PTY/agent-level test coverage; not needed to turn CI green. Spec §4.1 steps 5–6.
- **Explicit `raceLoser` tagging** in `runBatch`. Today branch aborts carry no structured cause → `readCause` returns `undefined` → existing silent-halt behavior is preserved, so this is safe to defer.
- **Increment 2 (full unification):** one `AgencyAbort` type, collapsed codegen ladder, ~95 regenerated fixtures, stdlib leaf migration. Separate spec→plan→PR.
