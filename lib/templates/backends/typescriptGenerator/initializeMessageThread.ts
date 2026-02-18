// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/initializeMessageThread.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `if (__stack.messages[{{{index:string}}}]) {
     __stack.messages[{{{index:string}}}] = MessageThread.fromJSON(__stack.messages[{{{index:string}}}]);
} else {
    __stack.messages[{{{index:string}}}] = new MessageThread();
}`;

export type TemplateType = {
  index: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    