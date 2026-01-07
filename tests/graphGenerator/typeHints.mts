



import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import * as readline from "readline";
import fs from "fs";
import { Graph, goToNode } from "simplemachine";
import { StatelogClient } from "statelog-client";
import { nanoid } from "nanoid";

const statelogHost = "http://localhost:1065";
const traceId = nanoid();
const statelogClient = new StatelogClient({host: statelogHost, tid: traceId});
const model = "gpt-4.1-nano-2025-04-14";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
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
  statelogHost,
  traceId
};

// Define the names of the nodes in the graph
// Useful for type safety
const nodes = ["main"] as const;
type Node = (typeof nodes)[number];

const graph = new Graph<State, Node>(nodes, graphConfig);
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
  const messages:any[] = [{ role: "user", content: prompt }];
  const tools = undefined;

  let completion = await openai.chat.completions.create({
    model,
    messages,
    tools,
    response_format: zodResponseFormat(z.object({
      value: z.number()
    }), "count_response"),
  });
  const endTime = performance.now();
  statelogClient.promptCompletion({
    messages,
    completion,
    model,
    timeTaken: endTime - startTime,
  });

  let responseMessage = completion.choices[0].message;
  // Handle function calls
  while (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
    // Add assistant's response with tool calls to message history
    messages.push(responseMessage);
    let toolCallStartTime, toolCallEndTime;

    // Process each tool call
    for (const toolCall of responseMessage.tool_calls) {
      
    }

    const nextStartTime = performance.now();
    // Get the next response from the model
    completion = await openai.chat.completions.create({
      model,
      messages: messages,
      tools: tools,
    });
    const nextEndTime = performance.now();

    statelogClient.promptCompletion({
      messages,
      completion,
      model,
      timeTaken: nextEndTime - nextStartTime,
    });

    responseMessage = completion.choices[0].message;
  }

  // Add final assistant response to history
  messages.push(responseMessage);

  try {
  const result = JSON.parse(completion.choices[0].message.content || "");
  return result.value;
  } catch (e) {
    return completion.choices[0].message.content;
    // console.error("Error parsing response for variable 'count':", e);
    // console.error("Full completion response:", JSON.stringify(completion, null, 2));
    // throw e;
  }
}

async function _message(): Promise<string> {
  const prompt = `a greeting message`;
  const startTime = performance.now();
  const messages:any[] = [{ role: "user", content: prompt }];
  const tools = undefined;

  let completion = await openai.chat.completions.create({
    model,
    messages,
    tools,
    response_format: zodResponseFormat(z.object({
      value: z.string()
    }), "message_response"),
  });
  const endTime = performance.now();
  statelogClient.promptCompletion({
    messages,
    completion,
    model,
    timeTaken: endTime - startTime,
  });

  let responseMessage = completion.choices[0].message;
  // Handle function calls
  while (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
    // Add assistant's response with tool calls to message history
    messages.push(responseMessage);
    let toolCallStartTime, toolCallEndTime;

    // Process each tool call
    for (const toolCall of responseMessage.tool_calls) {
      
    }

    const nextStartTime = performance.now();
    // Get the next response from the model
    completion = await openai.chat.completions.create({
      model,
      messages: messages,
      tools: tools,
    });
    const nextEndTime = performance.now();

    statelogClient.promptCompletion({
      messages,
      completion,
      model,
      timeTaken: nextEndTime - nextStartTime,
    });

    responseMessage = completion.choices[0].message;
  }

  // Add final assistant response to history
  messages.push(responseMessage);

  try {
  const result = JSON.parse(completion.choices[0].message.content || "");
  return result.value;
  } catch (e) {
    return completion.choices[0].message.content;
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
