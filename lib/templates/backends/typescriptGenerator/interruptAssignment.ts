// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/interruptAssignment.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `// Remember this will be called both in a tool call context
// and when the user is simply calling a function.

if (__state.interruptData?.interruptResponse?.type === "resolve") {
  {{{variableName}}} = __state.interruptData.interruptResponse.value;
  __state.interruptData.interruptResponse = null;
} else if (__state.interruptData?.interruptResponse?.type === "approve") {
  {{{variableName}}} = true;
  __state.interruptData.interruptResponse = null;
} else if (__state.interruptData?.interruptResponse?.type === "reject") {
  // reject for tool calls handled separately
  {{{variableName}}} = false;
  __state.interruptData.interruptResponse = null;
} else if (__state.interruptData?.interruptResponse?.type === "modify") {
  throw new Error("Interrupt response of type 'modify' is used for modifying tool call args. Use resolve instead.");
} else {
  const __interruptResult = interrupt({{{interruptArgs}}});
  __ctx.stateStack.nodesTraversed = __graph.getNodesTraversed();
  __interruptResult.state = __ctx.stateStack.toJSON();
  {{#nodeContext}}
  return { messages: __threads, data: __interruptResult };
  {{/nodeContext}}
  {{^nodeContext}}
  return __interruptResult;
  {{/nodeContext}}
}`;

export type TemplateType = {
  variableName: string | boolean | number;
  interruptArgs: string | boolean | number;
  nodeContext: boolean;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    