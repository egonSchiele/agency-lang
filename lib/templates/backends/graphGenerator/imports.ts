// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/graphGenerator/imports.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `import { z } from "zod";
import * as readline from "readline";
import fs from "fs";
import { PieMachine, goToNode } from "piemachine";
import { StatelogClient } from "statelog-client";
import { nanoid } from "nanoid";
import {
  assistantMessage,
  getClient,
  userMessage,
  toolMessage,
  messageFromJSON,
} from "smoltalk";
import type { Message } from "smoltalk";

/* Code to log to statelog */
const statelogHost = "{{{logHost:string}}}";
const traceId = nanoid();
const statelogConfig = {
  host: statelogHost,
  traceId: traceId,
  apiKey: process.env.STATELOG_API_KEY || "",
  projectId: "{{{logProjectId:string}}}",
  debugMode: {{{logDebugMode:boolean}}},
};
const __statelogClient = new StatelogClient(statelogConfig);

/* Code for Smoltalk client */
const __model: ModelName = "{{{clientDefaultModel:string}}}";

const getClientWithConfig = (config = {}) => {
  const defaultConfig = {
    openAiApiKey: process.env.OPENAI_API_KEY || "",
    googleApiKey: process.env.GEMINI_API_KEY || "",
    model: __model,
    logLevel: "{{{clientLogLevel:string}}}",
  };

  return getClient({ ...defaultConfig, ...config });
};

let __client = getClientWithConfig();

/* Code for PieMachine graph */
export type State<T> = {
  messages: string[];
  data: T;
};

// enable debug logging
const graphConfig = {
  debug: {
    log: true,
    logData: false,
  },
  statelog: statelogConfig,
};

const graph = new PieMachine<State<any>>(graphConfig);

/******** builtins ********/

const not = (val: any): boolean => !val;
const eq = (a: any, b: any): boolean => a === b;
const neq = (a: any, b: any): boolean => a !== b;
const lt = (a: any, b: any): boolean => a < b;
const lte = (a: any, b: any): boolean => a <= b;
const gt = (a: any, b: any): boolean => a > b;
const gte = (a: any, b: any): boolean => a >= b;
const and = (a: any, b: any): boolean => a && b;
const or = (a: any, b: any): boolean => a || b;
const head = <T>(arr: T[]): T | undefined => arr[0];
const tail = <T>(arr: T[]): T[] => arr.slice(1);
const empty = <T>(arr: T[]): boolean => arr.length === 0;

