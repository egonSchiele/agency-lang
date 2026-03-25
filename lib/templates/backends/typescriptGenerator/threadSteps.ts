// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/threadSteps.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `const {{{subVar}}} = {{{subStore}}} ?? 0;
if ({{{subVar}}} <= 0) {
  {{{setup}}}
  {{{subStore}}} = 1;
}
{{#bodyStatements}}
if ({{{this.subVar}}} <= {{{this.index}}}) {
  {{{this.code}}}
  {{{this.subStore}}} = {{{this.nextIndex}}};
}
{{/bodyStatements}}
{{{cleanup}}}
`;

export type TemplateType = {
  subVar: string | boolean | number;
  subStore: string | boolean | number;
  setup: string | boolean | number;
  bodyStatements: {
    subVar: string | boolean | number;
    index: string | boolean | number;
    code: string | boolean | number;
    subStore: string | boolean | number;
    nextIndex: string | boolean | number;
  }[];
  cleanup: string | boolean | number;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    