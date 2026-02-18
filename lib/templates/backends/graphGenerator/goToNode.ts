// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/graphGenerator/goToNode.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `goToNode("{{{nodeName:string}}}",
  {
    messages: __stack.messages,
    __metadata: {
      graph: __graph,
      // we need to pass in the state log client here because
      // if we rely on the local state log client
      // each client in each file has a different trace id.
      // So we pass in the client to make sure they all use the same trace id

      statelogClient,
      callbacks: __callbacks,
    },
    {{#hasData}}
    data: {{{data:string}}}
    {{/hasData}}
    {{^hasData}}
    data: null
    {{/hasData}}
  }
);`;

export type TemplateType = {
  nodeName: string;
  hasData: boolean;
  data: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    