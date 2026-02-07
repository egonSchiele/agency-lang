// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/functionDefinition.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `
export async function {{{functionName:string}}}({{{args}}}) : Promise<{{{returnType}}}> {
    const __messages: Message[] = [];
    const __step = __metadata?.part || 0;
    const __self: Record<string, any> = {};

    let __currentStep = __step;
    {{{functionBody}}}
}`;

export type TemplateType = {
  functionName: string;
  args: string | boolean | number;
  returnType: string | boolean | number;
  functionBody: string | boolean | number;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    