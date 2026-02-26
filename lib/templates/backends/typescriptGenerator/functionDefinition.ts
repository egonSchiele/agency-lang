// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/functionDefinition.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `
export async function {{{functionName:string}}}({{{paramList:string}}}__metadata={}) {
    const { stack: __stack, step: __step, self: __self, threads: __threads, statelogClient, graph: __graph } =
      setupFunction({ ctx: __ctx, metadata: __metadata });

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
    