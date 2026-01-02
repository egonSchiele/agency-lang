// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/graphGenerator/edge.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `graph.edge("{{{fromNode}}}", "{{{toNode}}}");
`;

export type TemplateType = {
  fromNode: string | boolean | number;
  toNode: string | boolean | number;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    