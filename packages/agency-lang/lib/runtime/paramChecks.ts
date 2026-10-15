import type { Run } from "./asyncContext.js";
import { hasInterrupts } from "./interrupts.js";
import type { Interrupt } from "./interrupts.js";
import { __invalidArgument } from "./invalidArgument.js";
import { failure, isFailure, isSuccess } from "./result.js";
import type { ResultValue } from "./result.js";

/** What a validation hands back: the checked value, a failure, or the
 *  interrupts a `@validate` function raised. */
export type CheckOutcome = ResultValue | Interrupt[];

/** One `!` parameter's check: the type text for the failure message, and
 *  the validation the compiler chose for the type. */
export type ParamCheck = {
  typeText: string;
  validate: (run: Run, value: unknown) => Promise<CheckOutcome> | CheckOutcome;
};

/** The checks of one function, by parameter name. */
export type ParamChecks = Record<string, ParamCheck>;

export type HaltingRunner = {
  halt(result: unknown): void;
};

export type ArgFrame = {
  args: Record<string, unknown>;
};

/**
 * Check the named `!` parameters of a function in order, reading each raw
 * argument from the frame and writing the checked value back.
 *
 * A check that fails halts the runner with the invalid-argument failure
 * and stops: later parameters are not checked. A validator that raised an
 * interrupt comes back as an interrupt list; a parameter check cannot
 * pause, so that halts with a failure too. So does anything else a
 * validator written in TypeScript might hand back.
 */
function describeOutcome(outcome: unknown): string {
  if (outcome === undefined) return "nothing";
  if (outcome === null) return "null";
  return `the ${typeof outcome} ${JSON.stringify(outcome)}`;
}

export async function __checkParams(
  run: Run,
  runner: HaltingRunner,
  frame: ArgFrame,
  functionName: string,
  checks: ParamChecks,
  names: string[],
): Promise<void> {
  for (const name of names) {
    const check = checks[name];
    if (check === undefined) {
      throw new Error(
        `No check for parameter "${name}" of ${functionName}: the names list and the checks table are both written by the compiler and must agree.`,
      );
    }
    const raw = frame.args[name];
    const outcome = await check.validate(run, raw);
    if (isSuccess(outcome)) {
      frame.args[name] = outcome.value;
      continue;
    }
    if (isFailure(outcome)) {
      runner.halt(
        __invalidArgument({
          functionName,
          paramName: name,
          typeText: check.typeText,
          value: raw,
          failure: outcome,
        }),
      );
      return;
    }
    if (hasInterrupts(outcome)) {
      runner.halt(
        failure(
          `Argument "${name}" of ${functionName} could not be checked: a validator for ${check.typeText} raised an interrupt, and a parameter check cannot pause. Check the value with a cast on its own line before the call.`,
        ),
      );
      return;
    }
    runner.halt(
      failure(
        `Argument "${name}" of ${functionName} could not be checked: a validator for ${check.typeText} returned ${describeOutcome(outcome)} instead of a success or a failure.`,
      ),
    );
    return;
  }
}
