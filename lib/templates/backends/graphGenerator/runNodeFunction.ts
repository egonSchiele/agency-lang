// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/graphGenerator/runNodeFunction.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `export async function {{{nodeName:string}}}({{{argsStr:string}}}): Promise<{{{returnType:string}}}> {
  const data = [ {{{argsStr:string}}} ];
  const result = await graph.run("{{{nodeName:string}}}", { messages: [], data });
  return result.data;
}
`;

export type TemplateType = {
  nodeName: string;
  argsStr: string;
  returnType: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    