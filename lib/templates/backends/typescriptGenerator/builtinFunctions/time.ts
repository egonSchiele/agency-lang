// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/builtinFunctions/time.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `let {{{timingVarName:string}}}_startTime: number = performance.now();
{{{bodyCodeStr:string}}}
let {{{timingVarName}}}_endTime: number = performance.now();
let {{{timingVarName}}}: number = {{{timingVarName}}}_endTime - {{{timingVarName}}}_startTime;

{{#printTime}}
console.log("Time taken:", {{{timingVarName}}}, "ms");
{{/printTime}}`;

export type TemplateType = {
  timingVarName: string;
  bodyCodeStr: string;
  printTime: boolean;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    