// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/interruptReturn.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `if (__state.interruptData?.interruptResponse?.type === "approve") {
  __state.interruptData.interruptResponse = null;
} else if (__state.interruptData?.interruptResponse?.type === "resolve") {
  const __resolvedValue = __state.interruptData.interruptResponse.value;
  __state.interruptData.interruptResponse = null;
  {{#nodeContext}}
  return { messages: __threads, data: __resolvedValue };
  {{/nodeContext}}
  {{^nodeContext}}
  __ctx.stateStack.pop();
  return __resolvedValue;
  {{/nodeContext}}
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
    