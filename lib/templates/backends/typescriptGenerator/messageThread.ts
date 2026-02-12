// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/messageThread.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `
{{#isSubthread}}
__self.messages_{{{nodeId}}} = __self.messages_{{{parentNodeId}}}.newSubthreadChild();
{{/isSubthread}}
{{^isSubthread}}
__self.messages_{{{nodeId}}} = __self.messages_{{{parentNodeId}}}.newChild();
{{/isSubthread}}

{{{bodyCode:string}}}
{{#hasVar}}
{{{varName?}}} = __self.messages_{{{nodeId}}}.cloneMessages()
{{/hasVar}}

// __self.messages = __self.prevMessages;`;

export type TemplateType = {
  isSubthread: boolean;
  nodeId: string | boolean | number;
  parentNodeId: string | boolean | number;
  bodyCode: string;
  hasVar: boolean;
  varName?: string | boolean | number;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    