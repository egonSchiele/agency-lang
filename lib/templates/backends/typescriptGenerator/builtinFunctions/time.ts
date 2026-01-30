// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/builtinFunctions/time.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `const {{{timingVarName:string}}}_startTime = performance.now();
{{{bodyCodeStr:string}}}
const {{{timingVarName}}}_endTime = performance.now();
const {{{timingVarName}}} = {{{timingVarName}}}_endTime - {{{timingVarName}}}_startTime;`;

export type TemplateType = {
  timingVarName: string;
  bodyCodeStr: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    