// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/traceSetup.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `import { TraceWriter } from "agency-lang/runtime";
const __traceWriter = new TraceWriter({{{traceFile:string}}}, {{{programId:string}}});
__globalCtx.traceWriter = __traceWriter;
`;

export type TemplateType = {
  traceFile: string;
  programId: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    