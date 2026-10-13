/**
 * The edge of a callable: what happens when a function or node is entered.
 *
 * A function's `@capabilities` tag names what it needs from the host. The
 * generated code carries that list in the wrapper's metadata, and the two
 * places a callable starts, `AgencyFunction.invoke` and the compiled node
 * body, both go through `enterCallable` here. Nothing else checks a
 * capability or writes the capability log. See
 * docs/dev/language/capabilities.md.
 */

import { requireCapabilities, UnsupportedOnHostError, type Capability } from "../host/host.js";
import type { Run } from "./asyncContext.js";
import { runtimeFailure, type ResultFailure } from "./result.js";
import { capabilityLogWriter } from "./capabilityLog.js";

/** The sentence added for a model that called the function as a tool, so it
 *  does not try again with other arguments. */
const NO_RETRY = "No tool call can supply it.";

/**
 * Run `body` if the run's host has every capability in `capabilities`,
 * else return `refused(run, failure)` without running it. Both are handed
 * the run, as every body the runtime calls back is
 * (docs/dev/compiler/codegen-run-parameter.md). The failure is the
 * host's own refusal, converted the way the generated catch converts one
 * thrown inside a body, so a refusal at entry and a refusal from inside the
 * host read the same and log the same.
 *
 * The body never begins, so its `pushHandler` calls never run, and no
 * handler is skipped by a partial run. This is the argument
 * `checkFailureArgs` makes for failure propagation, and it holds here for
 * the same reason: a call that never started cannot raise an effect past an
 * unregistered handler.
 *
 * When the host's settings name a capability log (`agency test
 * --check-capabilities`), this is also where a callable's `enter` and
 * `exit` lines are written. The exit is written in a `finally`, so a body
 * that throws, fails, or is aborted still leaves the runner's stack; a
 * missed exit would cover every later host use in the case.
 */
export async function enterCallable<T>(
  run: Run,
  name: string,
  capabilities: Capability[],
  body: (run: Run) => Promise<T>,
  refused: (run: Run, failure: ResultFailure) => T = (_run, failure) => failure as T,
): Promise<T> {
  const failure = refusalAtEntry(run, name, capabilities);
  if (failure !== null) {
    return refused(run, failure);
  }
  const write = capabilityLogWriter(run.ctx.host);
  if (write === null) {
    return body(run);
  }
  write({ kind: "enter", name, capabilities });
  try {
    return await body(run);
  } finally {
    write({ kind: "exit", name });
  }
}

/** The failure for entering `name` on a host that lacks one of
 *  `capabilities`, or null when the host has them all. */
export function refusalAtEntry(
  run: Run,
  name: string,
  capabilities: Capability[],
): ResultFailure | null {
  try {
    requireCapabilities(run.ctx.host, capabilities, name);
    return null;
  } catch (error) {
    if (!(error instanceof UnsupportedOnHostError)) {
      throw error;
    }
    error.message = `${error.message} ${NO_RETRY}`;
    run.log.error({ errorType: "runtimeError", message: error.message, functionName: name });
    return runtimeFailure(error, { functionName: name });
  }
}
