

import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import * as readline from "readline";
import fs from "fs";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
function add(a:number, b:number):number {
  return a + b;
}

// Define the function tool for OpenAI
const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
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
  },
];





type Coords = { x: number; y: number };
async function _foo(): Promise<Coords> {
  const prompt = `a set of coordinates`;
  const startTime = performance.now();
  console.log("Running prompt for foo")
  const completion = await openai.chat.completions.create({
    model: "gpt-5-nano-2025-08-07",
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
    tools: tools,
    response_format: zodResponseFormat(z.object({
      value: z.object({ "x": z.number(), "y": z.number() })
    }), "foo_response"),
  });
  const endTime = performance.now();
  console.log("Prompt for variable 'foo' took " + (endTime - startTime).toFixed(2) + " ms");
  console.log("Completion response:", JSON.stringify(completion, null, 2));
  try {
  const result = JSON.parse(completion.choices[0].message.content || "");
  console.log("foo:", result.value);
  return result.value;
  } catch (e) {
    console.error("Error parsing response for variable 'foo':", e);
    console.error("Full completion response:", JSON.stringify(completion, null, 2));
    throw e;
  }
}
const foo = await _foo();
console.log(foo)

