// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/interruptReturn.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `// Check for a batch response keyed by interrupt_id
const __interruptData = __stack.locals.__interruptId ? __ctx.getInterruptData(__stack.locals.__interruptId) : undefined;
const __ir = __interruptData?.interruptResponse;
if (__interruptData) {
  __state.interruptData = __interruptData;
  __stack.interrupted = false;
}
if (__ir?.type === "approve") {
  // approved, continue execution
} else if (__ir?.type === "reject" && !__state.isToolCall) {
  // rejected, return early (tool calls handle reject inside runPrompt)
  {{#nodeContext}}
  return { messages: __threads, data: null };
  {{/nodeContext}}
  {{^nodeContext}}
  return null;
  {{/nodeContext}}
} else if (__ir?.type === "modify") {
  if (__state.isToolCall) {
    // continue, args will get modified in the tool call handler via interruptData
  } else {
    throw new Error("Interrupt response of type 'modify' is not supported outside of tool calls yet.");
  }
} else if (__ir?.type === "resolve") {
  throw new Error("Interrupt response of type 'resolve' cannot be returned from an interrupt call. It can only be assigned to a variable.");
} else if (!__ir) {
  const __interruptResult = interrupt({{{interruptArgs}}});
  __stack.locals.__interruptId = __interruptResult.interrupt_id;
  __stack.interrupted = true;
  {{#nodeContext}}
  return { messages: __threads, data: __interruptResult };
  {{/nodeContext}}
  {{^nodeContext}}
  return __interruptResult;
  {{/nodeContext}}
}
`;

export type TemplateType = {
  nodeContext: boolean;
  interruptArgs: string | boolean | number;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    