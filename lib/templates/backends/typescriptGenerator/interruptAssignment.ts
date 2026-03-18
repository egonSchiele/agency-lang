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
  assignResolve: string | boolean | number;
  assignApprove: string | boolean | number;
  assignReject: string | boolean | number;
  interruptArgs: string | boolean | number;
  nodeContext: boolean;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    