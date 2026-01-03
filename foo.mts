

import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import * as readline from "readline";
import fs from "fs";
import { Graph } from "graph";

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
const nodes = ["msg","category"] as const;
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



type Url = { url: string };
let msg:any;

graph.node("msg", async (state) => {
  const innerFunc = async () => {
    return _builtinInput("> ")

  };
  msg = await innerFunc();
  return msg;
});
let category:any;

graph.node("category", async (state) => {
  const innerFunc = async function _category(msg: string): Promise<"import_recipe" | "create_ingredient"> {
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
;
  category = await innerFunc(msg);
  return category;
});

graph.edge("msg", "category");

const initialState: State = {};
const finalState = graph.run("msg", initialState);

