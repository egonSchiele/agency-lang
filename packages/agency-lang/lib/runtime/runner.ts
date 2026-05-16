import { nanoid } from "nanoid";
import { debugStep } from "./debugger.js";
import { hasInterrupts } from "./interrupts.js";
import { __pipeBind } from "./result.js";
import type { SourceLocationOpts } from "./state/checkpointStore.js";
import type { RuntimeContext } from "./state/context.js";
import type { State } from "./state/stateStack.js";
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
    items: any[],
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

    for (let i = 0; i < items.length; i++) {
      if (this.halted) return;

      // Skip to resume iteration
      if (i < this.frame.locals[iterKey]) continue;

      this._break = false;
      this._continue = false;
      this.path.push(id);
      try {
        await callback(items[i], i, this);
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
    condition: () => boolean,
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

    while (condition()) {
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
    this.ctx.statelogClient.forkStart({
      forkId,
      mode,
      branchCount: items.length,
    });
    this.ctx.statelogClient.startSpan(mode === "all" ? "forkAll" : "race");

    this.path.push(id);
    let result: any;
    try {
      // Race resume: if a winner was already chosen on a previous run,
      // resume only that branch — skip the race entirely.
      const raceWinnerKey = this.raceWinnerKey(id);
      if (mode === "race" && this.frame.locals[raceWinnerKey] !== undefined) {
        result = await this.resumeRaceWinner(
          id,
          items,
          blockFn,
          stateStack,
          this.frame.locals[raceWinnerKey] as number,
        );
        if (hasInterrupts(result)) return result;
      } else if (mode === "all") {
        result = await this.runForkAll(id, items, blockFn, stateStack);
        if (hasInterrupts(result)) return result;
      } else {
        result = await this.runRace(id, items, blockFn, stateStack);
        if (hasInterrupts(result)) return result;
      }

      // Clean up branch state after successful completion
      this.frame.popBranches();
    } finally {
      this.path.pop();
      this.ctx.statelogClient.endSpan(); // end forkAll/race span
      this.ctx.statelogClient.forkEnd({
        forkId,
        mode,
        timeTaken: performance.now() - forkStartTime,
        winnerIndex: mode === "race"
          ? this.frame.locals[this.raceWinnerKey(id)] as number | undefined
          : undefined,
      });
    }

    if (this.halted) return undefined;

    this.frame.locals[this.forkResultKey(id)] = result;
    this.clearDebugFlag(id);
    this.setCounter(id + 1);
    return result;
  }

  /** Run all branches in parallel (fork mode). Returns an array of values,
   * or an Interrupt[] if any branch interrupted. */
  private async runForkAll(
    id: number,
    items: any[],
    blockFn: (
      item: any,
      index: number,
      branchStack: StateStack,
    ) => Promise<any>,
    stateStack: StateStack,
  ): Promise<any> {
    const promises = items.map((item, i) => {
      const branchKey = this.forkBranchKey(id, i);
      const existing = this.frame.getOrCreateBranch(branchKey);
      if (existing.result !== undefined) {
        return Promise.resolve(existing.result.result);
      }
      // Each fork branch gets its own AbortController. For fork-all this is
      // mainly there for parity with race; we don't currently abort fork-all
      // branches, but having a signal in place lets generated code use it.
      if (!existing.abortController) {
        existing.abortController = new AbortController();
        // Compose with the parent stack's signal so nested fork/race aborts
        // propagate down through every level.
        const parentSignal = stateStack.abortSignal;
        existing.stack.abortSignal = parentSignal
          ? AbortSignal.any([parentSignal, existing.abortController.signal])
          : existing.abortController.signal;
      }
      this.ctx.statelogClient.enterFork();
      return blockFn(item, i, existing.stack).finally(() => {
        this.ctx.statelogClient.exitFork();
      });
    });

    const settled = await Promise.allSettled(promises);
    const interrupts: any[] = [];

    for (let i = 0; i < settled.length; i++) {
      const s = settled[i];
      const branchKey = this.forkBranchKey(id, i);
      if (s.status === "rejected") {
        throw s.reason;
      }
      if (hasInterrupts(s.value)) {
        interrupts.push(...s.value);
        this.frame.setInterruptOnBranch(
          branchKey,
          s.value[0].interruptId,
          s.value[0].interruptData,
          s.value[0].checkpoint,
        );
      } else {
        this.frame.setResultOnBranch(branchKey, s.value);
      }
    }

    if (interrupts.length > 0) {
      const cpId = this.ctx.checkpoints.create(stateStack, this.ctx, {
        moduleId: this.moduleId,
        scopeName: this.scopeName,
        stepPath: this.stepPath(id),
      });
      const cp = this.ctx.checkpoints.get(cpId)!;
      this.ctx.statelogClient.checkpointCreated({
        checkpointId: cpId,
        reason: "fork",
        sourceLocation: { moduleId: cp.moduleId, scopeName: cp.scopeName, stepPath: cp.stepPath },
      });
      for (const intr of interrupts) {
        intr.checkpoint = cp;
        intr.checkpointId = cpId;
      }
      return interrupts;
    }

    return settled.map((s) => (s as PromiseFulfilledResult<any>).value);
  }

  /** Run all branches concurrently but return as soon as one settles.
   * On interrupt: record the winner, abort the losers, clear loser branches,
   * stamp a checkpoint, and return the interrupt array.
   * On value: return the value (losers' work is discarded). */
  private async runRace(
    id: number,
    items: any[],
    blockFn: (
      item: any,
      index: number,
      branchStack: StateStack,
    ) => Promise<any>,
    stateStack: StateStack,
  ): Promise<any> {
    // Build the per-branch promises, each tagged with its index so we know
    // who won the race.
    const taggedPromises: Promise<{ index: number; value: any }>[] = items.map(
      (item, i) => {
        const branchKey = this.forkBranchKey(id, i);
        const existing = this.frame.getOrCreateBranch(branchKey);
        if (existing.result !== undefined) {
          return Promise.resolve({ index: i, value: existing.result.result });
        }
        if (!existing.abortController) {
          existing.abortController = new AbortController();
          // Compose with the parent stack's signal so nested race aborts
          // propagate down through every level. The branch's signal is
          // attached to its stack so any code holding the stack (runPrompt,
          // ctx.isCancelled checks, etc.) observes a branch-only abort.
          const parentSignal = stateStack.abortSignal;
          existing.stack.abortSignal = parentSignal
            ? AbortSignal.any([parentSignal, existing.abortController.signal])
            : existing.abortController.signal;
        }
        this.ctx.statelogClient.enterFork();
        return blockFn(item, i, existing.stack).then(
          (value) => {
            this.ctx.statelogClient.exitFork();
            return { index: i, value };
          },
          (err) => {
            this.ctx.statelogClient.exitFork();
            throw err;
          },
        );
      },
    );

    // Promise.race resolves with whichever finishes first.
    const { index: winnerIndex, value: winnerValue } =
      await Promise.race(taggedPromises);

    // Abort the losing branches so any in-flight work (LLM calls, tool calls)
    // can stop. Note: synchronous code that has already reached an
    // interrupt() call before we get here will still resolve its orphan
    // promise — we discard those resolutions below.
    for (let i = 0; i < items.length; i++) {
      if (i === winnerIndex) continue;
      const branchKey = this.forkBranchKey(id, i);
      const branch = this.frame.getBranch(branchKey);
      branch?.abortController?.abort();
    }

    // Record the winner so a resume on the same race step replays only this
    // branch (not the abandoned losers).
    this.frame.locals[this.raceWinnerKey(id)] = winnerIndex;

    const winnerBranchKey = this.forkBranchKey(id, winnerIndex);

    if (hasInterrupts(winnerValue)) {
      // Save the winner's interrupt info on its branch so resume can find it.
      this.frame.setInterruptOnBranch(
        winnerBranchKey,
        winnerValue[0].interruptId,
        winnerValue[0].interruptData,
        winnerValue[0].checkpoint,
      );
      // Drop the loser branches before serializing — they hold partial state
      // we never want to revisit.
      for (let i = 0; i < items.length; i++) {
        if (i === winnerIndex) continue;
        this.frame.deleteBranch(this.forkBranchKey(id, i));
      }
      // Stamp a checkpoint capturing only the winner's slice.
      const cpId = this.ctx.checkpoints.create(stateStack, this.ctx, {
        moduleId: this.moduleId,
        scopeName: this.scopeName,
        stepPath: this.stepPath(id),
      });
      const cp = this.ctx.checkpoints.get(cpId)!;
      this.ctx.statelogClient.checkpointCreated({
        checkpointId: cpId,
        reason: "race",
        sourceLocation: { moduleId: cp.moduleId, scopeName: cp.scopeName, stepPath: cp.stepPath },
      });
      for (const intr of winnerValue) {
        intr.checkpoint = cp;
        intr.checkpointId = cpId;
      }
      return winnerValue;
    }

    // Winner produced a value. Cache it on the winner branch and drop losers.
    this.frame.setResultOnBranch(winnerBranchKey, winnerValue);
    for (let i = 0; i < items.length; i++) {
      if (i === winnerIndex) continue;
      this.frame.deleteBranch(this.forkBranchKey(id, i));
    }
    return winnerValue;
  }

  /** Race resume: only the recorded winner is re-executed. */
  private async resumeRaceWinner(
    id: number,
    items: any[],
    blockFn: (
      item: any,
      index: number,
      branchStack: StateStack,
    ) => Promise<any>,
    stateStack: StateStack,
    winnerIndex: number,
  ): Promise<any> {
    const branchKey = this.forkBranchKey(id, winnerIndex);
    const existing = this.frame.getBranch(branchKey);
    if (!existing) {
      throw new Error(
        `Race resume: winner branch ${branchKey} (index ${winnerIndex}) is missing — state may be corrupted.`,
      );
    }

    // Already-completed winner: return cached result.
    if (existing.result !== undefined) {
      return existing.result.result;
    }

    // Pending winner: re-run blockFn with the existing branch stack. We
    // start a fresh AbortController for the resumed run; the branch stack
    // hasn't been re-attached to a stack signal yet, but resume only re-runs
    // the winner so there are no losers to abort. (If the winner itself
    // contains nested fork/race, those will install their own signals.)
    if (!existing.abortController) {
      existing.abortController = new AbortController();
      existing.stack.abortSignal = existing.abortController.signal;
    }
    const value = await blockFn(items[winnerIndex], winnerIndex, existing.stack);

    if (hasInterrupts(value)) {
      this.frame.setInterruptOnBranch(
        branchKey,
        value[0].interruptId,
        value[0].interruptData,
        value[0].checkpoint,
      );
      const cpId = this.ctx.checkpoints.create(stateStack, this.ctx, {
        moduleId: this.moduleId,
        scopeName: this.scopeName,
        stepPath: this.stepPath(id),
      });
      const cp = this.ctx.checkpoints.get(cpId)!;
      this.ctx.statelogClient.checkpointCreated({
        checkpointId: cpId,
        reason: "race",
        sourceLocation: { moduleId: cp.moduleId, scopeName: cp.scopeName, stepPath: cp.stepPath },
      });
      for (const intr of value) {
        intr.checkpoint = cp;
        intr.checkpointId = cpId;
      }
      return value;
    }

    this.frame.setResultOnBranch(branchKey, value);
    return value;
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
