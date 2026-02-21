// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/builtinFunctions/system.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `__threads.active().push(smoltalk.systemMessage({{{systemMessage:string}}}));
`;

export type TemplateType = {
  systemMessage: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    