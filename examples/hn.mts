



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
const statelogClient = new StatelogClient({ host: statelogHost, tid: traceId });
const model = "gpt-4.1-nano-2025-04-14";

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
const nodes = ["main"] as const;
type Node = (typeof nodes)[number];

const graph = new Graph<State, Node>(nodes, graphConfig);
function add({ a, b }: { a: number, b: number }): number {
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

async function _builtinFetch(url: string, args: any = {}): any {
  const result = await fetch(url, args);
  try {
    const text = await result.text();
    return text;
  } catch (e) {
    throw new Error(`Failed to get text from ${url}: ${e}`);
  }
}



const getTopStoriesTool: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "getTopStories",
    description:
      "Get today's top hacker news stories.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
};
const getStoryTool: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "getStory",
    description:
      "Get details of a specific story",
    parameters: {
      type: "object",
      properties: { "storyId": { "type": "string", "description": "" } },
      required: ["storyId"],
      additionalProperties: false,
    },
  },
};
async function getTopStories({ }) {
  return _builtinFetch("https://hacker-news.firebaseio.com/v0/topstories.json")

} async function getStory({ storyId }) {
  return _builtinFetch(`https://hacker-news.firebaseio.com/v0/item/${storyId}.json`)

}
async function _storyTitles(): Promise<{ messages: any[]; value: string[] }> {
  const prompt = `Give me the titles for 2 of the top stories on Hacker News today. You can use the getTopStories tool to get a list of the top story IDs, and then use the getStory tool to get the details of each story.`;
  const startTime = performance.now();
  const messages: any[] = [{ role: "user", content: prompt }];
  const tools = [getTopStoriesTool, getStoryTool];
  const schema = z.object({
    value: z.array(z.string())
  })
  const response_format = zodResponseFormat(schema, "storyTitles_response");

  let completion = await openai.chat.completions.create({
    model,
    messages,
    tools,
    response_format
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
      if (toolCall.type === "function" &&
        toolCall.function.name === "getTopStories"
      ) {
        const args = JSON.parse(toolCall.function.arguments);

        toolCallStartTime = performance.now();
        const result = await getTopStories(args);
        toolCallEndTime = performance.now();

        console.log("Tool 'getTopStories' called with arguments:", args);
        console.log("Tool 'getTopStories' returned result:", result);

        statelogClient.toolCall({
          toolName: "getTopStories",
          args,
          output: result,
          model,
          timeTaken: toolCallEndTime - toolCallStartTime,
        });

        // Add function result to messages
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        });
      }
      if (toolCall.type === "function" &&
        toolCall.function.name === "getStory"
      ) {
        const args = JSON.parse(toolCall.function.arguments);

        toolCallStartTime = performance.now();
        const result = await getStory(args);
        toolCallEndTime = performance.now();

        console.log("Tool 'getStory' called with arguments:", args);
        console.log("Tool 'getStory' returned result:", result);

        statelogClient.toolCall({
          toolName: "getStory",
          args,
          output: result,
          model,
          timeTaken: toolCallEndTime - toolCallStartTime,
        });

        // Add function result to messages
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        });
      }
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
    const result = schema.parse(completion.choices[0].message.content || "");
    return { messages, value: result.value };
  } catch (e) {
    // ideally, retry
    return { messages, value: completion.choices[0].message.content };
    //console.error("Error parsing response for variable 'storyTitles':", e);
    //console.error("Full completion response:", JSON.stringify(completion, null, 2));
    //throw e;
  }
}
graph.node("main", async (state) => {




  const storyTitles = await _storyTitles();

  console.log(storyTitles)
  return (storyTitles.value)
});

const initialState: State = { messages: [], data: {} };
const finalState = graph.run("main", initialState);
