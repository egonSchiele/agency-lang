// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/interruptReturn.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `// Remember this will be called both in a tool call context
// and when the user is simply calling a function.

if (__state.interruptData?.interruptResponse?.type === "approve") {
  // approved, clear interrupt response and continue execution
  __state.interruptData.interruptResponse = null;
} else if (__state.interruptData?.interruptResponse?.type === "reject" && !__state.isToolCall) {
  // rejected, clear interrupt response and return early
  // tool calls will instead tell the llm that the call was rejected
  __state.interruptData.interruptResponse = null;
  {{#nodeContext}}
  return { messages: __threads, data: null };
  {{/nodeContext}}
  {{^nodeContext}}
  return null;
  {{/nodeContext}}
} else if (__state.interruptData?.interruptResponse?.type === "modify") {
  if (__state.isToolCall) {
    // continue, args will get modified in the tool call handler
  } else {
    throw new Error("Interrupt response of type 'modify' is not supported outside of tool calls yet.");
  }
} else if (__state.interruptData?.interruptResponse?.type === "resolve") {
  console.log(JSON.stringify(__state.interruptData, null, 2));
  throw new Error("Interrupt response of type 'resolve' cannot be returned from an interrupt call. It can only be assigned to a variable.");
  const __resolvedValue = __state.interruptData.interruptResponse.value;
  {{#nodeContext}}
  return { messages: __threads, data: __resolvedValue };
  {{/nodeContext}}
  {{^nodeContext}}
  return __resolvedValue;
  {{/nodeContext}}
} else {
  const __interruptResult = interrupt({{{interruptArgs}}});
  __interruptResult.state = __ctx.stateToJSON();
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
    