// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/functionCatchFailure.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `if (__error instanceof RestoreSignal) {
  throw __error;
}
// All aborts — cancellations (Esc / abort) AND guard trips — are now a single
// AgencyAbort carrying an AbortCause, and must propagate untouched. The owning
// guard's \`try\` converts its own guardTrip; every other abort unwinds. One
// rung replaces the old GuardExceededError + isAbortError ladder. Converting
// any abort to a Failure here would (a) hide a guard trip so the block appears
// to succeed over budget, and (b) let a cancel limp onward / surface as a
// logged ERROR the REPL can't recognize. See lib/runtime/errors.ts (§5).
if (__error instanceof AgencyAbort) {
  throw __error;
}
// Surface the underlying exception via logger + statelog before
// converting to a Failure. Without this, a caller that doesn't
// inspect the result (the common case for void side-effect calls)
// silently loses the error — a debugging nightmare. See the
// recordAlwaysScoped bug debugged in
// https://ampcode.com/threads/T-019e7a3a-edfa-74d6-917a-255c31bf8491.
{
  const __errMsg = __error instanceof Error ? __error.message : String(__error);
  const __errStack = __error instanceof Error && __error.stack ? __error.stack : "";
  const __log = __createLogger(__ctx.logLevel);
  __log.error("Function " + {{{functionName}}} + " threw an exception (converted to Failure): " + __errMsg);
  if (__errStack) __log.error(__errStack);
  __ctx.statelogClient?.error?.({
    errorType: "runtimeError",
    message: __errMsg,
    functionName: {{{functionName}}},
    retryable: __self.__retryable,
  });
}
return failure(
  __error instanceof Error ? __error.message : String(__error),
  {
    checkpoint: getRuntimeContext().ctx.getResultCheckpoint(),
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
    