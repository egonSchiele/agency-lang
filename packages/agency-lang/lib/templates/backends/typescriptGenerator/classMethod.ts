// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/classMethod.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `  async {{{methodName}}}({{{params}}}__state: any = undefined) {
    const __setupData = setupFunction({ state: __state });
    const __stack = __setupData.stack;
    const __step = __setupData.step;
    const __self = __setupData.self;
    const __threads = __setupData.threads;
    const __ctx = __state?.ctx || __globalCtx;
    const statelogClient = __ctx.statelogClient;
    const __graph = __ctx.graph;
    let __forked;
    let __functionCompleted = false;
    if (!__ctx.globals.isInitialized({{{moduleId}}})) {
      await __initializeGlobals(__ctx);
    }
    const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: {{{moduleId}}}, scopeName: {{{scopeName}}} });
{{#paramAssignments}}
    __stack.args[{{{this.nameQuoted}}}] = {{{this.name}}};
{{/paramAssignments}}
    try {
{{{body}}}
      if (runner.halted) { return runner.haltResult; }
      __functionCompleted = true;
    } catch (__error) {
      if (__error instanceof RestoreSignal) { throw __error; }
      throw __error;
    } finally {
      if (!__isForked) { __stateStack.pop() }
    }
  }`;

export type TemplateType = {
  methodName: string | boolean | number;
  params: string | boolean | number;
  moduleId: string | boolean | number;
  scopeName: string | boolean | number;
  paramAssignments: {
    nameQuoted: string | boolean | number;
    name: string | boolean | number;
  }[];
  body: string | boolean | number;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    