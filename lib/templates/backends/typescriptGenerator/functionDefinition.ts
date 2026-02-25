// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/functionDefinition.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `
export async function {{{functionName:string}}}({{{paramList:string}}}__metadata={}) {
    const __stack = __stateStack.getNewState();
    const __step = __stack.step;
    const __self = __stack.locals;
    const __graph = __metadata?.graph || graph;
    const statelogClient = __metadata?.statelogClient || __statelogClient;

    // if being called from a node, we'll pass in threads.
    // if being called as a tool, we won't have threads, but we'll create an empty ThreadStore here.
    // obv none of these messages will connect to a thread the user can see.
    const __threads = __metadata?.threads || new ThreadStore();

    {{{paramAssignments:string}}}

    {{{functionBody}}}
}
`;

export type TemplateType = {
  functionName: string;
  paramList: string;
  paramAssignments: string;
  functionBody: string | boolean | number;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    