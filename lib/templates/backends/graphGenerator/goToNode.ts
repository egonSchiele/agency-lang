// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/graphGenerator/goToNode.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `goToNode("{{{nodeName:string}}}",
  {
    messages: __messages,
    __metadata: {
      graph: __graph,
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
    