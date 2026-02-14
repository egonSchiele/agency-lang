// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/graphGenerator/runNodeFunction.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `{{#hasArgs}}
export async function {{{nodeName:string}}}({{{argsStr:string}}}, { messages, callbacks } = {}) {
{{/hasArgs}}
{{^hasArgs}}
export async function {{{nodeName:string}}}({ messages, callbacks } = {}) {
{{/hasArgs}}
  const __data = [ {{{argsStr:string}}} ];
  __callbacks = callbacks || {};
  const __result = await graph.run("{{{nodeName:string}}}", { messages: messages || [], data: __data });
  return __createReturnObject(__result);
}
`;

export type TemplateType = {
  hasArgs: boolean;
  nodeName: string;
  argsStr: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    