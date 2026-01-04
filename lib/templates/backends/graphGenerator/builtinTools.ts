// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/graphGenerator/builtinTools.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `function add({a, b}: {a:number, b:number}):number {
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
  };`;

export type TemplateType = {
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    