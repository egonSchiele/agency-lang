// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/tool.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `export const __{{{name:string}}}Tool = {
  name: "{{{name:string}}}",
  description: \`{{{description:string}}}\`,
  schema: z.object({{{schema:string}}})
};

export const __{{{name:string}}}ToolParams = {{{parameters:string}}};`;

export type TemplateType = {
  name: string;
  description: string;
  schema: string;
  parameters: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    