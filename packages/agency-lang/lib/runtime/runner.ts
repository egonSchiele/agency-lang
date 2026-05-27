import { nanoid } from "nanoid";
import { agencyStore } from "./asyncContext.js";
import { debugStep } from "./debugger.js";
import { hasInterrupts } from "./interrupts.js";
import { __pipeBind } from "./result.js";
import { runBatch } from "./runBatch.js";
import type { SourceLocationOpts } from "./state/checkpointStore.js";
import type { RuntimeContext } from "./state/context.js";
import type { BranchState, State } from "./state/stateStack.js";
import { StateStack } from "./state/stateStack.js";
import type { ThreadStore } from "./state/threadStore.js";
import type { HandlerFn } from "./types.js";

/**
 * Runner centralizes step execution logic for generated Agency code.
 *
 * Each node/function gets its own Runner wrapping its State frame.
 * The builder assigns explicit step IDs that match the source map paths.
 * The Runner maintains a `path` array that tracks nesting depth —
 * push when entering a nested scope, pop when leaving.
 *
 * Halt propagation: when an interrupt or debug pause occurs, call runner.halt(result).
 * All subsequent step calls become no-ops.
 */
export class Runner {
  halted = false;
  haltResult: any = null;

  private ctx: RuntimeContext<any>;
  private frame: State;
  private path: number[] = [];
  private nodeContext: boolean;
  private state: any;
  private moduleId: string;
  private scopeName: string;
  /** The StateStack this Runner is operating on. When the Runner is running
   * inside a fork/race branch, this is the branch's stack — and reading
   * `stack.abortSignal` lets us notice if the branch has been cancelled
   * (e.g., a race loser whose winner already resolved). */
  private stack?: StateStack;
  /** ThreadStore active for this Runner's scope. Captured into the
   *  per-step AsyncLocalStorage frame so stdlib helpers that read
   *  `getRuntimeContext().threads` (e.g. the std::thread `*Message`
   *  builtins migrated off the context-injected pattern) see the same
   *  ThreadStore the codegen would otherwise have prepended as a
   *  positional arg. Optional so existing call sites (and the runner
   *  unit tests) keep working without passing it. */
  private threads?: ThreadStore;

  constructor(
    ctx: RuntimeContext<any>,
    frame: State,
    opts?: {
      nodeContext?: boolean;
      state?: any;
      moduleId?: string;
      scopeName?: string;
      stack?: StateStack;
      threads?: ThreadStore;
    },
  ) {
    this.ctx = ctx;
    this.frame = frame;
    this.nodeContext = opts?.nodeContext ?? false;
    this.state = opts?.state ?? {};
    this.moduleId = opts?.moduleId ?? "";
    this.scopeName = opts?.scopeName ?? "";
    // Post-ALS migration the codegen no longer emits `stack` / `threads`
    // as part of the Runner opts — both values live in the active
    // `agencyStore` frame and are recovered here. Direct test usages of
    // `new Runner(ctx, frame)` outside an ALS frame fall back to
    // `undefined`, which matches the pre-migration behaviour (no
    // guard/abort-signal observation, no per-step ALS re-wrap).
    const als = agencyStore.getStore();
    this.stack = opts?.stack ?? als?.stack;
    this.threads = opts?.threads ?? als?.threads;
  }

  /** Run `fn` inside an `agencyStore.run` frame seeded with this
   *  Runner's `ctx` / `stack` / `threads`. Stdlib helpers invoked from
   *  inside `fn` will see those values via `getRuntimeContext()` —
   *  matching what the deprecated `__ctx, __stateStack, __threads`
   *  positional args would have carried. If `stack` or `threads` is
   *  missing (older test harnesses that build a Runner without them),
   *  fall through to whatever frame is already on the ALS stack to
   *  avoid clobbering an outer frame with `undefined`. */
  private runInScope<T>(fn: () => Promise<T>): Promise<T> {
    if (this.stack && this.threads) {
      return agencyStore.run(
        { ctx: this.ctx, stack: this.stack, threads: this.threads },
        fn,
      );
    }
    return fn();
  }

  // ── Path and counter management ──

  /** The current step path as a string, e.g. "1.0.2" */
  key(): string {
    return this.path.join(".");
  }

