// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/interruptAssignment.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `if (__stateStack.interruptData?.interruptResponse?.type === "resolve") {
  {{{variableName}}} = __stateStack.interruptData.interruptResponse.value;
  __stateStack.interruptData.interruptResponse = null;
} else {
  const __interruptResult = interrupt({{{interruptArgs}}});
  __stateStack.interruptData = {
    nodesTraversed: __graph.getNodesTraversed(),
  };
  __interruptResult.__state = __stateStack.toJSON();
  {{#nodeContext}}
  return { messages: __stack.messages, data: __interruptResult };
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
    