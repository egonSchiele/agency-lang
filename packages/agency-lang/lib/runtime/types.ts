import { CostEstimate, TokenUsage } from "smoltalk";
import { RuntimeContext, StateStack, ThreadStore } from "./index.js";
import { ThreadStoreJSON } from "./state/threadStore.js";
import { SimpleMachine } from "@/simplemachine/graph.js";
import { StatelogClient } from "@/statelogClient.js";
import { InterruptData } from "./interrupts.js";

export type GraphState = {
  messages?: ThreadStore;
  data: any; //Record<string, any>;

  // make sure each node has access to the graph
  // and statelog client instances that were used to execute it,
  // so that they can log to the same trace and manipulate the same graph.
  ctx: RuntimeContext<GraphState>;

  // if true, restore the state from the state stack in ctx.
  isResume?: boolean;

  // response to the interrupt,
  // as well as the tool call that caused the interrupt,
  // and the messages at the time of the interrupt,
  interruptData?: InterruptData;
};

export type InternalFunctionState = {
  threads: ThreadStore;
  ctx: RuntimeContext<GraphState>;
  interruptData?: InterruptData;
  isToolCall?: boolean;
  stateStack?: StateStack;  // per-thread stack for async calls
  moduleId?: string;
  scopeName?: string;
  stepPath?: string;
};

export type NodeReturnValue<T> = {
  data: T;
  messages: ThreadStore;
};

export type RunNodeResult<T> = {
  messages: ThreadStoreJSON;
  data: T;
  tokens?: TokenStats;
};

export type TokenStats = {
  usage: TokenUsage;
  cost: CostEstimate;
};

export type Rejected = { type: "rejected"; value?: any };
export type Approved = { type: "approved"; value?: any };
export type Propagated = { type: "propagated" };

export type HandlerFn = (data: any) => Promise<Approved | Rejected | Propagated | undefined>;

/* tokenstats
{
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        totalTokens: 0,
      },
      cost: {
        inputCost: 0,
        outputCost: 0,
        totalCost: 0,
        currency: "USD",
      },
    };
    */
