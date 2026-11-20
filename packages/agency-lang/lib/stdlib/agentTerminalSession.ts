// The terminal's session: one session run, driven through the session
// driver (lib/stdlib/agentDriver/), with the terminal's shell run asked
// about what no rule decides. `agentTerminalDriver.ts` holds one of these
// for the process and gives it to the shell run's Agency code. See
// docs/dev/agents/session-driver.md, "The terminal".
import type { Host } from "../host/host.js";
import { isAbortError } from "../runtime/errors.js";
import type { AgencyCallbacks } from "../runtime/hooks.js";
import type { Interrupt, InterruptResponse } from "../runtime/interrupts.js";
import { approve, reject } from "../runtime/interruptResponse.js";
import type { RunUsage } from "../runtime/invocationUsage.js";
import { mergeHeldJobs, type HeldJob } from "../runtime/jobs/heldJobs.js";
import { checkPolicyExplicit, type Policy } from "../runtime/policy.js";
import { resolvePolicyDirs } from "../runtime/policyDirs.js";
import { _readSessionRecord, readSavedRun, type SessionRecord } from "./agentSessions.js";
import {
  copyCarriedPolicy,
  currentApproval,
  heldJobsOf,
  initialPhase,
  pauseData,
  reduceDriver,
  restoredPhase,
  resumeRun,
  saveRun,
  savedRun,
  startRun,
  stillHeld,
  stopDroppedJobs,
  takeHold,
  type AgentModule,
  type Answer,
  type DriverAction,
  type DriverPhase,
  type Happened,
  type Holder,
  type Leg,
  type LegOutcome,
  type PauseData,
  type Settle,
} from "./agentDriver/index.js";

/** What the terminal's shell run does for the session. Each is an Agency
 *  function of the shell run, called back from TypeScript.
 *
 *  - `ask`: ask the person about one interrupt. It throws a cancellation
 *    when the person presses Esc at the prompt.
 *  - `policy`: the rules in force now. Read before each leg and after each
 *    answer, so an "always" answer reaches the rest of the pause.
 *  - `show`: print a line the driver has for the person. */
export type TerminalShell = {
  ask: (interrupt: Interrupt) => Promise<InterruptResponse>;
  policy: () => Promise<Policy>;
  show: (line: ShownLine) => Promise<void>;
};

export type ShownLine = { kind: "reply" | "error" | "info" | "warning"; text: string };

export type TerminalSession = {
  /** Starts the run. "" or why it could not start. */
  start(shell: TerminalShell): Promise<string>;
  /** Loads saved session `id`, takes hold of it, and goes on from where
   *  it was saved: a turn waiting on approvals asks them again. "" or why
   *  it can't go on. */
  resume(id: string, shell: TerminalShell): Promise<string>;
  /** Sends an answer and runs legs until the session waits for a message
   *  again. `abortSignal` aborts a running leg (Esc while the model works). */
  send(answer: Answer, shell: TerminalShell, abortSignal?: AbortSignal): Promise<void>;
  pause(): PauseData | null;
  usage(): RunUsage | null;
  /** The jobs the session holds now: the newest pause's, and the ones the
   *  turn in progress started. */
  heldJobs(): HeldJob[];
  /** Why the session can't go on, or "" while it can. */
  endedBecause(): string;
};

export type TerminalSessionArgs = {
  agent: AgentModule;
  /** The sessions folder the record and the run are saved in. */
  dir: string;
  /** The agent home, where a session's own policy file is kept. */
  home: string;
  holder: Holder;
  host: Host;
  /** Called after each save, with the session's id. */
  onSaved?: (id: string) => void;
};

/** Collects what a leg reports for the person: the reply and the errors.
 *  The terminal's trace callbacks print everything else. */
function callbacksFor(shown: ShownLine[]): AgencyCallbacks {
  return {
    onEmit: (data: unknown) => {
      if (typeof data !== "object" || data === null || !("type" in data)) {
        return;
      }
      if (data.type === "session.reply" && "text" in data) {
        shown.push({ kind: "reply", text: String(data.text) });
      } else if (data.type === "session.error" && "message" in data) {
        shown.push({ kind: "error", text: String(data.message) });
      }
    },
  };
}

/** The answer a rule in `policy` gives an interrupt, or null when it gives
 *  none. A reject rule answers anything. An approve rule answers only a
 *  raise that wants no typed value, as the terminal's handler does: an
 *  approval from a rule carries no value. */
