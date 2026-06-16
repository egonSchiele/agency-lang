import { nanoid } from "nanoid";
import { SmolConfig } from "smoltalk";
import type { DebuggerState } from "../../debugger/debuggerState.js";
import type { LogLevel } from "../../logger.js";
import { SimpleMachine } from "../../simplemachine/index.js";
import { StatelogClient, StatelogConfig } from "../../statelogClient.js";
import { nativeTypeReplacer, nativeTypeReviver } from "../revivers/index.js";
import { CoverageCollector } from "../coverageCollector.js";
import { AgencyCancelledError } from "../errors.js";
import { agencyStore } from "../asyncContext.js";
import type { AgencyCallbacks } from "../hooks.js";
import type { InterruptResponse } from "../interrupts.js";
import { LLMClient, SmoltalkClient } from "../llmClient.js";
import { MemoryManager } from "../memory/manager.js";
import { MemoryFrame } from "../memory/frame.js";
import { getOrCreateStore } from "../memory/registry.js";
import type { MemoryConfig } from "../memory/types.js";
import { GlobalStore } from "../state/globalStore.js";
import { StateStack } from "../state/stateStack.js";
import { TraceWriter } from "../trace/traceWriter.js";
import type { TraceConfig } from "../trace/types.js";
import type { HandlerFn } from "../types.js";
import { applyRuntimeConfigOverridesToContextArgs } from "../configOverrides.js";
import type { Checkpoint } from "./checkpointStore.js";
import { CheckpointStore, RESULT_ENTRY_LABEL } from "./checkpointStore.js";
import { PendingPromiseStore } from "./pendingPromiseStore.js";

/**
 * Process-wide singleton CoverageCollector used when AGENCY_COVERAGE is set.
 * One collector per process — multiple RuntimeContext instances created within
 * the same process all share it, and a single `process.on("exit")` listener
 * writes the merged data once. AGENCY_COVERAGE_OUTDIR is set by the CLI from
 * agency.json's coverage.outDir; defaults to ".coverage" otherwise.
 */
let _processCoverageCollector: CoverageCollector | null = null;
function getProcessCoverageCollector(): CoverageCollector {
  if (_processCoverageCollector) return _processCoverageCollector;
  const collector = new CoverageCollector();
  _processCoverageCollector = collector;
  const outDir = process.env.AGENCY_COVERAGE_OUTDIR ?? ".coverage";
  process.on("exit", () => {
    // process.on("exit") handlers are sync-only and any throw is unhelpful at
    // shutdown — log a warning and move on so coverage failures never make
    // test runs flaky or noisy.
    try {
      collector.write(outDir);
    } catch (err) {
      console.warn(
        `[coverage] failed to write to ${outDir}: ${(err as Error).message}`,
      );
    }
  });
  return collector;
}

/**
 * Round-trip `data` through JSON using the native-type replacer/reviver pair
 * so Sets/Maps/Dates/etc. inside a checkpoint payload come back as their
 * real classes instead of plain `{}` / `[]`.
 */
function reviveNative<T>(data: T): T {
  return JSON.parse(
    JSON.stringify(data, nativeTypeReplacer),
    nativeTypeReviver,
  );
}

/* bunch of stuff that every node/function in the runtime needs access to,
that we don't want to pass as individual arguments everywhere */
export class RuntimeContext<T> {
  // this is the part of the runtime context that gets
  // serialized/deserialized to support durable execution
  stateStack: StateStack;
  globals: GlobalStore;
  checkpoints: CheckpointStore;
  callbacks: AgencyCallbacks;
  onStreamLock: boolean;
  handlers: HandlerFn[];
  locks: Record<string, Promise<void>>;
  lockOwners: Record<string, string>;
  lockWaiters: Record<string, string[]>;
  lockReleasers: Record<string, () => void>;
  pendingPromises: PendingPromiseStore;
  graph: SimpleMachine<T>;
  _skipNextCheckpoint: boolean;
  _pendingArgOverrides?: Record<string, any>;
  _restoreCount: number;

