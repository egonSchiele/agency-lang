/**
 * `runBatch` — the single concurrent-interrupt primitive.
 *
 * Owns the boilerplate that every concurrent-interrupt site in the runtime
 * (`runForkAll`, `runRace`, `runPrompt`'s tool loop, the multi-callback hook
 * fire) used to hand-roll: per-child branch creation, abort-signal
 * composition, settle/collect, batch checkpoint stamping with shared
 * `intr.checkpoint`/`intr.checkpointId` overwrite, cost seed/propagate
 * hooks, cleanup on success.
 *
 * What `runBatch` does NOT change:
 *  - The leaf `interruptReturn` template still stamps a per-leaf checkpoint
 *    exactly as today (commit c72b9c1574 deliberately removed the older
 *    `isForked`-bypass approach because it broke nested-fork composition).
 *    `runBatch` reads the leaf's checkpoint off each surfaced `Interrupt`
 *    and writes it onto the BranchState via `setInterruptOnBranch` — the
 *    leaf's checkpoint is the vehicle that carries its pre-pop stack into
 *    `State.toJSON`'s branches walk.
 *  - Handler bookkeeping. Per-branch handler chains stay as today.
 *
 * The `intr.checkpoint` overwrite at the bottom is intentional: per commit
 * c72b9c1574, every interrupt batched together must share a single resume
 * point so resuming one resumes the whole batch.
 *
 * Invoke no-throw contract (audit when migrating call sites): every
 * `BatchChild.invoke` MUST RETURN `T | Interrupt[]` and never THROW an
 * `Interrupt[]`. Other JS errors may be thrown — in that case `runBatch`
 * rethrows the first one it sees and abandons any interrupts that sibling
 * branches successfully halted with (this matches today's
 * `runForkAll` / `runRace` behavior; callers that need both must catch
 * inside `invoke`). PromptBailout-style throws need to be converted to
 * returns at their call site before that site migrates to `runBatch`.
 *
 * Audit findings (2026-05-22, recorded at Task 4 step 1):
 *  - `lib/runtime/interrupts.ts` (`interruptWithHandlers`,
 *    `respondToInterrupts`, `runHandlerChain`): NO `Interrupt[]` throws.
 *    Errors thrown are `Error`s on contract violations or other
 *    bookkeeping bugs, never the interrupt array itself.
 *  - `lib/runtime/agencyFunction.ts` (`AgencyFunction.invoke`): NO
 *    `Interrupt[]` throws. Returns interrupts as values.
 *  - `lib/runtime/prompt.ts` (`runInvokeStep` and the tool loop body):
 *    NO `Interrupt[]` throws. Returns via `b.step`'s collector pattern.
 *  - `lib/runtime/promptRunner.ts`: `PromptBailout` IS thrown (twice).
 *    These are deliberate Error subclasses (not raw `Interrupt[]`) and
 *    are converted to returns in Task 4 before migration.
 *
 * Other adopters considering migration should re-run this audit on their
 * code path (`grep -nE "throw .*[Ii]nterrupt"`).
 *
 * Branch-result recording (see `recordBranchOutcomes`):
 *  - Default `true`: runBatch records the per-branch outcome via
 *    `setResultOnBranch` (success) or `setInterruptOnBranch` (interrupt).
 *    This is what fork/race need.
 *  - `false`: the caller's `invoke` is responsible for recording branch
 *    state itself (via `stack.setResultOnBranch` etc. inside the body).
 *    runBatch still stamps the shared checkpoint and overwrites
 *    `intr.checkpoint`/`checkpointId`, but does NOT touch BranchState
 *    fields. This is what runPrompt's tool loop needs because the tool
 *    body already records the real tool result on the branch before
 *    returning — letting runBatch then call `setResultOnBranch(key,
 *    undefined)` would overwrite the meaningful value with undefined.
 */
