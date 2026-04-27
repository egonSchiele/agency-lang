// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/interruptAssignment.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `// Resume path: check for a response by interruptId
const __response = __ctx.getInterruptResponse(__self.{{{interruptIdKey:string}}});
if (__response) {
  if (__response.type === "approve") {
    if (__response.value !== undefined) {
      {{{assignResolve}}};
    } else {
      {{{assignApprove}}};
    }
  } else if (__response.type === "reject") {
    // reject for tool calls handled separately
    {{#nodeContext}}
    runner.halt({ messages: __threads, data: failure("interrupt rejected", { retryable: false }) });
    {{/nodeContext}}
    {{^nodeContext}}
    runner.halt(failure("interrupt rejected", { retryable: false, checkpoint: __ctx.getResultCheckpoint() }));
    {{/nodeContext}}
    return;
  }
} else {
  // First run: call handlers, then propagate if unhandled
  const __handlerResult = await interruptWithHandlers({{{interruptArgs}}}, __ctx);
  if (isRejected(__handlerResult)) {
    {{#nodeContext}}
    runner.halt({ messages: __threads, data: failure(__handlerResult.value ?? "interrupt rejected", { retryable: false }) });
    {{/nodeContext}}
    {{^nodeContext}}
    runner.halt(failure(__handlerResult.value ?? "interrupt rejected", { retryable: false, checkpoint: __ctx.checkpoints.get(__resultCheckpointId) }));
    {{/nodeContext}}
    return;
  }
  if (isApproved(__handlerResult)) {
    {{{handlerApprove}}};
  } else {
    // No handler — propagate interrupt to TypeScript caller
    const __checkpointId = __ctx.checkpoints.create(__ctx, { moduleId: {{{moduleId}}}, scopeName: {{{scopeName}}}, stepPath: {{{stepPath}}} });
    __handlerResult.checkpointId = __checkpointId;
    __handlerResult.checkpoint = __ctx.checkpoints.get(__checkpointId);
    // Store interruptId on frame for response lookup on resume
    __self.{{{interruptIdKey:string}}} = __handlerResult.interruptId;
    {{#nodeContext}}
    runner.halt({ messages: __threads, data: __handlerResult });
    {{/nodeContext}}
    {{^nodeContext}}
    runner.halt(__handlerResult);
    {{/nodeContext}}
    return;
  }
}
`;

export type TemplateType = {
  interruptIdKey: string;
  assignResolve: string | boolean | number;
  assignApprove: string | boolean | number;
  nodeContext: boolean;
  interruptArgs: string | boolean | number;
  handlerApprove: string | boolean | number;
  moduleId: string | boolean | number;
  scopeName: string | boolean | number;
  stepPath: string | boolean | number;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    