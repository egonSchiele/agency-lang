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
import { assistantMessage, getClient, userMessage, toolMessage, messageFromJSON } from "smoltalk";
import type { Message } from "smoltalk";

const statelogHost = "https://statelog.adit.io";
const traceId = nanoid();
const statelogConfig = {
    host: statelogHost,
    traceId: traceId,
    apiKey: process.env.STATELOG_API_KEY || "",
    projectId: "agency-lang",
    debugMode: false,
  };
const __statelogClient = new StatelogClient(statelogConfig);
const __model: ModelName = "gpt-4o-mini";

const getClientWithConfig = (config = {}) => {
  const defaultConfig = {
    openAiApiKey: process.env.OPENAI_API_KEY || "",
    googleApiKey: process.env.GEMINI_API_KEY || "",
    model: __model,
    logLevel: "warn",
  };

  return getClient({ ...defaultConfig, ...config });
};

let __client = getClientWithConfig();

type State = {
  messages: string[];
  data: any;
}

// enable debug logging
const graphConfig = {
  debug: {
    log: true,
    logData: false,
  },
  statelog: statelogConfig,
};

const graph = new PieMachine<State>(graphConfig);

// builtins

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

// interrupts

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

function printJSON(obj: any) {
  console.log(JSON.stringify(obj, null, 2));
}

export type InterruptResponseType = InterruptResponseApprove | InterruptResponseReject;

export type InterruptResponseApprove = {
  type: "approve";
  newArguments?: Record<string, any>;
};
export type InterruptResponseReject = {
  type: "reject";
};

export async function respondToInterrupt(_interrupt: Interrupt, _interruptResponse: InterruptResponseType) {
  const interrupt = structuredClone(_interrupt);
  const interruptResponse = structuredClone(_interruptResponse);

  __stateStack = StateStack.fromJSON(interrupt.__state || {});
  __stateStack.deserializeMode();
  
  const messages = (__stateStack.interruptData.messages || []).map((json: any) => {
    // create message objects from JSON
    return messageFromJSON(json);
  });
  __stateStack.interruptData.messages = messages;
  __stateStack.interruptData.interruptResponse = interruptResponse;

  if (interruptResponse.type === "approve" && interruptResponse.newArguments) {
    __stateStack.interruptData.toolCall = {
      ...__stateStack.interruptData.toolCall,
      arguments: { ...__stateStack.interruptData.toolCall.arguments, ...interruptResponse.newArguments },
    };
    const lastMessage = __stateStack.interruptData.messages[__stateStack.interruptData.messages.length - 1];
    if (lastMessage && lastMessage.role === "assistant") {
      const toolCall = lastMessage.toolCalls?.[lastMessage.toolCalls.length - 1];
      if (toolCall) {
        toolCall.arguments = { ...toolCall.arguments, ...interruptResponse.newArguments };
      }
    }
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
    },

    // restore args from the state stack
    data: "<from-stack>"
  });
  return result.data;
}

export async function approveInterrupt(interrupt: Interrupt, newArguments?: Record<string, any>) {
  return await respondToInterrupt(interrupt, { type: "approve", newArguments });
}

export async function rejectInterrupt(interrupt: Interrupt) {
  return await respondToInterrupt(interrupt, { type: "reject" });
}

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

  constructor(stack: StackFrame[] = [], mode: "serialize" | "deserialize" = "serialize") {
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

let __stateStack = new StateStack();`;

export type TemplateType = {
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    