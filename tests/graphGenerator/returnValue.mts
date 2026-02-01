// @ts-nocheck


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
const __nodes = ["main"] as const;
type Node = (typeof __nodes)[number];

const graph = new PieMachine<State, Node>(__nodes, graphConfig);

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


graph.node("main", async (state): Promise<any> => {
    const __messages: Message[] = [];
    
    const x = 42;

return { ...state, data: x}

});

const initialState: State = {messages: [], data: {}};
const finalState = graph.run("main", initialState);
export async function main(data:any): Promise<any> {
  const result = await graph.run("main", { messages: [], data });
  return result.data;
}

export default graph;