  /** Return checkpoint metadata for the current step. */
  getCheckpointInfo(): SourceLocationOpts {
    return {
      moduleId: this.moduleId,
      scopeName: this.scopeName,
      stepPath: this.path.join("."),
    };
  }

  private getCounter(): number {
    if (this.path.length === 0) return this.frame.step;
    return this.frame.locals[`__substep_${this.key()}`] ?? 0;
  }

  private setCounter(val: number): void {
    if (this.path.length === 0) this.frame.step = val;
    else this.frame.locals[`__substep_${this.key()}`] = val;
  }

  // ── Halt ──

  halt(result: any): void {
    // Charge in-flight elapsed time to any TimeGuards on the stack
    // BEFORE flipping the halted flag, so the elapsed delta captures
    // every ms up to the halt boundary. Idempotent: subsequent halts
    // from outer Runners propagating the same interrupt see "paused"
    // and no-op. CostGuards' pause() is a no-op.
    this.stack?.guards.forEach((g) => g.pause());
    this.halted = true;
    this.haltResult = result;
  }

  /** Resume any paused guards on the active stack. Idempotent — a
   *  guard already in "running" state no-ops. Called at the top of
   *  every step-equivalent entry point (step, hook, pipe, thread,
   *  fork, debugger). After a halt, the first step entry re-arms
   *  TimeGuards' timers; subsequent entries within the same active
   *  window are no-ops. Also rebuilds non-serialized runtime state
   *  (AbortController, abortSignal composition) after deserialization. */
  private beforeStep(): void {
    this.stack?.guards.forEach((g) => g.resume(this.stack!));
  }

  // ── Loop control ──

  private _break = false;
  private _continue = false;

  /** Signal the current loop to break after this iteration */
  breakLoop(): void {
    this._break = true;
  }

  /** Signal the current loop to continue to the next iteration */
  continueLoop(): void {
    this._continue = true;
  }

  /** Check if execution should skip (halted, breaking, or continuing).
   *  Also halts if the runner's branch stack has been aborted — but
   *  if any guard's `check()` reports a trip, throw the structured
   *  GuardExceededError instead of silently halting. That lets the
   *  stdlib `guard` function's `try block()` convert it to a Failure
   *  with maxTime/actualTime (or maxCost/actualCost). Race-loser
   *  branch cancels (no guard tripped) still halt silently.
   *
   *  Three-way decision when `abortSignal.aborted`:
   *   1. Some guard.check() returns an error → throw it (first trip
   *      reaches user code via stdlib `guard`'s `try`).
   *   2. No guard returns an error but some guard.isTripped() → the
   *      abort came from a guard whose trip is already consumed
   *      (caught by `try`). The popGuard cleanup steps still need to
   *      run, so don't halt; fall through.
   *   3. No guard returns an error and none isTripped() → external
   *      abort (race-loser branch cancel). Halt silently as before. */
  private shouldSkip(): boolean {
    if (this.stack?.abortSignal?.aborted && !this.halted) {
      // Walk innermost-first so the deepest guard reports its trip
      // first. Mirrors the order in prompt.ts's cost-check loop.
      for (let i = this.stack.guards.length - 1; i >= 0; i--) {
        const err = this.stack.guards[i].check(this.stack);
        if (err) throw err;
      }
      const guardOwnsAbort = this.stack.guards.some((g) => g.isTripped());
      if (!guardOwnsAbort) {
        this.halt(undefined);
      }
    }
    return this.halted || this._break || this._continue;
  }

  // ── Debug hook ──

