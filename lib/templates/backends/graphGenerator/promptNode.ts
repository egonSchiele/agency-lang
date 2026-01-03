// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/graphGenerator/promptNode.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `let {{{name:string}}}:any;

graph.node("{{{name}}}", async (state) => {
  const innerFunc = {{{promptFunction:string}}};
  {{{name}}} = await innerFunc({{{argsStr:string}}});
  return {{{name}}};
});
`;

export type TemplateType = {
  name: string;
  promptFunction: string;
  argsStr: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    