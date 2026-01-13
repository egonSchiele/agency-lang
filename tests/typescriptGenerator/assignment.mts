



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






async function _bar(): Promise<number> {
  const prompt = `the number 1`;
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
    // console.error("Error parsing response for variable 'bar':", e);
    // console.error("Full completion response:", JSON.stringify(completion, null, 2));
    // throw e;
  }
}
const bar = await _bar();


