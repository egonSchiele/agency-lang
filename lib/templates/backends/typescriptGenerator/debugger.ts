// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/debugger.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `const __dbg = await debugStep(__ctx, __state, {
  moduleId: {{{moduleId:string}}},
  scopeName: {{{scopeName:string}}},
  stepPath: {{{stepPath:string}}},
  label: {{{label:string}}},
  nodeContext: {{{nodeContext:boolean}}},
});
if (__dbg) {
  {{#nodeContext}}
  return { messages: __threads, data: __dbg };
  {{/nodeContext}}
  {{^nodeContext}}
  return __dbg;
  {{/nodeContext}}
}
`;

export type TemplateType = {
  moduleId: string;
  scopeName: string;
  stepPath: string;
  label: string;
  nodeContext: boolean;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    