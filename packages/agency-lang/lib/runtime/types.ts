import { CostEstimate, TokenUsage } from "smoltalk";
import { RuntimeContext, ThreadStore } from "./index.js";
import { ThreadStoreJSON } from "./state/threadStore.js";
import type { RunUsage } from "./invocationUsage.js";

export type GraphState = {
  messages?: ThreadStore;
  data: any; //Record<string, any>;

  // make sure each node has access to the graph
  // and statelog client instances that were used to execute it,
  // so that they can log to the same trace and manipulate the same graph.
  ctx: RuntimeContext<GraphState>;

  // if true, restore the state from the state stack in ctx.
  isResume?: boolean;
};

/** A run's result before its entry point attaches `usage`. */
export type RunNodeCoreResult<T> = Omit<RunNodeResult<T>, "usage">;

export type NodeReturnValue<T> = {
  data: T;
  messages: ThreadStore;
};

export type RunNodeResult<T> = {
  messages: ThreadStoreJSON;
  data: T;
  /** What this run spent, per kind and model. */
  usage: RunUsage;
};

export type Rejected = { type: "reject"; value?: any };
export type Approved = { type: "approve"; value?: any };
export type Propagated = { type: "propagate" };
export type Passed = { type: "pass" };

export type HandlerFn = (interrupt: {
  effect: string;
  message: string;
  data: any;
  origin: string;
  // True for assignment-position raises (`const x = raise …`) — an
  // approval value is expected. See Interrupt.expectsValue.
  expectsValue?: boolean;
}) => Promise<Approved | Rejected | Propagated | Passed | undefined>;

/** One registered handler on `ctx.handlers`. A handler belongs to the
 *  scope where it was registered: `liveGuardIds` records which guards
 *  were live on the registering branch's stack at that moment, and that
 *  set decides both which guard trips the handler may adjudicate (only
 *  guards NOT in the set — you cannot adjudicate a guard you are inside)
 *  and which guards are suspended while the handler runs (also the
 *  guards not in the set: a handler's own work spends its registration
 *  site's budget, never a budget it is deciding about). Identity-based
 *  on guardId — ids are serialized and survive resume and fork, which
 *  array indices and registration counts do not (see the resumable-
 *  guards plan, decision 14). */
export type HandlerEntry = {
  fn: HandlerFn;
  liveGuardIds: string[];
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
