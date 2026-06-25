// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/cli/optimizeReport.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `# Optimize run {{{runId}}}

{{{metaLines}}}

## Iterations

| iter | decision | detail |
| --- | --- | --- |
{{{iterationRows}}}{{{championSection}}}
`;

export type TemplateType = {
  runId: string | boolean | number;
  metaLines: string | boolean | number;
  iterationRows: string | boolean | number;
  championSection: string | boolean | number;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    