  /**
   * Fires the debug/trace hook for a step. Returns truthy if the debugger
   * wants to pause (in which case the caller should halt).
   *
   * Uses a flag in frame.locals to avoid re-triggering on resume:
   * - First entry: no flag → fire hook → if it halts, set flag
   * - Resume: flag exists → skip hook → run code → clean up flag
   *
   * The flag is NOT deleted here on resume. Instead, step() deletes it
   * after the callback completes without halting. This handles the case
   * where a step halts due to a nested interrupt (e.g., function call
   * that pauses) — the flag stays set so the next resume skips the hook.
   */
  private async maybeDebugHook(
    id: number,
    label: string | null = null,
    isUserAdded: boolean = false,
  ): Promise<boolean> {
    if (!this.ctx.hasDebugger() && !this.ctx.hasTraceWriter()) return false;
    if (this.ctx.isInsideToolCall()) return false;

    // On resume after a debug pause, skip the hook.
    // Don't delete the flag yet — step() will clean it up after the
    // callback completes. If the callback halts (nested interrupt),
    // the flag stays set for the next resume.
    if (this.frame.locals[this.debugFlagKey(id)]) {
      //console.log(`[Runner] Resuming past debug hook at step ${stepPath}, skipping hook. node context: ${this.nodeContext}. locals: ${JSON.stringify(this.frame.locals)}`);
      return false;
    }

    // Set flag BEFORE calling debugStep so the checkpoint captures it.
    // If debugStep doesn't pause, we clear it below.
    this.frame.locals[this.debugFlagKey(id)] = true;

    const dbg = await debugStep(this.ctx, {
      moduleId: this.moduleId,
      scopeName: this.scopeName,
      stepPath: this.stepPath(id),
      label,
      nodeContext: this.nodeContext,
      isUserAdded,
    });

    if (dbg) {
      if (this.nodeContext) {
        // Wrap in { messages, data } to match node return format.
        // this.frame.threads is the live ThreadStore set by setupNode.
        this.halt({ messages: this.frame.threads, data: dbg });
      } else {
        // Function context: halt with raw single interrupt object. The
        // caller pattern unwraps and uses isInterrupt for debug pauses
        // (debugger pauses are always single, not array-shaped batches).
        this.halt(dbg);
      }
      return true;
    }

    // debugStep didn't pause — clear the flag
    this.clearDebugFlag(id);
    return false;
  }

  /** Clean up the debug flag for a step after it completes without halting. */
  private clearDebugFlag(id: number): void {
    if (!this.ctx.hasDebugger() && !this.ctx.hasTraceWriter()) {
      return;
    }
    delete this.frame.locals[this.debugFlagKey(id)];
  }

  private stepPath(id: number): string {
    return this.path.length === 0 ? `${id}` : `${this.key()}.${id}`;
  }

  private debugFlagKey(id: number): string {
    return `__dbg_${this.stepPath(id)}`;
  }

  // ── Per-branch cost/token tracking helpers ──

  /** Seed branch.stack.localCost / localTokens from the parent stack
   *  unless they're already populated (e.g., restored from a checkpoint
   *  on resume). Idempotent.
   *
   *  Also records `seedCost` / `seedTokens` — the IMMUTABLE baseline used
   *  later by propagateBranchCost to compute this branch's delta. Storing
   *  the baseline on the branch (rather than re-reading the parent at
   *  join time) means the delta survives the parent being mutated in the
   *  meantime — e.g. race losers propagating their spend into the parent
   *  before the winner resumes. See docs/superpowers/specs/2026-05-20-
   *  thread-builtins-and-stdlib-design.md. */
  private seedBranchCost(branchStack: StateStack, parentStack: StateStack): void {
    // Fresh-branch detection: seedBranchCost can be called more than
    // once for the same branch (e.g. a branch interrupts mid-flight
    // and the parent resumes runBatch on the next response cycle).
    // We must not clobber state the branch has already accumulated.
    // A branch is "fresh" iff it has no cost AND no tokens. Guards are
    // handled separately by `rehydrateInheritedGuards` in runBatch.ts —
    // they have their own idempotency tracking via BranchState.
    const isFresh =
      branchStack.localCost === 0 && branchStack.localTokens === 0;
    if (!isFresh) return;

    branchStack.localCost = parentStack.localCost;
    branchStack.localTokens = parentStack.localTokens;
    branchStack.seedCost = parentStack.localCost;
    branchStack.seedTokens = parentStack.localTokens;
  }

  /** Propagate cost/token deltas from a set of branches back to the
   *  outer stack. Delta = branch.localCost - branch.seedCost (the baseline
   *  captured when the branch was seeded). Using the per-branch seed
   *  rather than the parent's current totals is what makes the math
   *  correct when sibling branches have already propagated their spend
   *  into the parent (race losers → parent before winner resumes).
   *  Caller invokes this BEFORE popBranches() or deleteBranch —
   *  otherwise the branch stacks are gone. */
  private propagateBranchCost(
    branches: BranchState[],
    parentStack: StateStack,
  ): void {
    let costDelta = 0;
    let tokensDelta = 0;
    for (const branch of branches) {
      costDelta += branch.stack.localCost - branch.stack.seedCost;
      tokensDelta += branch.stack.localTokens - branch.stack.seedTokens;
    }
    parentStack.localCost += costDelta;
    parentStack.localTokens += tokensDelta;
  }

