// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/forkBlockSetup.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `const __bstack = __forkBranchStack.getNewState();
const __self = __bstack.locals;
const {{{paramName:string}}} = __forkItem;
__bstack.args[{{{paramNameQuoted}}}] = __forkItem;
const runner = new Runner(__ctx, __bstack, { state: __bstack, moduleId: {{{moduleId}}}, scopeName: {{{scopeName}}} });
try {
{{{body}}}
return runner.halted ? runner.haltResult : undefined;
} finally {
__forkBranchStack.pop();
}`;

export type TemplateType = {
  paramName: string;
  paramNameQuoted: string | boolean | number;
  moduleId: string | boolean | number;
  scopeName: string | boolean | number;
  body: string | boolean | number;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    