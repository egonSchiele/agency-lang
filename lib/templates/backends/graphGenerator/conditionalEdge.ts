// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/graphGenerator/conditionalEdge.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `graph.conditionalEdge("{{{fromNode}}}", {{{toNodes}}});
`;

export type TemplateType = {
  fromNode: string | boolean | number;
  toNodes: string | boolean | number;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    