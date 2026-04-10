// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/agency/template.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `import { print, printJSON, input, sleep, round, fetch, fetchJSON, read, write, readImage, notify, range, mostCommon } from "std::index";

{{{body:string}}}`;

export type TemplateType = {
  body: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    