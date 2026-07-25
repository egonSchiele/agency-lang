# Checkpoint-as-Soft-Interrupt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `checkpoint()` sound inside concurrent execution (fork/race/parallel/tool loop) by modeling it as a soft interrupt that settles at the `runBatch` barrier, per `docs/superpowers/ideas/2026-07-05-unify-checkpoint-and-interrupt-suspension-boundaries.md`.

**Architecture:** A new live-only `BatchCoordinator` object (mirroring `StateStack.abortSignal`'s live-field pattern) lets a branch "park" at a `checkpoint()` call. `runBatch` gains a dynamic barrier loop: when every child is settled-or-parked, a pure-checkpoint round stamps one shared checkpoint and continues everyone in place; a mixed round (real interrupt present) unwinds parked branches as `std::checkpoint` marker interrupts through the *existing* interrupt propagation/resume machinery. Nested batches propagate parking upward so only the outermost batch stamps (full-tree restorability). `respondToInterrupts` auto-approves markers; `restore`/`respondToInterrupts`/`rewindFrom` collapse onto one internal `resume` core.

**Tech Stack:** TypeScript runtime only (`lib/runtime/`). No parser, typechecker, codegen, or template changes. Vitest unit tests + `tests/agency/` execution tests.

## Global Constraints

- NEVER use dynamic imports.
- Use objects instead of maps; arrays instead of sets; types instead of interfaces.
- NEVER force push or amend commits.
- When running tests, save output to a file (`2>&1 | tee <log>`); do NOT rerun tests just to re-read output.
- Do NOT run the full agency test suite locally — only the specific tests named in each task.
- Agency code in fixtures MUST follow `docs/site/guide/basic-syntax.md` (`def`/`node`, parens + braces on `if`/`for`, `let`/`const` declarations).
- Handlers are safety infrastructure: nothing in this plan may cause a `handle` block to be skipped for a *real* interrupt. (`std::checkpoint` markers deliberately bypass the handler chain — see D4 — but real interrupts must flow exactly as today.)
- Commit messages: write to a file and pass with `git commit -F <file>` (apostrophes break inline `-m`).

---

## Part 1 — Design decisions (investigation results)

Read this section fully before starting any task. Each decision records the option chosen, the alternatives, and why.

### D1. How `checkpoint()` detects concurrency and finds the barrier: a live-only `StateStack.batchCoordinator` field

`runBatch` sets `branch.stack.batchCoordinator = coordinator` on every child branch stack it starts (in `startInvoke`, next to `composeBranchAbortSignal`). `checkpoint()` reads `getRuntimeContext().stack.batchCoordinator`:

- absent → solo path (top level, or a stack no batch is coordinating): cheap inline snapshot, exactly today's behavior *except* it captures the local slice (D2).
- present → concurrent path: park at the coordinator.

Why this works: inside a branch, every frame push (function calls, blocks) happens on the *same* `StateStack` object (`forkBlockSetup.mustache` seeds the branch stack; `Runner` picks it up from ALS; `runInBranchAlsFrame` seeds `stack: branch.stack`). Nested forks give inner branches their own stacks with the *inner* coordinator — innermost barrier wins naturally.

**Alternatives rejected:**
- *ALS slot on `AgencyStore`:* `Runner.runInScope` builds fresh frame objects without spreading the outer frame, so a coordinator slot would need explicit propagation in `runInScope`, `runInBranchAlsFrame`, `runInBootstrapFrame`, and `withCallsite` — four touch points and easy to miss one. The stack field needs one write site.
- *Comparing `stack !== ctx.stateStack`:* detects "inside a branch" but doesn't give you the coordinator handle, and misfires for stacks that aren't batch children.

Serialization safety: `StateStack.toJSON()` enumerates fields explicitly, so a plain class field is never serialized (same as `abortSignal`, `interrupted`). Deserialized stacks come back without it; `runBatch` re-sets it on re-entry.

### D2. Solo-path fix: capture `getRuntimeContext().stack`, not `ctx.stateStack`

The original bug. At the top level the two are the same object, so existing behavior is bit-identical. On any branch-like stack that somehow lacks a coordinator, capturing the local slice is strictly less wrong than capturing the root. Ships first as an independent, zero-risk commit.

### D3. Unwind mechanism: `checkpoint()` *returns* `Interrupt[]` — zero codegen changes

Verified in `tests/typescriptGenerator/checkpoint-restore.mjs`: every generated `checkpoint()` call site is already wrapped as

```ts
__stack.locals.cp = await __call(checkpoint, { type: "positional", args: [] });
if (hasInterrupts(__stack.locals.cp)) {
  await getRuntimeContext().ctx.pendingPromises.awaitAll()
  runner.halt({ ...__state, data: __stack.locals.cp })
  return;
}
```

So when a mixed batch tells a parked branch to unwind, `checkpoint()` simply returns `[markerInterrupt]` and the existing propagation halts the runner, the fork block returns `runner.haltResult`, and `runBatch` collects it like any other branch interrupt. No `HaltSignal` needed (that exists in `agencyInterrupt.ts` only because TS callers lack the generated guard). No template edits, no `make fixtures` churn.

The marker mirrors `agencyInterrupt.ts`'s discipline exactly:
1. persist `frame.locals["__interrupt_" + stepPath] = intr.interruptId` BEFORE stamping (resume idempotency; captured by the shared checkpoint),
2. stamp a leaf checkpoint from the **local branch stack** (slice rule — this is the vehicle carrying the pre-pop branch stack into `State.toJSON`'s branches walk),
3. return the array.

On resume, the same call site finds the persisted id, looks up `ctx.getInterruptResponse(id)`, and returns the auto-approved value (the shared checkpoint id) without re-parking.

### D4. Markers bypass the handler chain (deviation from the idea doc — flagged deliberately)

The idea doc suggested handlers could optionally observe `std::checkpoint`. We do NOT run `interruptWithHandlers` for markers in v1, because a catch-all `handle { ... approve }` block would approve the marker and let the branch run past its boundary while a sibling holds a real interrupt — exactly the double-execution bug the pin rule exists to prevent. Marker creation is mechanical: by the time one is created, the surface decision was already made by the *real* interrupt (whose handlers ran normally).

Consequences (document loudly):
- `handle std::checkpoint` never fires. No `effect std::checkpoint` declaration is added to stdlib (undeclared effects are silently unchecked, so user handlers naming it are not compile errors — they're just dead).
- Users who want to react to checkpoint creation use the host-surfaced batch or statelog `checkpointCreated`.
- Statelog: markers emit **no** `interruptThrown`/`interruptResolved` events (would break thrown↔resolved pairing since no user resolution exists). The shared `checkpointCreated` event is the observability signal.

Future work (out of scope): an observation-only notification hook.

### D5. Nesting: parking propagates to the parent coordinator; ONLY the outermost batch stamps

**This is the key gap found in the idea doc.** Its sketch has the branch's own `runBatch` stamp the pure-checkpoint batch — but a *nested* batch's `parentStack` is the outer branch's local slice. A checkpoint stamped there is not independently restorable: `restoreState` replaces the whole `execCtx.stateStack` with `cp.stack`, so a slice-only stack would resume the node with garbage frames. Interrupt batches don't have this problem because they unwind and every enclosing `runBatch` re-stamps on the way out; a pure batch never unwinds, so nothing re-stamps.

Rule: when a `runBatch` reaches a pure round, it checks `opts.parentStack.batchCoordinator`:
- present (nested) → it *parks itself* at the parent coordinator, transitively. The whole ancestor chain must reach settled-or-parked. When the outermost coordinator resolves "continue + cpId", each level relays the cpId down to its parked children.
- absent (outermost) → stamp `ctx.checkpoints.create(opts.parentStack, ...)`. At the outermost level `parentStack` is the node's full stack, and every descendant branch is at a boundary, so `State.toJSON`'s recursive branches walk serializes a complete, restorable tree.

Cost consequence (document): a `checkpoint()` deep inside nested concurrency blocks until *every* concurrent ancestor's siblings reach a boundary — the idea doc's risk #3, generalized. If any of them loops forever without a boundary, the checkpoint waits forever.

If instead the outer barrier decides "mixed" (a real interrupt exists anywhere), it resolves the nested batch's park with "unwind"; the nested batch unwinds its own parked children, collects their markers via its normal interrupt path (stamping its inner shared checkpoint, which the outer level then re-stamps as today), and the whole thing surfaces through the existing machinery.

### D6. Pure-round stamping must snapshot parked branches' globals/threads and run `beforeCheckpoint` at every level

`runInBranchAlsFrame` captures `branch.globalsJSON` / `branch.activeStack` only when the body settles as `Interrupt[]`. A parked branch hasn't settled, so without help the stamped checkpoint would restore the branch with a *fresh clone of the parent's* globals, losing writes the branch made before `checkpoint()`. Fix: `runInBranchAlsFrame` registers a per-branch snapshot closure on the coordinator (it closes over `branchGlobals`/`branchThreads`); before any pure-round stamp or upward park, the coordinator runs snapshots for currently-parked branches (isolated dials only, mirroring the capture-on-interrupt discipline).

Same reasoning for `hooks.beforeCheckpoint` (runPrompt's tool loop flushes sibling tool messages into `self.messagesJSON` with it): it must run at *each level* before that level parks upward or stamps — otherwise a checkpoint taken inside one tool would lose sibling tools' completed responses.

### D7. Race mode semantics

- A parked branch is not a settle, so it **cannot win** the race.
- Winner settles while a sibling is parked → parked losers are aborted: their park promise **rejects** with `AgencyCancelledError("race loser", makeAbortCause({kind:"raceLoser"}))`; `checkpoint()` lets it propagate; the branch is abandoned exactly like today's aborted losers (safe from unhandled-rejection because `Promise.race` already subscribed to every tagged promise). On the winner-interrupt path, parked losers are also deleted from `parentFrame.branches` before stamping (invariant #5: losers must not survive into the checkpoint).
- ALL branches parked, none settled → pure round: stamp (or propagate up), continue everyone, keep racing.

### D8. No serialization schema changes

The idea doc sketched a `BranchState` "parked-at-checkpoint" flag. Not needed:
- Mixed path: the marker rides the existing `interruptId`/`interruptData`/leaf-`checkpoint` fields via `setInterruptOnBranch` — indistinguishable from a real interrupt in the JSON, which is fine because resume behavior is driven by the *surfaced interrupt objects* (which carry `effect`), not the branch JSON.
- Pure path: the parked branch serializes as its live mid-step stack (frames un-popped — the same shape as a leaf checkpoint's pre-pop stack). No marker is persisted. On `restore(cpId)`, the branch re-runs its incomplete step, `checkpoint()` executes again, parks again, and mints a **new** checkpoint — which is exactly today's *top-level* restore semantics (the step containing `checkpoint()` is incomplete in the snapshot, so restore re-runs it and gets a fresh id). Retry loops (`restore(id)` inside a branch) work unchanged.

Consequence: post-join `restore(id)` of a mixed-batch checkpoint re-raises the contained real interrupts (branch re-invokes, interrupt site finds persisted id, no response recorded → re-raises with the saved id) and re-parks the marker branches. Consistent with rewind semantics; document loudly (idea-doc risk #2).

### D9. Resume auto-approval + unified `resume`

- `respondToInterrupts(interrupts, responses)`: markers get an injected `{type:"approve", value: <shared cp id>}`. `buildResponseMap` becomes lenient: accepts `responses.length === interrupts.length` (old hosts that respond positionally to everything — their marker responses are ignored and overridden by the auto-approval) OR `responses.length === realInterrupts.length` (new hosts skip markers). Anything else still throws.
- `reportUnhandledInterrupts` skips `std::checkpoint` entries when printing (a marker can only surface alongside a real unhandled interrupt, which still triggers the message + exit).
- New exported `resume({ctx, checkpoint, responses?, overrides?, ...})` — the one primitive. `respondToInterrupts` and `rewindFrom` become wrappers (rewindFrom keeps its `_skipNextCheckpoint` quirk via an option). Plain `resume(cp)` with no responses = today's rewind: real interrupts re-raise; markers re-park. The Agency-level `restore()` builtin (in-process `RestoreSignal`) is unchanged.

### D10. What `checkpoint()` returns, and checkpoint identity

- Concurrent-path `checkpoint()` returns the **shared batch checkpoint id** (all parked branches in the same round get the same id; both calls in a two-checkpoint round return the same id — the design doc's "one shared checkpoint").
- The shared checkpoint's recorded location (`moduleId/scopeName/stepPath`) is the **enclosing batch site** (the fork/race/tool-round step), not the `checkpoint()` callsite — it's stamped by `runBatch` with `opts.checkpointLocation`. Affects `restore(..., {maxRestores})` location counting: all checkpoints from the same fork share a location bucket. Document.
- `nodeId` comes from `ctx.stateStack.currentNodeId()` inside `Checkpoint.fromStateStack` — correct at the outermost stamp.

### D11. Errors and `restore()` racing with parked siblings

If any child settles rejected (JS error — including `RestoreSignal` from a `restore()` call inside a branch) while siblings are parked, the coordinator rejects all parked promises with that error's cancellation so `checkpoint()` throws, those branches settle, the barrier completes, and `runBatch` rethrows the first rejection (existing errors-win-over-interrupts invariant). A `restore()` inside a fork branch therefore: unwinds the whole batch → `RestoreSignal` reaches the node loop → `restoreState(cp)` → re-enters the fork with cached sibling results → the restoring branch re-runs. This makes the classic retry loop work *inside* a fork.

### Out of scope (explicitly)

- Cross-process (`_run` subprocess) checkpoint unification: `checkpoint()` in a subprocess sees its own process-local top-level stack (no coordinator) → solo inline snapshot, today's semantics. Document.
- `checkpoint()` inside an *unawaited* `async` function call: the async body runs on the caller's stack context via `pendingPromises`; whichever stack it sees governs (usually no coordinator → solo). Pin behavior with a test but do not build parking support for it.
- Handler observation of markers (D4 future work).
- Debugger rolling checkpoints (`createRolling` uses `ctx.stateStack` at step boundaries of the top-level runner — not affected by branch parking).

### Edge-case inventory (each maps to a test in the tasks below)

| # | Case | Expected behavior |
|---|------|-------------------|
| E1 | `checkpoint()` at top level (no fork) | Unchanged: inline snapshot, same id semantics (Task 1) |
| E2 | Fork: one branch checkpoints, siblings finish | Pure round: one shared cp, everyone continues inline, fork returns values (Task 4) |
| E3 | Fork: two branches checkpoint (same or different rounds) | Both parks resolve; same cp id per round; no deadlock (Task 4) |
| E4 | Fork: A checkpoints, C interrupts, B finishes | Batch surfaces: C's interrupt + A's `std::checkpoint` marker; one shared cp; resume approves C, auto-approves A; A's tail runs exactly once (Task 5) |
| E5 | Single-item fork with checkpoint | One-branch pure round auto-resolves (Task 4) |
| E6 | `checkpoint()` in a loop inside a branch (multiple parks) | Each round stamps a fresh shared cp (Task 4) |
| E7 | `restore(id)` inside a fork branch (retry loop) | Whole-batch unwind via RestoreSignal; siblings' results cached; branch re-runs (Task 9) |
| E8 | Sibling rejects (JS error) while another is parked | Parked branch aborted; first error rethrown (Task 9) |
| E9 | Nested fork: inner branch checkpoints | Park propagates; outermost stamps full tree; restore works (Task 6) |
| E10 | Nested fork mixed: inner checkpoints, outer sibling interrupts | Inner unwinds as marker through both levels; resume works (Task 6) |
| E11 | Race: all branches checkpoint | Pure round, race continues (Task 7) |
| E12 | Race: winner settles while loser parked | Parked loser aborted + (on interrupt path) deleted pre-stamp (Task 7) |
| E13 | Sequential mode (hook batching): child parks | Not-started siblings are trivially at boundary → pure round (Task 7) |
| E14 | Post-join `restore(cp)` of a mixed-batch checkpoint | Real interrupts re-raise; markers re-park (Task 8) |
| E15 | `shared: true` fork + checkpoint | Pointer-shared globals: no per-branch snapshot (skip), parent store captured by cp globals (Task 4) |
| E16 | Tool-loop (`recordBranchOutcomes: false`) + checkpoint in a tool | Parks at tool-round barrier; `beforeCheckpoint` flushes sibling tool messages pre-stamp (Task 6) |
| E17 | checkpoint in unawaited async call | Pinned as solo-inline (Task 9) |

---

## Part 2 — File structure

- **Create** `lib/runtime/batchCoordinator.ts` — `BatchCoordinator` class + `ParkResolution` type. Pure accounting, no imports from runBatch (breaks what would otherwise be a cycle: stateStack → batchCoordinator, runBatch → batchCoordinator).
- **Create** `lib/runtime/batchCoordinator.test.ts` — co-located unit tests.
- **Modify** `lib/runtime/state/stateStack.ts` — add live-only `batchCoordinator?: BatchCoordinator` field (type-only import).
- **Modify** `lib/runtime/checkpoint.ts` — solo slice fix; concurrent park/unwind path.
- **Modify** `lib/runtime/runBatch.ts` — barrier loop for all three modes; coordinator wiring; pure-round stamp; snapshot registration in `runInBranchAlsFrame`.
- **Modify** `lib/runtime/interrupts.ts` — marker auto-approval, lenient `buildResponseMap`, `reportUnhandledInterrupts` skip, new `resume` core.
- **Modify** `lib/runtime/rewind.ts` — `rewindFrom` delegates to `resume`.
- **Create** `tests/agency/fork/checkpoint/*.agency` + `.test.json` — execution tests E2–E14.
- **Modify** docs: `docs/dev/checkpointing.md`, `docs/dev/concurrent-interrupts.md`, `docs/dev/runBatch.md`, `docs/site/guide/checkpointing.md` (verify exact guide filename before editing).

---

## Part 3 — Tasks

### Task 1: Solo-path slice fix in `checkpoint()`

**Files:**
- Modify: `lib/runtime/checkpoint.ts:14-22`
- Test: `lib/runtime/checkpoint.test.ts`

**Interfaces:**
- Consumes: `getRuntimeContext()` (`lib/runtime/asyncContext.ts`).
- Produces: `checkpoint()` captures the ALS frame's `stack` (local slice). Signature unchanged (`Promise<number>` for now).

- [ ] **Step 1: Read the existing test file** `lib/runtime/checkpoint.test.ts` to match its setup helpers (it builds a `RuntimeContext` and uses `runInTestContext`).

- [ ] **Step 2: Write the failing test** — a checkpoint taken while the ALS frame carries a branch stack must serialize the branch stack, not `ctx.stateStack`:

```ts
test("checkpoint() captures the ALS frame's local stack, not ctx.stateStack", async () => {
  const ctx = await makeCtx(); // reuse the file's existing context factory
  ctx.stateStack.nodesTraversed.push("main");
  const rootFrame = ctx.stateStack.getNewState();
  rootFrame.locals.rootMarker = "root";
  const branchStack = new StateStack();
  const branchFrame = branchStack.getNewState();
  branchFrame.locals.branchMarker = "branch";
  const id = await runInTestContext(ctx, branchStack, new ThreadStore(), () =>
    checkpoint(),
  );
  const cp = ctx.checkpoints.get(id as number)!;
  const top = cp.stack.stack[cp.stack.stack.length - 1];
  expect(top.locals.branchMarker).toBe("branch");
  expect(top.locals.rootMarker).toBeUndefined();
});
```

Adjust imports (`StateStack`, `ThreadStore`, `runInTestContext`) to match the file's existing style.

- [ ] **Step 3: Run it, verify it fails** (captures rootMarker today):

```bash
pnpm test:run lib/runtime/checkpoint.test.ts 2>&1 | tee task1-test.log
```

Expected: the new test FAILS (`branchMarker` undefined / `rootMarker` present).

- [ ] **Step 4: Fix `checkpoint()`** — one-line change plus doc update:

```ts
export async function checkpoint(): Promise<number> {
  const { ctx, stack, callsite } = getRuntimeContext();
  await ctx.pendingPromises.awaitAll();
  // Capture the LOCAL slice from the active ALS frame — identical to
  // ctx.stateStack at the top level, and the branch's own stack inside
  // fork/race/tool-loop branches (the slice rule; see
  // docs/dev/concurrent-interrupts.md "Slice-only checkpoint composition").
  return ctx.checkpoints.create(stack, ctx, {
    moduleId: callsite?.moduleId ?? "",
    scopeName: callsite?.scopeName ?? "",
    stepPath: callsite?.stepPath ?? "",
  });
}
```

- [ ] **Step 5: Run the file's full test suite, verify green:**

```bash
pnpm test:run lib/runtime/checkpoint.test.ts 2>&1 | tee task1-test2.log
```

- [ ] **Step 6: Commit** (`git add lib/runtime/checkpoint.ts lib/runtime/checkpoint.test.ts`, message: `fix: checkpoint() captures the local stack slice, not ctx.stateStack`).

---

### Task 2: `BatchCoordinator`

**Files:**
- Create: `lib/runtime/batchCoordinator.ts`
- Create: `lib/runtime/batchCoordinator.test.ts`
- Modify: `lib/runtime/state/stateStack.ts` (add field)

**Interfaces:**
- Produces (consumed by Tasks 3–7):
  - `type ParkResolution = { action: "continue"; checkpointId: number } | { action: "unwind" }`
  - `class BatchCoordinator` with: `noteStarted()`, `noteSettled()`, `park(stack: StateStack): Promise<ParkResolution>`, `parkedCount: number`, `barrier(): Promise<void>`, `registerSnapshot(stack, fn)`, `snapshotParked()`, `continueParked(checkpointId)`, `unwindParked()`, `abortParked(err)`, `close()`.
  - `StateStack.batchCoordinator?: BatchCoordinator` (live-only, never serialized).

- [ ] **Step 1: Write the failing tests** (`lib/runtime/batchCoordinator.test.ts`):

```ts
import { describe, expect, test } from "vitest";
import { BatchCoordinator } from "./batchCoordinator.js";
import { StateStack } from "./state/stateStack.js";

describe("BatchCoordinator", () => {
  test("barrier resolves when every started child is settled or parked", async () => {
    const c = new BatchCoordinator();
    c.noteStarted();
    c.noteStarted();
    let barrierHit = false;
    const b = c.barrier().then(() => { barrierHit = true; });
    await Promise.resolve();
    expect(barrierHit).toBe(false);
    c.noteSettled();
    await Promise.resolve();
    expect(barrierHit).toBe(false);
    const stack = new StateStack();
    const park = c.park(stack);
    await b;
    expect(barrierHit).toBe(true);
    expect(c.parkedCount).toBe(1);
    c.continueParked(42);
    await expect(park).resolves.toEqual({ action: "continue", checkpointId: 42 });
    expect(c.parkedCount).toBe(0);
  });

  test("a continued child can park again in a later round", async () => {
    const c = new BatchCoordinator();
    c.noteStarted();
    const stack = new StateStack();
    const p1 = c.park(stack);
    c.continueParked(1);
    await expect(p1).resolves.toEqual({ action: "continue", checkpointId: 1 });
    const p2 = c.park(stack);
    c.unwindParked();
    await expect(p2).resolves.toEqual({ action: "unwind" });
  });

  test("abortParked rejects parked promises", async () => {
    const c = new BatchCoordinator();
    c.noteStarted();
    const park = c.park(new StateStack());
    const err = new Error("boom");
    c.abortParked(err);
    await expect(park).rejects.toBe(err);
  });

  test("snapshotParked runs snapshots for parked stacks only", async () => {
    const c = new BatchCoordinator();
    c.noteStarted(); c.noteStarted();
    const a = new StateStack(); const b = new StateStack();
    const ran: string[] = [];
    c.registerSnapshot(a, () => ran.push("a"));
    c.registerSnapshot(b, () => ran.push("b"));
    void c.park(a);
    c.snapshotParked();
    expect(ran).toEqual(["a"]);
    c.continueParked(0);
  });

  test("park after close throws", async () => {
    const c = new BatchCoordinator();
    c.close();
    expect(() => c.park(new StateStack())).toThrow(/completed/);
  });

  test("barrier resolves immediately when nothing is running", async () => {
    const c = new BatchCoordinator();
    await c.barrier(); // 0 started === 0 settled+parked
  });
});
```

- [ ] **Step 2: Run, verify failure** (module doesn't exist):

```bash
pnpm test:run lib/runtime/batchCoordinator.test.ts 2>&1 | tee task2-test.log
```

- [ ] **Step 3: Implement `lib/runtime/batchCoordinator.ts`:**

```ts
/**
 * `BatchCoordinator` — the settle-or-park barrier behind checkpoint()'s
 * soft-interrupt semantics inside concurrent execution.
 *
 * One coordinator per `runBatch` invocation. runBatch installs it on every
 * child branch's `StateStack.batchCoordinator` (live-only field, never
 * serialized — same pattern as `StateStack.abortSignal`). `checkpoint()`
 * finds it there and calls `park(stack)`, suspending the branch at a
 * boundary until runBatch decides the round:
 *
 *  - pure round (no real interrupt in the batch): `continueParked(cpId)` —
 *    every parked checkpoint() returns the shared checkpoint id inline.
 *  - mixed round (a sibling holds a real interrupt): `unwindParked()` —
 *    every parked checkpoint() returns a `std::checkpoint` marker
 *    Interrupt[] and the branch unwinds through the normal propagation.
 *  - error round (a sibling rejected): `abortParked(err)` — parked
 *    checkpoint() calls throw, the batch tears down, the error wins.
 *
 * Accounting is synchronous (single JS thread): `started`, `settled`, and
 * the parked list. The barrier is "no child actively running":
 * `started === settled + parked.length`. A continued branch leaves the
 * parked list and may park again in a later round (checkpoint in a loop).
 *
 * `registerSnapshot` lets `runInBranchAlsFrame` hand the coordinator a
 * closure that flushes branch-local GlobalStore/ThreadStore state onto the
 * BranchState before a pure-round stamp — parked branches never hit the
 * capture-on-interrupt path, so without this the stamped checkpoint would
 * restore them with stale parent clones.
 */
import type { StateStack } from "./state/stateStack.js";

export type ParkResolution =
  | { action: "continue"; checkpointId: number }
  | { action: "unwind" };

type ParkedEntry = {
  stack: StateStack;
  resolve: (r: ParkResolution) => void;
  reject: (err: unknown) => void;
};

type SnapshotEntry = { stack: StateStack; fn: () => void };

export class BatchCoordinator {
  private started = 0;
  private settled = 0;
  private parked: ParkedEntry[] = [];
  private snapshots: SnapshotEntry[] = [];
  private waiters: Array<() => void> = [];
  private closed = false;

  noteStarted(): void {
    this.started++;
  }

  noteSettled(): void {
    this.settled++;
    this.checkBarrier();
  }

  get parkedCount(): number {
    return this.parked.length;
  }

  /** Called by checkpoint() (via `stack.batchCoordinator`). Suspends the
   *  caller until runBatch decides the round. */
  park(stack: StateStack): Promise<ParkResolution> {
    if (this.closed) {
      throw new Error(
        "checkpoint(): the surrounding concurrent batch already completed. " +
          "This indicates a runtime bug — please report it.",
      );
    }
    return new Promise<ParkResolution>((resolve, reject) => {
      this.parked.push({ stack, resolve, reject });
      this.checkBarrier();
    });
  }

  /** Resolves when every started child is settled or parked. */
  barrier(): Promise<void> {
    if (this.atBarrier()) return Promise.resolve();
    return new Promise((res) => this.waiters.push(res));
  }

  private atBarrier(): boolean {
    return this.started === this.settled + this.parked.length;
  }

  private checkBarrier(): void {
    if (!this.atBarrier()) return;
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }

  /** Register (or replace) the branch-local state flush for a stack. */
  registerSnapshot(stack: StateStack, fn: () => void): void {
    const existing = this.snapshots.find((s) => s.stack === stack);
    if (existing) {
      existing.fn = fn;
      return;
    }
    this.snapshots.push({ stack, fn });
  }

  /** Flush branch-local stores for currently-parked branches. Runs before
   *  every pure-round stamp / upward park. Idempotent per round. */
  snapshotParked(): void {
    for (const p of this.parked) {
      const snap = this.snapshots.find((s) => s.stack === p.stack);
      snap?.fn();
    }
  }

  continueParked(checkpointId: number): void {
    const ps = this.drainParked();
    for (const p of ps) p.resolve({ action: "continue", checkpointId });
  }

  unwindParked(): void {
    const ps = this.drainParked();
    for (const p of ps) p.resolve({ action: "unwind" });
  }

  abortParked(err: unknown): void {
    const ps = this.drainParked();
    for (const p of ps) p.reject(err);
  }

  private drainParked(): ParkedEntry[] {
    const ps = this.parked;
    this.parked = [];
    return ps;
  }

  close(): void {
    this.closed = true;
  }
}
```

Note: `drainParked` empties the list *before* resolving so a synchronously re-parking branch lands in the next round's list, and barrier accounting stays consistent (a continued branch is "running" again until it settles or re-parks).

- [ ] **Step 4: Add the live-only field to `StateStack`** (`lib/runtime/state/stateStack.ts`, next to `abortSignal` around line 360), with a type-only import at the top:

```ts
import type { BatchCoordinator } from "../batchCoordinator.js";
```

```ts
  // The coordinator of the runBatch invocation this stack is a child
  // branch of, if any. Set by runBatch's startInvoke on every branch
  // stack; read by checkpoint() to decide solo-inline vs. park-at-
  // barrier (soft interrupt). Like abortSignal: live-only, NEVER
  // serialized (toJSON enumerates fields explicitly, so nothing to do).
  batchCoordinator?: BatchCoordinator;
```

- [ ] **Step 5: Run tests + structural linter, verify green:**

```bash
pnpm test:run lib/runtime/batchCoordinator.test.ts lib/runtime/state/stateStack.test.ts 2>&1 | tee task2-test2.log
pnpm run lint:structure 2>&1 | tee task2-lint.log
```

- [ ] **Step 6: Commit** (`feat: add BatchCoordinator settle-or-park barrier primitive`).

---

### Task 3: `runBatch` barrier loop (behavior-preserving restructure)

Restructure `runBatch`'s mode-"all"/"sequential" core so outcomes are recorded *as children settle* and a coordinator-driven round loop runs at the barrier — but with nothing parking yet, behavior is identical and **all 19 existing `runBatch` tests must stay green unmodified**.

**Files:**
- Modify: `lib/runtime/runBatch.ts`
- Test: `lib/runtime/runBatch.test.ts` (existing suite is the safety net; add 1 new test)

**Interfaces:**
- Consumes: `BatchCoordinator` from Task 2.
- Produces (relied on by Tasks 4–7):
  - Every non-cached child branch stack gets `stack.batchCoordinator` set before `invoke` and the coordinator is `close()`d before `runBatch` returns.
  - `runInBranchAlsFrame` registers the globals/threads snapshot on the coordinator.
  - Internal helper `resolvePureRound(opts, coordinator): Promise<void>` exists (stamps at outermost / parks upward when nested — nested path exercised in Task 6).

- [ ] **Step 1: Restructure mode "all"/"sequential".** Replace step 2 (settle) and step 3 (collect) of `runBatch` with a settle-tracking wrapper + round loop. Concretely:

Add a per-batch mutable record and settle recorder above the mode dispatch:

```ts
  const coordinator = new BatchCoordinator();
  // Recorded per task index as children settle (replaces the old
  // post-allSettled collect loop so a pure-checkpoint round can stamp a
  // checkpoint that already contains finished siblings' results).
  const settled: PromiseSettledResult<T | Interrupt[]>[] = new Array(
    tasks.length,
  );
  let interruptSeen = false;
  let firstError: { err: unknown } | undefined;

  const recordSettle = (i: number, s: PromiseSettledResult<T | Interrupt[]>) => {
    settled[i] = s;
    const t = tasks[i];
    const timeMs = t.cached ? 0 : performance.now() - t.startedAt;
    if (s.status === "rejected") {
      firstError ??= { err: s.reason };
      if (!t.cached) hooks?.onBranchEnd?.(t.child.key, i, "failure", timeMs);
    } else if (hasInterrupts(s.value)) {
      interruptSeen = true;
      if (!t.cached) hooks?.onBranchEnd?.(t.child.key, i, "interrupted", timeMs);
      if (recordOutcomes) {
        parentFrame.setInterruptOnBranch(
          t.child.key,
          s.value[0].interruptId,
          s.value[0].interruptData,
          s.value[0].checkpoint,
        );
      }
    } else {
      if (!t.cached) hooks?.onBranchEnd?.(t.child.key, i, "success", timeMs, s.value);
      if (recordOutcomes) parentFrame.setResultOnBranch(t.child.key, s.value as any);
    }
    coordinator.noteSettled();
  };

  const trackedInvoke = (i: number): Promise<void> => {
    coordinator.noteStarted();
    return startInvoke(opts, tasks[i], i, parentSpanStack).then(
      (value) => recordSettle(i, { status: "fulfilled", value }),
      (reason) => recordSettle(i, { status: "rejected", reason }),
    );
  };
```

Set the coordinator on the branch stack inside `startInvoke` (after `composeBranchAbortSignal`):

```ts
  t.branch.stack.batchCoordinator = opts.coordinator;
```

(Thread the coordinator to `startInvoke` — simplest is adding a `coordinator: BatchCoordinator` field to an internal extension of the opts passed around, or an extra parameter `startInvoke(opts, t, i, parentSpanStack, coordinator)`. Use the extra parameter; update all three call sites including the race paths.)

Round loop shared by "all" and "sequential":

```ts
  /** Wait for the barrier and resolve checkpoint rounds until no child is
   * parked. On return every started child has settled. */
  const settleRounds = async (): Promise<void> => {
    while (true) {
      await coordinator.barrier();
      if (coordinator.parkedCount === 0) return;
      if (firstError !== undefined) {
        coordinator.abortParked(firstError.err);
        continue;
      }
      if (interruptSeen) {
        coordinator.unwindParked();
        continue;
      }
      await resolvePureRound(opts, coordinator);
    }
  };
```

Mode dispatch becomes:

```ts
  if (mode === "sequential") {
    for (let i = 0; i < tasks.length; i++) {
      const p = trackedInvoke(i);
      await settleRounds();
      await p;
    }
  } else {
    const ps = tasks.map((_, i) => trackedInvoke(i));
    await settleRounds();
    await Promise.all(ps);
  }
  coordinator.close();
```

And the final collect shrinks to (outcomes already recorded):

```ts
  if (firstError !== undefined) throw firstError.err;
  const interrupts: Interrupt[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled" && hasInterrupts(s.value)) interrupts.push(...s.value);
  }
```

then the existing step-4/step-5 tail (stamp+return interrupts / propagate cost+popBranches+return values) unchanged. Keep the cached-branch semantics: cached tasks still go through `trackedInvoke` (their `startInvoke` resolves immediately with the cached value) — this keeps started/settled accounting uniform.

Add `resolvePureRound` (nested branch is completed in Task 6 — for now implement the outermost arm and make the nested arm throw a descriptive "not implemented yet" error; Task 6 replaces it):

```ts
/** A round where every child is settled-or-parked and no real interrupt or
 * error is present: stamp ONE shared checkpoint (outermost batch) or park
 * this whole batch at the enclosing batch's coordinator (nested — Task 6),
 * then release the parked branches with the checkpoint id. */
async function resolvePureRound<T>(
  opts: RunBatchOpts<T>,
  coordinator: BatchCoordinator,
): Promise<void> {
  const { ctx, parentStack, checkpointLocation, hooks } = opts;
  hooks?.beforeCheckpoint?.();
  coordinator.snapshotParked();
  const parentCoordinator = parentStack.batchCoordinator;
  if (parentCoordinator) {
    throw new Error("nested checkpoint parking is implemented in Task 6");
  }
  const cpId = ctx.checkpoints.create(parentStack, ctx, checkpointLocation);
  hooks?.onCheckpoint?.(cpId);
  coordinator.continueParked(cpId);
}
```

- [ ] **Step 2: Register the snapshot in `runInBranchAlsFrame`.** Inside the `agencyStore.run` body, before `await fn()`:

```ts
      // Parked-at-checkpoint branches never hit the capture-on-INTERRUPT
      // path below, so hand the coordinator a flush closure to run before
      // any pure-round checkpoint stamp (see BatchCoordinator docstring).
      branch.stack.batchCoordinator?.registerSnapshot(branch.stack, () => {
        if (!shareGlobals) branch.globalsJSON = branchGlobals.toJSON();
        if (!shareThreads) branch.activeStack = [...branchThreads.activeStack];
      });
```

- [ ] **Step 3: Run the existing `runBatch` suite — must be green with zero test edits:**

```bash
pnpm test:run lib/runtime/runBatch.test.ts lib/runtime/promptRunner.test.ts 2>&1 | tee task3-test.log
```

If any existing test fails, fix the restructure — do not modify the tests.

- [ ] **Step 4: Add one new test** pinning the coordinator lifecycle:

```ts
test("runBatch installs a batchCoordinator on child stacks and closes it after", async () => {
  // Build ctx/frame/stack with the file's existing helpers.
  let seen: BatchCoordinator | undefined;
  const result = await runBatch<number>({
    ...baseOpts(), // the file's existing opts factory
    mode: "all",
    children: [{
      key: "c0",
      invoke: async (childStack) => {
        seen = childStack.batchCoordinator;
        return 1;
      },
    }],
  });
  expect(result).toEqual({ kind: "values", values: [1] });
  expect(seen).toBeDefined();
  expect(() => seen!.park(new StateStack())).toThrow(/completed/);
});
```

- [ ] **Step 5: Run, verify green; run structural linter:**

```bash
pnpm test:run lib/runtime/runBatch.test.ts 2>&1 | tee task3-test2.log
pnpm run lint:structure 2>&1 | tee task3-lint.log
```

- [ ] **Step 6: Commit** (`refactor: runBatch settle-or-park round loop, outcomes recorded on settle`).

---

### Task 4: `checkpoint()` concurrent path — pure batches (single level)

**Files:**
- Modify: `lib/runtime/checkpoint.ts`
- Test: `lib/runtime/runBatch.test.ts` (integration through runBatch), `lib/runtime/checkpoint.test.ts`
- Create: `tests/agency/fork/checkpoint/checkpoint-pure.agency` + `.test.json`, `checkpoint-single-branch.agency` + `.test.json`, `checkpoint-two-branches.agency` + `.test.json`

**Interfaces:**
- Consumes: `BatchCoordinator.park` (Task 2), coordinator on branch stacks (Task 3).
- Produces: `checkpoint(): Promise<number | Interrupt[]>` — parks when `stack.batchCoordinator` is set; returns the shared checkpoint id on `continue`. (The `Interrupt[]` arm returns in Task 5; declare the union now.)

- [ ] **Step 1: Write the failing runBatch-level test:**

```ts
test("a child that parks at checkpoint() gets the shared checkpoint id and continues", async () => {
  const order: string[] = [];
  const result = await runBatch<string>({
    ...baseOpts(),
    mode: "all",
    children: [
      {
        key: "a",
        invoke: async (childStack) => {
          order.push("a:before");
          const res = await childStack.batchCoordinator!.park(childStack);
          order.push(`a:${res.action}`);
          return res.action === "continue" ? `cp:${res.checkpointId}` : "unwound";
        },
      },
      { key: "b", invoke: async () => { order.push("b"); return "done"; } },
    ],
  });
  expect(result.kind).toBe("values");
  const values = (result as any).values as string[];
  expect(values[1]).toBe("done");
  expect(values[0]).toMatch(/^cp:\d+$/);
  expect(order).toContain("a:continue");
  // The stamped checkpoint must contain b's finished result.
  const cpId = Number(values[0].slice(3));
  const cp = baseCtx.checkpoints.get(cpId)!;
  const frame = cp.stack.stack[cp.stack.stack.length - 1];
  expect(frame.branches!["b"].result).toEqual({ result: "done" });
});
```

(Adapt `baseOpts`/`baseCtx` to the file's existing fixtures — the suite already builds `ctx`, `parentStack`, `parentFrame`.)

- [ ] **Step 2: Run, verify it fails** (Task 3's loop should actually make this pass already — if it passes, good: it validates Task 3; keep it as a regression test and move on):

```bash
pnpm test:run lib/runtime/runBatch.test.ts 2>&1 | tee task4-test.log
```

- [ ] **Step 3: Implement `checkpoint()`'s concurrent path** (full replacement of `lib/runtime/checkpoint.ts`'s `checkpoint` function; add imports `interrupt, type Interrupt` from `./interrupts.js`):

```ts
/**
 * Capture a checkpoint of the current execution state.
 *
 * Solo path (no surrounding concurrent batch): inline snapshot of the
 * LOCAL stack slice; returns the checkpoint id immediately.
 *
 * Concurrent path (`stack.batchCoordinator` present — this stack is a
 * fork/race/parallel/tool-loop branch): checkpoint() is a SOFT interrupt.
 * It parks at the batch barrier until every sibling reaches a suspension
 * boundary (finish, interrupt, or checkpoint):
 *  - pure round (no real interrupt): ONE shared checkpoint is stamped by
 *    the outermost batch and its id is returned inline — no unwind.
 *  - mixed round (a sibling holds a real interrupt): returns a
 *    `std::checkpoint` marker Interrupt[]; the generated call-site guard
 *    halts the branch and the batch surfaces to the host. On resume the
 *    marker is auto-approved with the shared checkpoint id.
 * See docs/dev/checkpointing.md "Checkpoints inside concurrent execution".
 */
export async function checkpoint(): Promise<number | Interrupt[]> {
  const { ctx, stack, callsite } = getRuntimeContext();
  await ctx.pendingPromises.awaitAll();
  const location = {
    moduleId: callsite?.moduleId ?? "",
    scopeName: callsite?.scopeName ?? "",
    stepPath: callsite?.stepPath ?? "",
  };
  const coordinator = stack.batchCoordinator;
  if (!coordinator) {
    return ctx.checkpoints.create(stack, ctx, location);
  }

  // Resume idempotency (mixed-path replay): if this call site already
  // unwound as a marker and the resume injected its auto-approval,
  // return the shared checkpoint id without re-parking. Mirrors
  // agencyInterrupt.ts's persisted-id short-circuit.
  const frame = stack.lastFrame();
  const key = `__interrupt_${location.stepPath}`;
  const persistedId = frame?.locals[key];
  if (persistedId !== undefined) {
    const resp = ctx.getInterruptResponse(persistedId);
    if (resp !== undefined) return (resp as { value?: number }).value as number;
  }

  const res = await coordinator.park(stack);
  if (res.action === "continue") return res.checkpointId;

  // Unwind: a sibling holds a real interrupt, so this branch must pin at
  // its boundary. Become a std::checkpoint marker interrupt and let the
  // generated call-site `hasInterrupts` guard halt the branch. Handler
  // chains are deliberately bypassed (a handler approving the marker
  // would let this branch run past the shared resume point — double
  // execution on resume).
  const intr = interrupt({
    effect: "std::checkpoint",
    message: "checkpoint() suspended together with a concurrent interrupt",
    data: {},
    origin: location.moduleId,
    runId: ctx.getRunId(),
  });
  // Persist the id BEFORE stamping the leaf checkpoint so the snapshot
  // captures it (resume replays this step and short-circuits above).
  if (frame) frame.locals[key] = intr.interruptId;
  const leafCpId = ctx.checkpoints.create(stack, ctx, location);
  intr.checkpointId = leafCpId;
  intr.checkpoint = ctx.checkpoints.get(leafCpId);
  return [intr];
}
```

Verify `ctx.getRunId()` exists on `RuntimeContext` (it's used in `interrupts.ts:376`).

- [ ] **Step 4: Add a checkpoint-level unit test** (in `checkpoint.test.ts`): install a coordinator on the test stack, resolve the park from the test body, assert the returned id:

```ts
test("checkpoint() parks at the batch coordinator and returns the shared id", async () => {
  const ctx = await makeCtx();
  ctx.stateStack.nodesTraversed.push("main");
  const branchStack = new StateStack();
  branchStack.getNewState();
  const coordinator = new BatchCoordinator();
  coordinator.noteStarted();
  branchStack.batchCoordinator = coordinator;
  const pending = runInTestContext(ctx, branchStack, new ThreadStore(), () => checkpoint());
  await coordinator.barrier();
  coordinator.continueParked(99);
  await expect(pending).resolves.toBe(99);
});
```

- [ ] **Step 5: Run unit tests:**

```bash
pnpm test:run lib/runtime/checkpoint.test.ts lib/runtime/runBatch.test.ts 2>&1 | tee task4-test2.log
```

- [ ] **Step 6: Check how the agency test harness responds to interrupts.** Before writing execution tests, read the test runner (find it via `grep -rn "interruptHandlers" lib/ --include=*.ts | head`) and `docs/misc/TESTING.md` to confirm (a) how `interruptHandlers` map to surfaced interrupts (positional vs. per-interrupt) and (b) that a test with NO `interruptHandlers` fails loudly if something surfaces. Record findings in the task notes; Task 5 depends on them.

- [ ] **Step 7: Write execution tests** (`tests/agency/fork/checkpoint/`):

`checkpoint-pure.agency` (E2):

```agency
node main() {
  let results = fork(["a", "b", "c"]) as item {
    if (item == "a") {
      const id = checkpoint()
      if (id >= 0) {
        return "checkpointed"
      }
      return "impossible"
    }
    return "done: ${item}"
  }
  return results
}
```

`checkpoint-pure.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "checkpoint() in a fork branch auto-resolves when siblings finish (pure batch)",
      "input": "",
      "expectedOutput": "[\"checkpointed\",\"done: b\",\"done: c\"]",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

`checkpoint-single-branch.agency` (E5): same shape with `fork(["a"])`, expected `["checkpointed"]`.

`checkpoint-two-branches.agency` (E3):

```agency
node main() {
  let results = fork(["a", "b"]) as item {
    const id = checkpoint()
    if (id >= 0) {
      return "cp-ok: ${item}"
    }
    return "impossible"
  }
  return results
}
```

expected `["cp-ok: a","cp-ok: b"]`.

- [ ] **Step 8: Run the three execution tests, save output:**

```bash
pnpm run agency test tests/agency/fork/checkpoint/checkpoint-pure.agency 2>&1 | tee task4-agency.log
pnpm run agency test tests/agency/fork/checkpoint/checkpoint-single-branch.agency 2>&1 | tee -a task4-agency.log
pnpm run agency test tests/agency/fork/checkpoint/checkpoint-two-branches.agency 2>&1 | tee -a task4-agency.log
```

Expected: all pass. (If the runner wants the `.test.json` path instead, use that — check TESTING.md.)

- [ ] **Step 9: Commit** (`feat: checkpoint() parks as a soft interrupt inside concurrent batches (pure path)`).

---

### Task 5: Mixed batches — the `std::checkpoint` marker + resume auto-approval

**Files:**
- Modify: `lib/runtime/interrupts.ts` (`buildResponseMap`, `respondToInterrupts`, `reportUnhandledInterrupts`)
- Test: `lib/runtime/interrupts.test.ts`, `lib/runtime/runBatch.test.ts`
- Create: `tests/agency/fork/checkpoint/checkpoint-mixed.agency` + `.test.json`

**Interfaces:**
- Consumes: marker-producing `checkpoint()` (Task 4 built the unwind arm; this task makes runBatch trigger it and resume honor it).
- Produces:
  - `respondToInterrupts` auto-approves `effect === "std::checkpoint"` interrupts with `{type:"approve", value: <shared cp id>}`.
  - `buildResponseMap(interrupts, responses)` accepts `responses.length === interrupts.length` (marker responses overridden) or `=== real.length`.

- [ ] **Step 1: Write the failing runBatch test (mixed round):**

```ts
test("a parked child is unwound when a sibling interrupts (mixed batch)", async () => {
  const result = await runBatch<any>({
    ...baseOpts(),
    mode: "all",
    children: [
      {
        key: "a",
        invoke: async (childStack) => {
          const res = await childStack.batchCoordinator!.park(childStack);
          expect(res).toEqual({ action: "unwind" });
          // Simulate checkpoint()'s marker (unit level; the real marker
          // creation is covered by the execution test).
          return [makeTestInterrupt("std::checkpoint")];
        },
      },
      { key: "b", invoke: async () => [makeTestInterrupt("std::ask")] },
    ],
  });
  expect(result.kind).toBe("interrupts");
  const intrs = (result as any).interrupts as Interrupt[];
  expect(intrs.map((i) => i.effect).sort()).toEqual(["std::ask", "std::checkpoint"]);
  // Both share the batch checkpoint (existing stamp+overwrite).
  expect(intrs[0].checkpointId).toBe(intrs[1].checkpointId);
});
```

(`makeTestInterrupt` = the file's existing interrupt factory helper, or build via `interrupt({...})` with a leaf checkpoint attached the way existing tests do.)

- [ ] **Step 2: Run, verify** — with Task 3's loop this may already pass (the `unwindParked` arm). If so it's a pinned regression; continue.

```bash
pnpm test:run lib/runtime/runBatch.test.ts 2>&1 | tee task5-test.log
```

- [ ] **Step 3: Write failing tests for the resume half** (`lib/runtime/interrupts.test.ts`):

```ts
describe("std::checkpoint markers in respondToInterrupts", () => {
  test("buildResponseMap-lenient: responses may omit markers", ... );
  test("markers are auto-approved with the shared checkpoint id", ...);
  test("a user response supplied for a marker is overridden by the auto-approval", ...);
});
```

Concretely, the middle test: build two interrupts (one `std::ask`, one `std::checkpoint`) sharing a stamped checkpoint object, call `respondToInterrupts` with ONE response (`approve()`), and assert the run resumes (use the file's existing respond-path fixtures — there are existing `respondToInterrupts` tests to copy setup from; if the existing tests are integration-style through compiled fixtures, put these assertions on a new exported pure helper instead — see Step 4's `injectMarkerApprovals`).

- [ ] **Step 4: Implement.** In `lib/runtime/interrupts.ts`:

1. Marker predicate + constant near the top:

```ts
/** Effect name of the soft-interrupt marker emitted by checkpoint() when a
 * concurrent batch surfaces with a real interrupt. Markers bypass handler
 * chains and are auto-approved on resume — see lib/runtime/checkpoint.ts. */
export const CHECKPOINT_EFFECT = "std::checkpoint";

export function isCheckpointMarker(i: Interrupt): boolean {
  return i.effect === CHECKPOINT_EFFECT;
}
```

2. `buildResponseMap` leniency (replace the length check):

```ts
function buildResponseMap(
  interrupts: Interrupt[],
  responses: InterruptResponse[],
): Record<string, { response: InterruptResponse }> {
  const real = interrupts.filter((i) => !isCheckpointMarker(i));
  const zipTargets =
    responses.length === interrupts.length
      ? interrupts
      : responses.length === real.length
        ? real
        : undefined;
  if (zipTargets === undefined) {
    throw new Error(
      `respondToInterrupts: expected ${real.length} responses` +
        (real.length !== interrupts.length
          ? ` (or ${interrupts.length} including std::checkpoint markers)`
          : "") +
        ` but got ${responses.length}`,
    );
  }
  const responseMap: Record<string, { response: InterruptResponse }> = {};
  for (let i = 0; i < zipTargets.length; i++) {
    responseMap[zipTargets[i].interruptId] = { response: deepClone(responses[i]) };
  }
  return responseMap;
}
```

3. Auto-approval injection + statelog skip in `respondToInterrupts`, after the shared checkpoint is resolved:

```ts
  // std::checkpoint markers are auto-approved with the shared checkpoint
  // id: on replay the marker's call site returns this value inline as the
  // checkpoint() result. Overrides any user-supplied response for a
  // marker — rejecting a checkpoint is meaningless (it has nothing to
  // approve), so the auto-approval always wins.
  for (const intr of interrupts) {
    if (isCheckpointMarker(intr)) {
      responseMap[intr.interruptId] = {
        response: { type: "approve", value: checkpoint.id } as InterruptResponse,
      };
    }
  }
```

and in the `interruptResolved` statelog loop, guard positional pairing: iterate `real` (non-marker) interrupts zipped against the map (look responses up by `interruptId` from `responseMap` instead of positional `responses[i]`, so the lenient shapes don't mispair) and skip markers entirely.

4. `reportUnhandledInterrupts`: `if (isCheckpointMarker(it)) continue;` at the top of its loop.

- [ ] **Step 5: Run unit tests:**

```bash
pnpm test:run lib/runtime/interrupts.test.ts lib/runtime/runBatch.test.ts 2>&1 | tee task5-test2.log
```

- [ ] **Step 6: Execution test E4** (`tests/agency/fork/checkpoint/checkpoint-mixed.agency`):

```agency
node main() {
  let results = fork(["a", "b", "c"]) as item {
    if (item == "a") {
      const id = checkpoint()
      if (id >= 0) {
        return "checkpointed"
      }
      return "impossible"
    }
    if (item == "c") {
      interrupt("approve c?")
      return "approved: c"
    }
    return "done: b"
  }
  return results
}
```

`.test.json` (shape depends on Task 4 Step 6 findings — if `interruptHandlers` map positionally to the *surfaced* array, supply one `approve` and rely on the lenient real-only zip; if the harness auto-responds to each surfaced interrupt, supply what it needs):

```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "checkpoint marker surfaces alongside a real interrupt and auto-approves on resume",
      "input": "",
      "expectedOutput": "[\"checkpointed\",\"done: b\",\"approved: c\"]",
      "evaluationCriteria": [{ "type": "exact" }],
      "interruptHandlers": [{ "action": "approve" }]
    }
  ]
}
```

```bash
pnpm run agency test tests/agency/fork/checkpoint/checkpoint-mixed.agency 2>&1 | tee task5-agency.log
```

The load-bearing assertion is `"checkpointed"` appearing exactly once — the pinned branch's tail (`return "checkpointed"`) ran only on resume, not twice.

- [ ] **Step 7: Commit** (`feat: std::checkpoint marker interrupts — mixed batches surface and auto-approve on resume`).

---

### Task 6: Nested batches — park propagation to the outermost coordinator

**Files:**
- Modify: `lib/runtime/runBatch.ts` (`resolvePureRound` nested arm)
- Test: `lib/runtime/runBatch.test.ts`
- Create: `tests/agency/fork/checkpoint/checkpoint-nested.agency` + `.test.json`, `checkpoint-nested-mixed.agency` + `.test.json`

**Interfaces:**
- Consumes: `BatchCoordinator.park` (parent side), Task 3's `resolvePureRound` stub.
- Produces: nested pure rounds park upward; only the outermost stamps; mixed decisions cascade down as `unwind`.

- [ ] **Step 1: Write the failing unit test** — two nested `runBatch`es built by hand:

```ts
test("nested pure round parks at the parent coordinator; only the outermost stamps", async () => {
  const created: number[] = [];
  // Count checkpoint creations via ctx.checkpoints (compare store size
  // before/after, or wrap onCheckpoint hooks at both levels).
  const result = await runBatch<any>({
    ...baseOpts(),
    mode: "all",
    hooks: { onCheckpoint: (id) => created.push(id) },
    children: [
      {
        key: "outerA",
        invoke: async (outerStack) => {
          // inner batch runs on the outer branch's stack as its parentStack
          const innerFrame = outerStack.getNewState();
          const inner = await runBatch<any>({
            ...baseOpts(),
            parentStack: outerStack,
            parentFrame: innerFrame,
            mode: "all",
            children: [
              {
                key: "innerX",
                invoke: async (innerStack) => {
                  const res = await innerStack.batchCoordinator!.park(innerStack);
                  return res.action === "continue" ? res.checkpointId : "unwound";
                },
              },
            ],
          });
          outerStack.pop();
          return (inner as any).values[0];
        },
      },
      { key: "outerB", invoke: async () => "b-done" },
    ],
  });
  expect(result.kind).toBe("values");
  const cpId = (result as any).values[0];
  expect(typeof cpId).toBe("number");
  expect(created).toEqual([cpId]); // exactly one stamp, at the OUTER level
});
```

- [ ] **Step 2: Run, verify it fails** with Task 3's "implemented in Task 6" error:

```bash
pnpm test:run lib/runtime/runBatch.test.ts 2>&1 | tee task6-test.log
```

- [ ] **Step 3: Implement the nested arm of `resolvePureRound`:**

```ts
  if (parentCoordinator) {
    // Nested batch: a checkpoint stamped HERE would capture only this
    // branch's slice — not restorable (restoreState replaces the whole
    // stack). Park this entire batch at the enclosing batch's barrier
    // instead; the outermost batch stamps the full tree once every
    // concurrent ancestor is settled-or-parked, and the id is relayed
    // back down. If the parent decides "unwind" (a real interrupt exists
    // somewhere in the tree), cascade the unwind to our parked children —
    // they surface as std::checkpoint markers through the normal
    // interrupt path and this batch re-stamps on the way out as today.
    const res = await parentCoordinator.park(parentStack);
    if (res.action === "unwind") {
      coordinator.unwindParked();
      return;
    }
    coordinator.continueParked(res.checkpointId);
    return;
  }
```

- [ ] **Step 4: Run unit tests green:**

```bash
pnpm test:run lib/runtime/runBatch.test.ts 2>&1 | tee task6-test2.log
```

- [ ] **Step 5: Execution tests.**

`checkpoint-nested.agency` (E9):

```agency
node main() {
  let results = fork(["outer1", "outer2"]) as o {
    if (o == "outer1") {
      let inner = fork(["i1"]) as i {
        const id = checkpoint()
        if (id >= 0) {
          return "inner-checkpointed"
        }
        return "impossible"
      }
      return inner
    }
    return "outer2-done"
  }
  return results
}
```

expected `[["inner-checkpointed"],"outer2-done"]` (verify exact serialization of nested arrays against an existing nested-fork fixture in `tests/agency/fork/nested/` and adjust).

`checkpoint-nested-mixed.agency` (E10): same shape but `outer2` raises `interrupt("approve?")` before returning; `.test.json` supplies one `approve`; expected output has both branches completed, `"inner-checkpointed"` exactly once.

```bash
pnpm run agency test tests/agency/fork/checkpoint/checkpoint-nested.agency 2>&1 | tee task6-agency.log
pnpm run agency test tests/agency/fork/checkpoint/checkpoint-nested-mixed.agency 2>&1 | tee -a task6-agency.log
```

- [ ] **Step 6 (E16, tool loop): Execution test only if cheap.** The tool loop requires an LLM call (expensive). Write `tests/agency/fork/checkpoint/checkpoint-in-tool.agency` — an `llm(...)` prompt with a tool whose body calls `checkpoint()` — ONLY if an existing multi-tool fixture (`tests/agency/fork/llm-tools/`) can be minimally adapted with one LLM call. Otherwise cover the tool-loop path with a `promptRunner.test.ts` unit test that drives `PromptRunner.parallel` with a parking child, asserting `beforeCheckpoint` ran before the stamp (spy ordering). Do not add more than one LLM call.

- [ ] **Step 7: Commit** (`feat: nested batch checkpoint parking — only the outermost batch stamps`).

---

### Task 7: Race and sequential modes

**Files:**
- Modify: `lib/runtime/runBatch.ts` (`runRaceFirstTime`, `runRaceResume`)
- Test: `lib/runtime/runBatch.test.ts`
- Create: `tests/agency/fork/checkpoint/checkpoint-race.agency` + `.test.json`

**Interfaces:**
- Consumes: coordinator from Task 3 (already wired into `startInvoke` for all modes).
- Produces: race honors D7 (parked can't win; all-parked → pure round; winner-settle aborts parked losers); sequential parking already works via Task 3's loop — pin with a test.

- [ ] **Step 1: Write the failing race tests:**

```ts
test("race: all branches parked → pure round stamps and racing continues", async () => {
  const result = await runBatch<string>({
    ...baseOpts(),
    mode: "race",
    raceWinnerLocalKey: "__race_winner_0",
    children: ["a", "b"].map((k) => ({
      key: `race_${k}`,
      invoke: async (childStack) => {
        const res = await childStack.batchCoordinator!.park(childStack);
        if (res.action !== "continue") return "unwound";
        return `won-${k}`;
      },
    })),
  });
  expect(result.kind).toBe("values");
  expect((result as any).values[0]).toMatch(/^won-/);
});

test("race: parked loser is aborted when the winner settles", async () => {
  let loserErr: unknown;
  const result = await runBatch<string>({
    ...baseOpts(),
    mode: "race",
    raceWinnerLocalKey: "__race_winner_0",
    children: [
      { key: "winner", invoke: async () => "fast" },
      {
        key: "loser",
        invoke: async (childStack) => {
          try {
            await childStack.batchCoordinator!.park(childStack);
          } catch (e) {
            loserErr = e;
            throw e;
          }
          return "slow";
        },
      },
    ],
  });
  expect((result as any).values).toEqual(["fast"]);
  await vi.waitFor(() => expect(loserErr).toBeInstanceOf(AgencyCancelledError));
});
```

- [ ] **Step 2: Run, verify failure** (race currently `Promise.race`s settles only — the all-parked case hangs; use vitest timeouts):

```bash
pnpm test:run lib/runtime/runBatch.test.ts -t "race:" 2>&1 | tee task7-test.log
```

- [ ] **Step 3: Implement race parking.** In `runRaceFirstTime`, wire `trackedInvoke`-style settle tracking (coordinator `noteStarted`/`noteSettled` around the tagged promises — reuse the same helpers; keep the winner/first-failure identification), then replace the bare `await Promise.race(tagged)` with a decision loop:

```ts
  // Race barrier: either somebody settles (winner / first failure), or
  // everyone parks at a checkpoint (all-parked pure round: stamp or park
  // upward, continue everyone, keep racing). A parked branch is NOT a
  // settle and cannot win.
  const firstSettle = Promise.race(tagged).then(
    (w) => ({ kind: "winner" as const, w }),
    (e) => ({ kind: "failed" as const, e }),
  );
  let raceOutcome: Awaited<typeof firstSettle>;
  while (true) {
    const ev = await Promise.race([
      firstSettle,
      coordinator.barrier().then(() => "barrier" as const),
    ]);
    if (ev !== "barrier") { raceOutcome = ev; break; }
    if (coordinator.parkedCount === 0) { raceOutcome = await firstSettle; break; }
    await resolvePureRound(opts, coordinator);
  }
```

then dispatch `raceOutcome` into the existing winner/failure code paths. After the winner is known, abort parked losers *before* the existing loser abort/delete loop:

```ts
  coordinator.abortParked(
    new AgencyCancelledError("race loser", makeAbortCause({ kind: "raceLoser" })),
  );
```

(the existing `deleteBranch` loop over non-winner tasks already removes their branches on both winner-value and winner-interrupt paths — verify the interrupt path deletes parked losers too, since invariant #5 forbids losers surviving into the stamp). Also apply the coordinator wiring to `runRaceResume` (single child; parking there means a solo racer checkpointed — barrier of one → pure round). Close the coordinator on all exits.

Subtle: `resolvePureRound` in race mode runs while `firstSettle` is subscribed; because a pure round only fires when *nobody* has settled, there is no decision race — re-check `coordinator.parkedCount` right after the barrier as shown.

- [ ] **Step 4: Sequential-mode pin test** (E13 — should already pass via Task 3):

```ts
test("sequential: a parked child resolves a pure round while later children are unstarted", async () => {
  const result = await runBatch<string>({
    ...baseOpts(),
    mode: "sequential",
    children: [
      {
        key: "s0",
        invoke: async (childStack) => {
          const res = await childStack.batchCoordinator!.park(childStack);
          return res.action === "continue" ? "s0-cp" : "s0-unwound";
        },
      },
      { key: "s1", invoke: async () => "s1-done" },
    ],
  });
  expect((result as any).values).toEqual(["s0-cp", "s1-done"]);
});
```

- [ ] **Step 5: Run the whole runBatch suite:**

```bash
pnpm test:run lib/runtime/runBatch.test.ts 2>&1 | tee task7-test2.log
```

- [ ] **Step 6: Execution test E11** (`checkpoint-race.agency`, single item to keep output deterministic):

```agency
node main() {
  let result = race(["only"]) as item {
    const id = checkpoint()
    if (id >= 0) {
      return "raced-with-checkpoint"
    }
    return "impossible"
  }
  return result
}
```

expected `"raced-with-checkpoint"`.

```bash
pnpm run agency test tests/agency/fork/checkpoint/checkpoint-race.agency 2>&1 | tee task7-agency.log
```

- [ ] **Step 7: Commit** (`feat: checkpoint parking in race and sequential batch modes`).

---

### Task 8: Unified `resume(cp, responses?)`

**Files:**
- Modify: `lib/runtime/interrupts.ts` (extract `resume` core; `respondToInterrupts` delegates)
- Modify: `lib/runtime/rewind.ts` (`rewindFrom` delegates)
- Modify: `lib/runtime/index.ts` (export `resume`)
- Test: `lib/runtime/interrupts.test.ts`, existing `rewind`-related tests

**Interfaces:**
- Produces:

```ts
export async function resume(args: {
  ctx: RuntimeContext<GraphState>;
  checkpoint: Checkpoint;
  /** interruptId → response. Absent/partial: uncovered real interrupts
   * re-raise on replay; std::checkpoint markers re-park. */
  responses?: Record<string, InterruptResponse>;
  overrides?: Record<string, unknown>;
  metadata?: Record<string, any>;
  registerTopLevelCallbacks?: (ctx: RuntimeContext<GraphState>) => void | Promise<void>;
  moduleDir?: string;
  /** rewindFrom compatibility (skip re-stamping at the restored step). */
  skipNextCheckpoint?: boolean;
}): Promise<any>;
```

- [ ] **Step 1: Read `rewind.ts` fully** and diff its loop against `respondToInterrupts`+`runResumeLoop`. Confirm the deltas are exactly: response map (respond-only), `_skipNextCheckpoint` (rewind-only), runId minting (rewind mints, respond reuses `interrupt.runId`), overrides application (both), statelog details. If additional deltas exist, list them in the code comment and preserve each.

- [ ] **Step 2: Write the failing test:**

```ts
test("resume(cp) without responses re-raises the contained interrupts", async () => {
  // Reuse an existing respondToInterrupts fixture that produces a
  // surfaced batch; then call resume({ctx, checkpoint: interrupts[0].checkpoint!})
  // and assert the return value is an Interrupt[] batch with the SAME
  // interruptIds (invariant #4: saved ids are reused on re-raise).
});
```

Model the setup on the existing `respondToInterrupts` tests in `interrupts.test.ts` (or `tests/agency-js/interrupts/` if unit setup is impractical — prefer unit).

- [ ] **Step 3: Implement.** Extract the shared body (createExecutionContext → loadProviderModules → statelog checkpointRestored → registerTopLevelCallbacks in bootstrap frame → `applyOverrides` → `restoreState` → optional `setInterruptResponses` → optional `_skipNextCheckpoint` → metadata.callbacks/debugger → `runResumeLoop`) into `resume`, then:

- `respondToInterrupts` = validate + `buildResponseMap` + marker auto-approvals + per-response statelog, then `resume({..., responses: responseMap-values})` (adapt: `resume` takes `Record<string, InterruptResponse>`; wrap into the store's `{response}` shape inside `resume`).
- `rewindFrom` = deepClone cp + `resume({..., overrides, skipNextCheckpoint: true, metadata})`, preserving its runId-minting and its distinctive statelog events.

Keep both public signatures byte-compatible — generated code (`imports.ts` template output) calls them.

- [ ] **Step 4: Run every suite that touches these paths:**

```bash
pnpm test:run lib/runtime/interrupts.test.ts lib/runtime/runBatch.test.ts lib/runtime/checkpoint.test.ts 2>&1 | tee task8-test.log
pnpm run agency test tests/agency/fork/fork-multi-interrupt.agency 2>&1 | tee task8-agency.log
pnpm run agency test tests/agency/fork/checkpoint/checkpoint-mixed.agency 2>&1 | tee -a task8-agency.log
```

Also run one rewind-flavored test — find it via `grep -rln "rewindFrom" tests/ lib/ --include=*.test.ts | head` and run what exists.

- [ ] **Step 5: Export** `resume` from `lib/runtime/index.ts` next to the `respondToInterrupts` export.

- [ ] **Step 6: Commit** (`feat: unified resume(cp, responses?) core behind respondToInterrupts and rewindFrom`).

---

### Task 9: Error paths and remaining edge pins

**Files:**
- Test: `lib/runtime/runBatch.test.ts`
- Create: `tests/agency/fork/checkpoint/checkpoint-restore-in-fork.agency` + `.test.json`, `checkpoint-loop-in-fork.agency` + `.test.json`

- [ ] **Step 1 (E8): unit test — sibling rejection aborts parked branches:**

```ts
test("a sibling rejection aborts parked branches and the error wins", async () => {
  let parkRejected = false;
  await expect(
    runBatch<any>({
      ...baseOpts(),
      mode: "all",
      children: [
        {
          key: "parked",
          invoke: async (childStack) => {
            try {
              await childStack.batchCoordinator!.park(childStack);
            } catch (e) {
              parkRejected = true;
              throw e;
            }
            return "unreachable";
          },
        },
        { key: "bomb", invoke: async () => { throw new Error("boom"); } },
      ],
    }),
  ).rejects.toThrow("boom");
  expect(parkRejected).toBe(true);
});
```

Run; if it fails, fix `settleRounds`' error arm (Task 3) accordingly.

- [ ] **Step 2 (E7): execution test — retry loop inside a fork:**

`checkpoint-restore-in-fork.agency`:

```agency
shared attempts = 0

node main() {
  let results = fork(["only"]) as item {
    const id = checkpoint()
    attempts = attempts + 1
    if (attempts < 3) {
      restore(id, {})
    }
    return attempts
  }
  return results
}
```

expected `[3]`. (Verify `shared` declaration syntax against `tests/agency/` fixtures using `shared` — e.g. the checkpointing doc's examples — before finalizing.)

- [ ] **Step 3 (E6): execution test — checkpoint in a loop inside a branch:**

`checkpoint-loop-in-fork.agency`:

```agency
node main() {
  let results = fork(["a", "b"]) as item {
    let ids = []
    for (i in range(2)) {
      const id = checkpoint()
      ids = push(ids, id)
    }
    return len(ids)
  }
  return results
}
```

expected `[2,2]`. (Verify `range`/`push`/`len` names against stdlib — `grep -rn "def range\|def push\|def len" stdlib/*.agency` — and substitute the real ones.)

- [ ] **Step 4 (E17): pin async-call behavior.** Write a small execution test `checkpoint-async-call.agency` where an `async`-called function invokes `checkpoint()` and is awaited later at top level; assert it completes and returns a numeric id (solo path — read `docs/dev/async.md` first; if the async body actually inherits a branch stack in some configuration, adjust the expectation and document what you find in the test description).

- [ ] **Step 5: Run all new tests, save logs:**

```bash
pnpm test:run lib/runtime/runBatch.test.ts 2>&1 | tee task9-test.log
pnpm run agency test tests/agency/fork/checkpoint/checkpoint-restore-in-fork.agency 2>&1 | tee task9-agency.log
pnpm run agency test tests/agency/fork/checkpoint/checkpoint-loop-in-fork.agency 2>&1 | tee -a task9-agency.log
pnpm run agency test tests/agency/fork/checkpoint/checkpoint-async-call.agency 2>&1 | tee -a task9-agency.log
```

- [ ] **Step 6: Commit** (`test: checkpoint soft-interrupt edge cases — restore-in-fork, loops, errors, async`).

---

### Task 10: Documentation

**Files:**
- Modify: `docs/dev/checkpointing.md` — new section "Checkpoints inside concurrent execution": the boundary rule (finish OR interrupt OR checkpoint), solo vs. park, marker semantics, D8's restore-reruns-checkpoint semantics, barrier cost, location/maxRestores nuance (D10), subprocess/async carve-outs.
- Modify: `docs/dev/concurrent-interrupts.md` — add `BatchCoordinator` + the third settle outcome to the runBatch section; add invariant: "**Only the outermost batch stamps a pure-checkpoint round.** A nested batch parks upward; a slice-stamped pure checkpoint is not restorable."; update the invariants list and Key files.
- Modify: `docs/dev/runBatch.md` — document the settle-or-park barrier, `resolvePureRound`, race/sequential parking semantics, and the new no-throw-plus-no-park contract notes.
- Modify: the user-facing guide page (find it: `ls docs/site/guide/ | grep -i checkpoint`) — document `checkpoint()` in `fork`/`race`: blocks until siblings reach a boundary; may pause together with a sibling's interrupt (and the host sees a `std::checkpoint` entry it can ignore); `restore` of a fork checkpoint re-asks contained interrupts. Keep it user-level (no coordinator internals).
- Modify: `docs/superpowers/ideas/2026-07-05-unify-checkpoint-and-interrupt-suspension-boundaries.md` — update Status to "planned/in progress", link this plan, and record the two design amendments discovered during planning: nested parking must propagate to the outermost batch (D5), and markers bypass handler chains (D4).

- [ ] **Step 1: Write the doc changes** per the file list above.
- [ ] **Step 2: Check for dead references:** `grep -rn "respondToInterrupts\|rewindFrom" docs/dev/*.md | head` and update descriptions to mention the shared `resume` core.
- [ ] **Step 3: Commit** (`docs: checkpoint soft-interrupt model — boundary rule, nesting, resume unification`).

---

## Part 4 — Final verification (after all tasks)

- [ ] `pnpm test:run lib/runtime/ 2>&1 | tee final-unit.log` — full runtime unit suite.
- [ ] Run ONLY the new + directly-adjacent agency tests locally (`tests/agency/fork/checkpoint/*`, `tests/agency/fork/fork-multi-interrupt`, one race test). The full agency suite runs in CI on the PR.
- [ ] `pnpm run lint:structure 2>&1 | tee final-lint.log`.
- [ ] `make 2>&1 | tee final-make.log` — full build (stdlib untouched, but confirm the runtime compiles into the distributed build).
- [ ] Re-read D4/D5/D8 and confirm the implementation matches; if anything drifted, update the docs task output to match reality.

## Self-review notes (already applied)

- Spec coverage: idea-doc sections map to tasks — governing rule/barrier (T2–T4), soft-interrupt model (T4–T5), pin rule + worked example (T5, E4 test), unified resume (T8), risks 1–5 (D4, E14, D5-cost-doc, D-determinism-doc, T4's auto-resolve tests). Open questions resolved: auto-resolve mechanics = live-suspended parks, never unwinds (D5/T3); handler-reject of a checkpoint = not expressible v1 (D4); naming = `std::checkpoint` effect string, no stdlib `effect` declaration (D4).
- Two deliberate deviations from the idea doc, both flagged inline: nested stamping moved to the outermost batch (idea doc's sketch was slice-unsound), and no `BranchState` schema change (D8 shows it's unnecessary).
- Type consistency: `ParkResolution`, `BatchCoordinator` method names, `CHECKPOINT_EFFECT`, and `resume` signature are each defined once (Tasks 2, 5, 8) and consumed by name elsewhere.
