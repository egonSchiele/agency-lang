// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/messageThread.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `
{{#isSubthread}}
__stack.messages[{{{threadId:string}}}] = __stack.messages[{{{parentThreadId:string}}}].newSubthreadChild();
{{/isSubthread}}

{{{bodyCode:string}}}
{{#hasVar}}
{{{varName?}}} = __stack.messages[{{{threadId:string}}}].cloneMessages()
{{/hasVar}}

// __stack.messages = __stack.prevMessages;`;

export type TemplateType = {
  isSubthread: boolean;
  threadId: string;
  parentThreadId: string;
  bodyCode: string;
  hasVar: boolean;
  varName?: string | boolean | number;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    