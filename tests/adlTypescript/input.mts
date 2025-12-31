import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import * as readline from "readline";
import fs from "fs";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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

async function _sentiment(message: string): Promise<"happy" | "sad" | "neutral"> {
  const prompt = `Categorize the sentiment in this message: \"${message}\"`;
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
      value: z.union([z.literal("happy"), z.literal("sad"), z.literal("neutral")])
    }), "sentiment_response"),
  });
  const endTime = performance.now();
  console.log("Prompt for variable 'sentiment' took " + (endTime - startTime).toFixed(2) + " ms");
  try {
  const result = JSON.parse(completion.choices[0].message.content || "");
  return result.value;
  } catch (e) {
    console.error("Error parsing response for variable 'sentiment':", e);
    console.error("Full completion response:", JSON.stringify(completion, null, 2));
    throw e;
  }
}
const message = await _builtinInput("Please enter a message: ");
const sentiment = await _sentiment(message);
console.log(sentiment)