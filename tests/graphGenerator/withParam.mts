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

graph.node("main", async (state): Promise<any> => {
    const __messages: Message[] = [];
    
    const [input] = state.data;
    
    __nodesTraversed.push("main");
    


async function _result(input: string, __messages: Message[] = []): Promise<string> {
  const __prompt = `process this input: ${input}`;
  const startTime = performance.now();
  __messages.push(userMessage(__prompt));
  const __tools = undefined;

  
  
  const __responseFormat = undefined;
  

  const __client = getClientWithConfig({});

  let __completion = await __client.text({
    messages: __messages,
    tools: __tools,
    responseFormat: __responseFormat,
  });

  const endTime = performance.now();
  statelogClient.promptCompletion({
    messages: __messages,
    completion: __completion,
    model: __client.getModel(),
    timeTaken: endTime - startTime,
  });

  if (!__completion.success) {
    throw new Error(
      `Error getting response from ${__model}: ${__completion.error}`
    );
  }

  let responseMessage = __completion.value;

  // Handle function calls
  while (responseMessage.toolCalls.length > 0) {
    // Add assistant's response with tool calls to message history
    __messages.push(assistantMessage(responseMessage.output, { toolCalls: responseMessage.toolCalls }));
    let toolCallStartTime, toolCallEndTime;
    let haltExecution = false;

    // Process each tool call
    for (const toolCall of responseMessage.toolCalls) {
      
    }

    if (haltExecution) {
      statelogClient.debug(`Tool call interrupted execution.`, {
        messages: __messages,
        model: __client.getModel(),
      });
      try {
        const obj = JSON.parse(__messages.at(-1).content);
        obj.__messages = __messages;
        obj.__nodesTraversed = __nodesTraversed;
        return obj;
      } catch (e) {
        return __messages.at(-1).content;
      }
      //return __messages;
    }
  
    const nextStartTime = performance.now();
    let __completion = await __client.text({
      messages: __messages,
      tools: __tools,
      responseFormat: __responseFormat,
    });

    const nextEndTime = performance.now();

    statelogClient.promptCompletion({
      messages: __messages,
      completion: __completion,
      model: __client.getModel(),
      timeTaken: nextEndTime - nextStartTime,
    });

    if (!__completion.success) {
      throw new Error(
        `Error getting response from ${__model}: ${__completion.error}`
      );
    }
    responseMessage = __completion.value;
  }

  // Add final assistant response to history
  // not passing tool calls back this time
  __messages.push(assistantMessage(responseMessage.output));
  

  
  return responseMessage.output;
  
}

const result = await _result(input, __messages);


await console.log(result)

});

const initialState: State = {messages: [], data: {}};
const finalState = graph.run("main", initialState);
export async function main(data): Promise<any> {
  const result = await graph.run("main", { messages: [], data });
  return result.data;
}

export default graph;