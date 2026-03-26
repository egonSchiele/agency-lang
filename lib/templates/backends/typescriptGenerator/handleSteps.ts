// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/handleSteps.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `const {{{subVar}}} = {{{subStore}}} ?? 0;
{{{handlerDecl}}}
__ctx.pushHandler({{{handlerName}}});
try {
{{#bodyStatements}}
if ({{{this.subVar}}} <= {{{this.index}}}) {
  {{{this.code}}}
  {{{this.subStore}}} = {{{this.nextIndex}}};
}
{{/bodyStatements}}
} finally {
  __ctx.popHandler();
}
`;

export type TemplateType = {
  subVar: string | boolean | number;
  subStore: string | boolean | number;
  handlerDecl: string | boolean | number;
  handlerName: string | boolean | number;
  bodyStatements: {
    subVar: string | boolean | number;
    index: string | boolean | number;
    code: string | boolean | number;
    subStore: string | boolean | number;
    nextIndex: string | boolean | number;
  }[];
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    