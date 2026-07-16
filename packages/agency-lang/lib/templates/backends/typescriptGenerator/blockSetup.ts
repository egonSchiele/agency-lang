// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/blockSetup.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `const __bsetup = setupFunction();
const __bstack = __bsetup.stack;
const __self = __bstack.locals;
const {{{frameVar}}} = __bstack;
{{#params}}
__bstack.args[{{{this.paramNameQuoted}}}] = {{{this.paramName}}};
{{/params}}
const runner = new Runner(__ctx, __bstack, { state: __bstack, moduleId: {{{moduleId}}}, scopeName: {{{scopeName}}} });
try {
{{{body}}}
return runner.halted ? runner.haltResult : undefined;
} catch (__blockError) {
// Level rule for the block frame — see functionCatchFailure.mustache.
// This is where a saveDraft placed directly inside a guard block gets its
// partial onto the abort. __stampCarriedDraft no-ops on non-abort errors,
// so no instanceof check is needed; the rethrow preserves unwind order.
__stampCarriedDraft(__blockError, __bstack, {{{scopeName}}}, __ctx);
throw __blockError;
} finally {
// Pop the SAME stack \`setupFunction\` pushed onto (the ALS-current
// stack via \`__bsetup.stateStack\`), NOT \`__ctx.stateStack\`. When this
// block runs inside a parallel/fork/race branch (e.g. as a callback
// fired from \`onToolCallEnd\` during runPrompt's tool dispatch), the
// ALS stack is the branch stack — distinct from \`__ctx.stateStack\`.
// Popping \`__ctx.stateStack\` would corrupt the parent's frame chain
// (the parent's runPrompt frame disappears, the next iteration's
// \`pr.parallel\` reads \`lastFrame()\` as undefined, and crashes with
// "Cannot read properties of undefined (reading 'getOrCreateBranch')").
__bsetup.stateStack.pop();
}`;

export type TemplateType = {
  frameVar: string | boolean | number;
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
    