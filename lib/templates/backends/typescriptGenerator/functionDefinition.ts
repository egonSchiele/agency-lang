// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/functionDefinition.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `async function {{{functionName:string}}}({{{args}}}) : Promise<{{{returnType}}}> {
    {{{functionBody}}}
}`;

export type TemplateType = {
  functionName: string;
  args: string | boolean | number;
  returnType: string | boolean | number;
  functionBody: string | boolean | number;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    