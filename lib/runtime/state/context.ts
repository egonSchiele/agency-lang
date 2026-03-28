import { StateStack } from "../state/stateStack.js";
import { GlobalStore } from "../state/globalStore.js";
import { PendingPromiseStore } from "./pendingPromiseStore.js";
import { CheckpointStore } from "./checkpointStore.js";
import type { Checkpoint } from "./checkpointStore.js";
import { StatelogClient, StatelogConfig } from "../../statelogClient.js";
import { SimpleMachine } from "../../simplemachine/index.js";
import { nanoid } from "nanoid";
import { SmolPromptConfig } from "@/index.js";
import { callHook } from "../hooks.js";
import type { AgencyCallbacks } from "../hooks.js";
import type { AuditEntry, AuditEntryInput } from "../audit.js";
import type { HandlerFn } from "../types.js";

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

  // we need a single statelog client instance that can be used across the entire execution of the graph,
  // so that all the logs share the same traceId, so they all show up in the same trace in the Statelog dashboard.
  statelogClient: StatelogClient;
  smoltalkDefaults: Partial<SmolPromptConfig>;

  // this is the directory that the runtime is running in. We need this to be able to read files relative to the runtime.
  dirname: string;

  // stored so createExecutionContext can create new StatelogClients
  private statelogConfig: StatelogConfig;
  private maxRestores: number;

  constructor(args: {
    statelogConfig: StatelogConfig;
    smoltalkDefaults: Partial<SmolPromptConfig>;
    dirname: string;
    maxRestores?: number;
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
    this.pendingPromises = new PendingPromiseStore();
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
  }

  createExecutionContext(): RuntimeContext<T> {
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
    execCtx.onStreamLock = false;
    execCtx._skipNextCheckpoint = false;
    execCtx.pendingPromises = new PendingPromiseStore();
    execCtx.statelogClient = new StatelogClient({
      ...this.statelogConfig,
      traceId: nanoid(),
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
  pushHandler(fn: HandlerFn): void { this.handlers.push(fn); }
  popHandler(): void { this.handlers.pop(); }

  forkStack(): StateStack {
    return new StateStack();
  }

  /** Sever references held by an execution context so GC can reclaim them. */
  cleanup(): void {
    this.pendingPromises.clear();
    this.stateStack = null as any;
    this.globals = null as any;
    this.checkpoints = null as any;
    this.statelogClient = null as any;
    this.callbacks = null as any;
    this.handlers = null as any;
  }

  restoreState(checkpoint: Checkpoint): void {
    const currentTokenStats = this.globals.getTokenStats();
    this.stateStack = StateStack.fromJSON(checkpoint.stack);
    this.stateStack.deserializeMode();

    // The checkpoint stack has frames for all nodes traversed (e.g. bar → foo),
    // but we resume only at the last node. Strip frames from earlier nodes so
    // deserialization hands the correct frame to each setupNode/setupFunction.
    // const staleNodeCount = this.stateStack.nodesTraversed.length - 1;
    // if (staleNodeCount > 0) {
    //   this.stateStack.stack.splice(0, staleNodeCount);
    //   this.stateStack.deserializeStackLength -= staleNodeCount;
    // }

    this.globals = GlobalStore.fromJSON(checkpoint.globals);
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

  async audit(entry: AuditEntryInput): Promise<void> {
    const fullEntry = { ...entry, timestamp: Date.now() };
    await callHook({
      callbacks: this.callbacks,
      name: "onAuditLog",
      data: fullEntry as AuditEntry,
    });
  }
}
