import { StateStack } from "../state/stateStack.js";
import { StatelogClient, StatelogConfig } from "../../statelogClient.js";
import { SimpleMachine } from "../../simplemachine/index.js";
import { nanoid } from "nanoid";
import { SmolPromptConfig } from "@/index.js";

export class RuntimeContext<T> {
  // this is the part of the runtime context that gets
  // serialized/deserialized to support durable execution
  stateStack: StateStack;
  callbacks: Record<string, Function>;
  onStreamLock: boolean;
  graph: SimpleMachine<T>;

  // we need a single statelog client instance that can be used across the entire execution of the graph,
  // so that all the logs share the same traceId, so they all show up in the same trace in the Statelog dashboard.
  statelogClient: StatelogClient;
  smoltalkDefaults: Partial<SmolPromptConfig>;
  dirname: string;

  constructor(args: {
    statelogConfig: StatelogConfig;
    smoltalkDefaults: Partial<SmolPromptConfig>;
    dirname: string;
  }) {
    const statelogConfig = {
      ...args.statelogConfig,
      traceId: args.statelogConfig.traceId || nanoid(),
    };

    this.statelogClient = new StatelogClient(statelogConfig);
    this.stateStack = StateStack.createWithTokenStats();
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

  /* Get smoltalk config with missing keys populated with defaults */
  getSmoltalkConfig(
    config: Partial<SmolPromptConfig> = {},
  ): Partial<SmolPromptConfig> {
    return { ...this.smoltalkDefaults, ...config };
  }
}