export function settleUnder(policy: Policy, host: Host): Settle {
  const dirs = resolvePolicyDirs(host);
  return (interrupt) => {
    const decision = checkPolicyExplicit(policy, interrupt, dirs);
    if (decision === null) {
      return null;
    }
    if (decision.type === "reject") {
      return { response: reject(decision.message), by: "rule" };
    }
    if (decision.type === "approve" && interrupt.expectsValue !== true) {
      return { response: approve(), by: "rule" };
    }
    return null;
  };
}

/** The line for an approval a rule just answered, as `std::policy` prints
 *  it. */
export function settledLine(interrupt: Interrupt, response: InterruptResponse): ShownLine {
  if (response.type === "approve") {
    return { kind: "info", text: `⏺ Approved ${interrupt.effect} by the rule just saved` };
  }
  return { kind: "warning", text: `Policy rejected ${interrupt.effect}` };
}

/** Why a session that another front-end took can't go on here. */
export function movedMessage(heldBy: string, id: string): string {
  return `This session was continued in ${heldBy}. Reopen it with: agency agent --resume ${id}`;
}

/** The record the phase's pause reports, or null for a session that is
 *  not saved, or one that has not started or has ended. */
function recordOf(phase: DriverPhase): SessionRecord | null {
  if (phase.kind === "starting" || phase.kind === "ended") {
    return null;
  }
  return pauseData(phase.pause)?.record ?? null;
}

/** The interrupts the run gave the driver last: the approvals a turn waits
 *  on, or the pause. */
function newestInterrupts(phase: DriverPhase): Interrupt[] {
  switch (phase.kind) {
    case "starting":
    case "ended":
      return [];
    case "approving":
      return phase.queue.interrupts;
    default:
      return phase.pause;
  }
}

function heldJobsIn(phase: DriverPhase): HeldJob[] {
  const turnJobs = phase.kind === "working" || phase.kind === "approving" ? phase.turnJobs : [];
  return mergeHeldJobs(heldJobsOf(newestInterrupts(phase)), turnJobs);
}

/** Saves the session as the phase has it. A session with no record, or
 *  no turn yet, is not saved. */
async function saveTerminalRun(
  args: TerminalSessionArgs,
  phase: DriverPhase,
  shell: TerminalShell,
): Promise<void> {
  const record = recordOf(phase);
  const run = savedRun(phase);
  if (record === null || run === null || record.turns === 0) {
    return;
  }
  const saved = await saveRun({ dir: args.dir, record, run, holder: args.holder });
  if (!saved.success) {
    await shell.show({ kind: "warning", text: `Could not save the session: ${saved.error}` });
    return;
  }
  args.onSaved?.(record.id);
}

/** Shows, or acts on, one thing the driver reports. */
async function onHappened(
  args: TerminalSessionArgs,
  happened: Happened,
  shell: TerminalShell,
): Promise<void> {
  switch (happened.type) {
    case "settled":
      await shell.show(settledLine(happened.interrupt, happened.response));
      return;
    case "legFailed":
    case "startFailed":
      await shell.show({ kind: "error", text: happened.error });
      return;
    case "turnJobsDropped":
      await stopDroppedJobs(args.host, happened.jobs);
      return;
    case "forked": {
      const copied = await copyCarriedPolicy({
        home: args.home,
        from: happened.from,
        to: happened.to,
      });
      if (!copied.success) {
        await shell.show({ kind: "warning", text: copied.error });
      }
      return;
    }
    default:
      return;
  }
}

/** The reason to stop, when another front-end took the session since this
 *  one last checked; null while it is still this one's. */
async function movedAway(args: TerminalSessionArgs, phase: DriverPhase): Promise<string | null> {
  const record = recordOf(phase);
  if (record === null) {
    return null;
  }
  if (await stillHeld({ dir: args.dir, id: record.id, holder: args.holder })) {
    return null;
  }
  const now = await _readSessionRecord(args.dir, record.id);
  return movedMessage(now?.heldBy?.frontEnd ?? "another front-end", record.id);
}

/** Runs one leg, shows what it reported, and gives the action that
 *  finishes it. */
