



import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import * as readline from "readline";
import fs from "fs";
import { Graph, goToNode } from "simplemachine";
import { StatelogClient } from "statelog-client";
import { nanoid } from "nanoid";

const statelogHost = "http://localhost:1065";
const traceId = nanoid();
const statelogClient = new StatelogClient({host: statelogHost, tid: traceId});
const model = "gpt-5-nano-2025-08-07";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

type State = {
  messages: string[];
  data: any;
}

// enable debug logging
const graphConfig = {
  debug: {
    log: true,
    logData: true,
  },
  statelogHost,
  traceId
};

// Define the names of the nodes in the graph
// Useful for type safety
const nodes = ["importRecipe","createIngredient","main"] as const;
type Node = (typeof nodes)[number];

const graph = new Graph<State, Node>(nodes, graphConfig);
function add({a, b}: {a:number, b:number}):number {
  return a + b;
}

// Define the function tool for OpenAI
const addTool = {
    type: "function" as const,
    function: {
      name: "add",
      description:
        "Adds two numbers together and returns the result.",
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
  };

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
type Recipe = { title: string; ingredients: string[]; instructions: string };
type Url = { url: string };
type Recipe = { title: string; ingredients: string[]; instructions: string };

async function _url(msg: string): Promise<Url> {
  const prompt = `extract the url from this message: ${msg}`;
  const startTime = performance.now();
  const messages:any[] = [{ role: "user", content: prompt }];
  const tools = undefined;

  let completion = await openai.chat.completions.create({
    model,
    messages,
    tools,
    response_format: zodResponseFormat(z.object({
      value: z.object({ "url": z.string().describe("website url") })
    }), "url_response"),
  });
  const endTime = performance.now();
  statelogClient.promptCompletion({
    messages,
    completion,
    model,
    timeTaken: endTime - startTime,
  });

  let responseMessage = completion.choices[0].message;
  // Handle function calls
  while (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
    // Add assistant's response with tool calls to message history
    messages.push(responseMessage);
    let toolCallStartTime, toolCallEndTime;

    // Process each tool call
    for (const toolCall of responseMessage.tool_calls) {
      
    }

    const nextStartTime = performance.now();
    // Get the next response from the model
    completion = await openai.chat.completions.create({
      model,
      messages: messages,
      tools: tools,
    });
    const nextEndTime = performance.now();

    statelogClient.promptCompletion({
      messages,
      completion,
      model,
      timeTaken: nextEndTime - nextStartTime,
    });

    responseMessage = completion.choices[0].message;
  }

  // Add final assistant response to history
  messages.push(responseMessage);

  try {
  const result = JSON.parse(completion.choices[0].message.content || "");
  return result.value;
  } catch (e) {
    return completion.choices[0].message.content;
    // console.error("Error parsing response for variable 'url':", e);
    // console.error("Full completion response:", JSON.stringify(completion, null, 2));
    // throw e;
  }
}

async function _recipe(html: string): Promise<Recipe> {
  const prompt = `extract the recipe from this html: ${html}`;
  const startTime = performance.now();
  const messages:any[] = [{ role: "user", content: prompt }];
  const tools = undefined;

  let completion = await openai.chat.completions.create({
    model,
    messages,
    tools,
    response_format: zodResponseFormat(z.object({
      value: z.object({ "title": z.string(), "ingredients": z.array(z.string()), "instructions": z.string() })
    }), "recipe_response"),
  });
  const endTime = performance.now();
  statelogClient.promptCompletion({
    messages,
    completion,
    model,
    timeTaken: endTime - startTime,
  });

  let responseMessage = completion.choices[0].message;
  // Handle function calls
  while (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
    // Add assistant's response with tool calls to message history
    messages.push(responseMessage);
    let toolCallStartTime, toolCallEndTime;

    // Process each tool call
    for (const toolCall of responseMessage.tool_calls) {
      
    }

    const nextStartTime = performance.now();
    // Get the next response from the model
    completion = await openai.chat.completions.create({
      model,
      messages: messages,
      tools: tools,
    });
    const nextEndTime = performance.now();

    statelogClient.promptCompletion({
      messages,
      completion,
      model,
      timeTaken: nextEndTime - nextStartTime,
    });

    responseMessage = completion.choices[0].message;
  }

  // Add final assistant response to history
  messages.push(responseMessage);

  try {
  const result = JSON.parse(completion.choices[0].message.content || "");
  return result.value;
  } catch (e) {
    return completion.choices[0].message.content;
    // console.error("Error parsing response for variable 'recipe':", e);
    // console.error("Full completion response:", JSON.stringify(completion, null, 2));
    // throw e;
  }
}
graph.node("importRecipe", async (state) => {
    
    const msg = state.data;
    
    
const url = await _url(msg);


const html = await _builtinFetch(url.url);


const recipe = await _recipe(html);

console.log(recipe)
});
//  this is a comment
graph.node("createIngredient", async (state) => {
    
    const msg = state.data;
    
    console.log("tbd")
});

async function _category(msg: string): Promise<"import_recipe" | "create_ingredient"> {
  const prompt = `determine if the user wants to import a recipe from a website or create a new ingredient based on this message: ${msg}`;
  const startTime = performance.now();
  const messages:any[] = [{ role: "user", content: prompt }];
  const tools = undefined;

  let completion = await openai.chat.completions.create({
    model,
    messages,
    tools,
    response_format: zodResponseFormat(z.object({
      value: z.union([z.literal("import_recipe"), z.literal("create_ingredient")])
    }), "category_response"),
  });
  const endTime = performance.now();
  statelogClient.promptCompletion({
    messages,
    completion,
    model,
    timeTaken: endTime - startTime,
  });

  let responseMessage = completion.choices[0].message;
  // Handle function calls
  while (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
    // Add assistant's response with tool calls to message history
    messages.push(responseMessage);
    let toolCallStartTime, toolCallEndTime;

    // Process each tool call
    for (const toolCall of responseMessage.tool_calls) {
      
    }

    const nextStartTime = performance.now();
    // Get the next response from the model
    completion = await openai.chat.completions.create({
      model,
      messages: messages,
      tools: tools,
    });
    const nextEndTime = performance.now();

    statelogClient.promptCompletion({
      messages,
      completion,
      model,
      timeTaken: nextEndTime - nextStartTime,
    });

    responseMessage = completion.choices[0].message;
  }

  // Add final assistant response to history
  messages.push(responseMessage);

  try {
  const result = JSON.parse(completion.choices[0].message.content || "");
  return result.value;
  } catch (e) {
    return completion.choices[0].message.content;
    // console.error("Error parsing response for variable 'category':", e);
    // console.error("Full completion response:", JSON.stringify(completion, null, 2));
    // throw e;
  }
}
graph.node("main", async (state) => {
    
    const msg = await _builtinInput("> ");


const category = await _category(msg);

switch (category) {
  case "import_recipe":
return goToNode("importRecipe", { messages: state.messages, data: msg });

    break;
  case "create_ingredient":
return goToNode("createIngredient", { messages: state.messages, data: msg });

    break;
}
});

graph.conditionalEdge("main", ["importRecipe","createIngredient"]);

const initialState: State = {messages: [], data: {}};
const finalState = graph.run("main", initialState);
