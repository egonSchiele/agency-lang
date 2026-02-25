// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/interruptReturn.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `if (__stateStack.interruptData?.interruptResponse?.type === "approve") {
  __stateStack.interruptData.interruptResponse = null;
} else if (__stateStack.interruptData?.interruptResponse?.type === "resolve") {
  const __resolvedValue = __stateStack.interruptData.interruptResponse.value;
  __stateStack.interruptData.interruptResponse = null;
  {{#nodeContext}}
  return { messages: __threads, data: __resolvedValue };
  {{/nodeContext}}
  {{^nodeContext}}
  __stateStack.pop();
  return __resolvedValue;
  {{/nodeContext}}
} else {
  const __interruptResult = interrupt({{{interruptArgs}}});
  __stateStack.interruptData = {
    nodesTraversed: __graph.getNodesTraversed(),
  };
  __interruptResult.__state = __stateStack.toJSON();
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
    