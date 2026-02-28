import { CostEstimate, TokenUsage } from "smoltalk";
import { ThreadStore } from "./index.js";
import { ThreadStoreJSON } from "./state/threadStore.js";

export type GraphState = {
  messages: ThreadStore;
  data: any; //Record<string, any>;
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
