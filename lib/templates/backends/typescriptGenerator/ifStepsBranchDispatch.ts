// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/ifStepsBranchDispatch.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `{{#allBranches}}
{{#this.first}}if{{/this.first}}{{^this.first}}} else if{{/this.first}} ({{{this.condbranchVar}}} === {{{this.branchIndex}}}) {
{{#this.statements}}
  if ({{{this.subVar}}} <= {{{this.stmtIndex}}}) {
    {{{this.stmtCode}}}
    {{{this.subStore}}} = {{{this.nextIndex}}};
  }
{{/this.statements}}
{{/allBranches}}
}`;

export type TemplateType = {
  allBranches: {
    first: boolean;
    condbranchVar: string | boolean | number;
    branchIndex: string | boolean | number;
    statements: {
      subVar: string | boolean | number;
      stmtIndex: string | boolean | number;
      stmtCode: string | boolean | number;
      subStore: string | boolean | number;
      nextIndex: string | boolean | number;
    }[];
  }[];
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    