import { hasInterrupts, type Interrupt } from "./interrupts.js";
import type { RuntimeContext } from "./state/context.js";
import type { BranchState, State, StateStack } from "./state/stateStack.js";

export type BatchChild<T> = {
  /** Stable per-child key. Used for `getOrCreateBranch`. Caller is
   * responsible for uniqueness within `parentFrame.branches`. */
  key: string;
  /** Invoked with the child's own `StateStack` (already seeded with abort
   * signal composed with parent) and that stack's abort signal. Must
   * return either a value `T` (success) or an `Interrupt[]` (halted with
   * interrupts). MUST NOT throw `Interrupt[]`. May throw other errors. */
  invoke: (
    childStack: StateStack,
    abortSignal: AbortSignal,
  ) => Promise<T | Interrupt[]>;
};

export type BatchHooks = {
  seedBranchCost?: (childStack: StateStack, parentStack: StateStack) => void;
  /** Used by mode "all" / "sequential" only. The race adapter uses the
   * asymmetric pair below instead. */
  propagateBranchCost?: (
    branches: BranchState[],
    parentStack: StateStack,
  ) => void;
  /** Race mode only: propagate loser-branch cost at race-time (before the
   * losers are deleted). The winner's cost propagates separately on resume
   * via `propagateWinnerCost`. */
  propagateLoserCost?: (
    loserBranches: BranchState[],
    parentStack: StateStack,
  ) => void;
  /** Race mode only: propagate the winner's cost when the winner finally
   * completes (no-interrupt resume). */
  propagateWinnerCost?: (
    winnerBranch: BranchState,
    parentStack: StateStack,
  ) => void;
  /** Called once per branch start (statelog). */
  onBranchStart?: (key: string, index: number) => void;
  /** Called once per branch end with its outcome and elapsed time in ms. */
  onBranchEnd?: (
    key: string,
    index: number,
    outcome: "success" | "interrupted" | "failure" | "aborted",
    timeMs: number,
  ) => void;
  /** Called once immediately before `ctx.checkpoints.create` deep-clones
   * the parent frame. Use this to flush state that was mutated by
   * sibling branches during the batch into frame-backed locals that need
   * to survive the checkpoint. Concretely: runPrompt's tool loop pushes
   * `tool` messages onto the shared `MessageThread` from inside each
   * branch's body, but `self.messagesJSON` (the snapshot the checkpoint
   * captures) isn't refreshed by those pushes — the adapter uses this
   * hook to do `self.messagesJSON = snapshotMessages()` so the
   * deep-clone sees the up-to-date thread. Without this hook the
   * checkpoint would carry the pre-batch messages and successful
   * sibling tool responses would be silently lost on resume. */
  beforeCheckpoint?: () => void;
  /** Called once when the batch stamps its shared checkpoint. */
  onCheckpoint?: (checkpointId: number) => void;
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
  /** Mode "race" only: the `parentFrame.locals` key under which the winner
   * index is persisted. The caller (race adapter) computes
   * `__race_winner_${id}` and passes it. */
  raceWinnerLocalKey?: string;
  /** When `true` (default), runBatch records the per-branch outcome on
   * `parentFrame.branches` via `setResultOnBranch` (success) or
   * `setInterruptOnBranch` (interrupt). When `false`, the caller's
   * `invoke` is responsible for managing branch state itself — runBatch
   * still stamps the shared checkpoint and overwrites
   * `intr.checkpoint`/`checkpointId`, but does NOT touch BranchState
   * fields. Used by runPrompt's tool loop where the body manages the
   * real tool result on the branch. */
  recordBranchOutcomes?: boolean;
  hooks?: BatchHooks;
};

export type RunBatchResult<T> =
  | { kind: "values"; values: T[] }
  | { kind: "interrupts"; interrupts: Interrupt[] };

type Task<T> = {
  child: BatchChild<T>;
  branch: BranchState;
  startedAt: number;
  cached: boolean;
};

