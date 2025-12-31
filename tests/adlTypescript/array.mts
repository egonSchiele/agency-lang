import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import * as readline from "readline";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});



async function _numbers(): Promise<number[]> {
  const prompt = `the first 5 prime numbers`;
  const startTime = performance.now();
  const completion = await openai.chat.completions.create({
    model: "gpt-5-nano-2025-08-07",
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
    response_format: zodResponseFormat(z.object({
      value: z.array(z.number())
    }), "numbers_response"),
  });
  const endTime = performance.now();
  console.log("Prompt for variable 'numbers' took " + (endTime - startTime).toFixed(2) + " ms");
  try {
  const result = JSON.parse(completion.choices[0].message.content || "");
  return result.value;
  } catch (e) {
    console.error("Error parsing response for variable 'numbers':", e);
    console.error("Full completion response:", JSON.stringify(completion, null, 2));
    throw e;
  }
}
async function _greetings(): Promise<string[]> {
  const prompt = `a list of 3 common greetings in different languages`;
  const startTime = performance.now();
  const completion = await openai.chat.completions.create({
    model: "gpt-5-nano-2025-08-07",
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
    response_format: zodResponseFormat(z.object({
      value: z.array(z.string())
    }), "greetings_response"),
  });
  const endTime = performance.now();
  console.log("Prompt for variable 'greetings' took " + (endTime - startTime).toFixed(2) + " ms");
  try {
  const result = JSON.parse(completion.choices[0].message.content || "");
  return result.value;
  } catch (e) {
    console.error("Error parsing response for variable 'greetings':", e);
    console.error("Full completion response:", JSON.stringify(completion, null, 2));
    throw e;
  }
}
const numbers = await _numbers();
console.log(numbers)
const greetings = await _greetings();
console.log(greetings)