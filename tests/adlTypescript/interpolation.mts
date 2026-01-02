import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import * as readline from "readline";
import fs from "fs";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});



const name = "Alice";
async function _greeting(name: string): Promise<string> {
  const prompt = `say hi to ${name}`;
  const startTime = performance.now();
  console.log("Running prompt for greeting")
  const completion = await openai.chat.completions.create({
    model: "gpt-5-nano-2025-08-07",
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
    response_format: zodResponseFormat(z.object({
      value: z.string()
    }), "greeting_response"),
  });
  const endTime = performance.now();
  console.log("Prompt for variable 'greeting' took " + (endTime - startTime).toFixed(2) + " ms");
  try {
  const result = JSON.parse(completion.choices[0].message.content || "");
  console.log("greeting:", result.value);
  return result.value;
  } catch (e) {
    console.error("Error parsing response for variable 'greeting':", e);
    console.error("Full completion response:", JSON.stringify(completion, null, 2));
    throw e;
  }
}
const greeting = await _greeting(name);
console.log(greeting)