async function runLeg(
  args: TerminalSessionArgs,
  leg: Leg,
  shell: TerminalShell,
  abortSignal: AbortSignal | undefined,
): Promise<{ action: DriverAction; usage: RunUsage | null }> {
  const shown: ShownLine[] = [];
  const outcome: LegOutcome = await resumeRun({
    agent: args.agent,
    callbacks: callbacksFor(shown),
    policy: await shell.policy(),
    interrupts: leg.interrupts,
    responses: leg.responses,
    abortSignal,
  });
  for (const line of shown) {
    await shell.show(line);
  }
  const settle = settleUnder(await shell.policy(), args.host);
  return {
    action: {
      type: "legFinished",
      result: outcome.result,
      settle,
      startedJobs: outcome.startedJobs,
    },
    usage: outcome.usage,
  };
}

/** Asks the approval showing, and gives the action that answers it. */
async function askApproval(
  args: TerminalSessionArgs,
  interrupt: Interrupt,
  shell: TerminalShell,
): Promise<DriverAction> {
  let response: InterruptResponse;
  try {
    response = await shell.ask(interrupt);
  } catch (error) {
    if (isAbortError(error)) {
      return { type: "approvalCancelled" };
    }
    throw error;
  }
  const settle = settleUnder(await shell.policy(), args.host);
  return { type: "decided", response, interruptId: interrupt.interruptId, settle };
}

export function terminalSession(args: TerminalSessionArgs): TerminalSession {
  let phase: DriverPhase = initialPhase;
  let usage: RunUsage | null = null;

  // A function, so a read after an await sees the phase as it is now.
  const endedReason = (): string => (phase.kind === "ended" ? phase.reason : "");

  const apply = async (action: DriverAction, shell: TerminalShell): Promise<void> => {
    const step = reduceDriver(phase, action);
    phase = step.phase;
    for (const happened of step.happened) {
      await onHappened(args, happened, shell);
    }
    if (phase.kind === "waitingForUser" || phase.kind === "approving") {
      await saveTerminalRun(args, phase, shell);
    }
  };

  /** One step of a turn: a leg, or one approval. False when there is
   *  nothing more to do until the next answer. */
  const step = async (shell: TerminalShell, abortSignal?: AbortSignal): Promise<boolean> => {
    if (phase.kind === "working" || phase.kind === "answering") {
      const moved = await movedAway(args, phase);
      if (moved !== null) {
        phase = { kind: "ended", reason: moved };
        await shell.show({ kind: "warning", text: moved });
        return false;
      }
      const leg = await runLeg(args, phase.leg, shell, abortSignal);
      usage = leg.usage ?? usage;
      await apply(leg.action, shell);
      return true;
    }
    const showing = phase.kind === "approving" ? currentApproval(phase.queue) : null;
    if (showing === null) {
      return false;
    }
    await apply(await askApproval(args, showing, shell), shell);
    return true;
  };

  const drive = async (shell: TerminalShell, abortSignal?: AbortSignal): Promise<void> => {
    while (await step(shell, abortSignal)) {
      // Each step changed the phase; go on until there is nothing to do.
    }
  };

  return {
    async start(shell) {
      const policy = await shell.policy();
      const shown: ShownLine[] = [];
      const outcome = await startRun({ agent: args.agent, callbacks: callbacksFor(shown), policy });
      usage = outcome.usage ?? usage;
      for (const line of shown) {
        await shell.show(line);
      }
      const settle = settleUnder(policy, args.host);
      await apply({ type: "legFinished", result: outcome.result, settle }, shell);
      return endedReason();
    },

    async resume(id, shell) {
      const run = await readSavedRun(args.dir, id);
      if (run === null) {
        return `The file for session ${id} is missing or is not a saved session.`;
      }
      const held = await takeHold({ dir: args.dir, id, holder: args.holder });
      if (!held.success) {
        return held.error;
      }
      const restored = restoredPhase(run, { settle: settleUnder(await shell.policy(), args.host) });
      phase = restored.phase;
      for (const happened of restored.happened) {
        await onHappened(args, happened, shell);
      }
      if (endedReason() === "") {
        await drive(shell);
      }
      return endedReason();
    },

    async send(answer, shell, abortSignal) {
      if (phase.kind !== "waitingForUser") {
        return;
      }
      const action: DriverAction =
        answer.kind === "message"
          ? { type: "submitted", text: answer.text, notes: answer.notes, target: answer.target }
          : { type: "answered", answer };
      phase = reduceDriver(phase, action).phase;
      await drive(shell, abortSignal);
    },

    pause: () =>
      phase.kind === "starting" || phase.kind === "ended" ? null : pauseData(phase.pause),
    usage: () => usage,
    heldJobs: () => heldJobsIn(phase),
    endedBecause: () => endedReason(),
  };
}