/** (Re)compose the branch's abort signal from the parent stack's signal
 * and the branch's own controller. Always overwrites `stack.abortSignal`
 * so that re-entries (e.g. race resume that reuses a deserialized
 * branch) don't carry a stale signal. The controller is created on
 * first use and persists for the life of the branch in this run; the
 * field is live-only on BranchState and not serialized, so resumes
 * start from a fresh controller. */
function composeBranchAbortSignal(
  branch: BranchState,
  parentStack: StateStack,
): AbortSignal {
  if (!branch.abortController) {
    branch.abortController = new AbortController();
  }
  const parentSig = parentStack.abortSignal;
  const composed = parentSig
    ? AbortSignal.any([parentSig, branch.abortController.signal])
    : branch.abortController.signal;
  branch.stack.abortSignal = composed;
  return composed;
}

/** Wire up a branch's AbortController + composed signal, seed cost, and
 * fire `onBranchStart`. Returns the child's `invoke` promise (or a
 * resolved promise for cached branches). Centralized so all three modes
 * use identical setup. */
function startInvoke<T>(
  opts: RunBatchOpts<T>,
  t: Task<T>,
  i: number,
  parentSpanStack: ReturnType<RuntimeContext<any>["statelogClient"]["snapshotStack"]>,
): Promise<T | Interrupt[]> {
  const { ctx, parentStack, hooks } = opts;
  if (t.cached) {
    return Promise.resolve(t.branch.result!.result);
  }
  const signal = composeBranchAbortSignal(t.branch, parentStack);
  hooks?.seedBranchCost?.(t.branch.stack, parentStack);
  hooks?.onBranchStart?.(t.child.key, i);
  t.startedAt = performance.now();
  return ctx.statelogClient.runInBranchContext(parentSpanStack, () =>
    t.child.invoke(t.branch.stack, signal),
  );
}

/** Stamp the shared batch-level checkpoint and overwrite every interrupt's
 * checkpoint+id so they all resume from the same point. */
function stampSharedCheckpoint<T>(
  opts: RunBatchOpts<T>,
  interrupts: Interrupt[],
): void {
  const { ctx, parentStack, checkpointLocation, hooks } = opts;
  // Give the caller a last chance to mutate frame state that needs to
  // be visible in the deep-cloned checkpoint (see beforeCheckpoint
  // hook docstring). runPrompt's parallel-tool adapter uses this to
  // snapshot the per-tool `messages.push(...)`es that happened during
  // the batch into `self.messagesJSON` before the deep-clone fires.
  hooks?.beforeCheckpoint?.();
  const cpId = ctx.checkpoints.create(parentStack, ctx, checkpointLocation);
  const cp = ctx.checkpoints.get(cpId)!;
  for (const intr of interrupts) {
    intr.checkpoint = cp;
    intr.checkpointId = cpId;
  }
  hooks?.onCheckpoint?.(cpId);
}

