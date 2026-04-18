import type { Checkpoint } from "../state/checkpointStore.js";
import { GlobalStore } from "../state/globalStore.js";

// --- Event types ---

type BaseEvent = {
  step: number;
  nodeId: string;
  scopeName: string;
  moduleId: string;
  stepPath: string;
};

export type NodeEnterEvent = BaseEvent & {
  type: "node-enter";
  nodeName: string;
};

export type NodeExitEvent = BaseEvent & {
  type: "node-exit";
  nodeName: string;
};

export type FunctionEnterEvent = BaseEvent & {
  type: "function-enter";
  functionName: string;
  args: Record<string, any>;
};

export type FunctionExitEvent = BaseEvent & {
  type: "function-exit";
  functionName: string;
  returnValue?: any;
};

export type VariableSetEvent = BaseEvent & {
  type: "variable-set";
  variable: string;
  value: any;
  previousValue: any;
  scope: "local" | "global";
};

export type LlmCallEvent = BaseEvent & {
  type: "llm-call";
  prompt: string;
  response: string;
  toolCalls: Array<{ name: string; arguments: any; result?: any }>;
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    totalTokens: number;
  } | null;
};

export type ToolCallEvent = BaseEvent & {
  type: "tool-call";
  toolName: string;
  args: any;
  result: any;
};

export type InterruptThrownEvent = BaseEvent & {
  type: "interrupt-thrown";
  message: string;
};

export type InterruptResolvedEvent = BaseEvent & {
  type: "interrupt-resolved";
  outcome: "approved" | "rejected" | "resolved";
  data?: any;
};

export type BranchEvent = BaseEvent & {
  type: "branch";
  condition: "if" | "else" | "while" | "for";
  iteration?: number;
};

export type TraceEvent =
  | NodeEnterEvent
  | NodeExitEvent
  | FunctionEnterEvent
  | FunctionExitEvent
  | VariableSetEvent
  | LlmCallEvent
  | ToolCallEvent
  | InterruptThrownEvent
  | InterruptResolvedEvent
  | BranchEvent;

// --- Helpers ---

export function makeBaseEvent(
  checkpoint: Checkpoint,
  step: number,
): BaseEvent {
  return {
    step,
    nodeId: checkpoint.nodeId,
    scopeName: checkpoint.scopeName,
    moduleId: checkpoint.moduleId,
    stepPath: checkpoint.stepPath,
  };
}

function isInternalVar(name: string): boolean {
  return name.startsWith("__");
}

function diffObject(
  prev: Record<string, any>,
  curr: Record<string, any>,
): Array<{ key: string; value: any; previousValue: any }> {
  const changes: Array<{ key: string; value: any; previousValue: any }> = [];
  for (const key of Object.keys(curr)) {
    if (isInternalVar(key)) continue;
    const prevVal = prev[key];
    const currVal = curr[key];
    if (JSON.stringify(prevVal) !== JSON.stringify(currVal)) {
      changes.push({ key, value: currVal, previousValue: prevVal ?? null });
    }
  }
  return changes;
}

function getMessages(checkpoint: Checkpoint): any[] {
  const frame = checkpoint.stack.stack.at(-1);
  if (!frame?.threads) return [];
  const { threads, activeStack } = frame.threads;
  const threadIds = Object.keys(threads);
  if (threadIds.length === 0) return [];
  const activeId =
    activeStack.findLast((id: string) => threads[id] != null) ?? threadIds[0];
  return threads[activeId]?.messages ?? [];
}

function getMessageContent(message: any): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map((part: any) => part.text ?? "").join("");
  }
  if (message.content == null && message.toolCalls) {
    return message.toolCalls
      .map(
        (tc: any) =>
          `Tool call: ${tc.name}(${JSON.stringify(tc.arguments)})`,
      )
      .join("\n");
  }
  return message.content == null ? "" : JSON.stringify(message.content);
}

