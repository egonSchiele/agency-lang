// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/cli/deployReport.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `{{{targetBlock:string}}}{{{filesBlock:string}}}{{#dryRun}}{{{dryRunNote:string}}}{{/dryRun}}{{#deployed}}{{{deployedBody:string}}}{{/deployed}}
`;

export type TemplateType = {
  targetBlock: string;
  filesBlock: string;
  dryRun: boolean;
  dryRunNote: string;
  deployed: boolean;
  deployedBody: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    