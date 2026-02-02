// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/tool.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `const {{{name:string}}}Tool = {
  name: "{{{name:string}}}",
  description: \`{{{description:string}}}\`,
  schema: z.object({{{schema:string}}})
};
`;

export type TemplateType = {
  name: string;
  description: string;
  schema: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    