export async function runBatch<T>(
  opts: RunBatchOpts<T>,
): Promise<RunBatchResult<T>> {
  const { ctx, parentStack, parentFrame, mode, children, hooks } = opts;

  // 0a. Cheap insurance against caller bugs.
  const seen = new Set<string>();
  for (const c of children) {
    if (seen.has(c.key)) {
      throw new Error(
        `runBatch: duplicate child key ${JSON.stringify(c.key)}`,
      );
    }
    seen.add(c.key);
  }

  // 0b. Mode-flip defensive assert. If a previous run recorded a race
  // winner under `raceWinnerLocalKey` but the caller now passes a
  // non-race mode (or vice versa), that's a serious checkpoint/code
  // mismatch — fail loudly rather than produce subtly broken state.
  const raceKey = opts.raceWinnerLocalKey;
  const persistedWinner =
    raceKey !== undefined ? parentFrame.locals[raceKey] : undefined;
  if (persistedWinner !== undefined && typeof persistedWinner === "number") {
    if (mode !== "race") {
      throw new Error(
        `runBatch: checkpoint/mode mismatch — parentFrame.locals[${JSON.stringify(
          raceKey,
        )}] holds a race winner (${persistedWinner}) but mode is ${JSON.stringify(
          mode,
        )}.`,
      );
    }
  }

  // 0c. Race resume short-circuit: if a winner is persisted, run only the
  // winner's child. Subsumes the old `resumeRaceWinner` so the caller
  // (`Runner.fork`) can unconditionally invoke `runBatch`.
  if (
    mode === "race" &&
    raceKey !== undefined &&
    typeof persistedWinner === "number"
  ) {
    return runRaceResume(opts, persistedWinner);
  }

  // 1. Set up tasks (branches). When `recordBranchOutcomes` is false the
  //    caller is responsible for setting branch.result, AND for idempotent
  //    re-execution of the body on resume — branch.result being set does
  //    NOT mean "the body is fully done" (it may only mean "the tool's
  //    invoke step succeeded; the .end + .log steps may still need to
  //    fire"). So skip the cached-branch short-circuit in that mode.
  const recordOutcomes = opts.recordBranchOutcomes !== false;
  const tasks: Task<T>[] = children.map((child) => {
    const branch = parentFrame.getOrCreateBranch(child.key);
    return {
      child,
      branch,
      startedAt: 0,
      cached: recordOutcomes && branch.result !== undefined,
    };
  });
  const parentSpanStack = ctx.statelogClient.snapshotStack();

  if (mode === "race") {
    return runRaceFirstTime(opts, tasks, parentSpanStack);
  }

  // 2. mode "all" or "sequential": settle every child.
  let settled: PromiseSettledResult<T | Interrupt[]>[];
  if (mode === "sequential") {
    settled = [];
    for (let i = 0; i < tasks.length; i++) {
      try {
        settled.push({
          status: "fulfilled",
          value: await startInvoke(opts, tasks[i], i, parentSpanStack),
        });
      } catch (reason) {
        settled.push({ status: "rejected", reason });
      }
    }
  } else {
    // mode "all" — parallel.
    settled = await Promise.allSettled(
      tasks.map((t, i) => startInvoke(opts, t, i, parentSpanStack)),
    );
  }

  // 3. Collect outcomes. Gate hooks on non-cached so cached branches don't
  // emit duplicate statelog events on resume cycles.
  const interrupts: Interrupt[] = [];
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    const t = tasks[i];
    const { child, cached } = t;
    const timeMs = cached ? 0 : performance.now() - t.startedAt;
    if (s.status === "rejected") {
      if (!cached) hooks?.onBranchEnd?.(child.key, i, "failure", timeMs);
      // Rethrow: any sibling interrupts collected are discarded (matches
      // today's runForkAll/runRace behavior; documented at top of file).
      throw s.reason;
    }
    const value = s.value;
    if (hasInterrupts(value)) {
      if (!cached) hooks?.onBranchEnd?.(child.key, i, "interrupted", timeMs);
      interrupts.push(...value);
      if (recordOutcomes) {
        parentFrame.setInterruptOnBranch(
          child.key,
          value[0].interruptId,
          value[0].interruptData,
          // The leaf's per-branch checkpoint goes here — it vehicles the
          // pre-pop branch stack into State.toJSON's branches walk.
          value[0].checkpoint,
        );
      }
    } else {
      if (!cached) hooks?.onBranchEnd?.(child.key, i, "success", timeMs);
      if (recordOutcomes) {
        parentFrame.setResultOnBranch(child.key, value as any);
      }
    }
  }

  // 4. Stamp shared parent checkpoint + overwrite.
  if (interrupts.length > 0) {
    stampSharedCheckpoint(opts, interrupts);
    return { kind: "interrupts", interrupts };
  }

  // 5. No interrupts — propagate cost, clear branches, return values.
  const allBranches = tasks.map((t) => t.branch);
  hooks?.propagateBranchCost?.(allBranches, parentStack);
  parentFrame.popBranches();
  return {
    kind: "values",
    values: settled.map((s) => (s as PromiseFulfilledResult<T>).value),
  };
}

