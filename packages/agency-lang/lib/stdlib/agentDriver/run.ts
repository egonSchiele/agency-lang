// Starting and resuming a session run. Stateless: the caller keeps the
// pause and says what to answer it with. See docs/dev/agents/session-driver.md.
import type { Host } from "../../host/host.js";
import { isAbortError } from "../../runtime/errors.js";
import type { AgencyCallbacks } from "../../runtime/hooks.js";
import { hasInterrupts, type Interrupt, type InterruptResponse } from "../../runtime/interrupts.js";
import type { RunUsage } from "../../runtime/invocationUsage.js";
import type { Policy } from "../../runtime/policy.js";
import { isFailure } from "../../runtime/result.js";
import type { RunNodeResult } from "../../runtime/types.js";
import { failure, success, type Result } from "../../types/result.js";
import { SESSION_INPUT_EFFECT } from "./interface.js";
import { withPauseLeftAlone } from "./policy.js";

export const RUN_ENDED_ERROR = "The agent run ended unexpectedly.";

// `policy` is the run's policy: it answers the approvals a rule matches,
// inside the run. `host` is what the run takes from its platform, its
// working folder included. `logFile` is where the run's events are logged.
// Like the callbacks, all three must be given again on every resume: the
// runtime does not keep them.
type Placement = { host?: Host; logFile?: string };
export type StartOptions = { callbacks: AgencyCallbacks; policy?: Policy } & Placement;
export type ResumeMetadata = { callbacks: AgencyCallbacks };
export type ResumeInvocation = { policy?: Policy } & Placement;
export type ResumeOptions = {
  metadata: ResumeMetadata;
  invocation?: ResumeInvocation;
  abortSignal?: AbortSignal;
};

export type RespondToInterrupts = (
  interrupts: Interrupt[],
  responses: InterruptResponse[],
  opts: ResumeOptions,
) => Promise<RunNodeResult<unknown>>;

/** A compiled session program, as a front-end uses it: start the run and
 *  resume it. `main` has its start data bound already. */
export type AgentModule = {
  main: (opts: StartOptions) => Promise<RunNodeResult<unknown>>;
  respondToInterrupts: RespondToInterrupts;
};

export type AgentStep =
  | { kind: "waitingForUser"; interrupts: Interrupt[] }
  | { kind: "needsApproval"; interrupts: Interrupt[] }
  | { kind: "cancelled" };

/** What one call into the run gave back. `usage` is the run's total
 *  spend so far, or null when the call threw and gave back no result. */
export type LegOutcome = { result: Result<AgentStep>; usage: RunUsage | null };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failureError(data: unknown): string {
  if (typeof data === "object" && data !== null && "error" in data) {
    return String(data.error);
  }
  return RUN_ENDED_ERROR;
}

/** What a paused (or finished) run is asking for next. */
export function toStep(result: RunNodeResult<unknown>): Result<AgentStep> {
  const data: unknown = result.data;
  if (isFailure(data)) {
    return failure(failureError(data));
  }
  if (!hasInterrupts(data)) {
    return failure(RUN_ENDED_ERROR);
  }
  const interrupts: Interrupt[] = data;
  const wantsMessage = interrupts.some((interrupt) => interrupt.effect === SESSION_INPUT_EFFECT);
  if (wantsMessage) {
    return success({ kind: "waitingForUser", interrupts });
  }
  return success({ kind: "needsApproval", interrupts });
}

function outcomeOf(result: RunNodeResult<unknown>): LegOutcome {
  return { result: toStep(result), usage: result.usage ?? null };
}

/** The policy a run is given: the caller's, or none, with the core's
 *  pause pinned. Applied here so no front-end can forget the pin. */
function runPolicy(policy: Policy | null): Policy {
  return withPauseLeftAlone(policy ?? {});
}

/** Starts the run. `policy` null means no rules: every approval reaches
 *  the front-end. */
export async function startRun(args: {
  agent: AgentModule;
  callbacks: AgencyCallbacks;
  policy: Policy | null;
}): Promise<LegOutcome> {
  const policy = runPolicy(args.policy);
  try {
    const result = await args.agent.main({ callbacks: args.callbacks, policy });
    return outcomeOf(result);
  } catch (error) {
    return { result: failure(errorText(error)), usage: null };
  }
}

/** Resumes the run. The callbacks and the policy are passed again on
 *  every resume: the runtime does not keep the ones given to `main`. An
 *  abort through `abortSignal` comes back as `cancelled`. */
export async function resumeRun(args: {
  agent: AgentModule;
  callbacks: AgencyCallbacks;
  policy: Policy | null;
  interrupts: Interrupt[];
  responses: InterruptResponse[];
  abortSignal?: AbortSignal;
}): Promise<LegOutcome> {
  const policy = runPolicy(args.policy);
  try {
    const result = await args.agent.respondToInterrupts(args.interrupts, args.responses, {
      metadata: { callbacks: args.callbacks },
      invocation: { policy },
      abortSignal: args.abortSignal,
    });
    return outcomeOf(result);
  } catch (error) {
    if (isAbortError(error)) {
      return { result: success({ kind: "cancelled" }), usage: null };
    }
    return { result: failure(errorText(error)), usage: null };
  }
}

function quoted(texts: string[]): string {
  return texts.map((text) => `"${text}"`).join(", ");
}

/** Prefixes a message with a note about requests the user cancelled, since
 *  the agent no longer remembers them but their side effects remain. */
export function withCancelNote(args: { message: string; cancelledTexts: string[] }): string {
  const { message, cancelledTexts } = args;
  if (cancelledTexts.length === 0) {
    return message;
  }
  let note: string;
  if (cancelledTexts.length === 1) {
    note = `(The user cancelled their previous request, ${quoted(cancelledTexts)}, partway through. Some of its changes may already have been made.)`;
  } else {
    note = `(The user cancelled their previous requests, ${quoted(cancelledTexts)}, partway through. Some of their changes may already have been made.)`;
  }
  return `${note}\n\n${message}`;
}
