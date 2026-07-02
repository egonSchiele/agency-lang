// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/agency/template.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `import { print, printJSON, parseJSON, input, sleep, round, read, write, writeBinary, readBinary, notify, range, mostCommon, keys, values, entries, emit, callback } from "std::index";

{{{body:string}}}`;

export type TemplateType = {
  body: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    