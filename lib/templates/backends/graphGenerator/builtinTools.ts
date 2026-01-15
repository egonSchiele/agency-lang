// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/graphGenerator/builtinTools.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `function add({a, b}: {a:number, b:number}):number {
  return a + b;
}

const addTool = {
  name: "add",
  description: "Adds two numbers together and returns the result.",
  schema: z.object({
    a: z.number().describe("The first number to add"),
    b: z.number().describe("The second number to add"),
  }),
};
`;

export type TemplateType = {
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    