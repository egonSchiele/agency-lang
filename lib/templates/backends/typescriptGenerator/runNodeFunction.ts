// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/runNodeFunction.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `{{#hasArgs}}
export async function {{{nodeName:string}}}({{{argsStr:string}}}, { messages, callbacks }: { messages?: any; callbacks?: any } = {}) {
{{/hasArgs}}
{{^hasArgs}}
export async function {{{nodeName:string}}}({ messages, callbacks }: { messages?: any; callbacks?: any } = {}) {
{{/hasArgs}}
  return runNode({
    ctx: __globalCtx,
    nodeName: "{{{nodeName:string}}}",
    data: { {{{argsStr:string}}} },
    messages,
    callbacks,
  });
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
    