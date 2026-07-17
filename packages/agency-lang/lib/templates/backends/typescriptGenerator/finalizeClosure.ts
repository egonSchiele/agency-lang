// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/finalizeClosure.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `const __finalize = async ({{{binderParam:string}}}): Promise<any> => {
  const runner = new Runner(__ctx, {{{frameVar:string}}}, { state: {{{frameVar:string}}}, moduleId: {{{moduleId:string}}}, scopeName: {{{scopeName:string}}} });
{{{body:string}}}
  return runner.halted ? runner.haltResult : undefined;
};
`;

export type TemplateType = {
  binderParam: string;
  frameVar: string;
  moduleId: string;
  scopeName: string;
  body: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    