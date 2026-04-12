// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/functionCatchFailure.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `if (__error instanceof RestoreSignal) {
  throw __error;
}
return failure(
  __error instanceof Error ? __error.message : String(__error),
  {
    checkpoint: __ctx.getResultCheckpoint(),
    retryable: __self.__retryable,
    functionName: {{{functionName}}},
    args: __stack.args,
  }
);
`;

export type TemplateType = {
  functionName: string | boolean | number;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    