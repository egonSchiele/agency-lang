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
const nodes = [] as const;
type Node = (typeof nodes)[number];

const graph = new Graph<State, Node>(nodes, graphConfig);
function add(a: number, b: number): number {
  return a + b;
}

// Define the function tool for OpenAI
const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "add",
      description: "Adds two numbers together and returns the result.",
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
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(prompt, (answer: string) => {
      rl.close();
      resolve(answer);
    });
  });
}

const msg = await _builtinInput("> ");
async function _category(
  msg: string
): Promise<"import_recipe" | "create_ingredient"> {
  const prompt = `determine if the user wants to import a recipe from a website or create a new ingredient based on this message: ${msg}, or use the add tool to add two numbers together. Respond with either "import_recipe" or "create_ingredient", or call the add tool.`;
  const startTime = performance.now();
  console.log("Running prompt for category");
  const completion = await openai.chat.completions.create({
    model: "gpt-5-nano-2025-08-07",
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
    tools: tools,
    response_format: zodResponseFormat(
      z.object({
        value: z.union([
          z.literal("import_recipe"),
          z.literal("create_ingredient"),
        ]),
      }),
      "category_response"
    ),
  });
  const endTime = performance.now();
  console.log(
    "Prompt for variable 'category' took " +
      (endTime - startTime).toFixed(2) +
      " ms"
  );
  console.log("Completion response:", JSON.stringify(completion, null, 2));
  try {
    const result = JSON.parse(completion.choices[0].message.content || "");
    console.log("category:", result.value);
    return result.value;
  } catch (e) {
    console.error("Error parsing response for variable 'category':", e);
    console.error(
      "Full completion response:",
      JSON.stringify(completion, null, 2)
    );
    throw e;
  }
}
const category = await _category(msg);

const initialState: State = {};
const finalState = graph.run("", initialState);
