import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import * as readline from "readline";
import fs from "fs";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});



async function _bar(): Promise<number> {
  const prompt = `the number 1`;
  const startTime = performance.now();
  console.log("Running prompt for bar")
  const completion = await openai.chat.completions.create({
    model: "gpt-5-nano-2025-08-07",
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
    response_format: zodResponseFormat(z.object({
      value: z.number()
    }), "bar_response"),
  });
  const endTime = performance.now();
  console.log("Prompt for variable 'bar' took " + (endTime - startTime).toFixed(2) + " ms");
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