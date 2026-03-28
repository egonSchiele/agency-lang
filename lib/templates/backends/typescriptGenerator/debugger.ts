// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/debugger.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `if (__state.interruptData?.interruptResponse?.type === "approve") {
  __state.interruptData.interruptResponse = null;
} else {
  const __debugInterrupt = interrupt({{{label:string}}});
  __debugInterrupt.debugger = true;
  const __checkpointId = __ctx.checkpoints.create(__ctx);
  __debugInterrupt.checkpointId = __checkpointId;
  __debugInterrupt.checkpoint = __ctx.checkpoints.get(__checkpointId);

  {{#nodeContext}}
  return { messages: __threads, data: __debugInterrupt };
  {{/nodeContext}}

  {{^nodeContext}}
  return __debugInterrupt;
  {{/nodeContext}}
}`;

export type TemplateType = {
  label: string;
  nodeContext: boolean;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    