/** Mode "race" first-time path: launch every child, await the first
 * settle, abort the rest, delete loser branches, propagate loser cost,
 * stamp + overwrite if the winner halted. */
async function runRaceFirstTime<T>(
  opts: RunBatchOpts<T>,
  tasks: Task<T>[],
  parentSpanStack: ReturnType<
    RuntimeContext<any>["statelogClient"]["snapshotStack"]
  >,
): Promise<RunBatchResult<T>> {
  const { parentFrame, hooks } = opts;
  const raceKey = opts.raceWinnerLocalKey;

  // Tag promises with their index so we can identify the winner / first
  // failure regardless of resolution order.
  const tagged = tasks.map((t, i) =>
    startInvoke(opts, t, i, parentSpanStack).then(
      (value) => ({ index: i, value }),
      (err) => Promise.reject({ index: i, err }),
    ),
  );

  let winnerIndex: number;
  let winnerValue: T | Interrupt[];
  try {
    const winner = await Promise.race(tagged);
    winnerIndex = winner.index;
    winnerValue = winner.value;
  } catch (tagged) {
    const { index: failedIndex, err } = tagged as { index: number; err: any };
    const failedTask = tasks[failedIndex];
    const failedTime = failedTask.cached
      ? 0
      : performance.now() - failedTask.startedAt;
    if (!failedTask.cached) {
      hooks?.onBranchEnd?.(failedTask.child.key, failedIndex, "failure", failedTime);
    }
    // Abort still-running siblings so they don't keep doing work whose
    // results we'll throw away.
    for (let i = 0; i < tasks.length; i++) {
      if (i === failedIndex) continue;
      tasks[i].branch.abortController?.abort();
    }
    throw err;
  }

  // Compute winner timing + abort losers + emit end events.
  const winnerTask = tasks[winnerIndex];
  const winnerTime = winnerTask.cached
    ? 0
    : performance.now() - winnerTask.startedAt;
  for (let i = 0; i < tasks.length; i++) {
    if (i === winnerIndex) continue;
    const t = tasks[i];
    t.branch.abortController?.abort();
    if (!t.cached) {
      hooks?.onBranchEnd?.(
        t.child.key,
        i,
        "aborted",
        performance.now() - t.startedAt,
      );
    }
  }
  if (!winnerTask.cached) {
    hooks?.onBranchEnd?.(
      winnerTask.child.key,
      winnerIndex,
      hasInterrupts(winnerValue) ? "interrupted" : "success",
      winnerTime,
    );
  }

  // Persist the winner index so resume re-runs only this branch.
  if (raceKey !== undefined) {
    parentFrame.locals[raceKey] = winnerIndex;
  }

  const winnerKey = winnerTask.child.key;

  if (hasInterrupts(winnerValue)) {
    // Record interrupt info on the winner branch.
    parentFrame.setInterruptOnBranch(
      winnerKey,
      winnerValue[0].interruptId,
      winnerValue[0].interruptData,
      winnerValue[0].checkpoint,
    );
    // Eagerly propagate LOSER cost — their LLM calls really happened.
    // Winner's cost is deferred to resume (see `runRaceResume`).
    const losers: BranchState[] = [];
    for (let i = 0; i < tasks.length; i++) {
      if (i === winnerIndex) continue;
      losers.push(tasks[i].branch);
    }
    hooks?.propagateLoserCost?.(losers, opts.parentStack);
    // Drop loser branches before stamping — losers must not survive into
    // the serialized checkpoint.
    for (let i = 0; i < tasks.length; i++) {
      if (i === winnerIndex) continue;
      parentFrame.deleteBranch(tasks[i].child.key);
    }
    stampSharedCheckpoint(opts, winnerValue);
    return { kind: "interrupts", interrupts: winnerValue };
  }

  // Winner produced a value. Cache it, propagate cost from all branches
  // (winner + losers — their work counted), then drop losers.
  parentFrame.setResultOnBranch(winnerKey, winnerValue as any);
  // For race-success-first-time we ALSO bill losers right here (their LLM
  // calls already happened). The caller's `propagateLoserCost` hook covers
  // them; the winner's cost is propagated separately via
  // `propagateWinnerCost`. Today's `runRace` happens to call a single
  // `propagateBranchCost([winner, ...losers])` for this case; we keep the
  // asymmetric pair to preserve the resume-time semantics.
  const losers: BranchState[] = [];
  for (let i = 0; i < tasks.length; i++) {
    if (i === winnerIndex) continue;
    losers.push(tasks[i].branch);
  }
  hooks?.propagateLoserCost?.(losers, opts.parentStack);
  hooks?.propagateWinnerCost?.(winnerTask.branch, opts.parentStack);
  for (let i = 0; i < tasks.length; i++) {
    if (i === winnerIndex) continue;
    parentFrame.deleteBranch(tasks[i].child.key);
  }
  return { kind: "values", values: [winnerValue as T] };
}

