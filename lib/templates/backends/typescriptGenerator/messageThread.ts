// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/messageThread.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `__self.prevMessages = __self.messages || [];
__self.messages = [];
{{{bodyCode:string}}}
{{#hasVar}}
{{{varName?}}} = __cloneArray(__self.messages);
{{/hasVar}}

__self.messages = __self.prevMessages;`;

export type TemplateType = {
  bodyCode: string;
  hasVar: boolean;
  varName?: string | boolean | number;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    