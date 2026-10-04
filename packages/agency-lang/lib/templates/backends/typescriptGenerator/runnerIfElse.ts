// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/runnerIfElse.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `await runner.ifElse({{{id}}}, __run, [
{{#branches}}
  {
    condition: async (__run) => {{{this.condition}}},
    body: async (runner, __run) => {
{{{this.body}}}
    },
  },
{{/branches}}
]{{#hasElse}}, async (runner, __run) => {
{{{elseBranch}}}
}{{/hasElse}}{{{matchOpts}}});`;

export type TemplateType = {
  id: string | boolean | number;
  branches: {
    condition: string | boolean | number;
    body: string | boolean | number;
  }[];
  hasElse: boolean;
  elseBranch: string | boolean | number;
  matchOpts: string | boolean | number;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    