// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/graphGenerator/runNodeFunction.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `{{#hasArgs}}
export async function {{{nodeName:string}}}({{{argsStr:string}}}, { messages } = {}): Promise<{{{returnType:string}}}> {
{{/hasArgs}}
{{^hasArgs}}
export async function {{{nodeName:string}}}({ messages } = {}): Promise<{{{returnType:string}}}> {
{{/hasArgs}}
  const data = [ {{{argsStr:string}}} ];
  const result = await graph.run("{{{nodeName:string}}}", { messages: messages || [], data });
  return result.data;
}
`;

export type TemplateType = {
  hasArgs: boolean;
  nodeName: string;
  argsStr: string;
  returnType: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    