function getTokenUsageDiff(
  prev: Checkpoint,
  curr: Checkpoint,
): LlmCallEvent["tokenUsage"] {
  const prevStats =
    prev.globals.store?.[GlobalStore.INTERNAL_MODULE]?.["__tokenStats"];
  const currStats =
    curr.globals.store?.[GlobalStore.INTERNAL_MODULE]?.["__tokenStats"];
  if (!currStats?.usage) return null;
  if (!prevStats?.usage) return { ...currStats.usage };
  return {
    inputTokens:
      (currStats.usage.inputTokens ?? 0) -
      (prevStats.usage.inputTokens ?? 0),
    outputTokens:
      (currStats.usage.outputTokens ?? 0) -
      (prevStats.usage.outputTokens ?? 0),
    cachedInputTokens:
      (currStats.usage.cachedInputTokens ?? 0) -
      (prevStats.usage.cachedInputTokens ?? 0),
    totalTokens:
      (currStats.usage.totalTokens ?? 0) -
      (prevStats.usage.totalTokens ?? 0),
  };
}

const INTERRUPT_LABELS = ["result-entry"];

function isInterruptLabel(label: string | null): boolean {
  if (!label) return false;
  return INTERRUPT_LABELS.some((il) => label.includes(il));
}

// --- Detectors ---

export function detectNodeTransitions(
  prev: Checkpoint | null,
  curr: Checkpoint,
  step: number,
): TraceEvent[] {
  const events: TraceEvent[] = [];

  if (prev === null) {
    events.push({
      ...makeBaseEvent(curr, step),
      type: "node-enter",
      nodeName: curr.nodeId,
    });
    return events;
  }

  if (prev.nodeId !== curr.nodeId) {
    events.push({
      ...makeBaseEvent(prev, step),
      type: "node-exit",
      nodeName: prev.nodeId,
    });
    events.push({
      ...makeBaseEvent(curr, step),
      type: "node-enter",
      nodeName: curr.nodeId,
    });
  }

  return events;
}

export function detectStackChanges(
  prev: Checkpoint | null,
  curr: Checkpoint,
  step: number,
): TraceEvent[] {
  if (!prev) return [];
  const events: TraceEvent[] = [];
  const prevDepth = prev.stack.stack.length;
  const currDepth = curr.stack.stack.length;

  if (currDepth > prevDepth) {
    for (let i = prevDepth; i < currDepth; i++) {
      const frame = curr.stack.stack[i];
      events.push({
        ...makeBaseEvent(curr, step),
        type: "function-enter",
        functionName: curr.scopeName,
        args: { ...frame.args },
      });
    }
  } else if (currDepth < prevDepth) {
    const callerFrame = curr.stack.stack.at(-1);
    const prevCallerFrame = prev.stack.stack[currDepth - 1];
    let returnValue: any = undefined;
    if (callerFrame && prevCallerFrame) {
      for (const key of Object.keys(callerFrame.locals)) {
        if (!isInternalVar(key) && !(key in prevCallerFrame.locals)) {
          returnValue = callerFrame.locals[key];
          break;
        }
      }
    }
    for (let i = prevDepth - 1; i >= currDepth; i--) {
      events.push({
        ...makeBaseEvent(prev, step),
        type: "function-exit",
        functionName: prev.scopeName,
        ...(returnValue !== undefined ? { returnValue } : {}),
      });
    }
  }

  return events;
}

export function detectVariableChanges(
  prev: Checkpoint | null,
  curr: Checkpoint,
  step: number,
): TraceEvent[] {
  if (!prev) return [];
  const events: TraceEvent[] = [];
  const base = makeBaseEvent(curr, step);

  const prevFrame = prev.stack.stack.at(-1);
  const currFrame = curr.stack.stack.at(-1);
  if (
    prevFrame &&
    currFrame &&
    prev.stack.stack.length === curr.stack.stack.length
  ) {
    for (const change of diffObject(prevFrame.locals, currFrame.locals)) {
      events.push({
        ...base,
        type: "variable-set",
        variable: change.key,
        value: change.value,
        previousValue: change.previousValue,
        scope: "local",
      });
    }
  }

  const prevStore = prev.globals.store ?? {};
  const currStore = curr.globals.store ?? {};
  for (const moduleId of Object.keys(currStore)) {
    if (moduleId === GlobalStore.INTERNAL_MODULE) continue;
    const prevMod = prevStore[moduleId] ?? {};
    const currMod = currStore[moduleId] ?? {};
    for (const change of diffObject(prevMod, currMod)) {
      events.push({
        ...base,
        type: "variable-set",
        variable: change.key,
        value: change.value,
        previousValue: change.previousValue,
        scope: "global",
      });
    }
  }

  return events;
}

