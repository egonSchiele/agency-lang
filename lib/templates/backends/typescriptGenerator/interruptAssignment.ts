// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/interruptAssignment.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `// Remember this will be called both in a tool call context
// and when the user is simply calling a function.

if (__state.interruptData?.interruptResponse?.type === "resolve") {
  {{{assignResolve}}};
  __state.interruptData.interruptResponse = null;
} else if (__state.interruptData?.interruptResponse?.type === "approve") {
  {{{assignApprove}}};
  __state.interruptData.interruptResponse = null;
} else if (__state.interruptData?.interruptResponse?.type === "reject") {
  // reject for tool calls handled separately
  {{{assignReject}}};
  __state.interruptData.interruptResponse = null;
} else if (__state.interruptData?.interruptResponse?.type === "modify") {
  throw new Error("Interrupt response of type 'modify' is used for modifying tool call args. Use resolve instead.");
} else {
  const __handlerResult = await interruptWithHandlers({{{interruptArgs}}}, __ctx);
  if (isRejected(__handlerResult)) {
    {{#nodeContext}}
    return { messages: __threads, data: __handlerResult.value };
    {{/nodeContext}}
    {{^nodeContext}}
    return __handlerResult.value;
    {{/nodeContext}}
  }
  if (isApproved(__handlerResult)) {
    {{{handlerApprove}}};
  } else {
    // No handler — propagate interrupt to TypeScript caller
    const __checkpointId = __ctx.checkpoints.create(__ctx, { moduleId: {{{moduleId}}}, scopeName: {{{scopeName}}}, stepPath: {{{stepPath}}} });
    __handlerResult.checkpointId = __checkpointId;
    __handlerResult.checkpoint = __ctx.checkpoints.get(__checkpointId);
    {{#nodeContext}}
    return { messages: __threads, data: __handlerResult };
    {{/nodeContext}}
    {{^nodeContext}}
    return __handlerResult;
    {{/nodeContext}}
  }
}
`;

export type TemplateType = {
  assignResolve: string | boolean | number;
  assignApprove: string | boolean | number;
  assignReject: string | boolean | number;
  interruptArgs: string | boolean | number;
  nodeContext: boolean;
  handlerApprove: string | boolean | number;
  moduleId: string | boolean | number;
  scopeName: string | boolean | number;
  stepPath: string | boolean | number;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    