// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/internalFunctionCall.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `{{{awaitPrefix:string}}}{{{functionName:string}}}({{{argsString:string}}}{{#hasArgs}}, {{/hasArgs}}{
    statelogClient: {{{statelogClient:string}}},
    graph: {{{graph:string}}},
    threads: __threads
})`;

export type TemplateType = {
  awaitPrefix: string;
  functionName: string;
  argsString: string;
  hasArgs: boolean;
  statelogClient: string;
  graph: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    