export function detectLlmCalls(
  prev: Checkpoint | null,
  curr: Checkpoint,
  step: number,
): TraceEvent[] {
  if (!prev) return [];
  const events: TraceEvent[] = [];
  const base = makeBaseEvent(curr, step);

  const prevMessages = getMessages(prev);
  const currMessages = getMessages(curr);

  if (currMessages.length <= prevMessages.length) return events;

  const newMessages = currMessages.slice(prevMessages.length);
  const toolCalls: Array<{ name: string; arguments: any; result?: any }> = [];

  let prompt = "";
  let response = "";

  for (const msg of newMessages) {
    if (msg.role === "user") {
      prompt = getMessageContent(msg);
    } else if (msg.role === "assistant" && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        toolCalls.push({ name: tc.name, arguments: tc.arguments });
      }
    } else if (msg.role === "tool") {
      const pending = toolCalls.findLast((tc) => tc.result === undefined);
      if (pending) {
        pending.result = getMessageContent(msg);
        events.push({
          ...base,
          type: "tool-call",
          toolName: pending.name,
          args: pending.arguments,
          result: pending.result,
        });
      }
    } else if (msg.role === "assistant") {
      response = getMessageContent(msg);
    }
  }

  events.push({
    ...base,
    type: "llm-call",
    prompt,
    response,
    toolCalls: toolCalls.map(({ name, arguments: args, result }) => ({
      name,
      arguments: args,
      result,
    })),
    tokenUsage: getTokenUsageDiff(prev, curr),
  });

  return events;
}

export function detectInterrupts(
  prev: Checkpoint | null,
  curr: Checkpoint,
  step: number,
): TraceEvent[] {
  if (!prev) return [];
  const events: TraceEvent[] = [];

  if (isInterruptLabel(curr.label)) {
    events.push({
      ...makeBaseEvent(curr, step),
      type: "interrupt-thrown",
      message: curr.label ?? "",
    });
  }

  if (isInterruptLabel(prev.label) && !isInterruptLabel(curr.label)) {
    events.push({
      ...makeBaseEvent(curr, step),
      type: "interrupt-resolved",
      outcome: "approved",
    });
  }

  return events;
}

export function detectBranches(
  prev: Checkpoint | null,
  curr: Checkpoint,
  step: number,
): TraceEvent[] {
  if (!prev) return [];
  const events: TraceEvent[] = [];
  const base = makeBaseEvent(curr, step);

  const prevLocals = prev.stack.stack.at(-1)?.locals ?? {};
  const currLocals = curr.stack.stack.at(-1)?.locals ?? {};

  for (const key of Object.keys(currLocals)) {
    if (key.startsWith("__condbranch_")) {
      const prevVal = prevLocals[key];
      const currVal = currLocals[key];
      if (JSON.stringify(prevVal) !== JSON.stringify(currVal)) {
        events.push({
          ...base,
          type: "branch",
          condition: currVal ? "if" : "else",
        });
      }
    }

    if (key.startsWith("__iteration_")) {
      const prevVal = prevLocals[key];
      const currVal = currLocals[key];
      if (JSON.stringify(prevVal) !== JSON.stringify(currVal)) {
        events.push({
          ...base,
          type: "branch",
          condition: "for",
          iteration: currVal,
        });
      }
    }
  }

  return events;
}

// --- Orchestrator ---

type EventEmitter = (
  prev: Checkpoint | null,
  curr: Checkpoint,
  step: number,
) => TraceEvent[];

const eventEmitters: EventEmitter[] = [
  detectNodeTransitions,
  detectStackChanges,
  detectVariableChanges,
  detectLlmCalls,
  detectInterrupts,
  detectBranches,
];

function diff(
  prev: Checkpoint | null,
  curr: Checkpoint,
  step: number,
): TraceEvent[] {
  const events: TraceEvent[] = [];
  for (const emitter of eventEmitters) {
    events.push(...emitter(prev, curr, step));
  }
  return events;
}

export function generateEventLog(checkpoints: Checkpoint[]): TraceEvent[] {
  if (checkpoints.length === 0) return [];

  const events: TraceEvent[] = [];

  events.push(...diff(null, checkpoints[0], 0));

  for (let i = 1; i < checkpoints.length; i++) {
    events.push(...diff(checkpoints[i - 1], checkpoints[i], i));
  }

  return events;
}
