import { StateStack } from "../state/stateStack.js";
import { GlobalStore } from "../state/globalStore.js";
import { PendingPromiseStore } from "./pendingPromiseStore.js";
import { CheckpointStore, RESULT_ENTRY_LABEL } from "./checkpointStore.js";
import type { Checkpoint } from "./checkpointStore.js";
import { StatelogClient, StatelogConfig } from "../../statelogClient.js";
import { SimpleMachine } from "../../simplemachine/index.js";
import { nanoid } from "nanoid";
import { SmolPromptConfig } from "smoltalk";
import { callHook } from "../hooks.js";
import type { AgencyCallbacks } from "../hooks.js";
import { AgencyFunction } from "../agencyFunction.js";
import type { HandlerFn } from "../types.js";
import type { DebuggerState } from "../../debugger/debuggerState.js";
import { TraceWriter } from "../trace/traceWriter.js";
import type { TraceConfig } from "../trace/types.js";
import { reviveWithClasses, type ClassRegistry } from "../classReviver.js";
import { AgencyCancelledError } from "../errors.js";
import { McpManager } from "../mcp/mcpManager.js";

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
  debuggerState: DebuggerState | null;
  private traceWriter: TraceWriter | null;

  // we need a single statelog client instance that can be used across the entire execution of the graph,
  // so that all the logs share the same traceId, so they all show up in the same trace in the Statelog dashboard.
  statelogClient: StatelogClient;
  smoltalkDefaults: Partial<SmolPromptConfig>;

  // this is the directory that the runtime is running in. We need this to be able to read files relative to the runtime.
  dirname: string;

  // Callback functions registered via the `callback` keyword in Agency code.
  // Stored separately from `callbacks` so that runNode can wrap them with the
  // current execution context. We can't register them directly on `callbacks`
  // because they need access to the per-execution ctx (for globals, state stack,
  // etc.), but at registration time only __globalCtx exists. External TypeScript
  // callers pass callbacks via runNode's `callbacks` option and should NOT receive
  // the execution context — wrapping at execution time keeps that boundary clean.
  _registeredCallbacks: Partial<
    Record<keyof AgencyCallbacks, (...args: any[]) => any>
  > = {};

  // class registry for serialization/deserialization of Agency class instances
  classRegistry: ClassRegistry = {};

  abortController: AbortController;
  private _mcpManager: McpManager;

  traceConfig: TraceConfig;
  runId: string | null;

  // stored so createExecutionContext can create new StatelogClients
  private statelogConfig: StatelogConfig;
  maxRestores: number;

  constructor(args: {
    statelogConfig: StatelogConfig;
    smoltalkDefaults: Partial<SmolPromptConfig>;
    dirname: string;
    maxRestores?: number;
    traceConfig?: TraceConfig;
  }) {
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
    // When rewinding, the checkpoint lives in a sentinel step right after the LLM call.
    // On restore, the sentinel re-runs and would emit a duplicate checkpoint.
    // rewindFrom sets this flag so the first sentinel skips, then clears it.
    this._skipNextCheckpoint = false;
    this._restoreCount = 0;
    this._toolCallDepth = 0;
    this.pendingPromises = new PendingPromiseStore();
    this.debuggerState = null;
    this.traceWriter = null;
    this.traceConfig = args.traceConfig || {};
    this.runId = null;
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
    this.classRegistry = {};
    this.abortController = new AbortController();
    this._mcpManager = new McpManager({});
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
    execCtx.dirname = this.dirname;
    execCtx.statelogConfig = this.statelogConfig;
    execCtx.stateStack = new StateStack();
    execCtx.globals = GlobalStore.withTokenStats();
    execCtx.maxRestores = this.maxRestores;
    execCtx.checkpoints = new CheckpointStore(this.maxRestores);
    execCtx.handlers = [];
    execCtx.callbacks = {};
    execCtx._registeredCallbacks = {};
    execCtx.onStreamLock = false;
    execCtx._skipNextCheckpoint = false;
    execCtx._restoreCount = 0;
    execCtx._toolCallDepth = 0;
    execCtx.debuggerState = this.debuggerState;
    execCtx.traceWriter = await TraceWriter.create({
      runId,
      traceConfig: this.traceConfig,
    });
    execCtx.traceConfig = this.traceConfig;
    execCtx.runId = runId;
    execCtx.pendingPromises = new PendingPromiseStore();
    execCtx.classRegistry = this.classRegistry;
    execCtx.abortController = new AbortController();
    execCtx._mcpManager = this._mcpManager;
    execCtx.statelogClient = new StatelogClient({
      ...this.statelogConfig,
      traceId: runId,
    });
    return execCtx;
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
  /**
   * Install Agency-defined callbacks (from `callback` declarations) onto this
   * execution context, wrapping each one to inject ctx so it accesses the
   * correct per-execution globals/state.
   */
  installRegisteredCallbacks(source: RuntimeContext<T>): void {
    for (const name in source._registeredCallbacks) {
      const fn = source._registeredCallbacks[name as keyof AgencyCallbacks]!;
      (this.callbacks as any)[name] = (data: any) => {
        if (AgencyFunction.isAgencyFunction(fn)) {
          return fn.invoke({ type: "positional", args: [data] }, { ctx: this });
        }
        return (fn as Function)(data, { ctx: this });
      };
    }
  }

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

  cancel(reason?: string): void {
    if (!this.abortController.signal.aborted) {
      this.abortController.abort(new AgencyCancelledError(reason));
    }
  }

  registerClass(name: string, cls: ClassRegistry[string]): void {
    this.classRegistry[name] = cls;
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

    const stack = reviveWithClasses(checkpoint.stack, this.classRegistry);
    const globals = reviveWithClasses(checkpoint.globals, this.classRegistry);

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
    config: Partial<SmolPromptConfig> = {},
  ): Partial<SmolPromptConfig> {
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

  hasDebugger(): boolean {
    return this.debuggerState !== null;
  }

  hasTraceWriter(): boolean {
    return this.traceWriter !== null;
  }

  createMcpManager(config: Record<string, any>): void {
    const onOAuthRequired = this._registeredCallbacks.onOAuthRequired as
      | ((data: any) => void | Promise<void>)
      | undefined;
    this._mcpManager = new McpManager(config, { onOAuthRequired });
  }

  get mcpManager(): McpManager {
    return this._mcpManager;
  }

  async disconnectMcp(): Promise<void> {
    await this._mcpManager.disconnectAll();
  }
}