  /* Here is why this is needed: When you're stepping through the code,
  every step emits a checkpoint and halts execution. When you execute an
  LLM call that then calls a tool, that tool will also emit a checkpoint
  and halt execution. At that point, that interrupt is going to bubble up
  to run prompt, and it's going to look like the tool call threw an
  interrupt, and then everything's going to get messed up from there.
  Longer term, it would be great for the debugger to show what's happening
  as the tool call is getting executed, but for now, we just use this flag
  so that if we're inside a tool call, we don't halt execution and we don't
  emit a checkpoint.*/
  _toolCallDepth: number;
  /** Nested-dispatch depth counter for `runHandlerChain` (lib/runtime/interrupts.ts).
   *  Incremented on entry to each handler-chain dispatch, decremented in its
   *  `finally`. The dispatcher throws a `HandlerRecursionError` when this counter
   *  exceeds `MAX_HANDLER_CHAIN_DEPTH` — that means a handler raised an interrupt
   *  whose dispatch re-entered the same chain too many times, almost always a
   *  handler accidentally re-invoking itself (see the recursion case debugged in
   *  https://ampcode.com/threads/T-019e7a80-0a51-75ce-840e-89b5f595da5c).
   *
   *  This is NOT the length of `ctx.handlers`. It only grows when a handler's body
   *  triggers another interrupt while the outer dispatch is still in flight. Normal
   *  push/pop of handlers via `with approve` does not increment it. */
  _handlerChainDepth: number;
  debuggerState: DebuggerState | null;
  private traceWriter: TraceWriter | null;

  // we need a single statelog client instance that can be used across the entire execution of the graph,
  // so that all the logs share the same traceId, so they all show up in the same trace in the Statelog dashboard.
  statelogClient: StatelogClient;
  smoltalkDefaults: Partial<SmolConfig>;
  /** Max characters of a single tool result fed back to the LLM (the
   *  full result is still returned to Agency code). `undefined` falls
   *  back to the runtime default in `runPrompt`. Baked in from
   *  `agency.json` `client.maxToolResultChars` at compile time. */
  maxToolResultChars?: number;
  private _llmClient: LLMClient;
  private _interruptResponses: Record<string, { response: InterruptResponse }> = {};

  get llmClient(): LLMClient { return this._llmClient; }
  setLLMClient(client: LLMClient): void { this._llmClient = client; }

  setInterruptResponses(responses: Record<string, { response: InterruptResponse }>): void {
    this._interruptResponses = responses;
  }

  getInterruptResponse(interruptId: string): InterruptResponse | undefined {
    return this._interruptResponses[interruptId]?.response;
  }

  // this is the directory that the runtime is running in. We need this to be able to read files relative to the runtime.
  dirname: string;

  /** Callbacks registered at module top-level (via `_callback` during
   *  `__initializeGlobals`, when no real caller frame exists yet). Persist for
   *  the whole run. */
  topLevelCallbacks: Array<{ name: string; fn: any }> = [];

  abortController: AbortController;

  traceConfig: TraceConfig;
  runId: string | null;
  verbose: boolean;
  /**
   * Log threshold used by ad-hoc subsystem loggers (memory, etc.).
   * Plumbed in from `AgencyConfig.logLevel` so users can crank it up to
   * `"debug"` when investigating issues without recompiling. The logger
   * itself is stateless — consumers call `createLogger(execCtx.logLevel)`
   * on demand rather than carrying a long-lived Logger instance, which
   * lets each subsystem add its own prefix without coordinating an
   * instance pool.
   */
  logLevel: LogLevel;
  getStaticVars?: () => Record<string, unknown>;
  coverageCollector: CoverageCollector | null = null;

  // stored so createExecutionContext can create new StatelogClients
  private statelogConfig: StatelogConfig;
  maxRestores: number;

