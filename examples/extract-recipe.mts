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

type Url = { url: string };
async function _category(msg: string): Promise<"import_recipe" | "create_ingredient"> {
  const prompt = `determine if the user wants to import a recipe from a website or create a new ingredient based on this message: ${msg}`;
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
      value: z.union([z.literal("import_recipe"), z.literal("create_ingredient")])
    }), "category_response"),
  });
  const endTime = performance.now();
  console.log("Prompt for variable 'category' took " + (endTime - startTime).toFixed(2) + " ms");
  try {
  const result = JSON.parse(completion.choices[0].message.content || "");
  return result.value;
  } catch (e) {
    console.error("Error parsing response for variable 'category':", e);
    console.error("Full completion response:", JSON.stringify(completion, null, 2));
    throw e;
  }
}
const msg = await _builtinInput("> ");
const category = await _category(msg);
