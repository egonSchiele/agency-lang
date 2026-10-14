import type { Run } from "./asyncContext.js";
import { __invalidArgument } from "./invalidArgument.js";
import { isFailure } from "./result.js";
import type { ResultValue } from "./result.js";

/** One `!` parameter's check, as the generated code describes it: the type
 *  text for the failure message, and the validation the compiler chose for
 *  the type (a schema check, or the walk that also runs `@validate`
 *  functions). */
export type ParamCheck = {
  typeText: string;
  validate: (run: Run, value: unknown) => Promise<ResultValue> | ResultValue;
};

/** The checks of one function, by parameter name. A function with no `!`
 *  parameter emits no table. */
export type ParamChecks = Record<string, ParamCheck>;

/** What `__checkParams` needs from a Runner: the halt, and nothing else. */
export type HaltingRunner = {
  halt(result: unknown): void;
};

/** What it needs from the function's frame: the argument slots. */
export type ArgFrame = {
  args: Record<string, unknown>;
};

/**
 * Check the named `!` parameters of a function, in order, reading each raw
 * argument from the frame and writing the checked value back.
 *
 * A check that fails halts the runner with the invalid-argument failure and
 * stops: later parameters are not checked, and the ones before it keep
 * their checked values. The generated code calls this inside step 0, so a
 * resume whose counter is past step 0 never runs the checks again, and it
 * calls it once more for the parameters a resume overrode.
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
    const raw = frame.args[name];
    const outcome = await check.validate(run, raw);
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
    frame.args[name] = outcome.value;
  }
}