/** Mode "race" resume path: only re-run the recorded winner. */
async function runRaceResume<T>(
  opts: RunBatchOpts<T>,
  winnerIndex: number,
): Promise<RunBatchResult<T>> {
  const { ctx, parentStack, parentFrame, children, hooks } = opts;
  const child = children[winnerIndex];
  if (!child) {
    throw new Error(
      `runBatch race resume: persisted winner index ${winnerIndex} is out of range (children.length=${children.length}).`,
    );
  }
  const branch = parentFrame.getBranch(child.key);
  if (!branch) {
    throw new Error(
      `runBatch race resume: winner branch ${JSON.stringify(
        child.key,
      )} (index ${winnerIndex}) is missing — state may be corrupted.`,
    );
  }

  // Cached winner — return cached result. Cost was already propagated
  // when the winner first completed; don't double-bill on this defensive
  // path. (Matches today's resumeRaceWinner cached-branch behavior.)
  if (branch.result !== undefined) {
    return { kind: "values", values: [branch.result.result as T] };
  }

  // Compose the resumed winner's abort signal with the current parent
  // stack's signal so an outer abort (e.g. a surrounding race that
  // cancels this branch) propagates into the resumed work. Uses the
  // same helper as `startInvoke` so the composition rule lives in one
  // place.
  const signal = composeBranchAbortSignal(branch, parentStack);

  const parentSpanStack = ctx.statelogClient.snapshotStack();
  const startedAt = performance.now();
  hooks?.onBranchStart?.(child.key, winnerIndex);
  let value: T | Interrupt[];
  try {
    value = await ctx.statelogClient.runInBranchContext(parentSpanStack, () =>
      child.invoke(branch.stack, signal),
    );
  } catch (err) {
    hooks?.onBranchEnd?.(
      child.key,
      winnerIndex,
      "failure",
      performance.now() - startedAt,
    );
    throw err;
  }

  if (hasInterrupts(value)) {
    hooks?.onBranchEnd?.(
      child.key,
      winnerIndex,
      "interrupted",
      performance.now() - startedAt,
    );
    parentFrame.setInterruptOnBranch(
      child.key,
      value[0].interruptId,
      value[0].interruptData,
      value[0].checkpoint,
    );
    stampSharedCheckpoint(opts, value);
    return { kind: "interrupts", interrupts: value };
  }

  hooks?.onBranchEnd?.(
    child.key,
    winnerIndex,
    "success",
    performance.now() - startedAt,
  );
  parentFrame.setResultOnBranch(child.key, value as any);
  hooks?.propagateWinnerCost?.(branch, parentStack);
  return { kind: "values", values: [value as T] };
}
