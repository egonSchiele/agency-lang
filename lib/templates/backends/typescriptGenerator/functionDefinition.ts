// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/functionDefinition.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `
export async function {{{functionName:string}}}(args, __metadata={}) {
    const __stack = __stateStack.getNewState();
    const __step = __stack.step;
    const __self = __stack.locals;
    const __graph = __metadata?.graph || graph;
    const statelogClient = __metadata?.statelogClient || __statelogClient;
    const __threadId = __metadata?.threadId;

    // if we're passing messages in,
    // that means we want this function to add messages to that thread
    // so this func call is currently in a thread/subthread
    if (__metadata?.messages) {
      __stack.messages = __metadata.messages;
    }
    // args are always set whether we're restoring from state or not.
    // If we're not restoring from state, args were obviously passed in through the code.
    // If we are restoring from state, the node that called this function had to have passed
    // these arguments into this function call.
    // if we're restoring state, this will override __stack.args (which will be set),
    // but with the same values, so it doesn't matter that those values are being overwritten.
    const __params = [{{{argsStr}}}];
    (args).forEach((item, index) => {
      __stack.args[__params[index]] = item;
    });


    {{{functionBody}}}
}
`;

export type TemplateType = {
  functionName: string;
  argsStr: string | boolean | number;
  functionBody: string | boolean | number;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    