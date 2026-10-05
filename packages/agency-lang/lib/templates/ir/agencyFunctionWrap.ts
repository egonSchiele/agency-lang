// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/ir/agencyFunctionWrap.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `__AgencyFunction.create({ name: {{{name:string}}}, module: {{{module:string}}}, fn: {{{fn:string}}}, params: [{{{paramsStr:string}}}], toolDefinition: null }, __toolRegistry)`;

export type TemplateType = {
  name: string;
  module: string;
  fn: string;
  paramsStr: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    