// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/internalFunctionCall.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `{{{awaitPrefix:string}}}{{{functionName:string}}}([{{{argsString:string}}}], {{{metadata:string}}});`;

export type TemplateType = {
  awaitPrefix: string;
  functionName: string;
  argsString: string;
  metadata: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    