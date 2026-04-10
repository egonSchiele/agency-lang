// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/blockSetup.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `const __bsetup = setupFunction({ state: { ctx: __ctx, threads: __threads } });
const __bstack = __bsetup.stack;
const __self = __bstack.locals;
{{#params}}
__bstack.args[{{{this.paramNameQuoted}}}] = {{{this.paramName}}};
{{/params}}
const runner = new Runner(__ctx, __bstack, { state: __bstack, moduleId: {{{moduleId}}}, scopeName: {{{scopeName}}} });
try {
{{{body}}}
return runner.halted ? runner.haltResult : undefined;
} finally {
__ctx.stateStack.pop();
}`;

export type TemplateType = {
  params: {
    paramNameQuoted: string | boolean | number;
    paramName: string | boolean | number;
  }[];
  moduleId: string | boolean | number;
  scopeName: string | boolean | number;
  body: string | boolean | number;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    