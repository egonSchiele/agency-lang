// @ts-nocheck
import { z } from "zod";
import * as readline from "readline";
import fs from "fs";
import { PieMachine, goToNode } from "piemachine";
import { StatelogClient } from "statelog-client";
import { nanoid } from "nanoid";
import { assistantMessage, getClient, userMessage } from "smoltalk";

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
function add({a, b}: {a:number, b:number}):number {
  return a + b;
}

// Define the function tool for OpenAI
const addTool = {
    type: "function" as const,
    function: {
      name: "add",
      description:
        "Adds two numbers together and returns the result.",
      parameters: {
        type: "object",
        properties: {
          a: {
            type: "number",
            description: "The first number to add",
          },
          b: {
            type: "number",
            description: "The second number to add",
          },
        },
        required: ["a", "b"],
        additionalProperties: false,
      },
    },
  };


async function _greeting(): Promise<string> {
  const __prompt = `say hello`;
  const startTime = performance.now();
  const __messages: Message[] = [userMessage(__prompt)];
  const __tools = undefined;

  
  
  const __responseFormat = undefined;
  

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
    __messages.push(assistantMessage(responseMessage.output));
    let toolCallStartTime, toolCallEndTime;

    // Process each tool call
    for (const toolCall of responseMessage.toolCalls) {
      
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
  __messages.push(assistantMessage(responseMessage.output));
  

  
  return responseMessage.output;
  
}
graph.node("main", async (state) => {
    
    
const greeting = await _greeting();

console.log(greeting)
});

const initialState: State = {messages: [], data: {}};
const finalState = graph.run("main", initialState);
export async function main(data:any): Promise<any> {
  const result = await graph.run("main", { messages: [], data });
  return result.data;
}

export default graph;
