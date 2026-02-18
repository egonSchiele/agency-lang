// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/specialVar.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `__client = __getClientWithConfig({ {{{name}}}: {{{value}}} });`;

export type TemplateType = {
  name: string | boolean | number;
  value: string | boolean | number;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    