  // Memory layer (resolved decisions in
  // docs/superpowers/plans/2026-05-12-memory-layer.md and
  // docs/superpowers/plans/2026-05-29-memory-config-in-code.md).
  //
  // `jsonMemoryConfig` is the immutable seed from `agency.json`'s
  // `memory:` block. Each execCtx pushes it as the bottom frame on
  // its stateStack at construction so the active config is always
  // "top of stack or nothing." Code calls to `enableMemory(...)`
  // push additional frames on top. The "code wins over JSON" rule
  // is structural, not coded.
  //
  // Per-execCtx managers are cached by `configKey` so we don't
  // rebuild a heavy MemoryManager every time stdlib code looks up
  // the active manager. Cache lives on each execCtx (not on this
  // parent context) because manager construction takes the
  // execCtx's own statelog client / log level / llm client.
  jsonMemoryConfig?: MemoryConfig;
  private memoryManagerCache: Record<string, MemoryManager> = {};

  constructor(args: {
    statelogConfig: StatelogConfig;
    smoltalkDefaults: Partial<SmolConfig>;
    maxToolResultChars?: number;
    dirname: string;
    maxRestores?: number;
    traceConfig?: TraceConfig;
    verbose?: boolean;
    memory?: MemoryConfig;
    /** Threshold for ad-hoc subsystem loggers. Optional so existing
     *  test/runtime constructors keep working; defaults to "info" to
     *  match the established no-debug-by-default behavior. */
    logLevel?: LogLevel;
  }) {
    args = applyRuntimeConfigOverridesToContextArgs(args);
    const statelogConfig = {
      ...args.statelogConfig,
      traceId: args.statelogConfig.traceId || nanoid(),
    };

    this.statelogConfig = statelogConfig;
    this.maxRestores = args.maxRestores ?? 100;
    this.statelogClient = new StatelogClient(statelogConfig);
    this.stateStack = new StateStack();
    this.globals = GlobalStore.withTokenStats();
    this.checkpoints = new CheckpointStore(this.maxRestores);
    this.handlers = [];
    this.callbacks = {};
    this.onStreamLock = false;
    this.locks = {};
    this.lockOwners = {};
    this.lockWaiters = {};
    this.lockReleasers = {};
    // After a debugger rewind, the first debug step would write a duplicate
    // checkpoint to the trace (the user already saw the rewound checkpoint).
    // rewindFrom sets this flag so the first debugStep trace-write is skipped.
    this._skipNextCheckpoint = false;
    this._restoreCount = 0;
    this._toolCallDepth = 0;
    this._handlerChainDepth = 0;
    this.pendingPromises = new PendingPromiseStore();
    this.debuggerState = null;
    this.traceWriter = null;
    this.traceConfig = args.traceConfig || {};
    this.runId = null;
    this.verbose = args.verbose ?? false;
    this.logLevel = args.logLevel ?? "info";
    this.dirname = args.dirname;

    const graphConfig = {
      debug: {
        log: false,
        logData: false,
      },
      statelog: statelogConfig,
    };
    this.graph = new SimpleMachine<T>(graphConfig);

    this.smoltalkDefaults = args.smoltalkDefaults;
    this.maxToolResultChars = args.maxToolResultChars;
    this._llmClient = new SmoltalkClient();
    this.abortController = new AbortController();

    if (process.env.AGENCY_COVERAGE) {
      this.coverageCollector = getProcessCoverageCollector();
    }

    // JSON-derived memory config is kept as an immutable seed; the
    // actual store + manager are looked up lazily through
    // `getActiveMemoryManager()` on each execCtx so there's a single
    // source of truth (the active stateStack's frame stack).
    if (args.memory) {
      this.jsonMemoryConfig = args.memory;
    }
  }

  getRunId(): string {
    if (!this.runId) {
      throw new Error("runId not set on RuntimeContext");
    }
    return this.runId;
  }

