// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/internalFunctionCall.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `{{{awaitPrefix:string}}}{{{functionName:string}}}([{{{argsString:string}}}], {
    statelogClient: {{{statelogClient:string}}},
    graph: {{{graph:string}}},
    messages: {{{messages:string}}},
    threadId: {{{threadId:string}}}
})`;

export type TemplateType = {
  awaitPrefix: string;
  functionName: string;
  argsString: string;
  statelogClient: string;
  graph: string;
  messages: string;
  threadId: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    