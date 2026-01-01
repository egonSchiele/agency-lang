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

async function _builtinFetch(url: string, args: any): any {
  const result = await fetch(url, args);
  try {
    const text = await result.text();
    return text;
  } catch (e) {
    throw new Error(`Failed to get text from ${url}: ${e}`);
  }
}

type Url = { url: string };
async function _url(msg: string): Promise<Url> {
  const prompt = `extract the url from this message: ${msg}`;
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
      value: z.object({ "url": z.string().describe("website url") })
    }), "url_response"),
  });
  const endTime = performance.now();
  console.log("Prompt for variable 'url' took " + (endTime - startTime).toFixed(2) + " ms");
  try {
  const result = JSON.parse(completion.choices[0].message.content || "");
  return result.value;
  } catch (e) {
    console.error("Error parsing response for variable 'url':", e);
    console.error("Full completion response:", JSON.stringify(completion, null, 2));
    throw e;
  }
}
async function _recipe(html: string): Promise<string> {
  const prompt = `extract the recipe from this html: ${html}`;
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
      value: z.string()
    }), "recipe_response"),
  });
  const endTime = performance.now();
  console.log("Prompt for variable 'recipe' took " + (endTime - startTime).toFixed(2) + " ms");
  try {
  const result = JSON.parse(completion.choices[0].message.content || "");
  return result.value;
  } catch (e) {
    console.error("Error parsing response for variable 'recipe':", e);
    console.error("Full completion response:", JSON.stringify(completion, null, 2));
    throw e;
  }
}
const msg = await _builtinInput("> ");
const url = await _url(msg);
const html = await _builtinFetch(url
.url);
const recipe = await _recipe(html);
console.log(recipe)
