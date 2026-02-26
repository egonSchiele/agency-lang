// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/graphNode.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `
graph.node("{{{name}}}", async (state) => {
    const { graph: __graph, statelogClient, stack: __stack, step: __step, self: __self, threads: __threads, globalState: __globalState } =
      setupNode({ ctx: __ctx, state, nodeName: "{{{name}}}" });
    if (__globalState) __global = __globalState;

    await callHook({ callbacks: __ctx.callbacks, name: "onNodeStart", data: { nodeName: "{{{name}}}" } });

    {{#hasParam}}
    if (state.data !== "<from-stack>") {
      {{{paramAssignments}}}
    }
    {{/hasParam}}
    {{{body}}}

    await callHook({ callbacks: __ctx.callbacks, name: "onNodeEnd", data: { nodeName: "{{{name}}}", data: undefined } });
    return { messages: __threads, data: undefined };
});
`;

export type TemplateType = {
  name: string | boolean | number;
  hasParam: boolean;
  paramAssignments: string | boolean | number;
  body: string | boolean | number;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    