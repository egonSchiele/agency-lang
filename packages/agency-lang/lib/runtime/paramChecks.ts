import type { z } from "zod";
import { isAborted } from "./abortedResult.js";
import type { AbortedResult } from "./abortedResult.js";
import type { Run } from "./asyncContext.js";
import { hasInterrupts } from "./interrupts.js";
import type { Interrupt } from "./interrupts.js";
import { __invalidArgument, describeValue } from "./invalidArgument.js";
import { failure, isFailure, isSuccess } from "./result.js";
import type { ResultValue } from "./result.js";
import { __validateType } from "./schema.js";
import { __validateChainRecursive } from "./validateChain.js";
import type { TypeValidationDescriptor } from "./validateChain.js";

/** What a validation hands back: the checked value, a failure, the
 *  interrupts a `@validate` function raised, or the abort that stopped
 *  the validator (a cancel or a guard trip). */
export type CheckOutcome = ResultValue | Interrupt[] | AbortedResult;

/** One `!` parameter's check: the type text for the failure message, and
 *  the validation the compiler chose for the type. */
export type ParamCheck = {
  typeText: string;
  validate: (run: Run, value: unknown) => Promise<CheckOutcome> | CheckOutcome;
};

/** The checks of one function, by parameter name. */
export type ParamChecks = Record<string, ParamCheck>;

/** The check for a type that runs no validator: a zod schema. `build` runs
 *  on the first check and the schema is kept, so a tool a model calls over
 *  and over builds its schema once. Building late also lets a type alias
 *  declared below the function resolve. */
export function __schemaCheck(build: () => z.ZodType): ParamCheck["validate"] {
  let schema: z.ZodType | undefined;
  return (_run, value) => __validateType(value, (schema ??= build()));
}

/** The check for a type that reaches a `@validate` tag: a descriptor walk.
 *  The descriptor is built once, like the schema above. */
export function __descriptorCheck(build: () => TypeValidationDescriptor): ParamCheck["validate"] {
  let descriptor: TypeValidationDescriptor | undefined;
  return (run, value) => __validateChainRecursive(run, value, (descriptor ??= build()));
}

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
 *
 * A validator that was aborted (the user cancelled, or a guard tripped)
 * comes back as an `AbortedResult`. That is not a failed check: the abort
 * is rethrown as the exception the function's catch turns back into an
 * aborted result, the same way a checked cast rethrows it.
 */
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
    if (isAborted(outcome)) {
      throw outcome.toError();
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
        `Argument "${name}" of ${functionName} could not be checked: a validator for ${check.typeText} returned ${describeValue(outcome)} instead of a success or a failure.`,
      ),
    );
    return;
  }
}
