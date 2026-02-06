// @ts-nocheck

import __graph___bar from "./bar.ts";

import { greet, __greetTool } from "./bar.ts";
import { z } from "zod";
import * as readline from "readline";
import fs from "fs";
import { PieMachine, goToNode } from "piemachine";
import { StatelogClient } from "statelog-client";
import { nanoid } from "nanoid";
import { assistantMessage, getClient, userMessage, toolMessage } from "smoltalk";

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

type Interrupt<T> = {
  type: "interrupt";
  data: T;
};

function interrupt<T>(data: T): Interrupt<T> {
  return {
    type: "interrupt",
    data,
  };
}

function isInterrupt<T>(obj: any): obj is Interrupt<T> {
  return obj && obj.type === "interrupt";
}

function printJSON(obj: any) {
  console.log(JSON.stringify(obj, null, 2));
}
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

graph.node("foo", async (state): Promise<any> => {
    const __messages: Message[] = state.messages || [];
    const __graph = state.__metadata?.graph || graph;
    const statelogClient = state.__metadata?.statelogClient || __statelogClient;
    
    
      if (__part >= 0) {
        const name = await await _builtinInput(`> `);
      }
      

      if (__part >= 1) {
        
      }
      

      if (__part >= 2) {
        return goToNode("sayHi",
  {
    messages: __messages,
    __metadata: {
      graph: __graph,
      statelogClient,
    },
    
    data: [name]
    
    
  }
);
      }
      

      if (__part >= 3) {
        
      }
      
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