// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/internalFunctionCall.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `{{{awaitPrefix:string}}}{{{functionName:string}}}({{{argsString:string}}}{{#hasArgs}}, {{/hasArgs}}{
    ctx: __ctx,
    {{^isAsync}}
    threads: __threads,
    {{/isAsync}}
    {{#isAsync}}
    threads: new ThreadStore(),
    {{/isAsync}}
    interruptData: __state?.interruptData
})`;

export type TemplateType = {
  awaitPrefix: string;
  functionName: string;
  argsString: string;
  hasArgs: boolean;
  isAsync: boolean;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    