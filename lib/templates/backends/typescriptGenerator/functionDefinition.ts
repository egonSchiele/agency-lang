// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/functionDefinition.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `
export async function {{{functionName:string}}}(args, __metadata={}) : Promise<{{{returnType}}}> {
    const __messages: Message[] = __metadata?.messages || [];
    const __stack = __stateStack.getNewState();
    const __step = __stack.step;
    const __self: Record<string, any> = __stack.locals;
    const __graph = __metadata?.graph || graph;
    const statelogClient = __metadata?.statelogClient || __statelogClient;

    // TODO: Note that we don't need to use the same kind of restoration
    // from state for arguments as we do for nodes,
    // because the args are serialized in the tool call.
    // But what about situations where it was a function call, not a tool call?
    // In that case, we would want to deserialize the argument.
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
    