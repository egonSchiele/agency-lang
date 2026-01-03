

import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import * as readline from "readline";
import fs from "fs";
import { Graph } from "simplemachine";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

type State = Record<string, any>;
// enable debug logging
const graphConfig = {
  debug: {
    log: true,
    logData: true,
  },
  statelogHost: "http://localhost:1065",
};

// Define the names of the nodes in the graph
// Useful for type safety
const nodes = ["llm"] as const;
type Node = (typeof nodes)[number];

const graph = new Graph<State, Node>(nodes, graphConfig);

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



const msg = await _builtinInput("> ");
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
const category = await _category(msg);
async function _action(input: string): Promise<string> {
  const prompt = `Given this input, decide what action to take: ${input}`;
  const startTime = performance.now();
  console.log("Running prompt for action")
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
    }), "action_response"),
  });
  const endTime = performance.now();
  console.log("Prompt for variable 'action' took " + (endTime - startTime).toFixed(2) + " ms");
  try {
  const result = JSON.parse(completion.choices[0].message.content || "");
  console.log("action:", result.value);
  return result.value;
  } catch (e) {
    console.error("Error parsing response for variable 'action':", e);
    console.error("Full completion response:", JSON.stringify(completion, null, 2));
    throw e;
  }
}
graph.node("llm", async (state) => {
    const input = "foo";


const action = await _action(input);

switch (action) {
  case "tool_call":
tool_call()
    break;
  case "exit":
exit()
    break;
}
});

const initialState: State = {};
const finalState = graph.run("llm", initialState);

