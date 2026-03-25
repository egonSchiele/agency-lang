// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/substepBlock.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `if ({{{guardVar}}} <= {{{stepIndex}}}) {
  {{{body}}}
  {{{counterExpr}}} = {{{nextIndex}}};
}`;

export type TemplateType = {
  guardVar: string | boolean | number;
  stepIndex: string | boolean | number;
  body: string | boolean | number;
  counterExpr: string | boolean | number;
  nextIndex: string | boolean | number;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    