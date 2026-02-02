// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/graphGenerator/graphNode.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `graph.node("{{{name}}}", async (state): Promise<any> => {
    const __messages: Message[] = [];
    {{#hasParam}}
    const {{{paramNames}}} = state.data;
    {{/hasParam}}
    {{{body}}}
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
    