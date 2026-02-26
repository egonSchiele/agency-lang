import { StateStack } from "./stateStack.js";
import { StatelogClient } from "../statelogClient.js";
import { SimpleMachine } from "../simplemachine/index.js";
import { nanoid } from "nanoid";

export class RuntimeContext {
  stateStack: StateStack;
  callbacks: Record<string, Function>;
  onStreamLock: boolean;
  graph: SimpleMachine<any>;
  statelogClient: StatelogClient;
  getSmoltalkConfig: (config?: Record<string, any>) => Record<string, any>;
  dirname: string;

  constructor(args: {
    statelogConfig: {
      host: string;
      traceId?: string;
      apiKey: string;
      projectId: string;
      debugMode: boolean;
    };
    smoltalkDefaults: {
      openAiApiKey: string;
      googleApiKey: string;
      model: string;
      logLevel: string;
    };
    dirname: string;
  }) {
    const traceId = args.statelogConfig.traceId || nanoid();
    const statelogConfig = {
      ...args.statelogConfig,
      traceId,
    };

    this.statelogClient = new StatelogClient(statelogConfig);
    this.stateStack = StateStack.createWithTokenStats();
    this.callbacks = {};
    this.onStreamLock = false;
    this.dirname = args.dirname;

    const graphConfig = {
      debug: {
        log: true,
        logData: false,
      },
      statelog: statelogConfig,
    };
    this.graph = new SimpleMachine(graphConfig);

    const smoltalkDefaults = { ...args.smoltalkDefaults };
    this.getSmoltalkConfig = (config: Record<string, any> = {}): Record<string, any> => {
      return { ...smoltalkDefaults, ...config };
    };
  }
}
