import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import * as readline from "readline";
import fs from "fs";
import { StatelogClient } from "statelog-client";
import { nanoid } from "nanoid";

const statelogHost = "http://localhost:1065";
const traceId = nanoid();
const statelogClient = new StatelogClient({
    host: statelogHost,
    traceId: traceId,
    apiKey: process.env.STATELOG_API_KEY || "",
    projectId: "agency-lang",
    debugMode: true,
  });

const model = "gpt-5-nano-2025-08-07";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
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


async function _numbers(): Promise<number[]> {
  const __prompt = `the first 5 prime numbers`;
  const startTime = performance.now();
  const __messages: Message[] = [userMessage(__prompt)];
  const __tools = undefined;

  
  // Need to make sure this is always an object
  const __responseFormat = z.object({
     response: z.array(z.number())
  });
  
  

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
  __messages.push(assistantMessage(responseMessage.output, { toolCalls: responseMessage.toolCalls }));
  
  try {
  const result = JSON.parse(responseMessage.output || "");
  return result.response;
  } catch (e) {
    return responseMessage.output;
    // console.error("Error parsing response for variable 'numbers':", e);
    // console.error("Full completion response:", JSON.stringify(__completion, null, 2));
    // throw e;
  }
  

  
}
const numbers = await _numbers();
await console.log(numbers)
async function _greetings(): Promise<string[]> {
  const __prompt = `a list of 3 common greetings in different languages`;
  const startTime = performance.now();
  const __messages: Message[] = [userMessage(__prompt)];
  const __tools = undefined;

  
  // Need to make sure this is always an object
  const __responseFormat = z.object({
     response: z.array(z.string())
  });
  
  

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
  __messages.push(assistantMessage(responseMessage.output, { toolCalls: responseMessage.toolCalls }));
  
  try {
  const result = JSON.parse(responseMessage.output || "");
  return result.response;
  } catch (e) {
    return responseMessage.output;
    // console.error("Error parsing response for variable 'greetings':", e);
    // console.error("Full completion response:", JSON.stringify(__completion, null, 2));
    // throw e;
  }
  

  
}
const greetings = await _greetings();
await console.log(greetings)