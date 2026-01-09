



import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import * as readline from "readline";
import fs from "fs";
import { Graph, goToNode } from "simplemachine";
import { StatelogClient } from "statelog-client";
import { nanoid } from "nanoid";
import { assistantMessage, getClient, Message, userMessage } from "smoltalk";

const statelogHost = "http://localhost:1065";
const traceId = nanoid();
const statelogClient = new StatelogClient({host: statelogHost, tid: traceId});
const model = "gpt-4o-mini";

const client = getClient({
  apiKey: process.env.OPENAI_API_KEY || "",
  model,
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
const nodes = ["greet","processGreeting","main"] as const;
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






async function _greeting(): Promise<string> {
  const prompt = `say hello`;
  const startTime = performance.now();
  const messages: Message[] = [userMessage(prompt)];
  const tools = undefined;

  const responseFormat = z.string();

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
  return result.value;
  } catch (e) {
    return responseMessage.output;
    // console.error("Error parsing response for variable 'greeting':", e);
    // console.error("Full completion response:", JSON.stringify(completion, null, 2));
    // throw e;
  }
}
graph.node("greet", async (state) => {
    
    
const greeting = await _greeting();

return goToNode("processGreeting", { messages: state.messages, data: greeting });

});

async function _result(msg: string): Promise<string> {
  const prompt = `format this greeting: ${msg}`;
  const startTime = performance.now();
  const messages: Message[] = [userMessage(prompt)];
  const tools = undefined;

  const responseFormat = z.string();

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
  return result.value;
  } catch (e) {
    return responseMessage.output;
    // console.error("Error parsing response for variable 'result':", e);
    // console.error("Full completion response:", JSON.stringify(completion, null, 2));
    // throw e;
  }
}
graph.node("processGreeting", async (state) => {
    
    const msg = state.data;
    
    
const result = await _result(msg);

console.log(result)
});
graph.node("main", async (state) => {
    
    return goToNode("greet", { messages: state.messages, data:  });

});

graph.conditionalEdge("greet", ["processGreeting"]);

graph.conditionalEdge("main", ["greet"]);

const initialState: State = {messages: [], data: {}};
const finalState = graph.run("main", initialState);
