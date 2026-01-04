

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



const message = await _builtinInput("Please enter a message: ");

async function _sentiment(message: string): Promise<"happy" | "sad" | "neutral"> {
  const prompt = `Categorize the sentiment in this message: \"${message}\"`;
  const startTime = performance.now();
  console.log("Running prompt for sentiment")
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
      value: z.union([z.literal("happy"), z.literal("sad"), z.literal("neutral")])
    }), "sentiment_response"),
  });
  const endTime = performance.now();
  console.log("Prompt for variable 'sentiment' took " + (endTime - startTime).toFixed(2) + " ms");
  console.log("Completion response:", JSON.stringify(completion, null, 2));
  try {
  const result = JSON.parse(completion.choices[0].message.content || "");
  console.log("sentiment:", result.value);
  return result.value;
  } catch (e) {
    console.error("Error parsing response for variable 'sentiment':", e);
    console.error("Full completion response:", JSON.stringify(completion, null, 2));
    throw e;
  }
}
const sentiment = await _sentiment(message);
console.log(sentiment)

