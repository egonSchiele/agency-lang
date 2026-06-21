// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/functionCatchFailure.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `if (__error instanceof RestoreSignal) {
  throw __error;
}
// GuardExceededError must propagate up to the stdlib \`guard\`
// function's try/catch (in lib/runtime/result.ts via \`try block()\`).
// If we converted it to a Failure here, the guard would never see
// the trip and every guarded block would appear to succeed even
// over budget. See lib/runtime/guard.ts.
if (__error instanceof GuardExceededError) {
  throw __error;
}
// A cancellation (user pressed Esc / an abort fired) must propagate
// untouched: converting it to a Failure here would (a) let the agent
// limp onward through more soon-to-abort calls instead of stopping
// promptly, and (b) surface the abort as a logged ERROR + a Failure the
// REPL can't recognize as a cancel. The runtime is built to propagate
// AgencyCancelledError (see prompt.ts / hooks.ts / result.ts); honor that.
if (__isAbortError(__error)) {
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
    