  async createExecutionContext(runId: string): Promise<RuntimeContext<T>> {
    const execCtx = Object.create(
      RuntimeContext.prototype,
    ) as RuntimeContext<T>;
    execCtx.graph = this.graph;
    execCtx.smoltalkDefaults = this.smoltalkDefaults;
    execCtx.maxToolResultChars = this.maxToolResultChars;
    execCtx._llmClient = this._llmClient;
    execCtx.dirname = this.dirname;
    execCtx.statelogConfig = this.statelogConfig;
    execCtx.stateStack = new StateStack();
    execCtx.globals = GlobalStore.withTokenStats();
    execCtx.maxRestores = this.maxRestores;
    execCtx.checkpoints = new CheckpointStore(this.maxRestores);
    execCtx.handlers = [];
    execCtx.callbacks = {};
    execCtx.topLevelCallbacks = [];
    execCtx.onStreamLock = false;
    execCtx.locks = {};
    execCtx.lockOwners = {};
    execCtx.lockWaiters = {};
    execCtx.lockReleasers = {};
    execCtx._skipNextCheckpoint = false;
    execCtx._restoreCount = 0;
    execCtx._toolCallDepth = 0;
    execCtx._handlerChainDepth = 0;
    execCtx._interruptResponses = {};
    execCtx.debuggerState = this.debuggerState;
    execCtx.traceWriter = await TraceWriter.create({
      runId,
      traceConfig: this.traceConfig,
    });
    execCtx.traceConfig = this.traceConfig;
    execCtx.runId = runId;
    execCtx.verbose = this.verbose;
    execCtx.logLevel = this.logLevel;
    execCtx.pendingPromises = new PendingPromiseStore();
    execCtx.abortController = new AbortController();
    execCtx.statelogClient = new StatelogClient({
      ...this.statelogConfig,
      traceId: runId,
    });
    execCtx.coverageCollector = this.coverageCollector;

    // Memory layer: per-execCtx state.
    //   - jsonMemoryConfig is forwarded so `getActiveMemoryManager()`
    //     can re-seed the bottom frame on resumes from old
    //     checkpoints that pre-date frames-on-stateStack.
    //   - memoryManagerCache is per-execCtx (statelog client, llm
    //     client, log level are all per-execCtx).
    //   - JSON config seeds the BOTTOM frame on the new stateStack;
    //     after this point the active stack is the only source of
    //     truth. Code-level `enableMemory(...)` pushes on top.
    execCtx.jsonMemoryConfig = this.jsonMemoryConfig;
    execCtx.memoryManagerCache = {};
    if (this.jsonMemoryConfig) {
      execCtx.stateStack.pushMemoryFrame(new MemoryFrame(this.jsonMemoryConfig));
    }

    return execCtx;
  }

  /**
   * Resolve the active `MemoryManager` for the current stateStack.
   *
   * Single rule: top of `stateStack.other.memoryFrames` (accessed via
   * `activeMemoryFrame()`) wins. No fallback to a "default" manager —
   * the JSON config gets seeded as the bottom frame at execCtx
   * creation, so if JSON was set there will always be a frame and
   * this never returns `undefined` for JSON-only setups.
   *
   * The one back-compat seam: a checkpoint written before
   * `memoryFrames` existed (or one taken right after a user called
   * `disableMemory()` on the JSON-seeded bottom frame) has no frames.
   * If `jsonMemoryConfig` is set we re-seed it as a courtesy so old
   * traces resume as before. If the user explicitly popped, they
   * call `enableMemory(...)` again to turn it back on.
   *
   * Managers are cached per execCtx keyed by `configKey` so
   * push/pop/push of the same dir reuses one instance — important
   * for the "pop back to A returns A's manager" semantics.
   */
  getActiveMemoryManager(): MemoryManager | undefined {
    // Resolve memory against the ACTIVE branch stack, not the top-level
    // `this.stateStack`. Inside a fork/race/tool branch the active stack
    // is that branch's own slice (seeded from the parent at fork time via
    // `inheritMemoryFrom`), so `enableMemory`/`setMemoryId` inside a branch
    // are visible to that branch and don't leak to siblings/parent. At the
    // top level (and outside any ALS frame) this is `this.stateStack`.
    const stack = agencyStore.getStore()?.stack ?? this.stateStack;
    if (!stack) return undefined;
    let frame = stack.activeMemoryFrame();
    if (!frame && this.jsonMemoryConfig && !stack.hasMemoryFrameStack()) {
      // Old-checkpoint back-compat: stateStack restored from a
      // pre-memoryFrames snapshot (the array key isn't present at
      // all). Re-seed the JSON bottom frame so resume behaves like
      // a fresh run. An empty-array stack (user explicitly called
      // `disableMemory()`) is NOT re-seeded — that would silently
      // resurrect what the user asked to turn off.
      stack.pushMemoryFrame(new MemoryFrame(this.jsonMemoryConfig));
      frame = stack.activeMemoryFrame();
    }
    if (!frame) return undefined;

    const cached = this.memoryManagerCache[frame.configKey];
    if (cached) return cached;

    const manager = new MemoryManager({
      store: getOrCreateStore(frame.configKey, this.logLevel),
      config: frame.config,
      llmClient: this._llmClient,
      smoltalkDefaults: this.smoltalkDefaults,
      source: this.traceConfig?.program ?? "agent",
      // Reuse the per-execCtx StatelogClient so memory's own LLM/embed
      // spans nest under the same trace as the agent's calls.
      statelogClient: this.statelogClient,
      // Threshold for memory's internal logger; promoting this to
      // "debug" in agency.json surfaces every tier/extract/compact
      // step on stderr.
      logLevel: this.logLevel,
      memoryIdRef: {
        // memoryId is orthogonal to which frame is active — it lives
        // on `<stack>.other.memoryId` and persists across frame
        // pushes/pops. Read the ACTIVE branch stack dynamically on each
        // access (not a captured one): this manager is cached per
        // configKey and shared across concurrent branches, so each
        // branch's get/set must resolve to ITS own stack. Falls back to
        // `this.stateStack` outside any ALS frame.
        get: () => {
          const s = agencyStore.getStore()?.stack ?? this.stateStack;
          const id = s?.other?.memoryId;
          return typeof id === "string" ? id : "default";
        },
        set: (id: string) => {
          const s = agencyStore.getStore()?.stack ?? this.stateStack;
          if (!s) return;
          s.other.memoryId = id;
        },
      },
    });
    this.memoryManagerCache[frame.configKey] = manager;
    return manager;
  }

