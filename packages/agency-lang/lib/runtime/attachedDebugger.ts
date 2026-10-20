// A debugger installed on a program that something else is running: `agency
// run`, a TypeScript program that imported the compiled module, or a serve.
// The debugger lives in `DebuggerState.attached`, which the context reaches
// through its debug slot. Every public entry point of the runtime (`runNode`,
// `runExportedFunction`, `respondToInterrupts`, `resumeFromCheckpoint`,
// `rewindFrom`, `resumeCliFromCheckpoint`, and the serve twins) hands each
// batch of debug stops to it and goes on, so the caller never sees a stop:
// it gets the program's own interrupts and the final value, as it would with
// no debugger. The design is
// docs/superpowers/specs/2026-10-20-attach-to-a-running-program.md.

import type { DebuggerState } from "../debugger/debuggerState.js";
import type { AgencyCallbacks } from "./hooks.js";
import type { InvocationOptions } from "./invocationOptions.js";
import type { RunUsage, ServedInvocationOutcome } from "./invocationUsage.js";
import {
  hasInterrupts,
  isDebugger,
  respondToInterrupts,
  type Interrupt,
  type InterruptResponse,
} from "./interrupts.js";
import { isPaused } from "./pause.js";
import { rewindFrom } from "./rewind.js";
import type { Checkpoint, CheckpointStore } from "./state/checkpointStore.js";
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
  /** The usage of the last leg the debugger ran. A resume seeds its meter
   *  from the checkpoint it restores, so each leg's figure is the run's
   *  total so far, and the last one is the whole run's. Absent when the
   *  debugger ran no leg. */
  usage?: RunUsage;
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

/** The four functions a driver drives a program through, the shape a
 *  compiled module exports bound to its own context (`imports.mustache`).
 *  The debugger's `ModuleFunctions` is this type. */
export type AttachFunctions = {
  respondToInterrupts: (
    interrupts: Interrupt[],
    responses: InterruptResponse[],
    opts?: {
      overrides?: Record<string, unknown>;
      metadata?: Record<string, any>;
      invocation?: InvocationOptions;
      abortSignal?: AbortSignal;
      pauseSignal?: AbortSignal;
    },
  ) => Promise<any>;
  rewindFrom: (
    checkpoint: Checkpoint,
    overrides: Record<string, unknown>,
    opts?: {
      metadata?: Record<string, any>;
      invocation?: InvocationOptions;
      abortSignal?: AbortSignal;
      pauseSignal?: AbortSignal;
    },
  ) => Promise<any>;
  __setDebugger: (dbg: DebuggerState | null) => void;
  /** Absent from a module compiled before it existed. */
  __getDebugger?: () => DebuggerState | null;
  __getCheckpoints: () => CheckpointStore;
};

/** The four functions bound to `ctx`, for an attach server that runs
 *  inside the program and has no module to ask. Bound here, in the
 *  runtime that owns the context, and handed to `registerAttach`: the
 *  `#platform` file can be a different copy of the runtime than the one
 *  the program imported (a test loads the program's copy through vite and
 *  the platform file through Node), and a copy that did not load the
 *  program's modules cannot resume them. */
export function attachFunctionsFor(ctx: RuntimeContext<GraphState>): AttachFunctions {
  return {
    respondToInterrupts: (interrupts, responses, opts) =>
      respondToInterrupts({
        ctx,
        interrupts,
        responses,
        overrides: opts?.overrides,
        metadata: opts?.metadata,
        invocation: opts?.invocation,
        abortSignal: opts?.abortSignal,
        pauseSignal: opts?.pauseSignal,
      }),
    rewindFrom: (checkpoint, overrides, opts) =>
      rewindFrom({
        ctx,
        checkpoint,
        overrides,
        metadata: opts?.metadata,
        invocation: opts?.invocation,
        abortSignal: opts?.abortSignal,
        pauseSignal: opts?.pauseSignal,
      }),
    __setDebugger: (dbg) => {
      ctx.debuggerState = dbg;
    },
    __getDebugger: () => ctx.debuggerState,
    __getCheckpoints: () => ctx.checkpoints,
  };
}

type Outcome = ServedInvocationOutcome<RunNodeCoreResult<any>>;

export type SettleHooks = {
  /** The debugger ran the leg that produced the final value. The leg's
   *  core never had the caller's callbacks, so `runNode` fires the
   *  caller's `onAgentEnd` from here. */
  onFinished?: (outcome: Outcome & { status: "returned" }) => Promise<void>;
};

/** The outcome of one leg, with its debug stops answered. While the leg
 *  paused on nothing but debug stops and a debugger is attached, the stops
 *  go to the debugger and the leg it resumes becomes the outcome, carrying
 *  that leg's usage, which is the run's total so far. A batch that mixes
 *  stops with the program's own interrupts loses the stops: a resume never
 *  reads an answer for a debug stop (the stopped branch carries on from
 *  the flag in its frame), so the caller answers the rest and nothing is
 *  remembered. A final value is reported to the debugger unless the
 *  debugger ran the leg that produced it. A paused checkpoint, from the
 *  caller's own pause signal, is a suspension and goes back as it is. */
export async function settleStops(
  ctx: RuntimeContext<GraphState>,
  outcome: Outcome,
  leg: LegOptions,
  hooks: SettleHooks = {},
): Promise<Outcome> {
  let current = outcome;
  let debuggerRanALeg = false;
  while (current.status === "returned") {
    const attached = attachedDebuggerOf(ctx);
    if (attached === undefined) {
      return current;
    }
    const data: unknown = current.value.data;
    if (!hasInterrupts(data)) {
      if (isPaused(data)) {
        return current;
      }
      if (debuggerRanALeg) {
        await hooks.onFinished?.(current);
      } else {
        await attached.finished(current.value);
      }
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
    debuggerRanALeg = true;
    current = {
      status: "returned",
      value: ran.result,
      usage: ran.usage ?? current.usage,
      traceId: current.traceId,
    };
  }
  return current;
}

/** `settleStops` for an exported function, whose value is the bare
 *  `Interrupt[]` rather than a node's `{ data }` wrapper. The debugger's
 *  resumes return the wrapper, so the value is unwrapped again after. */
export async function settleFunctionStops(
  ctx: RuntimeContext<GraphState>,
  outcome: ServedInvocationOutcome<unknown>,
  leg: LegOptions,
): Promise<ServedInvocationOutcome<unknown>> {
  if (outcome.status !== "returned") {
    return outcome;
  }
  // A function has no thread of its own; the wrapper's is empty.
  const wrapped: RunNodeCoreResult<any> = {
    data: outcome.value,
    messages: { threads: {}, counter: 0, activeStack: [] },
  };
  const settled = await settleStops(ctx, { ...outcome, value: wrapped }, leg);
  if (settled.status !== "returned") {
    return settled;
  }
  return { ...settled, value: settled.value.data };
}
