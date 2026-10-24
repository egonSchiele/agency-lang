import type { AgencyFunction } from "./agencyFunction.js";
import { UNSET } from "./agencyFunction.js";
import type { Run } from "./asyncContext.js";
import {
  __checkParams,
  type ArgFrame,
  type HaltingRunner,
  type ParamChecks,
} from "./paramChecks.js";
import { failure } from "./result.js";

/** One parameter of the function a decorator's block rebinds. */
export type RebindSpec = {
  name: string;
  /** Written `name: T!`: checked again after the rebind. */
  checked: boolean;
  /** Present when the parameter has a default. A thunk, because a default
   *  is an Agency expression compiled where the function's scope is
   *  visible; it is called only when the record leaves the key out. */
  defaultValue?: () => unknown;
};

/**
 * The rebind statement a decorated body's block starts with. Binds `record`
 * with `fn.bindRecord`, so unknown keys, missing arguments, defaults, and
 * variadics follow the rules of a call and carry its messages; stores each
 * spec entry on the frame, calling `defaultValue` where the bound value is
 * UNSET; then runs the `!` checks over the checked entries. A failure to
 * bind halts the runner with a failure instead of throwing, so `block()`
 * returns a failure value and nothing propagates through the decorator.
 */
export async function __rebindParameters(
  run: Run,
  runner: HaltingRunner,
  frame: ArgFrame,
  fn: AgencyFunction,
  record: unknown,
  blockArg: unknown,
  spec: RebindSpec[],
  checks: ParamChecks | null,
): Promise<void> {
  let bound: Record<string, unknown>;
  try {
    bound = fn.bindRecord(record, blockArg);
  } catch (error) {
    runner.halt(failure(error instanceof Error ? error.message : String(error)));
    return;
  }
  for (const entry of spec) {
    const value = bound[entry.name];
    const useDefault = value === UNSET && entry.defaultValue !== undefined;
    frame.args[entry.name] = useDefault ? entry.defaultValue!() : value;
  }
  const checkedNames = spec.filter((entry) => entry.checked).map((entry) => entry.name);
  if (checkedNames.length > 0 && checks !== null) {
    await __checkParams(run, runner, frame, fn.name, checks, checkedNames);
  }
}