  // ── Core step method ──

  async step(
    id: number,
    callback: (runner: Runner) => Promise<void>,
  ): Promise<void> {
    this.beforeStep();
    if (this.shouldSkip()) return;
    if (this.getCounter() > id) return;

    if (await this.maybeDebugHook(id)) return;

    this.ctx.coverageCollector?.hit(this.moduleId, this.scopeName, this.stepPath(id));

    this.path.push(id);
    try {
      await this.runInScope(() => callback(this));
    } finally {
      this.path.pop();
    }

    if (this.halted) return;
    this.clearDebugFlag(id);
    this.setCounter(id + 1);
  }

  // ── Specialized: hook ──

  /**
   * Fire a codegen-emitted callback hook (onFunctionStart, onNodeStart,
   * onNodeEnd, onEmit) as a substep-counter-idempotent step. Unlike
   * `runner.step`, this does NOT call `maybeDebugHook` — codegen-emitted
   * hook sites have no user-visible source line, so pausing on them
   * would surprise the user (single-step would land on an internal hook
   * with no current line).
   *
   * Callback bodies cannot raise interrupts (statically forbidden by the
   * typechecker — see `checkCallbackBodyInterrupts`), so `bodyFn` is
   * fire-and-forget. The substep counter advances after `bodyFn`
   * resolves so resume re-entries (after a deeper interrupt or debug
   * pause) skip the hook instead of re-firing it.
   */
  async hook(id: number, bodyFn: () => Promise<void>): Promise<void> {
    this.beforeStep();
    if (this.shouldSkip()) return;
    if (this.getCounter() > id) return;

    this.ctx.coverageCollector?.hit(this.moduleId, this.scopeName, this.stepPath(id));

    this.path.push(id);
    try {
      await this.runInScope(() => bodyFn());
    } finally {
      this.path.pop();
    }

    if (this.halted) return;
    this.setCounter(id + 1);
  }

  async debugger(id: number, label: string): Promise<void> {
    this.beforeStep();
    if (this.shouldSkip()) return;
    if (this.getCounter() > id) return;
    if (await this.maybeDebugHook(id, label, true)) return;

    if (this.halted) return;
    this.clearDebugFlag(id);
    this.setCounter(id + 1);
  }

  // ── Specialized: pipe ──

  async pipe(id: number, input: any, fn: (value: any) => any): Promise<any> {
    this.beforeStep();
    if (this.shouldSkip()) return input;
    if (this.getCounter() > id)
      return this.frame.locals[`__pipe_result_${this.stepPath(id)}`] ?? input;

    if (await this.maybeDebugHook(id)) return input;

    this.ctx.coverageCollector?.hit(this.moduleId, this.scopeName, this.stepPath(id));

    const result = await this.runInScope(() => __pipeBind(input, fn));
    this.frame.locals[`__pipe_result_${this.stepPath(id)}`] = result;

    if (hasInterrupts(result)) {
      await this.ctx.pendingPromises.awaitAll();
      if (this.nodeContext) {
        this.halt({ ...this.state, data: result });
      } else {
        this.halt(result);
      }
      return result;
    }

    this.clearDebugFlag(id);
    this.setCounter(id + 1);
    return result;
  }

  // ── Specialized: thread ──

