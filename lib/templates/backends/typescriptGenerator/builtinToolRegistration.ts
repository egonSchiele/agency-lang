// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/builtinToolRegistration.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `__toolRegistry[{{{toolNameQuoted:string}}}] = __AgencyFunction.create({
  name: {{{toolNameQuoted}}},
  module: {{{moduleIdQuoted:string}}},
  fn: {{{internalName:string}}},
  params: __{{{toolName:string}}}ToolParams.map(p => ({ name: p, hasDefault: false, defaultValue: undefined, variadic: false })),
  toolDefinition: __{{{toolName}}}Tool,
}, __toolRegistry);`;

export type TemplateType = {
  toolNameQuoted: string;
  moduleIdQuoted: string;
  internalName: string;
  toolName: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    