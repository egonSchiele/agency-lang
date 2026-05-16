// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/prompts/memory/retrieval.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `You are filtering candidate entities from a knowledge graph for relevance to a query.

Candidate entities (each line: "id: name (type) — facts"):
{{{candidates:string}}}

Query: {{{query:string}}}

Return only the entity ids that are actually relevant to the query, as a JSON array of strings.

Rules:
- Each id must be one of the candidate ids above. Do not invent ids.
- Order does not matter.
- Return [] if no candidates are relevant.
- Return only the JSON array — no prose, no markdown.

Example output: ["entity-1", "entity-7"]
`;

export type TemplateType = {
  candidates: string;
  query: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    