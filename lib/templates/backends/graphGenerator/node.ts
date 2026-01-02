// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/graphGenerator/node.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `let {{{name:string}}}:any;

graph.node("{{{name}}}", async (state) => {
  const innerFunc = async () => {
    {{{body}}}
  };
  {{{name}}} = await innerFunc();
  return {{{name}}};
});
`;

export type TemplateType = {
  name: string;
  body: string | boolean | number;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    