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
  __state?: PackagedState;
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

export type InterruptResponseType = InterruptResponseApprove | InterruptResponseReject | InterruptResponseModify;
export type InterruptResponseApprove = {
  type: "approve";
};
export type InterruptResponseReject = {
  type: "reject";
};
export type InterruptResponseModify = {
  type: "modify";
  newArguments: Record<string, any>;
};


export async function respondToInterrupt(_interrupt: Interrupt, _interruptResponse: InterruptResponseType) {
  const interrupt = structuredClone(_interrupt);
  const interruptResponse = structuredClone(_interruptResponse);
  __stateStack = StateStack.fromJSON(interrupt.__state || {});
  __stateStack.deserializeMode();
  const messages = (__stateStack.other.messages || []).map((json: any) => {
    return messageFromJSON(json);
  });

  const nodesTraversed = __stateStack.other.nodesTraversed || [];
  const nodeName = nodesTraversed[nodesTraversed.length - 1];
  const result = await graph.run(nodeName, {
    messages: messages,
    __metadata: {
      graph: graph,
      statelogClient: __statelogClient,
      interruptResponse: interruptResponse,
      state: interrupt.__state,
      __stateStack: __stateStack,
    },
    data: "<from-stack>"
  });
  //console.log(\`Result of graph.run("\${nodeName}"):\`, JSON.stringify(result, null, 2));
  return result.data;
}


class PackagedState {
  public messages?: Message[];
  public nodesTraversed?: string[];
  public toolCall?: Record<string, any>;
  public step?: number;
  public self?: Record<string, any>;
  public global?: Record<string, any>;
  public args?: any;
  constructor(_state: Record<string, any>, args?: any) {
    const state = structuredClone(_state);
    this.messages = state.messages;
    this.nodesTraversed = state.graph?.getNodesTraversed();
    this.toolCall = state.toolCall;
    this.step = state.part;
    this.self = state.self;
    this.global = state.global;
    this.args = state.args;
  }

  toJSON() {
    return {
      messages: this.messages,
      nodesTraversed: this.nodesTraversed,
      toolCall: this.toolCall,
      step: this.step,
      self: this.self,
      global: this.global,
      args: this.args,
    };
  }

  nextStep() {
    this.step ||= 0;
    this.step += 1;
  }
}


class StateStack {
  public stack: StateItem[] = [];
  private mode: "serialize" | "deserialize" = "serialize";
  public globals: Record<string, any> = {};
  public other: Record<string, any> = {};

  private deserializeStackLength = 0;

  constructor(stack: StateItem[] = [], mode: "serialize" | "deserialize" = "serialize") {
    this.stack = stack;
    this.mode = mode;
  }

  getNewState(): StateItem | null {
    if (this.mode === "deserialize" && this.deserializeStackLength <= 0) {
      console.log("Forcing mode to serialize, nothing left to deserialize");
      this.mode = "serialize";
    }
    if (this.mode === "serialize") {
      const newState: StateItem = {
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

  pop(): StateItem | undefined {
    return this.stack.pop();
  }

  toJSON() {
    return structuredClone({
      stack: this.stack,
      globals: this.globals,
      other: this.other,
      mode: this.mode,
      deserializeStackLength: this.deserializeStackLength,
    });
  }

  static fromJSON(json: any): StateStack {
    const stateStack = new StateStack([], "serialize");
    stateStack.stack = json.stack || [];
    stateStack.globals = json.globals || {};
    stateStack.other = json.other || {};
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
    