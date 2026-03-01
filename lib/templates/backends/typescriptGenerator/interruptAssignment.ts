// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/interruptAssignment.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `if (__state.interruptData?.interruptResponse?.type === "modify") {
  {{{variableName}}} = __state.interruptData.interruptResponse.value;
  __state.interruptData.interruptResponse = null;
} else if (__state.interruptData?.interruptResponse?.type === "approve") {
  // todo: what's the best way to handle approve/reject responses?
  {{{variableName}}} = true;
  __state.interruptData.interruptResponse = null;
} else if (__state.interruptData?.interruptResponse?.type === "reject") {
  {{{variableName}}} = false;
  __state.interruptData.interruptResponse = null;
} else {
  // there's no interrupt response, which means this is the first time we're hitting the interrupt.
  const __interruptResult = interrupt({{{interruptArgs}}});
  __ctx.stateStack.nodesTraversed = __graph.getNodesTraversed();
  __interruptResult.state = __ctx.stateStack.toJSON();
  {{#nodeContext}}
  return { messages: __threads, data: __interruptResult };
  {{/nodeContext}}
  {{^nodeContext}}
  return __interruptResult;
  {{/nodeContext}}
}
`;

export type TemplateType = {
  variableName: string | boolean | number;
  interruptArgs: string | boolean | number;
  nodeContext: boolean;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    