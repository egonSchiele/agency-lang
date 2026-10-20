// A debugger installed on a program that something else is running: `agency
// run`, a TypeScript program that imported the compiled module, or a serve.
// The debugger lives in `DebuggerState.attached`, which the context reaches
// through its debug slot. The public entry points (`runNode`,
// `respondToInterrupts`, and their serve twins) hand every batch of debug
// stops to it and go on, so the caller never sees a stop: it gets the
// program's own interrupts and the final value, as it would with no
// debugger. The design is
// docs/superpowers/specs/2026-10-20-attach-to-a-running-program.md.

import type { AgencyCallbacks } from "./hooks.js";
import type { InvocationOptions } from "./invocationOptions.js";
import { sumRunUsage, type RunUsage, type ServedInvocationOutcome } from "./invocationUsage.js";
import { hasInterrupts, isDebugger, type Interrupt } from "./interrupts.js";
import type { RuntimeContext } from "./state/context.js";
import type { GraphState, RunNodeCoreResult } from "./types.js";

/** What the leg that stopped was started with. A resume does not remember
 *  these (see `InvocationOptions`), so the debugger passes them back on
 *  every resume and rewind it issues; otherwise a caller's policy, host,
 *  budget, callbacks, and cancel signal would be gone after the first
 *  step. */
export type LegOptions = {
  invocation?: InvocationOptions;
  callbacks?: AgencyCallbacks;
  abortSignal?: AbortSignal;
  pauseSignal?: AbortSignal;
};

export type AttachedRunResult = {
  result: RunNodeCoreResult<any>;
  /** The usage of every leg the debugger ran, summed. */
  usage: RunUsage;
};

export type AttachedDebugger = {
  /** Answer a batch of debug stops with the user's commands, resuming with
   *  `leg`'s options each time, and return when the program pauses on
   *  something else or finishes. */
  run(result: RunNodeCoreResult<any>, leg: LegOptions): Promise<AttachedRunResult>;
  /** The program finished while attached, without passing through `run`. */
  finished(result: RunNodeCoreResult<any>): Promise<void>;
};

/** The metadata key an attached debugger sets on the resumes and rewinds
 *  it issues itself, so the public entry points return those as they are
 *  instead of handing their stops back to the debugger that is already
 *  handling them. A key on the call, not a flag on the debugger: two runs
 *  in one process can share a debugger, and only the call knows whose
 *  resume it is. */
export const ATTACHED_RESUME = "attachedResume";

export function isAttachedResume(metadata: Record<string, unknown> | undefined): boolean {
  return metadata?.[ATTACHED_RESUME] === true;
}

export function attachedDebuggerOf(ctx: RuntimeContext<GraphState>): AttachedDebugger | undefined {
  return ctx.debugSlot.state?.attached;
}

type Outcome = ServedInvocationOutcome<RunNodeCoreResult<any>>;

/** The outcome of one leg, with its debug stops answered. While the leg
 *  paused on nothing but debug stops and a debugger is attached, the stops
 *  go to the debugger and the leg it resumes becomes the outcome. A batch
 *  that mixes stops with the program's own interrupts loses the stops: a
 *  resume never reads an answer for a debug stop (the stopped branch
 *  carries on from the flag in its frame), so the caller answers the rest
 *  and nothing is remembered. A final value is reported to the debugger
 *  unless the debugger ran the leg that produced it. */
export async function settleStops(
  ctx: RuntimeContext<GraphState>,
  outcome: Outcome,
  leg: LegOptions,
): Promise<Outcome> {
  let current = outcome;
  while (current.status === "returned") {
    const attached = attachedDebuggerOf(ctx);
    if (attached === undefined) {
      return current;
    }
    const data: unknown = current.value.data;
    if (!hasInterrupts(data)) {
      await attached.finished(current.value);
      return current;
    }
    const stops = data.filter((interrupt: Interrupt) => isDebugger(interrupt));
    const others = data.filter((interrupt: Interrupt) => !isDebugger(interrupt));
    if (stops.length === 0) {
      return current;
    }
    if (others.length > 0) {
      return { ...current, value: { ...current.value, data: others } };
    }
    const ran = await attached.run(current.value, leg);
    current = {
      status: "returned",
      value: ran.result,
      usage: sumRunUsage(current.usage, ran.usage),
      traceId: current.traceId,
    };
    if (!hasInterrupts(ran.result.data)) {
      // The debugger ran the leg that finished, so it has seen the end.
      return current;
    }
  }
  return current;
}
