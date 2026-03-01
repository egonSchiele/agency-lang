// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/graphNode.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `
graph.node("{{{name}}}", async (__state) => {
    const { stack: __stack, step: __step, self: __self, threads: __threads } =
      setupNode({ state: __state });
    const __ctx = __state.ctx;
    const statelogClient = __ctx.statelogClient;
    const __graph = __ctx.graph;
    await callHook({ callbacks: __ctx.callbacks, name: "onNodeStart", data: { nodeName: "{{{name}}}" } });

    if (__state.isResume) {
      __globalCtx.stateStack.globals = __state.ctx.stateStack.globals;
    }

    {{#hasParam}}
    if (!__state.isResume) {
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
    