  async thread(
    id: number,
    method: "create" | "createSubthread",
    callback: (runner: Runner) => Promise<void>,
  ): Promise<void> {
    this.beforeStep();
    if (this.shouldSkip()) return;
    if (this.getCounter() > id) return;

    if (await this.maybeDebugHook(id)) return;

    this.ctx.coverageCollector?.hit(this.moduleId, this.scopeName, this.stepPath(id));

    // Post-ALS migration the ThreadStore is captured on `this.threads`
    // (seeded by the constructor from explicit opts or the active
    // ALS frame). Generated `runner.thread(...)` call sites no longer
    // need to pass it explicitly. Throw a clear error if absent — that
    // only happens when a Runner is constructed in a test harness
    // without `threads:` and outside any ALS frame.
    const threads = this.threads;
    if (!threads) {
      throw new Error(
        "Runner.thread() called without a ThreadStore available. " +
          "Construct the Runner with { threads } or wrap the call in " +
          "agencyStore.run({ ctx, stack, threads }, fn).",
      );
    }

    // Guard thread creation so it only happens once. On resume from a
    // debug pause inside the callback, the entire thread() method
    // re-executes (the step counter only advances after the callback
    // completes). Without this guard, threads.create() would run again
    // on every resume, creating duplicate threads.
    const threadKey = `__thread_${this.stepPath(id)}`;
    let tid: string;
    if (this.frame.locals[threadKey] !== undefined) {
      tid = this.frame.locals[threadKey];
    } else {
      tid = threads[method]();
      this.frame.locals[threadKey] = tid;
    }
    threads.pushActive(tid);

    this.path.push(id);
    try {
      await this.runInScope(() => callback(this));
    } finally {
      this.path.pop();
      threads.popActive();
    }

    if (this.halted) return;
    this.clearDebugFlag(id);
    this.setCounter(id + 1);
  }

  // ── Specialized: handle ──

  async handle(
    id: number,
    handlerFn: HandlerFn,
    callback: (runner: Runner) => Promise<void>,
  ): Promise<void> {
    if (this.shouldSkip()) return;
    if (this.getCounter() > id) return;

    if (await this.maybeDebugHook(id)) return;

    this.ctx.coverageCollector?.hit(this.moduleId, this.scopeName, this.stepPath(id));

    this.ctx.pushHandler(handlerFn);
    this.path.push(id);
    try {
      await this.runInScope(() => callback(this));
    } finally {
      this.path.pop();
      this.ctx.popHandler();
    }

    if (this.halted) return;
    this.clearDebugFlag(id);
    this.setCounter(id + 1);
  }

  // ── Specialized: ifElse ──

  async ifElse(
    id: number,
    branches: {
      condition: () => boolean | Promise<boolean>;
      body: (runner: Runner) => Promise<void>;
    }[],
    elseBranch?: (runner: Runner) => Promise<void>,
  ): Promise<void> {
    if (this.shouldSkip()) return;
    if (this.getCounter() > id) return;

    if (await this.maybeDebugHook(id)) return;

    this.ctx.coverageCollector?.hit(this.moduleId, this.scopeName, this.stepPath(id));

    // Derive condbranch key from current path
    const condKey =
      this.path.length === 0
        ? `__condbranch_${id}`
        : `__condbranch_${this.key()}.${id}`;

    // Evaluate condition only once (not on resume). Conditions may call
    // stdlib helpers that read `getRuntimeContext()`, so evaluate inside
    // the scope frame.
    if (this.frame.locals[condKey] === undefined) {
      let branchIndex = -1;
      await this.runInScope(async () => {
        for (let i = 0; i < branches.length; i++) {
          if (await branches[i].condition()) {
            branchIndex = i;
            break;
          }
        }
      });
      this.frame.locals[condKey] = branchIndex;
    }

    const branchIndex = this.frame.locals[condKey];

    this.path.push(id);
    try {
      await this.runInScope(async () => {
        if (branchIndex >= 0 && branchIndex < branches.length) {
          await branches[branchIndex].body(this);
        } else if (elseBranch) {
          await elseBranch(this);
        }
      });
    } finally {
      this.path.pop();
    }

    if (this.halted) return;
    this.clearDebugFlag(id);
    this.setCounter(id + 1);
  }

  // ── Specialized: loop (for) ──

