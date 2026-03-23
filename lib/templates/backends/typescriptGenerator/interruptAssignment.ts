// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/interruptAssignment.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `// Check for a batch response keyed by interrupt_id
const __interruptData = __stack.locals.__interruptId ? __ctx.getInterruptData(__stack.locals.__interruptId) : undefined;
const __ir = __interruptData?.interruptResponse;
if (__interruptData) {
  __state.interruptData = __interruptData;
}
if (__ir?.type === "resolve") {
  {{{assignResolve}}};
} else if (__ir?.type === "approve") {
  {{{assignApprove}}};
} else if (__ir?.type === "reject") {
  {{{assignReject}}};
} else if (__ir?.type === "modify") {
  throw new Error("Interrupt response of type 'modify' is used for modifying tool call args. Use resolve instead.");
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
    