

import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import * as readline from "readline";
import fs from "fs";

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
  const prompt = `the 10th fibonacci number`;
  const startTime = performance.now();
  const messages:any[] = [{ role: "user", content: prompt }];
  const tools = undefined;
  console.log("Running prompt for bar")
  let completion = await openai.chat.completions.create({
    model: "gpt-5-nano-2025-08-07",
    messages,
    tools,
    response_format: zodResponseFormat(z.object({
      value: z.number()
    }), "bar_response"),
  });
  const endTime = performance.now();
  console.log("Prompt for variable 'bar' took " + (endTime - startTime).toFixed(2) + " ms");
  console.log("Completion response:", JSON.stringify(completion, null, 2));

  let responseMessage = completion.choices[0].message;
  // Handle function calls
  while (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
    // Add assistant's response with tool calls to message history
    messages.push(responseMessage);

    // Process each tool call
    for (const toolCall of responseMessage.tool_calls) {
      
    }

    // Get the next response from the model
    completion = await openai.chat.completions.create({
      model: "gpt-5-nano-2025-08-07",
      messages: messages,
      tools: tools,
    });

    responseMessage = completion.choices[0].message;
  }

  // Add final assistant response to history
  messages.push(responseMessage);

  try {
  const result = JSON.parse(completion.choices[0].message.content || "");
  console.log("bar:", result.value);
  return result.value;
  } catch (e) {
    console.error("Error parsing response for variable 'bar':", e);
    console.error("Full completion response:", JSON.stringify(completion, null, 2));
    throw e;
  }
}
const bar = await _bar();
console.log(bar)

