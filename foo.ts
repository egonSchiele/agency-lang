// @ts-nocheck

import __graph___bar from "./bar.ts";
import { readFile }  from "./basicFunctions.ts";
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
const statelogClient = new StatelogClient(statelogConfig);
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
    logData: true,
  },
  statelog: statelogConfig,
};

// Define the names of the nodes in the graph
// Useful for type safety
const __nodes = ["bar","main"] as const;

const graph = new PieMachine<State>(__nodes, graphConfig);

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

const __nodesTraversed = [];
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
const readFileToolTool = {
  name: "readFileTool",
  description: `No description provided.`,
  schema: z.object({"path": z.string(), })
};
async function readFileTool({path}) : Promise<string> {
    const __messages: Message[] = [];
    return await readFile(path)


}graph.node("bar", async (state): Promise<any> => {
    const __messages: Message[] = [];
    
    const [msg] = state.data;
    
    __nodesTraversed.push("bar");
    await console.log(`This is the bar node.`)

});
graph.node("main", async (state): Promise<any> => {
    const __messages: Message[] = [];
    
    __nodesTraversed.push("main");
    const msg = await await _builtinInput(`> `);


// return bar(msg)


return goToNode("categorize",
  {
    messages: state.messages,
    
    data: [msg]
    
    
  }
);



//  +readFileTool


//  response = llm("Help me read the specified file: ${msg}")


//  printJSON(response)


});

graph.conditionalEdge("main", ["categorize"]);

graph.merge(__graph___bar);
const initialState: State = {messages: [], data: {}};
const finalState = graph.run("main", initialState);
export async function bar(data): Promise<any> {
  const result = await graph.run("bar", { messages: [], data });
  return result.data;
}

export async function main(data): Promise<any> {
  const result = await graph.run("main", { messages: [], data });
  return result.data;
}

export default graph;