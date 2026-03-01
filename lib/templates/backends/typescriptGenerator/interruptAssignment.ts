// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/interruptAssignment.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `if (__state.interruptData?.interruptResponse?.type === "resolve") {
  {{{variableName}}} = __state.interruptData.interruptResponse.value;
  __state.interruptData.interruptResponse = null;
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
  variableName: string | boolean | number;
  interruptArgs: string | boolean | number;
  nodeContext: boolean;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    