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
import type { CheckpointEdit, StopAt } from "./state/checkpointPatch/index.js";
import type { RunUsage, ServedInvocationOutcome } from "./invocationUsage.js";
import {
  hasInterrupts,
  isDebugger,
  respondToInterrupts,
  respondToInterruptsForServe,
  type Interrupt,
  type InterruptResponse,
} from "./interrupts.js";
import { isPaused } from "./pause.js";
import { rewindFrom } from "./rewind.js";
import type { Checkpoint, CheckpointStore } from "./state/checkpointStore.js";
import { ATTACHED_AGENT_END } from "./agentEnd.js";
import { ATTACHED_RESUME, debugRunOfStack, letGoOfDebugRun } from "./debugRun.js";
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
  /** The run began in `runNode`, so the leg that ends it fires
   *  `onAgentEnd` (see `agentEnd.ts`). */
  agentEnd?: boolean;
};

/** What the debugger's legs came to: the leg the program paused or
 *  finished on, or the error a leg threw. `usage` is the last leg's,
 *  which is the run's total so far, since a resume seeds its meter from
 *  the checkpoint it restores; absent when the debugger ran no leg. */
export type AttachedRunResult =
  { result: RunNodeCoreResult<any>; usage?: RunUsage } | { threw: unknown; usage: RunUsage };

export type AttachedDebugger = {
  /** Answer a batch of debug stops with the user's commands, resuming with
   *  `leg`'s options each time, and return when the program pauses on
   *  something else or finishes. */
  run(result: RunNodeCoreResult<any>, leg: LegOptions): Promise<AttachedRunResult>;
  /** The program finished while attached, without passing through `run`. */
  finished(result: RunNodeCoreResult<any>): Promise<void>;
  /** A step in the run `runKey` was let through because another run is
   *  being debugged (`debugRun.ts`); once per such run is enough. */
  ignoring?(runKey: string): void;
  /** A new run took the debugger: what the driver keeps for one run, the
   *  pending overrides, is the old run's and is dropped. */
  ownerChanged?(): void;
};

export { ATTACHED_RESUME, isAttachedResume } from "./debugRun.js";

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
      edits?: CheckpointEdit[];
      at?: StopAt;
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
      edits?: CheckpointEdit[];
      at?: StopAt;
      metadata?: Record<string, any>;
      invocation?: InvocationOptions;
      abortSignal?: AbortSignal;
      pauseSignal?: AbortSignal;
    },
  ) => Promise<any>;
  /** The serve-style resume, which hands back a thrown leg as an outcome
   *  with its usage instead of throwing; the attached driver uses it when
   *  the module has it. */
  respondToInterruptsForServe?: (
    interrupts: Interrupt[],
    responses: InterruptResponse[],
    opts?: {
      overrides?: Record<string, unknown>;
      edits?: CheckpointEdit[];
      at?: StopAt;
      metadata?: Record<string, any>;
      invocation?: InvocationOptions;
      abortSignal?: AbortSignal;
      pauseSignal?: AbortSignal;
    },
  ) => Promise<ServedInvocationOutcome<any>>;
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
        edits: opts?.edits,
        at: opts?.at,
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
        edits: opts?.edits,
        at: opts?.at,
        metadata: opts?.metadata,
        invocation: opts?.invocation,
        abortSignal: opts?.abortSignal,
        pauseSignal: opts?.pauseSignal,
      }),
    respondToInterruptsForServe: (interrupts, responses, opts) =>
      respondToInterruptsForServe({
        ctx,
        interrupts,
        responses,
        overrides: opts?.overrides,
        edits: opts?.edits,
        at: opts?.at,
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

/** The outcome of one leg, with its debug stops answered. While the leg
 *  paused on nothing but debug stops and a debugger is attached, the stops
 *  go to the debugger and the leg it resumes becomes the outcome, carrying
 *  that leg's usage, which is the run's total so far; a leg that threw is
 *  a thrown outcome, as it is with no debugger. A batch that mixes stops
 *  with the program's own interrupts loses the stops: a resume never
 *  reads an answer for a debug stop (the stopped branch carries on from
 *  the flag in its frame), so the caller answers the rest and nothing is
 *  remembered. A final value is reported to the debugger unless the
 *  debugger ran the leg that produced it. A paused checkpoint, from the
 *  caller's own pause signal, is a suspension and goes back as it is. A
 *  batch of stops that reaches here after the debugger was detached, in
 *  the moment between the stop and this settle, is let go with the leg's
 *  own options, as the debugger's `quit` lets a stop go: the caller must
 *  never be handed a stop. */
export async function settleStops(
  ctx: RuntimeContext<GraphState>,
  outcome: Outcome,
  leg: LegOptions,
): Promise<Outcome> {
  let current = outcome;
  let debuggerRanALeg = false;
  while (current.status === "returned") {
    const data: unknown = current.value.data;
    const attached = attachedDebuggerOf(ctx);
    if (!hasInterrupts(data)) {
      // The end of a run the debugger owned, in a leg the caller ran, is
      // news for the person; the end of a run it ignored is not.
      if (
        attached !== undefined &&
        !isPaused(data) &&
        !debuggerRanALeg &&
        current.debugOwner === true
      ) {
        await attached.finished(current.value);
      }
      return current;
    }
    // A debugger that is installed but not attached, `agency debug` in
    // its own process, is the caller: its stops go back to it whole.
    if (attached === undefined && ctx.hasDebugger()) {
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
    if (attached === undefined) {
      // No debugger at all: the one that was attached when the leg
      // stopped has since been removed, and its stops are let go.
      current = await letStopsGo(ctx, data, leg);
      continue;
    }
    // The run is let go of when the debugger leaves the stop with no
    // outcome to judge: its UI throwing an ordinary error, or a leg it
    // resumed throwing before the leg had a context of its own, as a
    // rewind whose restore fails does. A failed `:load` is neither: the
    // driver goes back to the stop, and the run keeps the debugger.
    const thisRun = debugRunOfStack(stops[0]?.checkpoint?.stack);
    let ran: AttachedRunResult;
    try {
      ran = await attached.run(current.value, leg);
    } catch (error) {
      letGoOfDebugRun(ctx, thisRun);
      throw error;
    }
    debuggerRanALeg = true;
    if ("threw" in ran) {
      letGoOfDebugRun(ctx, thisRun);
      return { status: "threw", error: ran.threw, usage: ran.usage, traceId: current.traceId };
    }
    current = {
      status: "returned",
      value: ran.result,
      usage: ran.usage ?? current.usage,
      traceId: current.traceId,
    };
  }
  return current;
}

/** Resume a batch of nothing but debug stops with `leg`'s options, the
 *  way the debugger would on `continue`. */
function letStopsGo(
  ctx: RuntimeContext<GraphState>,
  stops: Interrupt[],
  leg: LegOptions,
): Promise<Outcome> {
  return respondToInterruptsForServe({
    ctx,
    interrupts: stops,
    responses: stops.map(() => ({ type: "approve" as const })),
    invocation: leg.invocation,
    metadata: {
      callbacks: leg.callbacks,
      [ATTACHED_RESUME]: true,
      [ATTACHED_AGENT_END]: leg.agentEnd === true,
    },
    abortSignal: leg.abortSignal,
    pauseSignal: leg.pauseSignal,
  });
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
