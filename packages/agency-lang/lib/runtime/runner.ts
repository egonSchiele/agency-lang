import { nanoid } from "nanoid";
import type { CallbackName } from "../types/function.js";
import { debugStep } from "./debugger.js";
import {
  fireGlobalHooks,
  gatherCallbacks,
  invokeOneCallback,
  type CallbackMap,
} from "./hooks.js";
import { hasInterrupts } from "./interrupts.js";
import { __pipeBind } from "./result.js";
import { runBatch } from "./runBatch.js";
import type { SourceLocationOpts } from "./state/checkpointStore.js";
import type { RuntimeContext } from "./state/context.js";
import type { BranchState, State } from "./state/stateStack.js";
import { StateStack } from "./state/stateStack.js";
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

  constructor(
    ctx: RuntimeContext<any>,
    frame: State,
    opts?: {
      nodeContext?: boolean;
      state?: any;
      moduleId?: string;
      scopeName?: string;
      stack?: StateStack;
    },
  ) {
    this.ctx = ctx;
    this.frame = frame;
    this.nodeContext = opts?.nodeContext ?? false;
    this.state = opts?.state ?? {};
    this.moduleId = opts?.moduleId ?? "";
    this.scopeName = opts?.scopeName ?? "";
    this.stack = opts?.stack;
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
    this.halted = true;
    this.haltResult = result;
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
   * Also halts if the runner's branch stack has been aborted (race loser). */
  private shouldSkip(): boolean {
    if (this.stack?.abortSignal?.aborted && !this.halted) {
      this.halt(undefined);
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

    const dbg = await debugStep(this.ctx, this.state, {
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
    if (branchStack.localCost === 0 && branchStack.localTokens === 0) {
      branchStack.localCost = parentStack.localCost;
      branchStack.localTokens = parentStack.localTokens;
      branchStack.seedCost = parentStack.localCost;
      branchStack.seedTokens = parentStack.localTokens;
    }
    // Clone parent guards so LLM calls inside the branch are checked
    // against ancestor limits. Per-entry copy keeps the parent's
    // entries safe from mutation if the child later pushes its own.
    // LIMITATION: deltas from a child branch only roll back into the
    // parent at branch completion (propagateBranchCost), so an outer
    // guard cannot trip mid-fork — only after the fork completes.
    branchStack.guards = parentStack.guards.map((g) => ({ ...g }));
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
    if (this.shouldSkip()) return;
    if (this.getCounter() > id) return;

    if (await this.maybeDebugHook(id)) return;

    this.ctx.coverageCollector?.hit(this.moduleId, this.scopeName, this.stepPath(id));

    this.path.push(id);
    try {
      await callback(this);
    } finally {
      this.path.pop();
    }

    if (this.halted) return;
    this.clearDebugFlag(id);
    this.setCounter(id + 1);
  }

  async debugger(id: number, label: string): Promise<void> {
    if (this.shouldSkip()) return;
    if (this.getCounter() > id) return;
    if (await this.maybeDebugHook(id, label, true)) return;

    if (this.halted) return;
    this.clearDebugFlag(id);
    this.setCounter(id + 1);
  }

  // ── Specialized: pipe ──

  async pipe(id: number, input: any, fn: (value: any) => any): Promise<any> {
    if (this.shouldSkip()) return input;
    if (this.getCounter() > id)
      return this.frame.locals[`__pipe_result_${this.stepPath(id)}`] ?? input;

    if (await this.maybeDebugHook(id)) return input;

    this.ctx.coverageCollector?.hit(this.moduleId, this.scopeName, this.stepPath(id));

    const result = await __pipeBind(input, fn);
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
    threads: any,
    method: "create" | "createSubthread",
    callback: (runner: Runner) => Promise<void>,
  ): Promise<void> {
    if (this.shouldSkip()) return;
    if (this.getCounter() > id) return;

    if (await this.maybeDebugHook(id)) return;

    this.ctx.coverageCollector?.hit(this.moduleId, this.scopeName, this.stepPath(id));

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
      await callback(this);
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
      await callback(this);
    } finally {
      this.path.pop();
      this.ctx.popHandler();
    }

    if (this.halted) return;
    this.clearDebugFlag(id);
    this.setCounter(id + 1);
  }

  // ── Specialized: hook ──

  /**
   * Fire a codegen-emitted callback hook (onFunctionStart, onFunctionEnd,
   * onEmit, onNodeStart, onNodeEnd) as a resumable substep.
   *
   * If any registered callback for `hookName` halts with `Interrupt[]`,
   * we halt this runner so the surrounding generated function returns
   * the interrupts up the stack via `runner.haltResult`. The substep
   * counter is NOT advanced on halt, so on resume the hook re-fires and
   * the callback's frame (preserved in the callback's own checkpoint
   * stamped at its interrupt site) is re-entered in deserialize mode —
   * its substep counters point straight at the interrupt step, which
   * finds the user's response keyed by the saved __interruptId_N and
   * completes without re-running earlier substeps.
   *
   * We deliberately do NOT stamp a separate checkpoint here: the
   * callback's interrupt site already stamps one that captures the full
   * stack including the callback frame with its substep counters and
   * saved interrupt ids. `respondToInterrupts` reads `intr.checkpoint`
   * first, so the callback-stamped checkpoint is what gets used on
   * resume.
   *
   * If the hook returns no interrupts the substep counter advances, so
   * subsequent resumes skip the hook (no duplicate analytics events
   * after every interrupt cycle).
   */
  async hook(
    id: number,
    hookName: CallbackName,
    // Hook payload type varies per hook — most hooks pass an object
    // shape, but onEmit forwards whatever value `emit(...)` was called
    // with (string, number, custom object, etc.). Use `unknown` so the
    // generated TypeScript compiles for every hook payload shape.
    data: unknown,
  ): Promise<void> {
    if (this.shouldSkip()) return;
    if (this.getCounter() > id) return;

    // NOTE: codegen-emitted hook substeps (onNodeStart/onNodeEnd/onEmit/
    // onFunctionStart/onFunctionEnd) are invisible to the debugger.
    // They have no source mapping and aren't user-authored code, so
    // pausing on them would surprise the user (single-step would land
    // on an internal hook with no current line). We intentionally do
    // NOT call maybeDebugHook here.

    this.ctx.coverageCollector?.hit(this.moduleId, this.scopeName, this.stepPath(id));

    this.path.push(id);
    try {
      // Walk the right slice for scoped-callback discovery. If this Runner
      // was instantiated inside a fork branch (forkBlockSetup template
      // sets `stack: __forkBranchStack`), `this.stack` is the branch's
      // own stack — scoped callbacks registered in the branch's frame
      // chain live there, NOT on `ctx.stateStack`.
      const parentStack = this.stack ?? this.ctx.stateStack;

      // (A previous draft of this method had a defensive
      // `frame.hasBranches() && !this.stack` assertion meant to catch a
      // codegen-template that forgot to wire `stack: branchStack` into
      // a fork-branch Runner. Dropped: the assertion false-positives on
      // resume after Runner.hook itself opens per-callback branches via
      // runBatch, because those branches persist on `this.frame` until
      // the hook completes. A more precise check would have to inspect
      // branch keys, which couples the assertion to the key scheme.
      // Forkblock-template correctness is currently enforced by the
      // existing fork-suite tests instead.)

      // Global hooks (registered by external packages, e.g. mcp) fire
      // first — same order as today's callHook. They have no interrupt
      // mechanism so they run inline.
      await fireGlobalHooks(
        this.ctx,
        hookName as keyof CallbackMap,
        data as CallbackMap[keyof CallbackMap],
        this.stack,
      );

      const callbacks = gatherCallbacks(
        this.ctx,
        hookName as keyof CallbackMap,
        parentStack,
      );

      // Fast path: nothing to fire via runBatch. Done.
      if (callbacks.length === 0) {
        // fall through to the normal post-body cleanup below.
      } else {
        // Per-callback runBatch: each callback fires as a separate
        // sequential child branch. When one interrupts, runBatch stamps
        // a shared checkpoint and surfaces all collected interrupts;
        // the per-branch `result`/`interrupt` recording on
        // `parentFrame.branches` means resume short-circuits (via the
        // cached-branch path in runBatch) any callback whose interrupt
        // was already responded to, re-firing only the un-resolved
        // ones. Without this, every resume cycle re-fired every
        // callback from scratch, breaking side-effect-once semantics
        // for multi-callback hooks.
        const result = await runBatch<undefined>({
          ctx: this.ctx,
          parentStack,
          parentFrame: this.frame,
          checkpointLocation: this.getCheckpointInfo(),
          // Sequential is REQUIRED here — `callHook` historically fires
          // callbacks in declared order, and using `mode: "all"` would
          // silently turn ordered side effects into a concurrent race.
          mode: "sequential",
          children: callbacks.map((fn, i) => ({
            key: this.hookBranchKey(id, i),
            invoke: async (branchStack) => {
              // Fire this single callback on the branch's own stack so
              // any interrupt raised inside captures a checkpoint with
              // the right slice. We already extracted `fn` from the
              // outer `gatherCallbacks` call — don't re-gather inside
              // the child.
              const interrupts = await invokeOneCallback({
                ctx: this.ctx,
                fn,
                name: hookName as keyof CallbackMap,
                data: data as CallbackMap[keyof CallbackMap],
                stateStack: branchStack,
              });
              return interrupts ?? undefined;
            },
          })),
        });
        if (result.kind === "interrupts") {
          if (this.nodeContext) {
            this.halt({ ...this.state, data: result.interrupts });
          } else {
            this.halt(result.interrupts);
          }
          return;
        }
      }
    } finally {
      this.path.pop();
    }

    if (this.halted) return;
    this.clearDebugFlag(id);
    this.setCounter(id + 1);
  }

  private hookBranchKey(id: number, index: number): string {
    return this.path.length === 0
      ? `hook_${id}_${index}`
      : `hook_${this.key()}_${id}_${index}`;
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

    // Evaluate condition only once (not on resume)
    if (this.frame.locals[condKey] === undefined) {
      let branchIndex = -1;
      for (let i = 0; i < branches.length; i++) {
        if (await branches[i].condition()) {
          branchIndex = i;
          break;
        }
      }
      this.frame.locals[condKey] = branchIndex;
    }

    const branchIndex = this.frame.locals[condKey];

    this.path.push(id);
    try {
      if (branchIndex >= 0 && branchIndex < branches.length) {
        await branches[branchIndex].body(this);
      } else if (elseBranch) {
        await elseBranch(this);
      }
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
        await callback(iterable[i], i, this);
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

    while (await condition()) {
      if (this.halted) return;

      if (currentIter < this.frame.locals[iterKey]) {
        currentIter++;
        continue;
      }

      this._break = false;
      this._continue = false;
      this.path.push(id);
      try {
        await callback(this);
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
      await callback(this);
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