  async loop(
    id: number,
    items: any[] | Record<string, any>,
    callback: (item: any, index: number, runner: Runner) => Promise<void>,
  ): Promise<void> {
    if (this.shouldSkip()) return;
    if (this.getCounter() > id) return;

    if (await this.maybeDebugHook(id)) return;

    this.ctx.coverageCollector?.hit(this.moduleId, this.scopeName, this.stepPath(id));

    const iterKey =
      this.path.length === 0
        ? `__iteration_${id}`
        : `__iteration_${this.key()}.${id}`;

    this.frame.locals[iterKey] = this.frame.locals[iterKey] ?? 0;

    // Records (plain objects) iterate by key. Arrays iterate by element.
    // Anything else (null, undefined, primitives) is treated as an empty
    // iterable, matching how a JS `for...of` over a non-iterable would
    // simply do nothing rather than crash mid-flow.
    let iterable: any[];
    if (Array.isArray(items)) {
      iterable = items;
    } else if (items != null && typeof items === "object") {
      iterable = Object.keys(items);
    } else {
      iterable = [];
    }

    for (let i = 0; i < iterable.length; i++) {
      if (this.halted) return;

      // Skip to resume iteration
      if (i < this.frame.locals[iterKey]) continue;

      this._break = false;
      this._continue = false;
      this.path.push(id);
      try {
        await this.runInScope(() => callback(iterable[i], i, this));
      } finally {
        this.path.pop();
      }

      if (this.halted) return;

      // Reset all nested tracking variables for next iteration
      const pathPrefix =
        this.path.length === 0 ? `${id}` : `${this.key()}.${id}`;
      this.frame.clearLocalsWithPrefix(`__substep_${pathPrefix}`);
      this.frame.clearLocalsWithPrefix(`__condbranch_${pathPrefix}`);
      this.frame.clearLocalsWithPrefix(`__iteration_${pathPrefix}`);
      this.frame.clearLocalsWithPrefix(`__interruptId_${pathPrefix}`);
      this.frame.clearLocalsWithPrefix(`__pipe_result_`);
      this.frame.locals[iterKey] = i + 1;

      if (this._break) break;
      // _continue: just let the for loop naturally continue
    }

    this._break = false;
    this._continue = false;
    this.clearDebugFlag(id);
    this.setCounter(id + 1);
  }

  // ── Specialized: whileLoop ──

  async whileLoop(
    id: number,
    // The condition may be sync (`x < 3`) or async (`isSuccess(r)` — the TS
    // builder always emits `await` around function calls, so any condition
    // containing one becomes a Promise<boolean>).
    condition: () => boolean | Promise<boolean>,
    callback: (runner: Runner) => Promise<void>,
  ): Promise<void> {
    if (this.shouldSkip()) return;
    if (this.getCounter() > id) return;

    if (await this.maybeDebugHook(id)) return;

    this.ctx.coverageCollector?.hit(this.moduleId, this.scopeName, this.stepPath(id));

    const iterKey =
      this.path.length === 0
        ? `__iteration_${id}`
        : `__iteration_${this.key()}.${id}`;

    this.frame.locals[iterKey] = this.frame.locals[iterKey] ?? 0;
    let currentIter = 0;

    while (await this.runInScope(async () => condition())) {
      if (this.halted) return;

      if (currentIter < this.frame.locals[iterKey]) {
        currentIter++;
        continue;
      }

      this._break = false;
      this._continue = false;
      this.path.push(id);
      try {
        await this.runInScope(() => callback(this));
      } finally {
        this.path.pop();
      }

      if (this.halted) return;

      const pathPrefix =
        this.path.length === 0 ? `${id}` : `${this.key()}.${id}`;
      this.frame.clearLocalsWithPrefix(`__substep_${pathPrefix}`);
      this.frame.clearLocalsWithPrefix(`__condbranch_${pathPrefix}`);
      this.frame.clearLocalsWithPrefix(`__iteration_${pathPrefix}`);
      this.frame.clearLocalsWithPrefix(`__interruptId_${pathPrefix}`);
      this.frame.clearLocalsWithPrefix(`__pipe_result_`);
      this.frame.locals[iterKey] = currentIter + 1;
      currentIter++;

      if (this._break) break;
      // _continue: just let the while loop naturally continue
    }

    this._break = false;
    this._continue = false;
    this.clearDebugFlag(id);
    this.setCounter(id + 1);
  }

  // ── Specialized: branchStep (async calls) ──

  async branchStep(
    id: number,
    branchKey: string,
    callback: (runner: Runner) => Promise<void>,
  ): Promise<void> {
    if (this.shouldSkip()) return;

    // Enter if: counter hasn't passed this OR branch data exists (resuming async)
    const hasExistingBranch = this.frame.getBranch(branchKey) !== undefined;
    if (this.getCounter() > id && !hasExistingBranch) return;

    if (await this.maybeDebugHook(id)) return;

    this.ctx.coverageCollector?.hit(this.moduleId, this.scopeName, this.stepPath(id));

    this.path.push(id);
    try {
      await this.runInScope(() => callback(this));
    } finally {
      this.path.pop();
    }

    if (this.halted) return;
    this.clearDebugFlag(id);
    this.setCounter(id + 1);
  }

