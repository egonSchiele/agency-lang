import { AgencyFunction } from "./agencyFunction.js";
import { currentRun, type Run } from "./asyncContext.js";
import { __call } from "./call.js";
import { callFromOutside } from "./toolInvocation.js";

/** Trusted stdlib bridge: capture the call's run before the first await. */
export function invokeLearnedFunction(
  target: AgencyFunction,
  args: Record<string, unknown>,
): Promise<unknown> {
  return invokeLearnedFunctionFor(currentRun(), target, args);
}

/** The generated entry is already a resumable node. Calling inside its run
 * keeps imported functions, handlers, and child checkpoints on that stack. */
export function invokeLearnedFunctionFor(
  run: Run,
  target: AgencyFunction,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (!AgencyFunction.isAgencyFunction(target)) {
    throw new Error("The selected export is not an Agency function");
  }
  return __call(run, target, callFromOutside(args));
}
