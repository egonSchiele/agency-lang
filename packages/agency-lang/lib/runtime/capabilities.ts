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

/**
 * Run `body` if the run's host has every capability in `capabilities`,
 * else return `refused(run, failure)` without running it. Both are handed
 * the run, as every body the runtime calls back is
 * (docs/dev/compiler/codegen-run-parameter.md). The failure is the
 * host's own refusal, converted the way the generated catch converts one
 * thrown inside a body, so a refusal at entry and a refusal from inside the
 * host read the same and log the same, with one sentence added that says
 * calling again will not help.
 *
 * The body never begins, so its `pushHandler` calls never run, and no
 * handler is skipped by a partial run. This is the argument
 * `checkFailureArgs` makes for failure propagation, and it holds here for
 * the same reason: a call that never started cannot raise an effect past an
 * unregistered handler.
 *
 * When the host has an `onCallable` (the test runner's host does, for
 * `agency test --check-capabilities`), this is also where it hears that a
 * callable started and ended. The exit is reported in a `finally`, so a body
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
    // On a resume, the saved frames of this call and everything below it
    // are for a body that will not run. Drop them, or the next call would
    // claim them. See StateStack.discardPausedChainFor.
    run.stack.discardPausedChainFor(name);
    return refused(run, failure);
  }
  const report = run.ctx.host.onCallable;
  if (report === undefined) {
    return body(run);
  }
  report({ kind: "enter", name, capabilities });
  try {
    return await body(run);
  } finally {
    report({ kind: "exit", name });
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
    // One more sentence, for a model that called the function as a tool and
    // for a person reading the failure: nothing about the call was wrong.
    error.message = `${error.message} Calling ${name} again will fail the same way.`;
    run.log.error({ errorType: "runtimeError", message: error.message, functionName: name });
    return runtimeFailure(error, { functionName: name });
  }
}
