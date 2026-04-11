import type { State, BranchState } from "./state/stateStack.js";
import { StateStack } from "./state/stateStack.js";
import type { RuntimeContext } from "./state/context.js";
import type { HandlerFn } from "./types.js";
import { isInterrupt } from "./interrupts.js";
import { __pipeBind } from "./result.js";
import { debugStep } from "./debugger.js";
import { color } from "termcolors";
import { id } from "smoltalk";

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

  constructor(ctx: RuntimeContext<any>, frame: State, opts?: { nodeContext?: boolean; state?: any; moduleId?: string; scopeName?: string }) {
    this.ctx = ctx;
    this.frame = frame;
    this.nodeContext = opts?.nodeContext ?? false;
    this.state = opts?.state ?? {};
    this.moduleId = opts?.moduleId ?? "";
    this.scopeName = opts?.scopeName ?? "";
  }

  // ── Path and counter management ──

  /** The current step path as a string, e.g. "1_0_2" */
  key(): string {
    return this.path.join("_");
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

  /** Check if execution should skip (halted, breaking, or continuing) */
  private shouldSkip(): boolean {
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
  private async maybeDebugHook(id: number, label: string | null = null, isUserAdded: boolean = false): Promise<boolean> {
    if (!this.ctx.debuggerState && !this.ctx.traceWriter) return false;


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
        // Function context: halt with raw interrupt so caller's isInterrupt check works.
        this.halt(dbg);
      }
      //console.log(`[Runner] Debug hook triggered at step ${this.stepPath(id)}, halting execution. node context: ${this.nodeContext}`);
      return true;
    }

    // debugStep didn't pause — clear the flag
    this.clearDebugFlag(id);
    //console.log(`[Runner] no dbg interrupt at step ${this.stepPath(id)}, continuing execution. node context: ${this.nodeContext}`);
    return false;
  }

  /** Clean up the debug flag for a step after it completes without halting. */
  private clearDebugFlag(id: number): void {
    //console.log(color.green(`[Runner] Clearing debug flag for step ${this.stepPath(id)}. node context: ${this.nodeContext}. locals before cleanup: ${JSON.stringify(this.frame.locals)}`));
    if (!this.ctx.debuggerState && !this.ctx.traceWriter) {
      //console.log(`[Runner] No debugger or trace writer in context, skipping debug flag cleanup for step ${this.stepPath(id)}.`);
      return
    };
    delete this.frame.locals[this.debugFlagKey(id)];
    //console.log(color.green(`[Runner] Debug flag cleared for step ${this.stepPath(id)}. locals after cleanup: ${JSON.stringify(this.frame.locals)}`));
  }

  private stepPath(id: number): string {
    return this.path.length === 0 ? `${id}` : `${this.key()}.${id}`;
  }

  private debugFlagKey(id: number): string {
    return `__dbg_${this.stepPath(id)}`;
  }

  // ── Core step method ──

  async step(id: number, callback: (runner: Runner) => Promise<void>): Promise<void> {
    if (this.shouldSkip()) return;
    if (this.getCounter() > id) return;

    if (await this.maybeDebugHook(id)) return;

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

  async pipe(
    id: number,
    input: any,
    fn: (value: any) => any,
  ): Promise<any> {
    if (this.shouldSkip()) return input;
    if (this.getCounter() > id) return this.frame.locals[`__pipe_result_${id}`] ?? input;

    if (await this.maybeDebugHook(id)) return input;

    const result = await __pipeBind(input, fn);
    this.frame.locals[`__pipe_result_${id}`] = result;

    if (isInterrupt(result)) {
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

    const tid = threads[method]();
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
    branches: { condition: () => boolean | Promise<boolean>; body: (runner: Runner) => Promise<void> }[],
    elseBranch?: (runner: Runner) => Promise<void>,
  ): Promise<void> {
    if (this.shouldSkip()) return;
    if (this.getCounter() > id) return;

    if (await this.maybeDebugHook(id)) return;

    // Derive condbranch key from current path
    const condKey =
      this.path.length === 0
        ? `__condbranch_${id}`
        : `__condbranch_${this.key()}_${id}`;

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
    if (this.halted) return;
    if (this.getCounter() > id) return;

    if (await this.maybeDebugHook(id)) return;

    const iterKey =
      this.path.length === 0
        ? `__iteration_${id}`
        : `__iteration_${this.key()}_${id}`;

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
        this.path.length === 0 ? `${id}` : `${this.key()}_${id}`;
      this.frame.clearLocalsWithPrefix(`__substep_${pathPrefix}`);
      this.frame.clearLocalsWithPrefix(`__condbranch_${pathPrefix}`);
      this.frame.clearLocalsWithPrefix(`__iteration_${pathPrefix}`);
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
    if (this.halted) return;
    if (this.getCounter() > id) return;

    if (await this.maybeDebugHook(id)) return;

    const iterKey =
      this.path.length === 0
        ? `__iteration_${id}`
        : `__iteration_${this.key()}_${id}`;

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
        this.path.length === 0 ? `${id}` : `${this.key()}_${id}`;
      this.frame.clearLocalsWithPrefix(`__substep_${pathPrefix}`);
      this.frame.clearLocalsWithPrefix(`__condbranch_${pathPrefix}`);
      this.frame.clearLocalsWithPrefix(`__iteration_${pathPrefix}`);
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
    const hasExistingBranch = this.frame.branches?.[branchKey];
    if (this.getCounter() > id && !hasExistingBranch) return;

    if (await this.maybeDebugHook(id)) return;

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
   * Returns the interrupt directly if any branch interrupts — the caller
   * (generated code) handles halt via the standard isInterrupt check.
   * Concurrent interrupt batching is deferred to stage 5.
   */
  async fork(
    id: number,
    items: any[],
    blockFn: (item: any, index: number, branchStack: StateStack) => Promise<any>,
    mode: "all" | "race",
  ): Promise<any> {
    if (this.shouldSkip()) return undefined;
    if (this.getCounter() > id) {
      return this.frame.locals[this.forkResultKey(id)];
    }

    if (await this.maybeDebugHook(id)) return undefined;

    this.path.push(id);
    let result: any;
    try {
      if (!this.frame.branches) this.frame.branches = {};

      const branchStacks = items.map((_item, i) => {
        const branchKey = this.forkBranchKey(id, i);
        const existing = this.frame.branches![branchKey];
        if (existing) {
          existing.stack.deserializeMode();
          return existing.stack;
        }
        const stack = new StateStack();
        this.frame.branches![branchKey] = { stack };
        return stack;
      });

      const promises = items.map((item, i) => blockFn(item, i, branchStacks[i]));

      if (mode === "all") {
        const settled = await Promise.allSettled(promises);

        // Return first interrupt found — caller handles halt
        for (const s of settled) {
          if (s.status === "fulfilled" && isInterrupt(s.value)) {
            return s.value;
          }
        }

        for (const s of settled) {
          if (s.status === "rejected") throw s.reason;
        }

        result = settled.map((s) => (s as PromiseFulfilledResult<any>).value);
      } else {
        result = await Promise.race(promises);
        if (isInterrupt(result)) return result;
      }

      // Clean up branch state after successful completion
      for (let i = 0; i < items.length; i++) {
        delete this.frame.branches![this.forkBranchKey(id, i)];
      }
    } finally {
      this.path.pop();
    }

    if (this.halted) return undefined;

    this.frame.locals[this.forkResultKey(id)] = result;
    this.clearDebugFlag(id);
    this.setCounter(id + 1);
    return result;
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