  /** Iterate every cached memory manager. Used at shutdown so a
   *  branch that opened a side store doesn't lose its writes. */
  getAllCachedMemoryManagers(): MemoryManager[] {
    return Object.values(this.memoryManagerCache);
  }

  /* Let's chat through what's going on here. Because since this function
  is called "fork"Stack, you may think that it clone the current stateStack.
  And that's exactly what I had earlier:

  ```
  return StateStack.fromJSON(this.stateStack.toJSON());
  ```

  This function was created for asynchronous threads, so we could keep track
  of their state. But the way we store the state is for each async thread,
  in branches. It's execution starts at the point it is defined. It doesn't
  have any previous state it's not going to wind up to back to a point *before*
  it was defined.
  Another way to think about it: Suppose node main, calls function foo,
  calls function A, which creates an async thread function A1, and A1 throws an interrupt:

  ```
    main -> foo -> A -> A1 (async thread) -> interrupt
  ```

  When we resume from the interrupt, we deserialize up to A1 using A's state stack.
  And from that point, we deserialize A1 using A1's state stack. So A1's state stack
  should *only* contain the state created after the A1 thread was initialized.
  Otherwise, there will be a bunch of extra frames on the state stack related
  to calling through our A1, which will be a mismatch.

  I'm still leaving this function because I think its name helps explain what
  is happening, and also because it's easier to find the code that creates these
  async threads. But we could just replace all calls to `forkStack`
  with `new StateStack()`.
  */
  pushHandler(fn: HandlerFn): void {
    this.handlers.push(fn);
  }
  popHandler(): void {
    this.handlers.pop();
  }

  enterToolCall(): void {
    this._toolCallDepth++;
  }

  exitToolCall(): void {
    if (this._toolCallDepth > 0) this._toolCallDepth--;
  }

  isInsideToolCall(): boolean {
    return this._toolCallDepth > 0;
  }

  get aborted(): boolean {
    return this.abortController.signal.aborted;
  }

  /**
   * Branch-aware cancellation check. Returns true if either:
   *   - the global ctx is aborted (e.g., user pressed Ctrl-C), OR
   *   - the given branch stack's per-branch abort signal has fired (e.g.,
   *     this branch is a race loser).
   *
   * Pass the local stateStack at any call site that lives inside a fork/race
   * branch so the check sees that branch's signal. Without a stack arg, this
   * is equivalent to `ctx.aborted`.
   */
  isCancelled(stack?: StateStack): boolean {
    if (this.abortController.signal.aborted) return true;
    return !!stack?.abortSignal?.aborted;
  }

