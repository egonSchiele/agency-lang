

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
};

// Define the names of the nodes in the graph
// Useful for type safety
const nodes = ["foo","bar","baz"] as const;
type Node = (typeof nodes)[number];

const graph = new Graph<State, Node>(nodes, graphConfig);





let foo:any;

graph.node("foo", async (state) => {
  const innerFunc = async () => {
    return [1, 2, 3]

  };
  foo = await innerFunc();
  return foo;
});
let bar:any;

graph.node("bar", async (state) => {
  const innerFunc = async () => {
    return {"name": "adl", "version": foo}

  };
  bar = await innerFunc();
  return bar;
});
let baz:any;

graph.node("baz", async (state) => {
  const innerFunc = async () => {
    return async function _promptFunc(): Promise<string> {
  const prompt = `say hello to alice`;
  const startTime = performance.now();
  console.log("Running prompt for promptFunc")
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
    }), "promptFunc_response"),
  });
  const endTime = performance.now();
  console.log("Prompt for variable 'promptFunc' took " + (endTime - startTime).toFixed(2) + " ms");
  try {
  const result = JSON.parse(completion.choices[0].message.content || "");
  console.log("promptFunc:", result.value);
  return result.value;
  } catch (e) {
    console.error("Error parsing response for variable 'promptFunc':", e);
    console.error("Full completion response:", JSON.stringify(completion, null, 2));
    throw e;
  }
}
();

  };
  baz = await innerFunc();
  return baz;
});

graph.edge("foo", "bar");

graph.edge("bar", "baz");

const initialState: State = {};
const finalState = graph.run("foo", initialState);

