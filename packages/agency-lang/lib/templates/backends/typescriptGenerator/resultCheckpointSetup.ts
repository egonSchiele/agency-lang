// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/resultCheckpointSetup.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `let __resultCheckpointId = -1;
if (__ctx.stateStack.currentNodeId()) {
  __resultCheckpointId = __ctx.checkpoints.createPinned(__stateStack, __ctx, { moduleId: {{{moduleId}}}, scopeName: {{{scopeName}}}, stepPath: "", label: "result-entry" });
}
if (__ctx._pendingArgOverrides) {
  const __overrides = __ctx._pendingArgOverrides;
  __ctx._pendingArgOverrides = undefined;
{{{paramsStr}}}
}
`;

export type TemplateType = {
  moduleId: string | boolean | number;
  scopeName: string | boolean | number;
  paramsStr: string | boolean | number;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    