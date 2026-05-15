// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/prompts/memory/forget.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `Given the following knowledge graph, identify which facts should be expired based on the user's request.

Knowledge graph:
{{{graphIndex:string}}}

User wants to forget: {{{query:string}}}

Return a JSON object with two fields:
- "observations": array of { entityName, observationContent } to expire (substring match)
- "relations":    array of { fromName, toName, type } to expire

Return { "observations": [], "relations": [] } if nothing matches.
`;

export type TemplateType = {
  graphIndex: string;
  query: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    