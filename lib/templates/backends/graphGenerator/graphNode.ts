// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/graphGenerator/graphNode.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `
graph.node("{{{name}}}", async (state): Promise<any> => {
    console.log({state})
    const __messages: Message[] = state.messages || [];
    const __graph = state.__metadata?.graph || graph;
    const __step = state.__metadata?.state?.step || 0;
    const statelogClient = state.__metadata?.statelogClient || __statelogClient;
    const __self: Record<string, any> = state.__metadata?.state?.self || {};
    const __interruptResponse: InterruptResponseType | undefined = state.__metadata?.interruptResponse;
    const __toolCall: Record<string, any>|undefined = state.__metadata?.state?.toolCall;

    if (state.__metadata?.state?.global) {
      __global = state.__metadata.state.global;
    }

    let __currentStep = __step;

    {{#hasParam}}
    
    const __params = {{{paramNames}}};
    (state.data || []).forEach((item, index) => {
      __self[__params[index]] = item;
    });
    {{/hasParam}}
    {{{body}}}
    
    // this is just here to have a default return value from a node if the user doesn't specify one
    return { ...state, data: undefined };
});
`;

export type TemplateType = {
  name: string | boolean | number;
  hasParam: boolean;
  paramNames: string | boolean | number;
  body: string | boolean | number;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    