



import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
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
const model = "gpt-4o-mini";

const client = getClient({
  openAiApiKey: process.env.OPENAI_API_KEY || "",
  googleApiKey: process.env.GEMINI_API_KEY || "",
  model,
  logLevel: "warn",
});

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
const nodes = ["main"] as const;
type Node = (typeof nodes)[number];

const graph = new PieMachine<State, Node>(nodes, graphConfig);
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






async function _count(): Promise<number> {
  const prompt = `the number 42`;
  const startTime = performance.now();
  const messages: Message[] = [userMessage(prompt)];
  const tools = undefined;

  // Need to make sure this is always an object
  const responseFormat = z.object({
     response: z.number()
  });

  let completion = await client.text({
    messages,
    tools,
    responseFormat,
  });

  const endTime = performance.now();
  statelogClient.promptCompletion({
    messages,
    completion,
    model,
    timeTaken: endTime - startTime,
  });

  if (!completion.success) {
    throw new Error(
      `Error getting response from ${model}: ${completion.error}`
    );
  }

  let responseMessage = completion.value;

  // Handle function calls
  while (responseMessage.toolCalls.length > 0) {
    // Add assistant's response with tool calls to message history
    messages.push(assistantMessage(responseMessage.output));
    let toolCallStartTime, toolCallEndTime;

    // Process each tool call
    for (const toolCall of responseMessage.toolCalls) {
      
    }

    const nextStartTime = performance.now();
    let completion = await client.text({
      messages,
      tools,
      responseFormat,
    });

    const nextEndTime = performance.now();

    statelogClient.promptCompletion({
      messages,
      completion,
      model,
      timeTaken: nextEndTime - nextStartTime,
    });

    if (!completion.success) {
      throw new Error(
        `Error getting response from ${model}: ${completion.error}`
      );
    }
    responseMessage = completion.value;
  }

  // Add final assistant response to history
  messages.push(assistantMessage(responseMessage.output));

  try {
  const result = JSON.parse(responseMessage.output || "");
  return result.response;
  } catch (e) {
    return responseMessage.output;
    // console.error("Error parsing response for variable 'count':", e);
    // console.error("Full completion response:", JSON.stringify(completion, null, 2));
    // throw e;
  }
}

async function _message(): Promise<string> {
  const prompt = `a greeting message`;
  const startTime = performance.now();
  const messages: Message[] = [userMessage(prompt)];
  const tools = undefined;

  // Need to make sure this is always an object
  const responseFormat = z.object({
     response: z.string()
  });

  let completion = await client.text({
    messages,
    tools,
    responseFormat,
  });

  const endTime = performance.now();
  statelogClient.promptCompletion({
    messages,
    completion,
    model,
    timeTaken: endTime - startTime,
  });

  if (!completion.success) {
    throw new Error(
      `Error getting response from ${model}: ${completion.error}`
    );
  }

  let responseMessage = completion.value;

  // Handle function calls
  while (responseMessage.toolCalls.length > 0) {
    // Add assistant's response with tool calls to message history
    messages.push(assistantMessage(responseMessage.output));
    let toolCallStartTime, toolCallEndTime;

    // Process each tool call
    for (const toolCall of responseMessage.toolCalls) {
      
    }

    const nextStartTime = performance.now();
    let completion = await client.text({
      messages,
      tools,
      responseFormat,
    });

    const nextEndTime = performance.now();

    statelogClient.promptCompletion({
      messages,
      completion,
      model,
      timeTaken: nextEndTime - nextStartTime,
    });

    if (!completion.success) {
      throw new Error(
        `Error getting response from ${model}: ${completion.error}`
      );
    }
    responseMessage = completion.value;
  }

  // Add final assistant response to history
  messages.push(assistantMessage(responseMessage.output));

  try {
  const result = JSON.parse(responseMessage.output || "");
  return result.response;
  } catch (e) {
    return responseMessage.output;
    // console.error("Error parsing response for variable 'message':", e);
    // console.error("Full completion response:", JSON.stringify(completion, null, 2));
    // throw e;
  }
}
graph.node("main", async (state) => {
    
    
const count = await _count();


const message = await _message();

console.log(count)
console.log(message)
});

const initialState: State = {messages: [], data: {}};
const finalState = graph.run("main", initialState);
