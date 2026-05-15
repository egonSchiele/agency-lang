// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/prompts/memory/compaction.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `Summarize the following conversation into a concise narrative. Preserve key facts, decisions, and context that would be important for continuing the conversation later. Do not include unnecessary detail.

Conversation:
{{{conversationText:string}}}

Write a concise summary:
`;

export type TemplateType = {
  conversationText: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    