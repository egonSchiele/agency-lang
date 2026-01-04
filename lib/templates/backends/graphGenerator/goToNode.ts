// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/graphGenerator/goToNode.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `goToNode("{{{nodeName:string}}}", { messages: state.messages, data: {{{data:string}}} });`;

export type TemplateType = {
  nodeName: string;
  data: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    