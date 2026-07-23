import { withThreadEndHooksEvents } from "./threadEndHooksEvents.js";
import { nanoid } from "nanoid";
import { __globals, agencyStore } from "./asyncContext.js";
import { raiseGuardTripsAtStep } from "./guardTripInterrupt.js";
import { debugStep } from "./debugger.js";
import { RestoreSignal, readCause } from "./errors.js";
import { HaltSignal } from "./haltSignal.js";
import { invokeCallbacks } from "./hooks.js";
import { hasInterrupts } from "./interrupts.js";
import { makeRedactReplacer, REDACTED } from "./redactForStatelog.js";
import { __pipeBind } from "./result.js";
import { nativeTypeReplacer, nativeTypeReviver } from "./revivers/index.js";
import { runBatch } from "./runBatch.js";
import { repairReopenedThread } from "./threadRepair.js";
import type { SourceLocationOpts } from "./state/checkpointStore.js";
import type { RuntimeContext } from "./state/context.js";
import type { BranchState, State } from "./state/stateStack.js";
import {
  StateStack,
  seedBranchCost as seedBranchCostImpl,
  propagateBranchCost as propagateBranchCostImpl,
} from "./state/stateStack.js";
import type { ThreadStore } from "./state/threadStore.js";
import type { HandlerFn } from "./types.js";
import { matchValName } from "../matchVal.js";
import { classifyIterable } from "../utils/iteration.js";

/** Options bag for the new `Runner.thread(id, method, opts, callback)`
 *  signature. All fields are optional; emitter passes only the ones
 *  the user supplied via `thread(label: ..., summarize: ..., continue: ..., session: ...) { ... }`. */
export type ThreadStepOpts = {
  label?: string;
  summarize?: boolean;
  /** Slug form (e.g. "t3"). Stripped to raw counter id internally. */
  continueId?: string;
  /** Session name; runtime maps it to a thread id via openSession. */
  session?: string;
  /** When true, the created thread is excluded from `listThreads()`. */
  hidden?: boolean;
};

/** Strip the leading `t` from a public thread slug to recover the
 *  internal counter-string id. Only strips when the slug matches the
 *  canonical `t<digits>` shape so user-chosen ids that happen to
 *  begin with `t` (e.g. session names like `"telephone"`) are not
 *  silently mangled. */
export function stripSlug(slug: string): string {
  return /^t\d+$/.test(slug) ? slug.slice(1) : slug;
}

/** Cap on the serialized size of a fork-branch value attached to a
 *  `forkBranchEnd` statelog event. Branch results are usually tiny (a
 *  number, a short object) but could be large; bound it so telemetry
 *  can't balloon. */
const FORK_VALUE_CHAR_CAP = 4000;

/** Serialize a fork branch's return value for the `forkBranchEnd` event
 *  WITHOUT ever throwing — telemetry must not break execution. Returns:
 *  - `undefined` when there is no value (non-success outcome, or a value
 *    JSON can't represent, e.g. a function);
 *  - a deep clone for normal small values (so it renders cleanly);
 *  - a truncated string for oversized values;
 *  - `"[unserializable]"` when (de)serialization throws (e.g. a cycle).
 *
 *  Redaction happens HERE, during the stringify — not only at post() time.
 *  The truncation branch returns a plain string, and post()'s redaction
 *  replacer cannot see inside a string, so an oversized redact()ed branch
 *  value would otherwise leak its first FORK_VALUE_CHAR_CAP chars into the
 *  event. The redact check composes with the shared nativeTypeReplacer
 *  (like deepClone) so untagged natives and non-redact tags still round-trip
 *  intact for the small path. Reads the caller's store leniently: both call
 *  sites run at the fork join inside the parent's ALS frame; with no frame
 *  this degrades to tag-preserving cloning, which post() still redacts on
 *  the un-truncated path. */
