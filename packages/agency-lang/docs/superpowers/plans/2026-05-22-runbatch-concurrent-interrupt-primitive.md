# `runBatch` — One Concurrent-Interrupt Primitive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace four hand-rolled instances of the concurrent-interrupt pattern (`runForkAll`, `runRace`, `runPrompt`'s tool loop, the proposed multi-callback hook fire) with a single `runBatch` primitive in the runtime. Plus fix one related slice-rule bug (parallel-branch callback fire — Plan 1) that doesn't itself need `runBatch` but is enabled by an `AgencyFunction.invoke` change that `runBatch` also wants. The leaf checkpoint mechanism (`interruptReturn` template, `interruptWithHandlers`) is **not** changed — the `isForked` approach that bypassed leaf stamping was deliberately removed in c72b9c1574 and must not be reintroduced. What changes is the boilerplate around `Promise.allSettled` that today every concurrent-interrupt site hand-rolls and gets subtly wrong (most recently in the parallel-callback Bug 2 — callbacks ran on `ctx.stateStack` instead of `branchStack`, breaking the slice rule).

**Architecture:** One runtime function, `runBatch(opts)`, owns:
- per-child branch creation (`getOrCreateBranch`),
- threading a per-child `branchStack` into the child's `invoke` (so the leaf inside captures the right slice — this collapses the slice-rule discipline to *one* place to audit instead of five; the caller can still pass `ctx.stateStack` as `parentStack` by mistake, but there's a single line to check rather than five hand-rolled sites),
- cached-result + pending-interrupt short-circuit on resume,
- per-child `AbortController` composition with the parent stack's signal,
- three execution modes:
  - `"all"` — `Promise.allSettled`, every child runs concurrently, return when all settle.
  - `"sequential"` — `for...of` loop, each child runs after the previous resolves, batch-level checkpoint still stamps once at the end. Used for sequential same-hook callbacks (today's `callHook` semantics). **This is required**: today's `callHook` fires callbacks strictly in order; `mode: "all"` would silently change that to concurrent, breaking ordering of side effects.
  - `"race"` — `Promise.race`, first to settle wins, abort losers.
- collecting `Interrupt[]` from children, calling `setInterruptOnBranch(key, id, data, childCheckpoint)` for each,
- stamping the single shared parent checkpoint and overwriting `intr.checkpoint`/`intr.checkpointId` on every collected interrupt (the overwrite is intentional, per commit c72b9c1574 — all interrupts in a batch deliberately share one resume point),
- cleanup on success via `popBranches()`.

What `runBatch` does **not** do: the leaf `interruptReturn` template still stamps a per-leaf checkpoint exactly as today; `runBatch` reads it from the surfaced `Interrupt[]` and stores it on the BranchState. This keeps the existing isForked-free composition (leaf always pops, leaf's checkpoint vehicles its pre-pop stack into the parent's `branches` walk in `State.toJSON`).

**Tech Stack:** TypeScript runtime (`lib/runtime/runner.ts`, `lib/runtime/promptRunner.ts`, `lib/runtime/prompt.ts`, `lib/runtime/hooks.ts`, `lib/runtime/state/stateStack.ts`), Agency execution tests (`tests/agency/`), Vitest.

**Constraint reminders:**
- Everything must be JSON-serializable. No in-memory side state. (`abortController` is the only live-only field on `BranchState` today; new code must follow the same pattern — anything not serializable must be reconstructable on resume.)
- Handlers (`handle` blocks) are safety-critical. Per-branch handler chains stay as today; `runBatch` does not touch handler bookkeeping.
- Per-branch cost/token propagation (`seedBranchCost` / `propagateBranchCost`) must be preserved for fork-all parity.

---

### Task 1: Add `runBatch` to the runtime (no migrations yet)

**Files:**
- Create: `lib/runtime/runBatch.ts`
- Create: `lib/runtime/runBatch.test.ts`

- [ ] **Step 1: Read the three existing call sites end-to-end**

Read these to understand exactly what the primitive must replicate:
- `Runner.runForkAll` (`lib/runtime/runner.ts:782-902`) — the canonical fork-mode shape, with cost seeding/propagation and ALS span isolation.
- `Runner.runRace` (`lib/runtime/runner.ts:990-...`) — race-mode, winner recording, loser deletion.
- `PromptRunner.parallel` + `BranchRunner` (`lib/runtime/promptRunner.ts:140-227`) — the runPrompt-side variant, with merged checkpoint stamping and the `BranchRunner.step` substep-per-branch idempotency.

Take notes on which pieces are batch-level (`runBatch` will own) versus per-child-body (stays inside the caller's `invoke`):
- batch-level: branch lifecycle, settle, stamp, overwrite, abort composition, cost seed/propagate, ALS branch context.
- per-child-body: substep idempotency inside a single branch (e.g. `BranchRunner.step`'s `completedSteps` for `.start`/`.invoke`/`.end`/`.log`), tool message pushes, anything specific to that caller's domain.

- [ ] **Step 2: Define the `runBatch` signature**

```ts
// lib/runtime/runBatch.ts
import type { Interrupt } from "./interrupts.js";
import { hasInterrupts } from "./interrupts.js";
import type { RuntimeContext } from "./state/context.js";
import type { State, StateStack, BranchState } from "./state/stateStack.js";

export type BatchChild<T> = {
  /** Stable per-child key. Used for `getOrCreateBranch`. Caller is
   * responsible for uniqueness within `parentFrame.branches`. */
  key: string;
  /** Invoked with the child's own `StateStack` (already seeded with abort
   * signal composed with parent) and that stack's abort signal. Must
   * return either a value `T` (success) or an `Interrupt[]` (halted with
   * interrupts). MUST NOT throw `Interrupt[]`. May throw other errors. */
  invoke: (childStack: StateStack, abortSignal: AbortSignal) => Promise<T | Interrupt[]>;
};

export type RunBatchOpts<T> = {
  ctx: RuntimeContext<any>;
  /** The parent's local state stack — used as the capture stack for the
   * shared batch-level checkpoint. MUST be the local slice (e.g. the
   * branch stack if `runBatch` is itself called inside a child of an
   * outer `runBatch`), NOT `ctx.stateStack`. This is the one discipline
   * the caller of `runBatch` must observe. */
  parentStack: StateStack;
  /** The frame where branch state lives. Usually `parentStack.lastFrame()`. */
  parentFrame: State;
  /** Where the shared checkpoint records its location. Same fields the
   * existing call sites pass to `ctx.checkpoints.create`. */
  checkpointLocation: { moduleId: string; scopeName: string; stepPath: string };
  /** "all" → Promise.allSettled, concurrent; "sequential" → for...of,
   * each child after the previous (today's callHook semantics); "race"
   * → first to settle wins, others are aborted.
   *
   * IMPORTANT: do not use "all" for hook-callback batching — that would
   * change today's strictly-sequential `callHook` ordering. Use
   * "sequential". */
  mode: "all" | "sequential" | "race";
  children: BatchChild<T>[];
  /** Optional: per-branch cost seed/propagate (set by runForkAll today).
   * Default: no-op. Pass `Runner`'s helpers when migrating runForkAll. */
  hooks?: {
    seedBranchCost?: (childStack: StateStack, parentStack: StateStack) => void;
    propagateBranchCost?: (branches: BranchState[], parentStack: StateStack) => void;
    /** Called once per branch start (statelog). */
    onBranchStart?: (key: string, index: number) => void;
    /** Called once per branch end with its outcome. */
    onBranchEnd?: (key: string, index: number, outcome: "success" | "interrupted" | "failure", timeMs: number) => void;
    /** Called once when the batch stamps its shared checkpoint. */
    onCheckpoint?: (checkpointId: number) => void;
  };
};

export type RunBatchResult<T> =
  | { kind: "values"; values: T[] }
  | { kind: "interrupts"; interrupts: Interrupt[] };

export async function runBatch<T>(opts: RunBatchOpts<T>): Promise<RunBatchResult<T>>;
```

The result is a tagged union so callers can pattern-match cleanly instead of having to inspect the array for `hasInterrupts`.

- [ ] **Step 3: Implement `runBatch` for modes `"all"` and `"sequential"`**

Both modes share branch setup, outcome collection, checkpoint stamping, and cost propagation. They differ only in how the children are awaited.

Sketch (full implementation in the file):

```ts
export async function runBatch<T>(opts: RunBatchOpts<T>): Promise<RunBatchResult<T>> {
  const { ctx, parentStack, parentFrame, checkpointLocation, mode, children, hooks } = opts;

  // 0. Cheap insurance against caller bugs.
  const seen = new Set<string>();
  for (const c of children) {
    if (seen.has(c.key)) throw new Error(`runBatch: duplicate child key ${JSON.stringify(c.key)}`);
    seen.add(c.key);
  }

  // 0b. Race resume dispatch — if the winner was recorded, run only the winner.
  // (mode "race" only; see Step 4.)

  // 1. Set up branches.
  type Task = { child: BatchChild<T>; branch: BranchState; startedAt: number; cached: boolean };
  const tasks: Task[] = children.map((child) => {
    const branch = parentFrame.getOrCreateBranch(child.key);
    return { child, branch, startedAt: 0, cached: branch.result !== undefined };
  });
  const parentSpanStack = ctx.statelogClient.snapshotStack();

  const startInvoke = (t: Task, i: number) => {
    if (t.cached) {
      return Promise.resolve(t.branch.result!.result);
    }
    if (!t.branch.abortController) {
      t.branch.abortController = new AbortController();
      const parentSig = parentStack.abortSignal;
      t.branch.stack.abortSignal = parentSig
        ? AbortSignal.any([parentSig, t.branch.abortController.signal])
        : t.branch.abortController.signal;
    }
    hooks?.seedBranchCost?.(t.branch.stack, parentStack);
    hooks?.onBranchStart?.(t.child.key, i);
    t.startedAt = performance.now();
    return ctx.statelogClient.runInBranchContext(parentSpanStack, () =>
      t.child.invoke(t.branch.stack, t.branch.stack.abortSignal!),
    );
  };

  // 2. Settle.
  let settled: PromiseSettledResult<T | Interrupt[]>[];
  if (mode === "sequential") {
    // Strict order, one at a time. Today's callHook semantics.
    settled = [];
    for (let i = 0; i < tasks.length; i++) {
      try { settled.push({ status: "fulfilled", value: await startInvoke(tasks[i], i) }); }
      catch (reason) { settled.push({ status: "rejected", reason }); }
    }
  } else {
    // mode "all" — parallel. (mode "race" handled in Step 4.)
    settled = await Promise.allSettled(tasks.map((t, i) => startInvoke(t, i)));
  }

  // 3. Collect outcomes. Gate hooks on non-cached so cached branches don't
  // emit duplicate statelog events on resume cycles.
  const interrupts: Interrupt[] = [];
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    const { child, branch, startedAt, cached } = tasks[i];
    const timeMs = cached ? 0 : performance.now() - startedAt;
    if (s.status === "rejected") {
      if (!cached) hooks?.onBranchEnd?.(child.key, i, "failure", timeMs);
      throw s.reason;
    }
    const value = s.value;
    if (hasInterrupts(value)) {
      if (!cached) hooks?.onBranchEnd?.(child.key, i, "interrupted", timeMs);
      interrupts.push(...value);
      parentFrame.setInterruptOnBranch(
        child.key,
        value[0].interruptId,
        value[0].interruptData,
        value[0].checkpoint, // leaf's per-branch checkpoint goes here
      );
    } else {
      if (!cached) hooks?.onBranchEnd?.(child.key, i, "success", timeMs);
      parentFrame.setResultOnBranch(child.key, value);
    }
  }

  // 4. Stamp shared parent checkpoint + overwrite.
  if (interrupts.length > 0) {
    const cpId = ctx.checkpoints.create(parentStack, ctx, checkpointLocation);
    const cp = ctx.checkpoints.get(cpId)!;
    for (const intr of interrupts) {
      intr.checkpoint = cp;
      intr.checkpointId = cpId;
    }
    hooks?.onCheckpoint?.(cpId);
    return { kind: "interrupts", interrupts };
  }

  // 5. No interrupts — propagate cost, clear branches, return values.
  const allBranches = tasks.map(t => t.branch);
  hooks?.propagateBranchCost?.(allBranches, parentStack);
  parentFrame.popBranches();
  return { kind: "values", values: settled.map(s => (s as PromiseFulfilledResult<T>).value) };
}
```

**Inherited invariant (document explicitly, do not change):** if any child rejects (throws a non-interrupt error), `runBatch` rethrows that error and abandons any interrupts that sibling branches successfully halted with. This matches today's `runForkAll`/`runRace` behavior. The runtime does not attempt to surface a mix of "real error" + "halted interrupts" — the error wins. Callers that need both must catch inside `invoke`.

- [ ] **Step 4: Implement mode `"race"` (including resume dispatch)**

Same overall shape, with these differences:
- Tag each promise with its index so the winner can be identified.
- Use `Promise.race` on the tagged promises to get the winner.
- After the winner settles, walk every non-winner task and call `branch.abortController?.abort()`.
- **Persist the winner under the existing key.** Use `parentFrame.locals[`__race_winner_${id}`]` where `id` is the runner step id (NOT `stepPath`). Today's `runRace` uses this exact key shape; changing it to `stepPath` would silently break any in-flight checkpoint serialized before the migration. The caller (`runRace` adapter in Task 3) passes `id` as an extra opt; `runBatch`'s mode "race" reads/writes that key.
  - Add `raceWinnerLocalKey?: string` to `RunBatchOpts` (only set for mode "race"). The adapter computes `__race_winner_${id}` and passes it.
- Delete loser branches via `parentFrame.deleteBranch(loserKey)` before stamping/returning. This preserves the existing slice-only guarantee that losers don't survive into the checkpoint.

**Resume dispatch (folded into Step 4, NOT deferred):** at the top of `runBatch`, before any branch setup, check if `mode === "race"` AND `opts.raceWinnerLocalKey` is set AND `parentFrame.locals[opts.raceWinnerLocalKey]` is a number. If so, run only the winner index (`children[winnerIndex]`) via a single-child invocation. This subsumes today's `resumeRaceWinner` so the caller (`Runner.fork`) does not need to dispatch — it unconditionally calls `runBatch` whether on first run or resume.

**Cost-propagation asymmetry (matches today's `runRace`):**
- On first race (winner settles, losers aborted): propagate cost ONLY for the loser branches eagerly via the hook (so their partial work is accounted for). Skip the winner — its cost will propagate later when the winner's branch finally pops in a no-interrupt resume.
- On race resume (only the winner runs and completes): propagate the winner's cost as a normal mode-"all"-style propagate.

Expose this via two distinct hook callbacks in `RunBatchOpts.hooks`:
```ts
propagateLoserCost?: (loserBranches: BranchState[], parentStack: StateStack) => void;
propagateWinnerCost?: (winnerBranch: BranchState, parentStack: StateStack) => void;
```
The race adapter (Task 3) provides both; the all adapter (Task 2) only provides `propagateBranchCost`. Drop the unified `propagateBranchCost` from race mode entirely — its caller-side semantics differ enough that a single hook signature would be misleading.

**Mode-flip defensive assert:** if `parentFrame.locals[raceWinnerLocalKey]` is set but `mode !== "race"` (or vice versa: caller passes `mode: "race"` but the frame has no `raceWinnerLocalKey` set yet and also has cached branches from an `"all"` run), throw a clear "checkpoint/mode mismatch" error. This should never happen but catches caller bugs loudly.

- [ ] **Step 5: Unit tests**

`lib/runtime/runBatch.test.ts`. No agency code — pure JS test of the primitive against a mocked `RuntimeContext`. Cover:
- single child, returns value → `{ kind: "values", values: [v] }`.
- single child, returns `Interrupt[]` → `{ kind: "interrupts", interrupts: [...] }`, with the leaf's `checkpoint` reachable via `parentFrame.getBranch(key)?.checkpoint`.
- multiple children, mixed outcomes → all values cached, all interrupts batched into one shared checkpoint.
- resume short-circuit: pre-populate a branch with `result: { result: 42 }`, run batch, the cached value is returned, `invoke` is never called, and `onBranchStart`/`onBranchEnd` do NOT fire for that branch.
- abort composition: parent stack's abort signal fires → child's `invoke` sees aborted signal.
- mode `"sequential"`: children invoked one after the previous; assert ordering via a shared side-effect log; batch-level checkpoint stamps once if any interrupted.
- mode `"all"` vs `"sequential"` produce identical observable outcomes for non-interrupting children except for fire ordering — both return values in `children` order.
- mode `"race"`: first settler wins, losers get aborted; loser branches deleted; winner branch persisted; `parentFrame.locals[raceWinnerLocalKey]` set.
- mode `"race"` resume (folded in Task 1 Step 4): with `raceWinnerLocalKey` set and a numeric value in locals, only the winner is invoked; loser children are not even branched.
- `hooks.seedBranchCost` / `propagateBranchCost` (mode "all") / `propagateLoserCost` + `propagateWinnerCost` (mode "race") / `onBranchStart` / `onBranchEnd` / `onCheckpoint` fire at the right moments and skip cached branches.
- empty `children: []` → returns `{ kind: "values", values: [] }`; `propagateBranchCost([])` and `popBranches()` are no-ops.
- duplicate child keys → throws `Error` with a clear message; no branches created, no checkpoint stamped.
- mode-flip defensive assert: pre-set `parentFrame.locals[raceWinnerLocalKey]`, call `runBatch` with `mode: "all"` → throws "checkpoint/mode mismatch."

Save test output:
```bash
pnpm test:run -- runBatch > /tmp/runbatch.log 2>&1
```

- [ ] **Step 6: Commit**

```bash
git add lib/runtime/runBatch.ts lib/runtime/runBatch.test.ts
git commit -F /tmp/commit-msg.txt   # "feat: add runBatch primitive for concurrent-interrupt batching (not yet migrated)"
```

---

### Task 2: Migrate `Runner.runForkAll` to `runBatch`

**Files:**
- Modify: `lib/runtime/runner.ts` (`runForkAll`)

This is the largest existing user and has the deepest test coverage (`tests/agency/fork/`). If `runBatch` doesn't pass these tests, the primitive is wrong.

- [ ] **Step 1: Replace `runForkAll`'s body**

The new `runForkAll` is a thin adapter:

```ts
private async runForkAll(
  id: number, items: any[], blockFn, stateStack: StateStack, forkId: string,
): Promise<any> {
  const result = await runBatch({
    ctx: this.ctx,
    parentStack: stateStack,
    parentFrame: this.frame,
    checkpointLocation: {
      moduleId: this.moduleId,
      scopeName: this.scopeName,
      stepPath: this.stepPath(id),
    },
    mode: "all",
    children: items.map((item, i) => ({
      key: this.forkBranchKey(id, i),
      invoke: (branchStack) => blockFn(item, i, branchStack),
    })),
    hooks: {
      seedBranchCost: this.seedBranchCost.bind(this),
      propagateBranchCost: this.propagateBranchCost.bind(this),
      onBranchStart: (key, i) => { /* no-op or set start time */ },
      onBranchEnd: (key, i, outcome, timeMs) => {
        this.ctx.statelogClient.forkBranchEnd({ forkId, branchIndex: i, outcome, timeTaken: timeMs });
      },
      onCheckpoint: (cpId) => {
        const cp = this.ctx.checkpoints.get(cpId)!;
        this.ctx.statelogClient.checkpointCreated({
          checkpointId: cpId, reason: "fork",
          sourceLocation: { moduleId: cp.moduleId, scopeName: cp.scopeName, stepPath: cp.stepPath },
        });
      },
    },
  });
  return result.kind === "interrupts" ? result.interrupts : result.values;
}
```

- [ ] **Step 2: Run the fork test suite, save output**

```bash
pnpm run agency test tests/agency/fork > /tmp/fork-post-migrate.log 2>&1 || true
```

Inspect `/tmp/fork-post-migrate.log`. Every test that was passing pre-migration must pass. Pay particular attention to:
- `fork-multi-interrupt`, `fork-multi-cycle-interrupt` (batching + multi-cycle),
- `fork-nested-interrupt`, `nested/three-levels-deep`, `nested/mixed-completion-nested` (slice-only composition),
- `fork-llm-tool-nested`, `fork-llm-deep-loop` (composition with runPrompt's tool loop, which is NOT yet migrated — verifies the two layers still interop),
- `fork-stress` (mixed everything).

- [ ] **Step 3: Commit**

```bash
git add lib/runtime/runner.ts
git commit -F /tmp/commit-msg.txt   # "refactor: runForkAll uses runBatch primitive"
```

---

### Task 3: Migrate `Runner.runRace` and `resumeRaceWinner` to `runBatch`

**Files:**
- Modify: `lib/runtime/runner.ts` (`runRace`, `resumeRaceWinner`, `Runner.fork`)

- [ ] **Step 1: Replace `runRace`'s body with `runBatch({ mode: "race", ... })`**

Same adapter shape as Task 2. Pass `raceWinnerLocalKey: \`__race_winner_${id}\`` so `runBatch` reads/writes the **existing** key (NOT a new `stepPath`-based one — keeping the key shape preserves checkpoint format compatibility with any in-flight serialized state). The winner-recording logic and loser-deletion live inside `runBatch`'s mode "race" path (added in Task 1 Step 4).

Provide both `propagateLoserCost` and `propagateWinnerCost` hooks (defined in Task 1 Step 4) — the race adapter is the only place that needs the asymmetric variant.

- [ ] **Step 2: Delete `resumeRaceWinner`; update `Runner.fork` to always call `runBatch`**

`resumeRaceWinner`'s logic is folded into `runBatch`'s mode "race" resume dispatch (Task 1 Step 4). Delete the function. Update `Runner.fork` to unconditionally call the race-mode `runBatch` adapter — the adapter itself handles "first run" vs. "resume winner" via the `raceWinnerLocalKey` check inside `runBatch`.

- [ ] **Step 3: Run the race test suite**

```bash
pnpm run agency test tests/agency/fork/race > /tmp/race-post-migrate.log 2>&1 || true
pnpm run agency test tests/agency/fork/race-basic.agency >> /tmp/race-post-migrate.log 2>&1 || true
pnpm run agency test tests/agency/fork/race-interrupt.agency >> /tmp/race-post-migrate.log 2>&1 || true
```

All race tests pass. Particular attention to:
- `race-mixed-completion`, `race-multi-cycle`, `race-reject-winner`, `race-with-fork-inside`.

- [ ] **Step 4: Commit**

```bash
git add lib/runtime/runner.ts
git commit -F /tmp/commit-msg.txt   # "refactor: runRace uses runBatch primitive"
```

---

### Task 4: Migrate `runPrompt`'s tool loop to `runBatch`

**Files:**
- Modify: `lib/runtime/prompt.ts` (the parallel tool-call loop, currently using `PromptRunner.parallel`)
- Modify: `lib/runtime/promptRunner.ts` (`PromptRunner.parallel` and `BranchRunner` survive but only own the per-branch substep machinery, not the batch orchestration)

This is the most invasive migration because `PromptRunner.parallel` and `BranchRunner` are intertwined. Split cleanly:
- `runBatch` owns batch orchestration: branch creation, settle, stamp, overwrite, abort.
- `BranchRunner.step` (the per-tool `.start` / `.invoke` / `.end` / `.log` substep idempotency) stays — but now it's invoked from inside a `runBatch` child's `invoke`, with the `branchStack` passed in by `runBatch`.

- [ ] **Step 1: Audit `invoke`'s no-throw contract for the tool-call path**

Before touching the tool loop, grep the runPrompt + `handler.invoke` + `interruptWithHandlers` call chains for any path that throws `Interrupt[]` (versus returning it). The previous `isForked` workaround relied on some paths throwing; now `runBatch` requires `invoke` to RETURN `T | Interrupt[]`, never throw `Interrupt[]`. Specifically check:
- `interruptWithHandlers` return paths in `lib/runtime/interrupts.ts` (does any handler chain path throw rather than return?)
- `handler.invoke` in `lib/runtime/agencyFunction.ts` (does it ever rethrow an interrupt that bubbled out of the function body?)
- `runInvokeStep` in `prompt.ts` (currently inside `b.step` — does it propagate via return or via throw?)
- `PromptBailout` throws — these are intentional and must be replaced with returns (covered in Step 2 below).

Document findings in a comment at the top of `runBatch.ts` so future migration work to other call sites knows the contract.

- [ ] **Step 2: Refactor `PromptRunner.parallel` to delegate to `runBatch`**

`PromptRunner.parallel` becomes a thin wrapper: it constructs the `BranchRunner` per child (still needed for `b.step`), then calls `runBatch` with each child's `invoke` being `branchFn(item, b)`.

The previous merged-checkpoint stamping at `promptRunner.ts:158-188` is deleted — `runBatch` now owns this.

The previous `PromptBailout` throw is replaced by returning the result tagged union; `runPrompt` pattern-matches. Any other `PromptBailout` throw sites surfaced in Step 1's audit must also convert to return.

- [ ] **Step 3: Update `runPrompt`'s call site**

Where `runPrompt` today does `await pr.parallel(...)`, it now does:

```ts
const result = await pr.parallel(`round.${round}.tool`, toolCalls, async (toolCall, b) => {
  // per-tool body, unchanged — still uses b.step for .start/.invoke/.end/.log
});
if (result.kind === "interrupts") {
  // Bail out of runPrompt with these interrupts (same as before, but via
  // result not via thrown PromptBailout).
  return result.interrupts;
}
// continue: result.kind === "values"
```

- [ ] **Step 4: Run the llm-tools test suite**

```bash
pnpm run agency test tests/agency/fork/llm-tools > /tmp/llmtools-post-migrate.log 2>&1 || true
```

All currently-passing tests pass. Focus:
- `multi-tool-all-interrupt`, `multi-tool-mixed`, `tool-multi-cycle` (tool-side concurrent interrupts),
- `nested-llm-interrupt`, `subthread-after-resume`, `tool-succeeds-then-interrupts` (the trickier composition cases),
- `fork-mixed-approve-reject` (handler interactions).

- [ ] **Step 5: Run the full regression sweep**

```bash
pnpm test:run > /tmp/regression-post-task4.log 2>&1 || true
pnpm run agency test tests/agency > /tmp/agency-post-task4.log 2>&1 || true
```

Both clean. No new failures introduced.

- [ ] **Step 6: Commit**

```bash
git add lib/runtime/prompt.ts lib/runtime/promptRunner.ts
git commit -F /tmp/commit-msg.txt   # "refactor: runPrompt tool loop uses runBatch primitive"
```

---

### Task 5: Thread `branchStack` through `callHook` (Plan 1 fix)

This task is **not a new `runBatch` adopter** — it's a slice-rule fix that the parallel-callback investigation surfaced (Bug 2 in `docs/notes/parallel-callback-investigation.md`). The reason it lives in this plan: the fix requires the same `AgencyFunction.invoke({ stateStack })` opt that other adopters want, so it's cheaper to land alongside the runBatch work than as a standalone change.

**Files:**
- Modify: `lib/runtime/prompt.ts` (`onToolCallStart` / `onToolCallEnd` hook fire inside each tool branch)
- Modify: `lib/runtime/hooks.ts` (factor an `invokeCallbacks` that accepts an optional `stateStack` override)
- Modify: `lib/runtime/agencyFunction.ts` (or wherever `AgencyFunction.invoke` lives) to accept an explicit `stateStack` opt

**Out of scope for this task:** the `_activeCallbacks` WeakSet bug (Bug 1) — handled in Task 7 below.

- [ ] **Step 1: Add `stateStack` override to `AgencyFunction.invoke`**

Today `AgencyFunction.invoke({ ctx })` implicitly pushes the new frame onto `ctx.stateStack`. Add an opt `stateStack?: StateStack`; when set, the frame pushes onto that stack instead. The existing tool-invoke pattern in `prompt.ts` already passes `stateStack: branchStack` for this purpose; generalize so callbacks can use the same mechanism.

- [ ] **Step 2: Factor `invokeCallbacks` in hooks.ts**

A helper that takes `(ctx, name, data, stateStack?)` and runs every gathered callback **on the given `stateStack`**, returning the merged `Interrupt[] | undefined`. Internally it's just today's `callHook` body, but with `stateStack` threaded through `fireWithGuard → invokeCallback → AgencyFunction.invoke`. `callHook` becomes a thin wrapper that calls `invokeCallbacks(ctx, name, data)` (no stack override → uses `ctx.stateStack`, same as today).

- [ ] **Step 3: Wrap each per-tool hook fire in its own `runBatch` child invoke**

Inside `prompt.ts`'s per-tool branch (currently `b.step("round.X.tool.Y.start", async () => await callHook(...))`):

The hook fire stays inside `b.step` for idempotency. The change is that the `callHook` call becomes `invokeCallbacks(ctx, "onToolCallStart", data, branchStack)` — passing the tool's own branch stack so any callback that throws an interrupt captures a checkpoint with the right slice and `setInterruptOnBranch` is called against the correct frame.

The leaf checkpoint stamping is unchanged. The slice-rule discipline is now enforced by **passing `branchStack` to `invokeCallbacks`** — no new `runBatch` is needed at this layer because we already have one (the tool-call batch), and each callback fires sequentially within a single tool's branch.

- [ ] **Step 4: Write fixtures from Plan 1**

Reuse the Plan 1 fixture list as-is (`multi-tool-callback-interrupts-both`, `-one`, `-start`, `-mixed-start-end`, `-three`, `-reject`, `-handler-caught`, `-asymmetric-failure`). All should pass after this task.

```bash
for f in tests/agency/fork/llm-tools/multi-tool-callback-interrupts-*.agency; do
  name=$(basename "$f" .agency)
  pnpm run agency test "$f" > "/tmp/$name.log" 2>&1 || true
done
```

- [ ] **Step 5: Commit fixtures + fix together**

```bash
git add lib/runtime/ tests/agency/fork/llm-tools/multi-tool-callback-interrupts-*
git commit -F /tmp/commit-msg.txt   # "fix: thread branchStack through callHook so parallel-branch callback interrupts capture the right slice (Plan 1)"
```

---

### Task 6: New use case — sequential multi-callback hook (replaces Plan 2's Task 3)

**Files:**
- Modify: `lib/runtime/runner.ts` (`Runner.hook`)
- Modify: `lib/runtime/hooks.ts` (expose `gatherCallbacks` for `Runner.hook`'s use; add an explicit `stack` parameter so it walks the right stack for scoped callbacks)

- [ ] **Step 1: Update `gatherCallbacks` signature**

Today `gatherCallbacks(ctx, name)` reads `ctx.stateStack.collectScopedCallbacks(name)`. When `Runner.hook` runs inside a fork branch, the scoped callbacks for the surrounding handler/function frame live on the branch's stack, NOT on `ctx.stateStack`. Add an explicit `stack: StateStack` parameter:

```ts
export function gatherCallbacks<K extends keyof CallbackMap>(
  ctx: RuntimeContext<any>, name: K, stack: StateStack,
): any[] {
  const scoped = stack.collectScopedCallbacks(name);
  // ... rest unchanged
}
```

`callHook` updates its internal call to pass `ctx.stateStack`. The audit: grep every existing `gatherCallbacks` call site and verify they pass the right stack. **This is a latent bug fix on top of the refactor** — today's `callHook` from inside a fork branch likely misses scoped callbacks too, but no test currently exercises that path.

- [ ] **Step 2: Audit `Runner.stack` wiring**

`runBatch`'s `parentStack` comes from `this.stack ?? this.ctx.stateStack` in the new `Runner.hook`. Verify that every Runner instantiated inside a fork branch sets its `stack` opt (today `forkBlockSetup.mustache` does this). Anywhere a Runner is created without a `stack` opt but might fire a hook from inside a branch → assert/throw at hook time:

```ts
// In Runner.hook, before runBatch call:
if (this.parentFrameHasBranches() && !this.stack) {
  throw new Error("Runner.hook fired from a frame with branches but Runner has no `stack` opt — slice-rule violation risk. Wire `stack: branchStack` when constructing this Runner.");
}
```

This catches the "wrong slice captured" failure mode loudly at first occurrence instead of producing subtly broken checkpoints.

- [ ] **Step 3: Rewrite `Runner.hook` body**

```ts
async hook(id: number, hookName: CallbackName, data: unknown): Promise<void> {
  if (this.shouldSkip()) return;
  if (this.getCounter() > id) return;
  if (await this.maybeDebugHook(id)) return;
  this.ctx.coverageCollector?.hit(this.moduleId, this.scopeName, this.stepPath(id));

  this.path.push(id);
  try {
    const parentStack = this.stack ?? this.ctx.stateStack;
    const callbacks = gatherCallbacks(this.ctx, hookName as keyof CallbackMap, parentStack);
    if (callbacks.length === 0) return;

    // Audit assertion (see Step 2).
    if (this.parentFrameHasBranches() && !this.stack) {
      throw new Error("Runner.hook slice-rule violation — see Step 2.");
    }

    const result = await runBatch({
      ctx: this.ctx,
      parentStack,
      parentFrame: this.frame,
      checkpointLocation: {
        moduleId: this.moduleId, scopeName: this.scopeName, stepPath: this.stepPath(id),
      },
      // SEQUENTIAL — preserve today's callHook strict-ordering semantics.
      // Using "all" here would silently make callbacks concurrent, which
      // changes ordering of side effects and could race on shared state.
      mode: "sequential",
      children: callbacks.map((fn, i) => ({
        key: `hook_${this.key()}_${id}_${i}`,
        invoke: (childStack) => invokeOneCallback({ ctx: this.ctx, name: hookName, fn, data, stateStack: childStack }),
      })),
    });

    if (result.kind === "interrupts") {
      // onAgentStart/End defense-in-depth.
      if (hookName === "onAgentStart" || hookName === "onAgentEnd") {
        throw new Error(/* same message as in callHook */);
      }
      if (this.nodeContext) {
        this.halt({ ...this.state, data: result.interrupts });
      } else {
        this.halt(result.interrupts);
      }
      return;
    }
  } finally {
    this.path.pop();
  }

  if (this.halted) return;
  this.clearDebugFlag(id);
  this.setCounter(id + 1);
}
```

- [ ] **Step 4: Fixture: multi-callback-same-hook resume**

`tests/agency/callback-multi-interrupt-resume.agency` — two top-level `callback("onNodeStart")` each incrementing a pre-interrupt and post-interrupt counter and calling `interrupt(...)`. Assert each counter increments exactly once across the resume cycle, with one cycle of `respondToInterrupts`. Also assert the callbacks fire **in order** (sequential mode preserved).

(Heed the Plan 2 review's caution that `callback-multi-interrupt-handled` already exists and tests a related case — write the new fixture as a distinct resume-focused variant, not a duplicate of the firing case.)

- [ ] **Step 5: Run the callback test suite**

```bash
pnpm test:run -- callback > /tmp/cb-post-task6.log 2>&1
pnpm run agency test tests/agency/callback-multi-interrupt-resume.agency >> /tmp/cb-post-task6.log 2>&1
```

All pass.

- [ ] **Step 6: Commit**

```bash
git add lib/runtime/runner.ts lib/runtime/hooks.ts tests/agency/callback-multi-interrupt-resume.*
git commit -F /tmp/commit-msg.txt   # "feat: multi-callback hook resume via runBatch (fixes Plan 2)"
```

---

### Task 7: Fix the `_activeCallbacks` WeakSet concurrency collision (Bug 1)

**Files:**
- Modify: `lib/runtime/hooks.ts` (`fireWithGuard`)

Orthogonal to `runBatch` but a real bug surfaced by the parallel-callback investigation. The global `_activeCallbacks` WeakSet silently drops concurrent fires of the same fn from sibling branches.

- [ ] **Step 1: Move the recursion guard to per-stack**

`fireWithGuard` accepts an optional `stateStack` (already threaded through by Task 5 Step 2). Replace the module-level WeakSet with `stateStack.other._activeCallbacks` (a serializable record keyed by some stable callback id, or simpler: use the existing `_globalHooks`-style scoping but per-stack). Concurrent branches have different stacks → no collision; same-stack recursion (the actual misuse the guard catches) still detected.

If a stable id per callback fn isn't trivially derivable, fallback: skip the guard when `stateStack` is set (concurrent fires can never recurse into themselves on the *same* stack because they're in different ones; the original recursion-via-helper-function case still applies for the single-stack path).

- [ ] **Step 2: Test that the parallel-callback fixtures from Task 5 see the expected number of fires per branch**

If Task 5's fixtures already pass with the right counts post-Task-7, this is verified end-to-end.

- [ ] **Step 3: Commit**

```bash
git add lib/runtime/hooks.ts
git commit -F /tmp/commit-msg.txt   # "fix: per-stack callback recursion guard (was global WeakSet, dropped concurrent fires)"
```

---

### Task 8: Documentation

**Files:**
- Modify: `docs/dev/concurrent-interrupts.md`
- Modify: `docs/dev/callback-hooks.md`
- Modify: `docs/site/appendix/callbacks.md`
- Create: `docs/dev/runBatch.md`

- [ ] **Step 1: Write `docs/dev/runBatch.md`**

A short doc (~100 lines) explaining the primitive: signature, semantics, invariants, when to use it vs. when not. Reference it from `concurrent-interrupts.md` and the per-use-case adapter docs.

The doc must include:
- The three modes (`all`, `sequential`, `race`) with explicit guidance: "Use `sequential` for hook callbacks; using `all` would silently turn today's strictly-ordered `callHook` into a concurrent race."
- The slice-rule discipline at the caller boundary: "`runBatch` is the only place in the runtime that takes a `parentStack` arg. Pass the local branch stack, NOT `ctx.stateStack`. This is the only invariant the caller is responsible for — `runBatch` enforces everything else."
- A **"Subprocess and runBatch"** section that says: subprocess interrupts have the same *logical* shape as a single-child batch, but the `invoke` crosses an IPC boundary (JSON serialization, separate process lifetime, separate checkpoint store). Modeling subprocess as `runBatch({ children: [{ key: "sub", invoke: ipcCall }] })` is correct in shape but the IPC layer (Plan 3) still needs to (a) reconstruct serialized checkpoints, (b) translate the subprocess's internal `Interrupt[]` JSON into runtime `Interrupt` objects with `.checkpoint` reconstructed via `Checkpoint.fromJSON`, (c) handle subprocess lifecycle (kill on propagation, preserve compiledPath for resume). The batch primitive does not erase this work; it provides the surrounding shape.
- The `invoke` no-throw contract (must return `T | Interrupt[]`, never throw `Interrupt[]`).
- The duplicate-key check and mode-flip assert as defensive guards, not invariants the caller must avoid violating.

- [ ] **Step 2: Rewrite `docs/dev/concurrent-interrupts.md`**

The fork/race/runPrompt sections become "X uses `runBatch` with these adapter hooks." The slice-only-capture invariant section now reads "the only place that takes a `parentStack` is `runBatch`; the discipline collapses to 'pass the local stack into runBatch.'"

- [ ] **Step 3: Update `docs/dev/callback-hooks.md`**

The multi-callback resume section is rewritten to describe the `runBatch`-based `Runner.hook`. The parallel-branch section is rewritten to describe `branchStack`-threading into `invokeCallbacks`.

- [ ] **Step 4: Update `docs/site/appendix/callbacks.md`**

Per-hook table: `onNodeStart`, `onNodeEnd`, `onFunctionStart`, `onEmit` change from `⚠️ Batched, but resume is partial` to `✅ Batched`. `onToolCallStart`/`onToolCallEnd` stay `✅ Batched` (now actually true). Note `onFunctionEnd` still excluded (still a raw `callHook` in `finally`; not addressed by this plan).

- [ ] **Step 5: Add a checkpoint-format migration note**

In both `docs/dev/runBatch.md` and `docs/dev/callback-hooks.md`, add a short "Migration note" section: **callback-hook checkpoints generated before this plan are not forward-compatible.** Today a single-callback hook interrupt produces a leaf checkpoint whose stack ends with the callback's frame, no `branches` map involved. After Task 6, the same hook interrupt goes into `parentFrame.branches[hook_<key>_<i>]`. Old persisted checkpoints will not resume on the new code, and vice versa. Per the project's "very few users, breaking changes OK" stance (per user direction during plan design), no version stamp or migration shim is added — users with persisted state from before this plan must rerun from the start. Make this loud and explicit so anyone deploying notices.

The same applies to any in-flight `__race_winner_*` checkpoints stamped under `runRace` before Task 3 — but since Task 3 keeps the existing key shape, those resume correctly.

- [ ] **Step 6: Commit**

```bash
git add docs/
git commit -F /tmp/commit-msg.txt   # "docs: runBatch primitive + concurrent-interrupt architecture revision"
```

---

### Task 9: Mark Plans 1 and 2 as superseded

**Files:**
- Modify: `docs/superpowers/plans/2026-05-22-callback-interrupts-parallel-tool-branches.md`
- Modify: `docs/superpowers/plans/2026-05-22-callback-interrupts-fork-style-resume.md`

- [ ] **Step 1: Add a header to each**

```markdown
> **Status: superseded by [2026-05-22-runbatch-concurrent-interrupt-primitive.md](2026-05-22-runbatch-concurrent-interrupt-primitive.md).**
> The runBatch refactor solves both plans' use cases as Tasks 5 and 6 respectively. Do not implement these plans directly.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/plans/
git commit -F /tmp/commit-msg.txt   # "docs: supersede callback-interrupts plans with runBatch plan"
```

---

### Validation checklist

- [ ] `pnpm test:run` passes (full unit suite).
- [ ] `pnpm run agency test tests/agency/fork` passes.
- [ ] `pnpm run agency test tests/agency/fork/llm-tools` passes.
- [ ] `pnpm run agency test tests/agency/fork/race` passes.
- [ ] `pnpm test:run -- callback` passes.
- [ ] All 8 Plan 1 fixtures pass (Task 5).
- [ ] Multi-callback resume fixture passes (Task 6).
- [ ] `pnpm run lint:structure` clean.
- [ ] `make` succeeds (no stdlib change in this plan).
- [ ] `make fixtures` no-op (no codegen change).
- [ ] Docs updated.
- [ ] Subprocess (Plan 3 / `docs/superpowers/plans/2026-05-10-subprocess-propagation-and-resume.md`): `docs/dev/runBatch.md` contains the "Subprocess and runBatch" section (per Task 8 Step 1) describing the *shape* match and the IPC work that remains. **Not implemented here.** Honest framing: `runBatch` provides the surrounding shape, not a replacement for the IPC layer.

---

### Risks and contingencies

- **Migration order risk.** Task 2 (fork) must land before Task 4 (runPrompt) because the fork tests cover the most ground. If Task 2 reveals a `runBatch` bug, fix it before proceeding.
- **`BranchRunner.step` semantics inside `runBatch`-children.** The per-tool `.start`/`.invoke`/`.end`/`.log` substep machinery still lives in `BranchRunner.step` after Task 4 — verify on resume that `completedSteps` is read correctly from the restored branch state (this is the existing mechanism, not new code, but the wrapping changes).
- **`stateStack` opt on `AgencyFunction.invoke`.** Task 5 Step 1 adds this opt. Verify no other call site relies on the implicit `ctx.stateStack` push behavior in a way that breaks when an explicit stack is passed. The existing tool-invoke path already does this, so the surface area is small.
- **`_activeCallbacks` per-stack scoping.** If a stable callback-id derivation isn't obvious, Task 7's fallback is acceptable for now — the original misuse case (recursion-via-helper-function within a single call chain) still applies on a single stack.
- **`onFunctionEnd` not addressed.** Still fires from a `finally` block, still drops interrupts. Tracked separately; this plan does not touch it.
- **Cost/token propagation contract.** `seedBranchCost` / `propagateBranchCost` are passed in as hooks. Verify that Task 2's migration preserves the exact ordering (seed before invoke, propagate before `popBranches`) by comparing the new code to the existing `runForkAll` line-by-line.
- **Race winner persistence on resume.** Verify Task 3's resume path: after the winner is recorded in `parentFrame.locals[__race_winner_${stepPath}]`, on resume the next `runBatch` call must detect this and dispatch only the winner. Today this is in `Runner.fork`; moving it into `runBatch` must preserve the dispatch.