async function _builtinFetch(url: string, args: any = {}): any {
  const result = await fetch(url, args);
  try {
    const text = await result.text();
    return text;
  } catch (e) {
    throw new Error(\`Failed to get text from $\{url\}: $\{e\}\`);
  }
}

async function _builtinFetchJSON(url: string, args: any = {}): any {
  const result = await fetch(url, args);
  try {
    const json = await result.json();
    return json;
  } catch (e) {
    throw new Error(\`Failed to parse JSON from $\{url\}: $\{e\}\`);
  }
}

function _builtinInput(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(prompt, (answer: string) => {
      rl.close();
      resolve(answer);
    });
  });
}

function _builtinRead(filename: string): string {
  const data = fs.readFileSync(filename);
  const contents = data.toString("utf8");
  return contents;
}

/*
 * @param filePath The absolute or relative path to the image file.
 * @returns The Base64 string, or null if an error occurs.
 */
function _builtinReadImage(filePath: string): string {
  const data = fs.readFileSync(filePath); // Synchronous file reading
  const base64String = data.toString("base64");
  return base64String;
}

function _builtinSleep(seconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, seconds * 1000);
  });
}

function printJSON(obj: any) {
  console.log(JSON.stringify(obj, null, 2));
}

/******** interrupts ********/

export type Interrupt<T> = {
  type: "interrupt";
  data: T;

  // JSONified StateStack, i.e. serialized execution state
  __state?: Record<string, any>;
};

export function interrupt<T>(data: T): Interrupt<T> {
  return {
    type: "interrupt",
    data,
  };
}

export function isInterrupt<T>(obj: any): obj is Interrupt<T> {
  return obj && obj.type === "interrupt";
}

export type InterruptResponseType =
  | InterruptResponseApprove
  | InterruptResponseReject;

export type InterruptResponseApprove = {
  type: "approve";
  newArguments?: Record<string, any>;
};
export type InterruptResponseReject = {
  type: "reject";
};

export async function respondToInterrupt(
  _interrupt: Interrupt,
  _interruptResponse: InterruptResponseType,
  metadata: Record<string, any> = {},
) {
  const interrupt = structuredClone(_interrupt);
  const interruptResponse = structuredClone(_interruptResponse);

  __stateStack = StateStack.fromJSON(interrupt.__state || {});
  __stateStack.deserializeMode();

  const messages = (__stateStack.interruptData.messages || []).map(
    (json: any) => {
      // create message objects from JSON
      return messageFromJSON(json);
    },
  );
  __stateStack.interruptData.messages = messages;
  __stateStack.interruptData.interruptResponse = interruptResponse;

  if (interruptResponse.type === "approve" && interruptResponse.newArguments) {
    __stateStack.interruptData.toolCall = {
      ...__stateStack.interruptData.toolCall,
      arguments: {
        ...__stateStack.interruptData.toolCall.arguments,
        ...interruptResponse.newArguments,
      },
    };
    // Error:
    // TypeError: Cannot set property arguments of #<ToolCall> which has only a getter
    //         toolCall.arguments = { ...toolCall.arguments, ...interruptResponse.newArguments };
    //
    // const lastMessage = __stateStack.interruptData.messages[__stateStack.interruptData.messages.length - 1];
    // if (lastMessage && lastMessage.role === "assistant") {
    //   const toolCall = lastMessage.toolCalls?.[lastMessage.toolCalls.length - 1];
    //   if (toolCall) {
    //     toolCall.arguments = { ...toolCall.arguments, ...interruptResponse.newArguments };
    //   }
    // }
  }

  // start at the last node we visited
  const nodesTraversed = __stateStack.interruptData.nodesTraversed || [];
  const nodeName = nodesTraversed[nodesTraversed.length - 1];
  const result = await graph.run(nodeName, {
    messages: messages,
    __metadata: {
      graph: graph,
      statelogClient: __statelogClient,
      __stateStack: __stateStack,
      __callbacks: metadata.callbacks,
    },

    // restore args from the state stack
    data: "<from-stack>",
  });
  return result.data;
}

export async function approveInterrupt(
  interrupt: Interrupt,
  metadata: Record<string, any> = {},
) {
  return await respondToInterrupt(interrupt, { type: "approve" }, metadata);
}

export async function modifyInterrupt(
  interrupt: Interrupt,
  newArguments?: Record<string, any>,
  metadata: Record<string, any> = {},
) {
  return await respondToInterrupt(
    interrupt,
    { type: "approve", newArguments },
    metadata,
  );
}

export async function rejectInterrupt(
  interrupt: Interrupt,
  metadata: Record<string, any> = {},
) {
  return await respondToInterrupt(interrupt, { type: "reject" }, metadata);
}

/****** StateStack and related functions for serializing/deserializing execution state during interrupts ********/

type StackFrame = {
  args: Record<string, any>;
  locals: Record<string, any>;
  step: number;
};

// See docs for notes on how this works.
class StateStack {
  public stack: StackFrame[] = [];
  private mode: "serialize" | "deserialize" = "serialize";
  public globals: Record<string, any> = {};
  public other: Record<string, any> = {};
  public interruptData: Record<string, any> = {};

  private deserializeStackLength = 0;

  constructor(
    stack: StackFrame[] = [],
    mode: "serialize" | "deserialize" = "serialize",
  ) {
    this.stack = stack;
    this.mode = mode;
  }

  getNewState(): StackFrame | null {
    if (this.mode === "deserialize" && this.deserializeStackLength <= 0) {
      console.log("Forcing mode to serialize, nothing left to deserialize");
      this.mode = "serialize";
    }
    if (this.mode === "serialize") {
      const newState: StackFrame = {
        args: {},
        locals: {},
        step: 0,
      };
      this.stack.push(newState);
      return newState;
    } else if (this.mode === "deserialize") {
      this.deserializeStackLength -= 1;
      const item = this.stack.shift();
      this.stack.push(item);
      return item;
    }
    return null;
  }

  deserializeMode() {
    this.mode = "deserialize";
    this.deserializeStackLength = this.stack.length;
  }

  pop(): StackFrame | undefined {
    return this.stack.pop();
  }

  toJSON() {
    return structuredClone({
      stack: this.stack,
      globals: this.globals,
      other: this.other,
      interruptData: this.interruptData,
      mode: this.mode,
      deserializeStackLength: this.deserializeStackLength,
    });
  }

  static fromJSON(json: any): StateStack {
    const stateStack = new StateStack([], "serialize");
    stateStack.stack = json.stack || [];
    stateStack.globals = json.globals || {};
    stateStack.other = json.other || {};
    stateStack.interruptData = json.interruptData || {};
    stateStack.mode = json.mode || "serialize";
    stateStack.deserializeStackLength = json.deserializeStackLength || 0;
    return stateStack;
  }
}

let __stateStack = new StateStack();

__stateStack.globals.__tokenStats = {
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

function __updateTokenStats(
  usage: Record<string, any>,
  cost: Record<string, any>,
) {
  if (!usage || !cost) return;
  const tokenStats = __stateStack.globals.__tokenStats;
  tokenStats.usage.inputTokens += usage.inputTokens || 0;
  tokenStats.usage.outputTokens += usage.outputTokens || 0;
  tokenStats.usage.cachedInputTokens += usage.cachedInputTokens || 0;
  tokenStats.usage.totalTokens += usage.totalTokens || 0;

  tokenStats.cost.inputCost += cost.inputCost || 0;
  tokenStats.cost.outputCost += cost.outputCost || 0;
  tokenStats.cost.totalCost += cost.totalCost || 0;
}

/**** Streaming callback and lock ****/
function isGenerator(variable) {
  const toString = Object.prototype.toString.call(variable);
  return (
    toString === "[object Generator]" || toString === "[object AsyncGenerator]"
  );
}

let __callbacks: Record<string, any> = {};

let onStreamLock = false;

function __cloneArray<T>(arr?: T[]): T[] {
  if (arr == undefined) return [];
  return [...arr];
}
`;

export type TemplateType = {
  logHost: string;
  logProjectId: string;
  logDebugMode: boolean;
  clientDefaultModel: string;
  clientLogLevel: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    