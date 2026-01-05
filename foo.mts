

import * as ext  from "./hello.mjs";

import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import * as readline from "readline";
import fs from "fs";
import { Graph, goToNode } from "simplemachine";
import { StatelogClient } from "statelog-client";

const statelogHost = "http://localhost:1065";
const statelogClient = new StatelogClient(statelogHost);
const model = "gpt-5-nano-2025-08-07";

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





const sayHelloTool: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: "function",
    function: {
      name: "sayHello",
      description:
        "No description provided.",
      parameters: {
        type: "object",
        properties: {"name":{"type":"string","description":""}},
        required: ["name"],
        additionalProperties: false,
      },
    },
  };
async function sayHello({name}) {
    return ext.hello(name)

}
async function _greeting(): Promise<string> {
  const prompt = `Greet John`;
  const startTime = performance.now();
  const messages:any[] = [{ role: "user", content: prompt }];
  const tools = [sayHelloTool];

  let completion = await openai.chat.completions.create({
    model,
    messages,
    tools,
    response_format: zodResponseFormat(z.object({
      value: z.string()
    }), "greeting_response"),
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
      if (toolCall.type === "function" &&
  toolCall.function.name === "sayHello"
) {
  const args = JSON.parse(toolCall.function.arguments);

  toolCallStartTime = performance.now();
  const result = await sayHello(args);
  toolCallEndTime = performance.now();

  console.log("Tool 'sayHello' called with arguments:", args);
  console.log("Tool 'sayHello' returned result:", result);

statelogClient.toolCall({
    toolName: "sayHello",
    args,
    output: result,
    model,
    timeTaken: toolCallEndTime - toolCallStartTime,
  });

  // Add function result to messages
  messages.push({
    role: "tool",
    tool_call_id: toolCall.id,
    content: JSON.stringify(result),
  });
}
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
    // console.error("Error parsing response for variable 'greeting':", e);
    // console.error("Full completion response:", JSON.stringify(completion, null, 2));
    // throw e;
  }
}
graph.node("main", async (state) => {
    
    

const greeting = await _greeting();

console.log(greeting)
});

const initialState: State = {messages: [], data: {}};
const finalState = graph.run("main", initialState);
