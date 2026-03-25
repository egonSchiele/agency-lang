// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/ifStepsCondbranch.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `if ({{{condbranchStore}}} === undefined) {
{{#branches}}
  {{#this.first}}if{{/this.first}}{{^this.first}}} else if{{/this.first}} ({{{this.condition}}}) {
    {{{this.condbranchStore}}} = {{{this.index}}};
{{/branches}}
{{#hasElse}}
  } else {
    {{{condbranchStore}}} = {{{elseIndex}}};
  }
{{/hasElse}}
{{^hasElse}}
  } else {
    {{{condbranchStore}}} = -1;
  }
{{/hasElse}}
}
const {{{condbranchVar}}} = {{{condbranchStore}}};
const {{{subVar}}} = {{{subStore}}} ?? 0;`;

export type TemplateType = {
  condbranchStore: string | boolean | number;
  branches: {
    first: boolean;
    condition: string | boolean | number;
    condbranchStore: string | boolean | number;
    index: string | boolean | number;
  }[];
  hasElse: boolean;
  elseIndex: string | boolean | number;
  condbranchVar: string | boolean | number;
  subVar: string | boolean | number;
  subStore: string | boolean | number;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    