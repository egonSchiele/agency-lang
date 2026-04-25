// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/runnerIfElse.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `await runner.ifElse({{{id}}}, [
{{#branches}}
  {
    condition: async () => {{{this.condition}}},
    body: async (runner) => {
{{{this.body}}}
    },
  },
{{/branches}}
]{{#hasElse}}, async (runner) => {
{{{elseBranch}}}
}{{/hasElse}});`;

export type TemplateType = {
  id: string | boolean | number;
  branches: {
    condition: string | boolean | number;
    body: string | boolean | number;
  }[];
  hasElse: boolean;
  elseBranch: string | boolean | number;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    