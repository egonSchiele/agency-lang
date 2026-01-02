

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
const nodes = ["foo","bar"] as const;
type Node = (typeof nodes)[number];

const graph = new Graph<State, Node>(nodes, graphConfig);





graph.node("foo", async (state) => {
  return [1, 2, 3]

});graph.node("bar", async (state) => {
  return {"name": "adl", "version": 1.0}

});
graph.edge("foo", "bar");

const initialState: State = {};
const finalState = graph.run("foo", initialState);