export function safeStatelogValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  const globals = __globals();
  const redact =
    globals && globals.hasAnyTags() ? makeRedactReplacer(globals) : null;
  const replacer = function (
    this: unknown,
    key: string,
    val: unknown,
  ): unknown {
    if (redact && redact.call(this, key, val) === REDACTED) return REDACTED;
    return nativeTypeReplacer.call(this, key, val);
  };
  let json: string | undefined;
  try {
    json = JSON.stringify(value, replacer);
  } catch {
    return "[unserializable]";
  }
  if (json === undefined) return undefined;
  if (json.length > FORK_VALUE_CHAR_CAP) {
    return json.slice(0, FORK_VALUE_CHAR_CAP) + "…[truncated]";
  }
  try {
    return JSON.parse(json, nativeTypeReviver);
  } catch {
    // e.g. a FunctionRef whose registry entry is gone — telemetry must
    // degrade, not throw.
    return "[unserializable]";
  }
}

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
      const outer = agencyStore.getStore();
      return agencyStore.run(
        {
          ctx: this.ctx,
          stack: this.stack,
          threads: this.threads,
          // Propagate the outer frame's `globals` so a Runner spun up
          // inside a fork branch sees the branch-local clone instead of
          // the canonical store. Fall back to `ctx.globals` for harness
          // entries that build a Runner outside any ALS frame (older
          // tests, direct invocation paths).
          globals: outer?.globals ?? this.ctx.globals,
          callsite: {
            moduleId: this.moduleId,
            scopeName: this.scopeName,
            stepPath: this.path.join("."),
          },
          runner: this,
        },
        fn,
      );
    }
    return fn();
  }

  /** Whether this runner is driving a graph-node body (vs. a function or
   *  resumable-scope body). TS helpers that need to produce the same halt
   *  payload shape as the codegen `interrupt` templates (`{messages, data}`
   *  in a node body, raw `data` in a function body) read this. Public to
   *  let `agency.interrupt` mirror the codegen branch without exposing
   *  the rest of Runner internals. */
  get isNodeContext(): boolean {
    return this.nodeContext;
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

  /** Pending match-expression exit: the matchId whose owning ifElse will clear
   *  this. Mirrors _break/_continue unwind. NEVER serialized (transient unwind
   *  state; interrupts cannot fire while skipping). Must never be set from a
   *  parallel/fork child — the lowering forbids returns across concurrency
   *  boundaries; this scalar would race. */
  private _matchExit: number | null = null;

  /** Signal the current loop to break after this iteration */
  breakLoop(): void {
    this._break = true;
  }

  /** Signal the current loop to continue to the next iteration */
  continueLoop(): void {
    this._continue = true;
  }

  /** Yield `value` from a match arm: store it as the match result and skip
   *  everything until the owning ifElse (matchId) consumes the flag. */
  exitMatch(matchId: number, value: unknown): void {
    this.frame.locals[matchValName(matchId)] = value;
    this._matchExit = matchId;
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
      // If the abort carries a guard trip that was ALREADY delivered via
      // the leaf-op path (an in-flight sleep/fetch aborted, then __tryCall
      // converted it to a Failure), the trip is handled. Do NOT re-throw
      // it here — this `shouldSkip` may be gating the guard's own
      // `_popGuard` cleanup step, and throwing would surface an unhandled
      // GuardExceededError for a trip the user already saw as a Failure.
      // Fall through so cleanup runs. See the abort-taxonomy spec.
      const cause = readCause(this.stack.abortSignal);
      if (cause?.kind === "guardTrip" && cause.delivered) {
        return (
          this.halted ||
          this._break ||
          this._continue ||
          this._matchExit !== null
        );
      }
      // THE shared trip walk (innermost-first, suspension-aware) — the
      // same one enforceGuards throws from. Routing through it matters:
      // a private loop here would call check() directly and miss the
      // stack's suspendedGuardIds consult, letting a suspended
      // over-budget CostGuard throw its trip out of the handler that
      // suspended it whenever the abort signal is live.
      const err = this.stack.detectTrippedGuard();
      if (err) throw err;
      const guardOwnsAbort = this.stack.guards.some((g) => g.isTripped());
      if (!guardOwnsAbort) {
        this.halt(undefined);
      }
    }
    return (
      this.halted || this._break || this._continue || this._matchExit !== null
    );
  }

  /** Step-boundary guard-trip raise (resumable-guards PR 3). The fast
   *  path is one sync array scan; the raise machinery only engages when
   *  an unsuspended, non-root guard is over budget and armed. NOT
   *  skipped inside tool-call windows (unlike the debugger hook): a
   *  trip mid-tool rides the same in-tool interrupt path as an input()
   *  inside a tool, and on approve the tool continues where it paused
   *  and its result reaches the thread normally — there is never a
   *  dangling tool_use, because the tool call completes on resume. */
  private async maybeRaiseGuardTrip(id: number): Promise<boolean> {
    if (!this.stack) return false;
    if (this.stack.firstRaisableTrip() === null) return false;
    const rt = agencyStore.getStore();
    return raiseGuardTripsAtStep({
      ctx: this.ctx,
      stack: this.stack,
      location: {
        moduleId: this.moduleId,
        scopeName: this.scopeName,
        stepPath: this.stepPath(id),
      },
      isNodeContext: this.isNodeContext,
      threads: rt?.threads,
      halt: (payload: unknown) => this.halt(payload),
    });
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
    // Shared with PromptRunner's tool-dispatch batches (see stateStack.ts).
    seedBranchCostImpl(branchStack, parentStack);
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
    // Shared with PromptRunner's tool-dispatch batches (see stateStack.ts).
    propagateBranchCostImpl(branches, parentStack);
  }

  // ── Core step method ──

  async step(
    id: number,
    callback: (runner: Runner) => Promise<void>,
  ): Promise<void> {
    this.beforeStep();
    // Guard-trip raise BEFORE shouldSkip: shouldSkip's guard walk both
    // CONSUMES a time trip's one-shot check latch and THROWS it — the
    // non-resumable path. Raising here first turns a detectable trip
    // into a question; approve re-arms and the step proceeds, reject
    // throws exactly what shouldSkip would have thrown, and an
    // unanswered trip halts with a checkpoint at THIS step — which is
    // replay-safe by construction, because on resume the same boundary
    // re-raises and applies the recorded answer before the body runs.
    if (await this.maybeRaiseGuardTrip(id)) return;
    if (this.shouldSkip()) return;
    if (this.getCounter() > id) return;

    if (await this.maybeDebugHook(id)) return;

    this.ctx.coverageCollector?.hit(this.moduleId, this.scopeName, this.stepPath(id));

    this.path.push(id);
    try {
      await this.runInScope(() => callback(this));
    } catch (e) {
      // `agency.interrupt()` (and any future TS-helper that mirrors the
      // codegen "halt + return" pattern) signals a halt by throwing
      // `HaltSignal` so the surrounding step body unwinds without
      // executing post-interrupt code. Absorb the signal here once the
      // runner is in the halted state; everything else (real errors,
      // RestoreSignal, etc.) propagates as usual.
      if (!(e instanceof HaltSignal && this.halted)) throw e;
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
    // Same raise point as step() — hook is the step-equivalent that
    // loop-body statements and function-start hooks execute through, so
    // a time trip during a tight loop is detected here.
    if (await this.maybeRaiseGuardTrip(id)) return;
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
    // Codegen emits opts as a thunk (`async () => (<opts>)`) so its value
    // expressions are evaluated ONLY after the halt/skip guards below. If a
    // preceding `return` halted the runner, the steps that assign the locals
    // those expressions reference are skipped, so evaluating them eagerly here
    // would dereference an unset local and throw. Evaluating lazily lets the
    // early return win. A bare object is still accepted for direct runtime
    // callers (tests); only a function means "thunk".
    optsArg:
      | ThreadStepOpts
      | (() => ThreadStepOpts | Promise<ThreadStepOpts>),
    callback: (runner: Runner) => Promise<void>,
  ): Promise<void> {
    // Single canonical signature; `prettyPrint.ts` always emits an
    // opts object (possibly empty) so there is no dual-form path to
    // support. Test harnesses pass `{}` explicitly when they don't
    // need named-args behaviour.
    this.beforeStep();
    if (this.shouldSkip()) return;
    if (this.getCounter() > id) return;

    if (await this.maybeDebugHook(id)) return;

    const opts = typeof optsArg === "function" ? await optsArg() : optsArg;

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

    // Guard thread creation/resumption so it only happens once. On
    // resume from a debug pause inside the callback, the entire
    // thread() method re-executes (the step counter only advances
    // after the callback completes). Without this guard, the side
    // effect (create/resumeExisting/openSession) would run again on
    // every resume, corrupting the registry.
    const threadKey = `__thread_${this.stepPath(id)}`;
    const resumptionKey = `__thread_resumed_${this.stepPath(id)}`;
    let tid: string;
    let isResumption = false;
    if (this.frame.locals[threadKey] !== undefined) {
      tid = this.frame.locals[threadKey];
      isResumption = this.frame.locals[resumptionKey] === true;
    } else {
      // Resolve the entry mode: continueId > session > default
      // create/createSubthread. continue + session are mutually
      // exclusive (rejected at parse time, but defended again here).
      if (opts.continueId !== undefined && opts.session !== undefined) {
        throw new Error(
          "thread() received both `continue` and `session` options; " +
            "they are mutually exclusive.",
        );
      }
      // Bundle the brand-new-create-path metadata so create() /
      // openSession() can apply it to the MessageThread AND forward
      // it to the threadCreated statelog event in one shot. Resumes
      // (continueId / existing session) bypass this — both are
      // decided at first-create time, not on every re-entry.
      const createMeta = {
        label: opts.label ?? null,
        hidden: opts.hidden === true,
      };
      if (opts.continueId !== undefined) {
        const rawId = stripSlug(opts.continueId);
        threads.resumeExisting(rawId);
        tid = rawId;
        isResumption = true;
      } else if (opts.session !== undefined && opts.session !== "") {
        // An empty session name means "no session": agents take a
        // `session: string = ""` parameter and pass it straight through, so
        // the default must yield a fresh isolated thread, not a real session
        // literally named "" that every such caller would share.
        const { id: openedId, existed } = threads.openSession(opts.session, createMeta);
        tid = openedId;
        isResumption = existed;
      } else if (method === "createSubthread") {
        tid = threads.createSubthread(createMeta);
      } else {
        tid = threads.create(createMeta);
      }
      if (isResumption) {
        // Reopened threads are repaired before new work lands; a
        // checkpoint resume never reaches this branch (the frame-locals
        // guard above skips the whole open side effect). The full safety
        // argument lives on repairReopenedThread.
        //
        // The createSubthread branch below needs no repair even though it
        // clones the parent's messages: a dangling tail only ever exists
        // on a thread whose turn parked and bailed out of the whole run,
        // so no code is left executing that could take a subthread off it
        // — and a later run must reopen the parent (through this branch)
        // before it can be active again.
        repairReopenedThread(threads.get(tid), this.ctx.statelogClient, tid);
      }
      this.frame.locals[threadKey] = tid;
      this.frame.locals[resumptionKey] = isResumption;
    }
    // For `continueId` / `session`, openSession / resumeExisting
    // already push the active stack. Avoid a double-push.
    const alreadyActive = threads.activeId() === tid;
    if (!alreadyActive) {
      threads.pushActive(tid);
    }

    // Fire onThreadStart. Slug the id for the public payload.
    const slug = `t${tid}`;
    const threadType: "thread" | "subthread" =
      method === "createSubthread" ? "subthread" : "thread";
    // Prefer the persisted label on the MessageThread so resumed
    // threads (continue/session) emit the original label even when
    // the resumption call site omits it. Fall back to opts.label
    // for fresh threads where MessageThread.label is still null.
    const startedThread = threads.get(tid);
    const parentRaw = startedThread?.parentId ?? undefined;
    const startedLabel = startedThread?.label ?? opts.label;
    await invokeCallbacks({
      ctx: this.ctx,
      name: "onThreadStart",
      data: {
        threadId: slug,
        threadType: parentRaw ? "subthread" : threadType,
        parentThreadId: parentRaw ? `t${parentRaw}` : undefined,
        label: startedLabel ?? undefined,
        isResumption,
      },
    });

    this.path.push(id);
    try {
      await this.runInScope(() => callback(this));
    } finally {
      this.path.pop();
      // Snapshot messages BEFORE popping the active stack so the
      // onThreadEnd payload sees the just-closed thread's final
      // message list. Use the active id (which is `tid`) to look it
      // up regardless of double-push avoidance.
      const closingThread = threads.get(tid);
      const messagesSnapshot = closingThread
        ? closingThread.messages.map((m) => m.toJSON())
        : [];
      // Always pop one entry: when we pushed above, this balances
      // that push; when openSession/resumeExisting pushed (so we
      // didn't double-push), this pops the resumed entry the user
      // is "closing".
      threads.popActive();
      // Fire onThreadEnd so the registry stdlib hook sees the
      // close. We fire from `finally` so exceptions thrown inside
      // the body still record a close event.
      await withThreadEndHooksEvents(
        this.ctx.statelogClient,
        {
          threadId: slug,
          eagerSummarize: opts.summarize === true,
          messageCount: messagesSnapshot.length,
        },
        async () => {
          try {
            await invokeCallbacks({
              ctx: this.ctx,
              name: "onThreadEnd",
              data: {
                threadId: slug,
                // Prefer persisted label so resumed threads emit the
                // original label even when the resumption call site
                // omits it (mirrors onThreadStart above).
                label: closingThread?.label ?? opts.label ?? undefined,
                eagerSummarize: opts.summarize === true,
                messages: messagesSnapshot,
              },
            });
          } catch (e) {
            // Swallow hook errors in finally to avoid masking the
            // primary exception. `fireWithGuard` inside invokeCallbacks
            // already logs JS errors; this catch is belt-and-braces for
            // unexpected throws from the dispatcher itself.
            if (e instanceof RestoreSignal) throw e;
            // Surface the failure as a structured statelog event so it
            // shows up in traces (replaces the prior bare console.error).
            // Optional chaining: older test contexts may construct a
            // statelogClient without the threadEndHookError method.
            this.ctx.statelogClient?.threadEndHookError?.({
              threadId: slug,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        },
      );
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
    // A COMPLETED handle block returns here, before pushHandler — its
    // scope is over and its handler stays gone on replay. This line is
    // also why the guard-set memo below cannot be keyed by counting
    // registrations: replay skips completed registrations, so a counter
    // counts different events than the original run did. Keys must be
    // POSITION (stepPath, here) or content — never an event count.
    if (this.getCounter() > id) return;

    if (await this.maybeDebugHook(id)) return;

    this.ctx.coverageCollector?.hit(this.moduleId, this.scopeName, this.stepPath(id));

    // Which guards were live when this handler registered? Decides the
    // handler's budget scoping (HandlerEntry.liveGuardIds). Memoized
    // FIRST-WRITE-WINS in the registering frame's locals: on resume,
    // stack.guards is restored from JSON BEFORE this replayed
    // registration runs, so a fresh capture here would see guards that
    // did not exist at the original registration — including a guard
    // whose trip this handler is supposed to adjudicate. The memo makes
    // the original capture the durable one. Keyed by stepPath (position)
    // per the note above; stored per-frame so recursive activations of
    // the same handle block each get their own entry; DELETED on pop so
    // a loop's next iteration (same stepPath, new guards) writes fresh.
    const memoKey = `__handlerGuards_${this.stepPath(id)}`;
    let liveGuardIds = this.frame.locals[memoKey] as string[] | undefined;
    if (liveGuardIds === undefined) {
      liveGuardIds = this.stack ? this.stack.guards.map((g) => g.guardId) : [];
      this.frame.locals[memoKey] = liveGuardIds;
    }

    this.ctx.pushHandler(handlerFn, liveGuardIds);
    this.path.push(id);
    try {
      await this.runInScope(() => callback(this));
    } finally {
      this.path.pop();
      this.ctx.popHandler();
      delete this.frame.locals[memoKey];
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
    // When this ifElse is the lowered form of a match expression, `matchId`
    // is the id it OWNS: a pending `_matchExit === matchId` unwind is consumed
    // (cleared) here in the finally so post-match code resumes. An ifElse that
    // does not own the pending id leaves the flag set (propagation continues).
    opts?: { matchId?: number },
  ): Promise<void> {
    // The top skip stays OUTSIDE the try: when we skip here an OUTER construct
    // owns the pending flag, so we must not clear it.
    if (this.shouldSkip()) return;
    try {
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
    } finally {
      // The owning ifElse consumes the pending match exit — even when the
      // branch body threw — so subsequent steps resume normally.
      if (opts?.matchId !== undefined && this._matchExit === opts.matchId) {
        this._matchExit = null;
      }
    }
  }

  // ── Specialized: loop (for) ──

  async loop(
    id: number,
    // The iterable is a thunk (codegen emits `async () => <expr>`) so its
    // expression is evaluated ONLY after the halt/skip guards below. If a
    // preceding `return` halted the runner, the steps that would assign the
    // iterable's backing locals are skipped, so eagerly evaluating the
    // expression here would dereference an unset local and throw. Evaluating
    // lazily lets the early return win. A bare value is still accepted for
    // direct runtime callers (tests); only a function means "thunk", since an
    // iterable can never legitimately be a function.
    items:
      | any[]
      | Record<string, any>
      | (() => any[] | Record<string, any> | Promise<any[] | Record<string, any>>),
    // Second arg is the numeric index for arrays, or the value for records.
    callback: (item: any, second: any, runner: Runner) => Promise<void>,
  ): Promise<void> {
    if (this.shouldSkip()) return;
    if (this.getCounter() > id) return;

    if (await this.maybeDebugHook(id)) return;

    this.ctx.coverageCollector?.hit(this.moduleId, this.scopeName, this.stepPath(id));

    const items_ = typeof items === "function" ? await items() : items;

    const iterKey =
      this.path.length === 0
        ? `__iteration_${id}`
        : `__iteration_${this.key()}.${id}`;

    this.frame.locals[iterKey] = this.frame.locals[iterKey] ?? 0;

    // Records iterate by key, arrays by element, everything else is empty.
    // The CLASSIFICATION is shared with `_pairsOf` so comprehensions and
    // `for` loops cannot disagree about what is iterable
    // (utils/iteration.ts). The iteration itself stays exactly as it was:
    // for arrays `iterable` is the caller's own array, and the loop below
    // re-reads `.length` each step, so a body that appends to the array it
    // is iterating keeps going. Materializing a snapshot here would break
    // that (pinned by tests/agency/for-loop-live-iteration.agency).
    const shape = classifyIterable(items_);
    let iterable: any[];
    let isRecord = false;
    if (shape.kind === "array") {
      iterable = items_ as any[];
    } else if (shape.kind === "record") {
      iterable = shape.keys;
      isRecord = true;
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
        // `for (item, second in x)`: for arrays the second variable is the
        // numeric index; for records it is the value at the current key. The
        // first callback arg is the element (array) or the key (record).
        const item = iterable[i];
        const second = isRecord ? (items_ as Record<string, any>)[item] : i;
        await this.runInScope(() => callback(item, second, this));
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
      // A pending match exit unwinds through the loop. Do NOT clear it here —
      // only the owning ifElse consumes it (a following step stays skipped).
      if (this._matchExit !== null) break;
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
      // A pending match exit unwinds through the loop. Do NOT clear it here —
      // only the owning ifElse consumes it (a following step stays skipped).
      if (this._matchExit !== null) break;
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
    // When `true`, branches pointer-share the parent's `GlobalStore`
    // (opted into by user syntax like `fork(items, shared: true)`).
    // The active-thread pointer is ALWAYS branch-local regardless of
    // `shared` — concurrent push/pop on a shared activeStack would
    // corrupt the conversation. When `false` (the default), each
    // branch also gets its own clone of the parent's `GlobalStore`.
    // Threads-registry and sessions stay shared in either mode —
    // `thread(continue: id)` / `thread(session: ...)` keep working.
    // Forwarded to `runBatch` as `shareGlobals: shared`.
    shared: boolean = false,
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
        result = await this.runForkAll(id, items, blockFn, stateStack, forkId, shared);
        if (hasInterrupts(result)) return result;
      } else {
        result = await this.runRace(id, items, blockFn, stateStack, forkId, shared);
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
    shared: boolean,
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
      // `shared: true` at the user-facing fork/parallel/race site
      // opts into pointer-sharing the parent's `GlobalStore` with
      // each branch (writes accumulate). Threads stay branch-local
      // regardless — concurrent push/pop on a shared activeStack
      // would corrupt the conversation. Default is fully isolated.
      shareGlobals: shared,
      children: items.map((item, i) => ({
        key: this.forkBranchKey(id, i),
        invoke: (branchStack) => blockFn(item, i, branchStack),
      })),
      hooks: {
        seedBranchCost: (childStack, parentStack) =>
          this.seedBranchCost(childStack, parentStack),
        propagateBranchCost: (branches, parentStack) =>
          this.propagateBranchCost(branches, parentStack),
        onBranchEnd: (_key, branchIndex, outcome, timeTaken, value) => {
          this.ctx.statelogClient.forkBranchEnd({
            forkId,
            branchIndex,
            outcome,
            timeTaken,
            value: safeStatelogValue(value),
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
    shared: boolean,
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
      // `shared: true` at the user-facing fork/parallel/race site
      // opts into pointer-sharing the parent's `GlobalStore` with
      // each branch (writes accumulate). Threads stay branch-local
      // regardless — concurrent push/pop on a shared activeStack
      // would corrupt the conversation. Default is fully isolated.
      shareGlobals: shared,
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
        onBranchEnd: (_key, branchIndex, outcome, timeTaken, value) => {
          this.ctx.statelogClient.forkBranchEnd({
            forkId,
            branchIndex,
            outcome,
            timeTaken,
            value: safeStatelogValue(value),
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
