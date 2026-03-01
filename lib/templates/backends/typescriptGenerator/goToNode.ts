// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/goToNode.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `goToNode("{{{nodeName:string}}}",
  {
    messages: __stack.messages,
    ctx: __ctx,
    {{#hasData}}
    data: {{{data:string}}}
    {{/hasData}}
    {{^hasData}}
    data: null
    {{/hasData}}
  });`;

export type TemplateType = {
  nodeName: string;
  hasData: boolean;
  data: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    