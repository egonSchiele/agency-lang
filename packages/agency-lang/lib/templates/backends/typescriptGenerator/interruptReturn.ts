// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/interruptReturn.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `// Resume path: check for a response by interruptId, fall back to interruptData for legacy path
const __response = __ctx.getInterruptResponse(__self.{{{interruptIdKey:string}}}) ?? __state?.interruptData?.interruptResponse;
if (__response) {
  if (__state?.interruptData) __state.interruptData.interruptResponse = null;
  if (__response.type === "approve") {
    // approved, continue execution
  } else if (__response.type === "reject" && !__state.isToolCall) {
    // rejected, halt
    // tool calls will instead tell the llm that the call was rejected
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
  if (!isApproved(__handlerResult)) {
    // No handler — propagate interrupt to TypeScript caller
    // Store interruptId on frame BEFORE checkpoint so it's captured in the snapshot
    __self.{{{interruptIdKey:string}}} = __handlerResult.interruptId;
    const __checkpointId = __ctx.checkpoints.create(__ctx, { moduleId: {{{moduleId}}}, scopeName: {{{scopeName}}}, stepPath: {{{stepPath}}} });
    __handlerResult.checkpointId = __checkpointId;
    __handlerResult.checkpoint = __ctx.checkpoints.get(__checkpointId);
    {{#nodeContext}}
    runner.halt({ messages: __threads, data: __handlerResult });
    {{/nodeContext}}
    {{^nodeContext}}
    runner.halt(__handlerResult);
    {{/nodeContext}}
    return;
  }
  // Approved — continue execution past interrupt
}
`;

export type TemplateType = {
  interruptIdKey: string;
  nodeContext: boolean;
  interruptArgs: string | boolean | number;
  moduleId: string | boolean | number;
  scopeName: string | boolean | number;
  stepPath: string | boolean | number;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    