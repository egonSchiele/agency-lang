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
async function _category(msg: string): Promise<"import_recipe" | "create_ingredient"> {
  const prompt = `determine if the user wants to import a recipe from a website or create a new ingredient based on this message: ${msg}`;
  const startTime = performance.now();
  console.log("Running prompt for category")
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
  console.log("category:", result.value);
  return result.value;
  } catch (e) {
    console.error("Error parsing response for variable 'category':", e);
    console.error("Full completion response:", JSON.stringify(completion, null, 2));
    throw e;
  }
}
async function importRecipe() {
async function _url(msg: string): Promise<Url> {
  const prompt = `extract the url from this message: ${msg}`;
  const startTime = performance.now();
  console.log("Running prompt for url")
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
  console.log("url:", result.value);
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
  console.log("Running prompt for recipe")
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
  console.log("recipe:", result.value);
  return result.value;
  } catch (e) {
    console.error("Error parsing response for variable 'recipe':", e);
    console.error("Full completion response:", JSON.stringify(completion, null, 2));
    throw e;
  }
}
const url = await _url(msg);
const html = await _builtinFetch(url
.url);
const recipe = await _recipe(html);
return console.log(recipe)


}
async function createIngredient() {
return console.log("tbd")


}
const msg = await _builtinInput("> ");
const category = await _category(msg);
//  this is a comment
switch (category) {
  case "import_recipe":
    importRecipe()
    
    break;
  case "create_ingredient":
    createIngredient()
    
    break;
}
