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

graph.node("main", async (state): Promise<any> => {
    const __messages: Message[] = state.messages || [];
    const __graph = state.__metadata?.graph || graph;
    const statelogClient = state.__metadata?.statelogClient || __statelogClient;
    
    const name = await await _builtinInput(`> `);



async function _fibs(__messages: Message[] = []): Promise<number[]> {
  const __prompt = `Generate a list of first 10 Fibonacci numbers.`;
  const startTime = performance.now();
  __messages.push(userMessage(__prompt));
  const __tools = undefined;

  
  // Need to make sure this is always an object
  const __responseFormat = z.object({
     response: z.array(z.number())
  });
  
  

  const __client = getClientWithConfig({});

  let __completion = await __client.text({
    messages: __messages,
    tools: __tools,
    responseFormat: __responseFormat,
  });

  const endTime = performance.now();
  await statelogClient.promptCompletion({
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
      await statelogClient.debug(`Tool call interrupted execution.`, {
        messages: __messages,
        model: __client.getModel(),
      });
      try {
        const obj = JSON.parse(__messages.at(-1).content);
        obj.__messages = __messages;
        obj.__nodesTraversed = __graph.getNodesTraversed();
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

    await statelogClient.promptCompletion({
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
  
  try {
  const result = JSON.parse(responseMessage.output || "");
  return result.response;
  } catch (e) {
    return responseMessage.output;
    // console.error("Error parsing response for variable 'fibs':", e);
    // console.error("Full completion response:", JSON.stringify(__completion, null, 2));
    // throw e;
  }
  

  
}

const fibs = await _fibs(__messages);


await console.log(`First 10 Fibonacci numbers: ${fibs}`)

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


});

graph.conditionalEdge("main", ["sayHi"]);

graph.merge(__graph___bar);
const initialState: State = {messages: [], data: {}};
const finalState = graph.run("main", initialState);
export async function main(): Promise<any> {
  const data = [  ];
  const result = await graph.run("main", { messages: [], data });
  return result.data;
}

export default graph;