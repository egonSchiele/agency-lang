import { StateStack } from "../state/stateStack.js";
import { GlobalStore } from "../state/globalStore.js";
import { StatelogClient, StatelogConfig } from "../../statelogClient.js";
import { SimpleMachine } from "../../simplemachine/index.js";
import { nanoid } from "nanoid";
import { SmolPromptConfig } from "@/index.js";
import type { AgencyCallbacks } from "../hooks.js";

/* bunch of stuff that every node/function in the runtime needs access to,
that we don't want to pass as individual arguments everywhere */
export class RuntimeContext<T> {
  // this is the part of the runtime context that gets
  // serialized/deserialized to support durable execution
  stateStack: StateStack;
  globals: GlobalStore;
  callbacks: AgencyCallbacks;
  onStreamLock: boolean;
  graph: SimpleMachine<T>;

  // we need a single statelog client instance that can be used across the entire execution of the graph,
  // so that all the logs share the same traceId, so they all show up in the same trace in the Statelog dashboard.
  statelogClient: StatelogClient;
  smoltalkDefaults: Partial<SmolPromptConfig>;

  // this is the directory that the runtime is running in. We need this to be able to read files relative to the runtime.
  dirname: string;

  // stored so createExecutionContext can create new StatelogClients
  private statelogConfig: StatelogConfig;

  constructor(args: {
    statelogConfig: StatelogConfig;
    smoltalkDefaults: Partial<SmolPromptConfig>;
    dirname: string;
  }) {
    const statelogConfig = {
      ...args.statelogConfig,
      traceId: args.statelogConfig.traceId || nanoid(),
    };

    this.statelogConfig = statelogConfig;
    this.statelogClient = new StatelogClient(statelogConfig);
    this.stateStack = new StateStack();
    this.globals = GlobalStore.withTokenStats();
    this.callbacks = {};
    this.onStreamLock = false;
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
    const execCtx = Object.create(RuntimeContext.prototype) as RuntimeContext<T>;
    execCtx.graph = this.graph;
    execCtx.smoltalkDefaults = this.smoltalkDefaults;
    execCtx.dirname = this.dirname;
    execCtx.statelogConfig = this.statelogConfig;
    execCtx.stateStack = new StateStack();
    execCtx.globals = GlobalStore.withTokenStats();
    execCtx.callbacks = {};
    execCtx.onStreamLock = false;
    execCtx.statelogClient = new StatelogClient({
      ...this.statelogConfig,
      traceId: nanoid(),
    });
    return execCtx;
  }

  /** Sever references held by an execution context so GC can reclaim them. */
  cleanup(): void {
    this.stateStack = null as any;
    this.globals = null as any;
    this.statelogClient = null as any;
    this.callbacks = null as any;
  }

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
}
