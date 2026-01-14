// @ts-nocheck
import { z } from "zod";
import * as readline from "readline";
import fs from "fs";
import { PieMachine, goToNode } from "piemachine";
import { StatelogClient } from "statelog-client";
import { nanoid } from "nanoid";
import { assistantMessage, getClient, userMessage } from "smoltalk";
import path from "path";
const __dirname = "/Users/adit/new-meal-app/src/backend/lib/agent/agency";
const statelogHost = "https://statelog.adit.io";
const traceId = nanoid();
const statelogConfig = {
  host: statelogHost,
  traceId: traceId,
  apiKey: process.env.STATELOG_API_KEY || "",
  projectId: "agency-lang",
  debugMode: false,
};

const statelogClient = new StatelogClient(statelogConfig);
const __model: ModelName = "gpt-4o-mini";

const getClientWithConfig = (config = {}) => {
  const defaultConfig = {
    openAiApiKey: process.env.OPENAI_API_KEY || "",
    googleApiKey: process.env.GEMINI_API_KEY || "",
    model: __model,
    logLevel: "warn",
  };

  return getClient({ ...defaultConfig, ...config });
};

let __client = getClientWithConfig();

type State = {
  messages: string[];
  data: any;
};

// enable debug logging
const graphConfig = {
  debug: {
    log: true,
    logData: true,
  },
  statelog: statelogConfig,
};

// Define the names of the nodes in the graph
// Useful for type safety
const __nodes = ["route"] as const;
type Node = (typeof __nodes)[number];

const graph = new PieMachine<State, Node>(__nodes, graphConfig);
function add({ a, b }: { a: number; b: number }): number {
  return a + b;
}

// Define the function tool for OpenAI
const addTool = {
  type: "function" as const,
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
};

function _builtinRead(filename: string): string {
  const data = fs.readFileSync(filename);
  const contents = data.toString("utf8");
  return contents;
}

//  - When users want a list of their ingredients, go to step "get_user_ingredients"
//  - when users want to add ingredients to their pantry, go to step "create_ingredients"
//  - when users want to edit or update existing ingredients, go to step "edit_ingredients"
//  - when users want to create a new meal or recipe, go to step "create_meal"
//  - when users provide a URL to import a recipe from a website, go to step "import_recipe"
//  - If the user is just chatting or not requesting any action, go to step "none"

async function _response(
  instructions: string,
  msg: string
): Promise<
  | "get_user_ingredients"
  | "create_ingredients"
  | "edit_ingredients"
  | "create_meal"
  | "import_recipe"
  | "none"
> {
  const __prompt = `${instructions}. Respond to this user message: ${msg}`;
  const startTime = performance.now();
  const __messages: Message[] = [userMessage(__prompt)];
  const __tools = undefined;

  // Need to make sure this is always an object
  const __responseFormat = z.object({
    response: z.union([
      z.literal("get_user_ingredients"),
      z.literal("create_ingredients"),
      z.literal("edit_ingredients"),
      z.literal("create_meal"),
      z.literal("import_recipe"),
      z.literal("none"),
    ]),
  });

  console.log(__responseFormat.toJSONSchema);

  let __completion = await __client.text({
    messages: __messages,
    tools: __tools,
    responseFormat: __responseFormat,
  });

  const endTime = performance.now();
  statelogClient.promptCompletion({
    messages: __messages,
    completion: __completion,
    model: __client.getModel(),
    timeTaken: endTime - startTime,
  });

  if (!__completion.success) {
    throw new Error(
      `Error getting response from ${__model}: ${__completion.error}`
    );
  }

  let responseMessage = __completion.value;

  // Handle function calls
  while (responseMessage.toolCalls.length > 0) {
    // Add assistant's response with tool calls to message history
    __messages.push(assistantMessage(responseMessage.output));
    let toolCallStartTime, toolCallEndTime;

    // Process each tool call
    for (const toolCall of responseMessage.toolCalls) {
    }

    const nextStartTime = performance.now();
    let __completion = await __client.text({
      messages: __messages,
      tools: __tools,
      responseFormat: __responseFormat,
    });

    const nextEndTime = performance.now();

    statelogClient.promptCompletion({
      messages: __messages,
      completion: __completion,
      model: __client.getModel(),
      timeTaken: nextEndTime - nextStartTime,
    });

    if (!__completion.success) {
      throw new Error(
        `Error getting response from ${__model}: ${__completion.error}`
      );
    }
    responseMessage = __completion.value;
  }

  // Add final assistant response to history
  __messages.push(assistantMessage(responseMessage.output));

  try {
    const result = JSON.parse(responseMessage.output || "");
    return result.response;
  } catch (e) {
    return responseMessage.output;
    // console.error("Error parsing response for variable 'response':", e);
    // console.error("Full completion response:", JSON.stringify(__completion, null, 2));
    // throw e;
  }
}
graph.node("route", async (state) => {
  const msg = state.data;

  const instructions = await _builtinRead(
    path.join(__dirname, "./prompts/router.md")
  );

  const response = await _response(instructions, msg);

  return { ...state, data: response };
});

export async function route(data: any): Promise<any> {
  const result = await graph.run("route", { messages: [], data });
  return result.data;
}

export default graph;
