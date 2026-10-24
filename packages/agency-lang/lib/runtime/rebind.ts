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

/** The frame a rebind writes: the decorated function's `__stack`.
 *  `rebinding` is live only, never serialized: the decorator depths
 *  (`__call_0` is depth 0) whose block is running on this frame right now. */
export type RebindFrame = ArgFrame & {
  rebinding?: number[];
};

/**
 * The rebind statement a decorated body's block starts with. Refuses to
 * run while another call to the same decorator's block is still running
 * on this frame (`depth` tells one decorator in a stack from another, whose
 * blocks nest). The rebound values live on the one frame, so two running
 * blocks would read each other's arguments; the second call halts with a
 * failure instead. `__releaseRebind` in the block's `finally` ends the
 * claim. Then binds `record`
 * with `fn.bindRecord` (`keep` is the function's block-typed parameters,
 * which a record cannot carry), so unknown keys, missing arguments,
 * defaults, and variadics follow the rules of a call and carry its
 * messages; stores each
 * spec entry on the frame, calling `defaultValue` where the bound value is
 * UNSET; then runs the `!` checks over the checked entries. A failure to
 * bind halts the runner with a failure instead of throwing, so `block()`
 * returns a failure value and nothing propagates through the decorator.
 */
export async function __rebindParameters(
  run: Run,
  runner: HaltingRunner,
  frame: RebindFrame,
  fn: AgencyFunction,
  record: unknown,
  keep: Record<string, unknown>,
  spec: RebindSpec[],
  checks: ParamChecks | null,
  depth: number,
): Promise<void> {
  const running = frame.rebinding ?? [];
  if (running.includes(depth)) {
    runner.halt(
      failure(
        `block() in '${fn.name}' was called while an earlier block() was still running. ` +
          `The arguments live on the one frame of '${fn.name}', so call block from one place at a time, not from several fork or parallel branches.`,
      ),
    );
    return;
  }
  frame.rebinding = [...running, depth];
  let bound: Record<string, unknown>;
  try {
    bound = fn.bindRecord(record, keep);
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

/** Ends the claim `__rebindParameters` made at `depth`. Called from the
 *  block's `finally`, so it runs whether the body returned, failed, or
 *  was unwound by a pause; a frame restored from a checkpoint has no
 *  claim, and releasing one that is not there does nothing. */
export function __releaseRebind(frame: RebindFrame, depth: number): void {
  frame.rebinding = (frame.rebinding ?? []).filter((running) => running !== depth);
}
