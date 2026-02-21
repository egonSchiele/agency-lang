// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/messageThread.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `
{
{{#isSubthread}}
const __tid = __threads.createSubthread();
{{/isSubthread}}
{{^isSubthread}}
const __tid = __threads.create();
{{/isSubthread}}
__threads.pushActive(__tid);

{{{bodyCode:string}}}
{{#hasVar}}
{{{varName?}}} = __threads.active().cloneMessages();
{{/hasVar}}

__threads.popActive();
}
`;

export type TemplateType = {
  isSubthread: boolean;
  bodyCode: string;
  hasVar: boolean;
  varName?: string | boolean | number;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    