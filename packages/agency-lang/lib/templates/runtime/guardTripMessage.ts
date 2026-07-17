// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/runtime/guardTripMessage.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `{{{name}}} exceeded its {{{dimension}}} budget: {{{spentText}}} (limit {{{limitText}}}). Approve more budget, or reject to stop this work and salvage its draft.`;

export type TemplateType = {
  name: string | boolean | number;
  dimension: string | boolean | number;
  spentText: string | boolean | number;
  limitText: string | boolean | number;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    