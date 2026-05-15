// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/prompts/memory/mergeSummary.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `Merge these two conversation summaries into a single cohesive summary. The existing summary covers earlier conversation, the new summary covers more recent conversation. Preserve all key facts and decisions.

Existing summary:
{{{existingSummary:string}}}

New summary:
{{{newSummary:string}}}

Write the merged summary:
`;

export type TemplateType = {
  existingSummary: string;
  newSummary: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    