// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/agency/template.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `{{{preludeImport:string}}}

{{{body:string}}}`;

export type TemplateType = {
  preludeImport: string;
  body: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    