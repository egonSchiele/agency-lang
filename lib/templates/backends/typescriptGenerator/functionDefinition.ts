// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/functionDefinition.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `
export async function {{{functionName:string}}}(args) : Promise<{{{returnType}}}> {
    const __messages: Message[] = [];
    const __stack = __stateStack.getNewState();
    const __step = __stack.step;
    const __self: Record<string, any> = __stack.locals;

    const __params = [{{{argsStr}}}];
      (args).forEach((item, index) => {
        __stack.args[__params[index]] = item;
      });


    {{{functionBody}}}
}`;

export type TemplateType = {
  functionName: string;
  returnType: string | boolean | number;
  argsStr: string | boolean | number;
  functionBody: string | boolean | number;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    