// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/graphGenerator/graphNode.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `
graph.node("{{{name}}}", async (state): Promise<any> => {
    const __messages: Message[] = state.messages || [];
    const __graph = state.__metadata?.graph || graph;
    const statelogClient = state.__metadata?.statelogClient || __statelogClient;
    {{#hasParam}}
    const {{{paramNames}}} = state.data;
    {{/hasParam}}
    {{{body}}}
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
    