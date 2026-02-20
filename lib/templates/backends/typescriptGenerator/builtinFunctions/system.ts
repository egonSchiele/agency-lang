// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/builtinFunctions/system.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `__stack.messages[{{{threadId}}}].push(smoltalk.systemMessage({{{systemMessage:string}}}));
let __completion = await __client.text({
  messages: __stack.messages[{{{threadId}}}].getMessages(),
});

`;

export type TemplateType = {
  threadId: string | boolean | number;
  systemMessage: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    