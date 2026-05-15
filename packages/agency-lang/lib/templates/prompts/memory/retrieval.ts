// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/prompts/memory/retrieval.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `Given the following knowledge graph, identify which entities are relevant to the query. Return a JSON array of entity names.

Knowledge graph:
{{{graphIndex:string}}}

Query: {{{query:string}}}

Return only the JSON array of entity names, e.g. ["Mom", "Dad"]. Return [] if no entities are relevant.
`;

export type TemplateType = {
  graphIndex: string;
  query: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    