  /**
   * Branch-aware AbortSignal for HTTP/fetch/streaming calls. Returns a
   * composite signal that fires on either global ctx abort OR the given
   * branch stack's abort. Pass to smoltalk's `abortSignal` so per-branch
   * cancellation actually tears down in-flight network requests.
   *
   * If no stack is given (or the stack has no branch signal), returns the
   * global ctx signal — same behavior as before.
   */
  getAbortSignal(stack?: StateStack): AbortSignal {
    if (!stack?.abortSignal) return this.abortController.signal;
    return AbortSignal.any([this.abortController.signal, stack.abortSignal]);
  }

  cancel(reason?: string): void {
    if (!this.abortController.signal.aborted) {
      this.abortController.abort(new AgencyCancelledError(reason));
    }
  }

  forkStack(): StateStack {
    return new StateStack();
  }

  /** Sever references held by an execution context so GC can reclaim them. */
  cleanup(): void {
    if (!this.abortController.signal.aborted) {
      this.abortController.abort(new AgencyCancelledError("cleanup"));
    }
    this.pendingPromises.clear();
    this.stateStack = null as any;
    this.globals = null as any;
    this.checkpoints = null as any;
    this.statelogClient = null as any;
    this.callbacks = null as any;
    this.handlers = null as any;
    this.traceWriter = null;
    this.memoryManagerCache = {};
  }

  /** Get the most recent result-entry checkpoint for the current function. */
  getResultCheckpoint(): Checkpoint | undefined {
    const sorted = this.checkpoints.getSorted();
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (sorted[i].pinned && sorted[i].label === RESULT_ENTRY_LABEL) {
        return sorted[i];
      }
    }
    return undefined;
  }

  restoreState(checkpoint: Checkpoint): void {
    const currentTokenStats = this.globals.getTokenStats();

    const stack = reviveNative(checkpoint.stack);
    const globals = reviveNative(checkpoint.globals);

    this.stateStack = StateStack.fromJSON(stack);
    this.stateStack.deserializeMode();

    this.globals = GlobalStore.fromJSON(globals);
    this.globals.restoreTokenStats(currentTokenStats);
    this.pendingPromises.clear();
  }

  /** @deprecated Use checkpoints.create() instead */
  stateToJSON() {
    return {
      stack: this.stateStack.toJSON(),
      globals: this.globals.toJSON(),
    };
  }

  toJSON() {
    return {
      stateStack: this.stateStack.toJSON(),
      callbacks: Object.keys(this.callbacks),
      onStreamLock: this.onStreamLock,
      graph: this.graph.toJSON(),
      statelogClient: "redacted",
      smoltalkDefaults: "redacted",
      dirname: this.dirname,
    };
  }
  /* Get smoltalk config with missing keys populated with defaults */
  getSmoltalkConfig(
    config: Partial<SmolConfig> = {},
  ): Partial<SmolConfig> {
    return { ...this.smoltalkDefaults, ...config };
  }

  async pauseTraceWriter(): Promise<void> {
    if (!this.traceWriter) {
      //throw new Error("No trace writer to pause");
    }
    await this.traceWriter?.pause();
    this.traceWriter = null;
  }

  async closeTraceWriter(): Promise<void> {
    if (!this.traceWriter) {
      //throw new Error("No trace writer to close");
    }
    await this.traceWriter?.close();
    this.traceWriter = null;
  }

  async writeCheckpointToTraceWriter(checkpoint: Checkpoint): Promise<void> {
    if (!this.traceWriter) {
      return;
    }
    await this.traceWriter.writeCheckpoint(checkpoint);
  }

  async writeStaticStateToTrace(values: Record<string, unknown>): Promise<void> {
    if (!this.traceWriter) {
      return;
    }
    await this.traceWriter.writeStaticState(values);
  }

  hasDebugger(): boolean {
    return this.debuggerState !== null;
  }

  hasTraceWriter(): boolean {
    return this.traceWriter !== null;
  }

}
