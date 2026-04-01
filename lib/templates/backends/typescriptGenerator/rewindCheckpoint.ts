// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/rewindCheckpoint.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `if (__ctx.callbacks.onCheckpoint) {
  if (__ctx._skipNextCheckpoint) {
    __ctx._skipNextCheckpoint = false;
  } else {
    const __cpId = __ctx.checkpoints.create(__ctx, { moduleId: {{{moduleId}}}, scopeName: {{{scopeName}}}, stepPath: {{{stepPath}}} });
    const __cp = __ctx.checkpoints.get(__cpId);
    await callHook({
      callbacks: __ctx.callbacks,
      name: "onCheckpoint",
      data: {
        checkpoint: __cp,
        llmCall: {
          step: __stack.step,
          targetVariable: "{{{targetVariable}}}",
          prompt: {{{prompt}}},
          response: {{{response}}},
          model: __ctx.getSmoltalkConfig().model || "unknown",
        },
      },
    });
    __ctx.checkpoints.delete(__cpId);
  }
}
`;

export type TemplateType = {
  moduleId: string | boolean | number;
  scopeName: string | boolean | number;
  stepPath: string | boolean | number;
  targetVariable: string | boolean | number;
  prompt: string | boolean | number;
  response: string | boolean | number;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    