// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/agency/template.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `import { print, printJSON, input, sleep, saveDraft, read, write, writeBinary, readBinary, range, callback, map, filter, exclude, find, findIndex, reduce, flatMap, every, some, count, sortBy, unique, groupBy } from "std::index";

{{{body:string}}}`;

export type TemplateType = {
  body: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    