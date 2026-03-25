// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/whileSteps.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `{{{iterStore}}} = {{{iterStore}}} ?? 0;
let {{{currentIterVar}}} = 0;
while ({{{condition}}}) {
  if ({{{currentIterVar}}} < {{{iterStore}}}) {
    {{{currentIterVar}}}++;
    continue;
  }
  {{{subStore}}} = {{{subStore}}} ?? 0;
{{#bodyStatements}}
  if ({{{this.subStore}}} <= {{{this.index}}}) {
    {{{this.code}}}
    {{{this.subStore}}} = {{{this.nextIndex}}};
  }
{{/bodyStatements}}
  {{{subStore}}} = 0;
{{#resetKeys}}
  delete __stack.locals.{{{this}}};
{{/resetKeys}}
  {{{iterStore}}}++;
  {{{currentIterVar}}}++;
}`;

export type TemplateType = {
  iterStore: string | boolean | number;
  currentIterVar: string | boolean | number;
  condition: string | boolean | number;
  subStore: string | boolean | number;
  bodyStatements: {
    subStore: string | boolean | number;
    index: string | boolean | number;
    code: string | boolean | number;
    nextIndex: string | boolean | number;
  }[];
  resetKeys: {
  }[];
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    