// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/graphGenerator/imports.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `import OpenAI from "openai";
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
const nodes = {{{nodes:string}}} as const;
type Node = (typeof nodes)[number];

const graph = new Graph<State, Node>(nodes, graphConfig);`;

export type TemplateType = {
  nodes: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    