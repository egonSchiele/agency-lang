// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/functionCallAssignment.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `{{{variableName:string}}}{{{typeAnnotation:string}}} = await {{{functionCode:string}}};

{{^globalScope}}
if (isInterrupt({{{variableName:string}}})) {
  {{#nodeContext}}
  return { ...state, data: {{{variableName:string}}} };
  {{/nodeContext}}
   {{^nodeContext}}
   return { data: {{{variableName:string}}} };
   {{/nodeContext}}
}
{{/globalScope}}`;

export type TemplateType = {
  variableName: string;
  typeAnnotation: string;
  functionCode: string;
  globalScope: boolean;
  nodeContext: boolean;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    