  // ── Specialized: fork/race (parallel execution with isolation) ──

  /**
   * Run blockFn for each input in parallel. Each branch gets its own
   * BranchState (StateStack) for isolation and serialization.
   *
   * mode "all" (fork): waits for all, returns results array.
   * mode "race": returns first to complete.
   *
   * blockFn receives (item, index, branchStack) where branchStack is the
   * branch's isolated StateStack (new or deserialized from interrupt).
   *
   * If any branch (fork) or the winner (race) interrupts, returns an
   * `Interrupt[]` — the caller (generated code) detects this via
   * `hasInterrupts(...)` and halts. All concurrent interrupts are batched
   * into the same array under a single shared checkpoint.
   */
  async fork(
    id: number,
    items: any[],
    blockFn: (
      item: any,
      index: number,
      branchStack: StateStack,
    ) => Promise<any>,
    mode: "all" | "race",
    stateStack: StateStack,
  ): Promise<any> {
    this.beforeStep();
    if (this.shouldSkip()) return undefined;
    if (this.getCounter() > id) {
      return this.frame.locals[this.forkResultKey(id)];
    }

    if (await this.maybeDebugHook(id)) return undefined;

    const forkId = nanoid(12);
    const forkStartTime = performance.now();
    const forkSpanId = this.ctx.statelogClient.startSpan(
      mode === "all" ? "forkAll" : "race",
    );
    this.ctx.statelogClient.forkStart({
      forkId,
      mode,
      branchCount: items.length,
    });

    this.path.push(id);
    let result: any;
    // Capture winnerIndex inside the try block: it's stored under a key
    // derived from `this.path`, but the outer `finally` pops the path
    // before emitting forkEnd, so reading via raceWinnerKey() there would
    // produce the wrong key. Read it now and close over the value.
    let winnerIndex: number | undefined = undefined;
    // Read the race winner from this.frame.locals using a key derived from
    // the current path. Safe to call only inside the try block.
    const readWinner = () =>
      this.frame.locals[this.raceWinnerKey(id)] as number | undefined;
    try {
      // Both runForkAll and runRace are now thin adapters over runBatch.
      // The race adapter internally handles "first run" vs. "resume only
      // the winner" via the persisted __race_winner_<id> key, so the
      // caller does NOT need to dispatch between them.
      if (mode === "all") {
        result = await this.runForkAll(id, items, blockFn, stateStack, forkId);
        if (hasInterrupts(result)) return result;
      } else {
        result = await this.runRace(id, items, blockFn, stateStack, forkId);
        if (hasInterrupts(result)) {
          winnerIndex = readWinner();
          return result;
        }
      }
      if (mode === "race") {
        winnerIndex = readWinner();
      }

      // Clean up branch state after successful completion
      this.frame.popBranches();
    } finally {
      this.path.pop();
      // Each branch ran inside its own AsyncLocalStorage span context, so
      // its pushes/pops are isolated from the parent. We can safely emit
      // forkEnd and pop the fork span here even while loser race branches
      // are still draining in the background — their stacks live in
      // independent ALS contexts and cannot touch the parent's stack.
      this.ctx.statelogClient.forkEnd({
        forkId,
        mode,
        timeTaken: performance.now() - forkStartTime,
        winnerIndex,
      });
      this.ctx.statelogClient.endSpan(forkSpanId); // end forkAll/race span
    }

    if (this.halted) return undefined;

    this.frame.locals[this.forkResultKey(id)] = result;
    this.clearDebugFlag(id);
    this.setCounter(id + 1);
    return result;
  }

