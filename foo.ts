// @ts-nocheck

import __graph___bar from "./bar.ts";

import { greet, __greetTool } from "./bar.ts";
import { z } from "zod";
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


export async function respondToInterrupt(interrupt: Interrupt, interruptResponse: InterruptResponseType) {
  __stateStack = StateStack.fromJSON(interrupt.__state || {});
  __stateStack.setMode("deserialize");
  const messages = (__stateStack.other.messages || []).map((json: any) => {
    return messageFromJSON(json);
  });

  const nodesTraversed = __stateStack.other.nodesTraversed || [];
  const nodeName = nodesTraversed[nodesTraversed.length - 1];
  return graph.run(nodeName, {
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
  public mode: "serialize" | "deserialize" = "serialize";
  public globals: Record<string, any> = {};
  public other: Record<string, any> = {};

  constructor(stack: StateItem[] = [], mode: "serialize" | "deserialize" = "serialize") {
    this.stack = stack;
    this.mode = mode;
  }

  getNewState(): StateItem | null {
    if (this.mode === "serialize") {
      const newState: StateItem = {
        args: {},
        locals: {},
        step: 0,
      };
      this.stack.push(newState);
      return newState;
    } else if (this.mode === "deserialize") {
      return this.stack.shift() || null;
    }
    return null;
  }

  setMode(mode: "serialize" | "deserialize") {
    this.mode = mode;
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
    });
  }

  static fromJSON(json: any): StateStack {
    const stateStack = new StateStack([], "serialize");
    stateStack.stack = json.stack || [];
    stateStack.globals = json.globals || {};
    stateStack.other = json.other || {};
    stateStack.mode = json.mode || "serialize";
    return stateStack;
  }
}

let __stateStack = new StateStack();
function add({a, b}: {a:number, b:number}):number {
  return a + b;
}

const addTool = {
  name: "add",
  description: "Adds two numbers together and returns the result.",
  schema: z.object({
    a: z.number().describe("The first number to add"),
    b: z.number().describe("The second number to add"),
  }),
};

function _builtinInput(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(prompt, (answer: string) => {
      rl.close();
      resolve(answer);
    });
  });
}
export const __testTool = {
  name: "test",
  description: `No description provided.`,
  schema: z.object({"x": z.string(), })
};
__stateStack.globals.prompt = `What is your name?`;

export async function test(args, __metadata={}) : Promise<any> {
    const __messages: Message[] = [];
    const __stack = __stateStack.getNewState();
    const __step = __stack.step > 0 ? __stack.step + 1 : 0;
    const __self: Record<string, any> = __stack.locals;

    const __params = ["x"];
      (args).forEach((item, index) => {
        __stack.args[__params[index]] = item;
      });


    
      if (__step <= 0) {
        
        __stack.step++;
      }
      

      if (__step <= 1) {
        __stack.locals.y = 1;
        __stack.step++;
      }
      

      if (__step <= 2) {
        await console.log(`Hello, ${__stack.args.x}!`)
        __stack.step++;
      }
      
}
graph.node("foo", async (state): Promise<any> => {
    const __messages: Message[] = state.messages || [];
    const __graph = state.__metadata?.graph || graph;
    const statelogClient = state.__metadata?.statelogClient || __statelogClient;
    if (state.__metadata?.__stateStack) {
      __stateStack = state.__metadata.__stateStack;
    }
    const __stack = __stateStack.getNewState();
    const __step = __stack.step;

    const __self: Record<string, any> = __stack.locals;

    const __interruptResponse: InterruptResponseType | undefined = state.__metadata?.interruptResponse;
    const __toolCall: Record<string, any>|undefined = __stateStack.other?.toolCall;

    if (state.__metadata?.state?.global) {
      __global = state.__metadata.state.global;
    }

    
    
      if (__step <= 0) {
        
        __stack.step++;
      }
      

      if (__step <= 1) {
        test([`Alice`])
        __stack.step++;
      }
      

      if (__step <= 2) {
        await console.log(__stateStack.globals.prompt)
        __stack.step++;
      }
      

      if (__step <= 3) {
        __stack.locals.name = await await _builtinInput(`> `);
        __stack.step++;
      }
      

      if (__step <= 4) {
        await console.log(`Your name is ${__stack.locals.name}. Greeting you with a tool`)
        __stack.step++;
      }
      

      if (__step <= 5) {
        return goToNode("sayHi",
  {
    messages: __messages,
    __metadata: {
      graph: __graph,
      statelogClient,
    },
    
    data: [__stack.locals.name]
    
    
  }
);
        __stack.step++;
      }
      
    
    // this is just here to have a default return value from a node if the user doesn't specify one
    return { ...state, data: undefined };
});

graph.conditionalEdge("foo", ["sayHi"]);

graph.merge(__graph___bar);


export async function foo({ messages } = {}): Promise<any> {

  const data = [  ];
  const result = await graph.run("foo", { messages: messages || [], data });
  return result.data;
}

export default graph;