  /** Run all branches in parallel (fork mode). Returns an array of values,
   * or an Interrupt[] if any branch interrupted.
   *
   * Thin adapter over `runBatch({ mode: "all" })`. The primitive owns:
   * branch lifecycle, abort composition, settle, leaf checkpoint capture,
   * shared checkpoint stamp + intr.checkpoint overwrite, popBranches on
   * success. This adapter wires up the fork-specific statelog events and
   * cost propagation. */
  private async runForkAll(
    id: number,
    items: any[],
    blockFn: (
      item: any,
      index: number,
      branchStack: StateStack,
    ) => Promise<any>,
    stateStack: StateStack,
    forkId: string,
  ): Promise<any> {
    const result = await runBatch<any>({
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
        seedBranchCost: (childStack, parentStack) =>
          this.seedBranchCost(childStack, parentStack),
        propagateBranchCost: (branches, parentStack) =>
          this.propagateBranchCost(branches, parentStack),
        onBranchEnd: (_key, branchIndex, outcome, timeTaken) => {
          this.ctx.statelogClient.forkBranchEnd({
            forkId,
            branchIndex,
            outcome,
            timeTaken,
          });
        },
        onCheckpoint: (cpId) => {
          const cp = this.ctx.checkpoints.get(cpId)!;
          this.ctx.statelogClient.checkpointCreated({
            checkpointId: cpId,
            reason: "fork",
            sourceLocation: {
              moduleId: cp.moduleId,
              scopeName: cp.scopeName,
              stepPath: cp.stepPath,
            },
          });
        },
      },
    });
    return result.kind === "interrupts" ? result.interrupts : result.values;
  }

  /** Run all branches concurrently but return as soon as one settles.
   *
   * Thin adapter over `runBatch({ mode: "race" })`. The primitive owns
   * branch lifecycle, abort composition, settle (`Promise.race` with
   * loser abort), shared checkpoint stamp + intr.checkpoint overwrite,
   * winner-index persistence under `raceWinnerLocalKey`, loser-branch
   * deletion, and resume dispatch (re-running only the recorded winner
   * when a persisted winner is present). The adapter wires up race-
   * specific statelog events and the asymmetric cost-propagation hooks:
   * losers propagate eagerly at race time, winner propagates when it
   * finally completes (no-interrupt resume). */
  private async runRace(
    id: number,
    items: any[],
    blockFn: (
      item: any,
      index: number,
      branchStack: StateStack,
    ) => Promise<any>,
    stateStack: StateStack,
    forkId: string,
  ): Promise<any> {
    const result = await runBatch<any>({
      ctx: this.ctx,
      parentStack: stateStack,
      parentFrame: this.frame,
      checkpointLocation: {
        moduleId: this.moduleId,
        scopeName: this.scopeName,
        stepPath: this.stepPath(id),
      },
      mode: "race",
      // Keep the existing key shape — changing to stepPath would silently
      // break any in-flight serialized checkpoint stamped before this
      // migration.
      raceWinnerLocalKey: this.raceWinnerKey(id),
      children: items.map((item, i) => ({
        key: this.forkBranchKey(id, i),
        invoke: (branchStack) => blockFn(item, i, branchStack),
      })),
      hooks: {
        seedBranchCost: (childStack, parentStack) =>
          this.seedBranchCost(childStack, parentStack),
        // Asymmetric cost-propagation: losers eagerly, winner deferred.
        // Both delegate to the same propagateBranchCost helper — the
        // delta math (branch.localCost - branch.seedCost) is identical;
        // only the timing differs.
        propagateLoserCost: (losers, parentStack) =>
          this.propagateBranchCost(losers, parentStack),
        propagateWinnerCost: (winner, parentStack) =>
          this.propagateBranchCost([winner], parentStack),
        onBranchEnd: (_key, branchIndex, outcome, timeTaken) => {
          this.ctx.statelogClient.forkBranchEnd({
            forkId,
            branchIndex,
            outcome,
            timeTaken,
          });
        },
        onCheckpoint: (cpId) => {
          const cp = this.ctx.checkpoints.get(cpId)!;
          this.ctx.statelogClient.checkpointCreated({
            checkpointId: cpId,
            reason: "race",
            sourceLocation: {
              moduleId: cp.moduleId,
              scopeName: cp.scopeName,
              stepPath: cp.stepPath,
            },
          });
        },
      },
    });
    return result.kind === "interrupts" ? result.interrupts : result.values[0];
  }

  private raceWinnerKey(id: number): string {
    return this.path.length === 0
      ? `__race_winner_${id}`
      : `__race_winner_${this.key()}_${id}`;
  }

  private forkBranchKey(id: number, index: number): string {
    return this.path.length === 0
      ? `fork_${id}_${index}`
      : `fork_${this.key()}_${id}_${index}`;
  }

  private forkResultKey(id: number): string {
    return this.path.length === 0
      ? `__fork_result_${id}`
      : `__fork_result_${this.key()}_${id}`;
  }
}
