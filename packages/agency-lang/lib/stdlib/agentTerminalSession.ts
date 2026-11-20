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
import { failure, type Result } from "../types/result.js";
import {
  _readSessionRecord,
  canResume,
  readSavedRun,
  type SessionRecord,
} from "./agentSessions.js";
import { renderEditDiff } from "./agentTerminalDiff.js";
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
  takeHold,
  type AgentModule,
  type AgentStep,
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
import { stopDroppedJobs } from "./agentDriver/jobControl.js";

/** What the terminal's shell run does for the session. Each is an Agency
 *  function of the shell run, called back from TypeScript.
 *
 *  - `ask`: ask the person about one interrupt. It throws a cancellation
 *    when the person presses Esc at the prompt.
 *  - `policy`: the rules in force now. Read before each leg and after each
 *    answer, so an "always" answer reaches the rest of the pause.
 *  - `show`: print a line the driver has for the person.
 *  - `forked`: the session was forked from one id to another, so a
 *    session policy file the shell saves "always" answers to moves too. */
export type TerminalShell = {
  ask: (interrupt: Interrupt) => Promise<InterruptResponse>;
  policy: () => Promise<Policy>;
  show: (line: ShownLine) => Promise<void>;
  forked?: (from: string, to: string) => Promise<void>;
};

export type ShownLine = { kind: "reply" | "error" | "info" | "warning"; text: string };

/** A line a leg reported. `editOf` is the file of an edit's diff, which is
 *  shown only when no prompt draws it. */
type Reported = ShownLine & { editOf?: string };

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

/** An edit's diff as the core reports it (`session.editDiff`). */
function editDiffLine(data: object): Reported | null {
  if (!("filename" in data) || !("hunks" in data) || !Array.isArray(data.hunks)) {
    return null;
  }
  const filename = String(data.filename);
  return { kind: "info", text: renderEditDiff(filename, data.hunks), editOf: filename };
}

/** Collects what a leg reports for the person: the reply, the errors, and
 *  each edit's diff. The terminal's trace callbacks print everything else. */
function callbacksFor(reported: Reported[]): AgencyCallbacks {
  return {
    onEmit: (data: unknown) => {
      if (typeof data !== "object" || data === null || !("type" in data)) {
        return;
      }
      if (data.type === "session.reply" && "text" in data) {
        reported.push({ kind: "reply", text: String(data.text) });
      } else if (data.type === "session.error" && "message" in data) {
        reported.push({ kind: "error", text: String(data.message) });
      } else if (data.type === "session.editDiff") {
        const diff = editDiffLine(data);
        if (diff !== null) reported.push(diff);
      }
    },
  };
}

/** The files of the edits a leg's new pause asks about: their prompt draws
 *  the diff, so the leg's report of it is not shown too. */
function editsAsked(result: Result<AgentStep>): string[] {
  if (!result.success || result.value.kind !== "needsApproval") {
    return [];
  }
  return result.value.interrupts
    .filter((interrupt) => interrupt.effect === "std::edit")
    .map((interrupt) => {
      const data: unknown = interrupt.data;
      return typeof data === "object" && data !== null && "filename" in data
        ? String(data.filename)
        : "";
    });
}

/** What of a leg's report to show: everything but the diffs a prompt will
 *  draw. */
function linesToShow(reported: Reported[], result: Result<AgentStep>): ShownLine[] {
  const asked = editsAsked(result);
  return reported
    .filter((line) => line.editOf === undefined || !asked.includes(line.editOf))
    .map(({ kind, text }) => ({ kind, text }));
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
 *  no turn yet, is not saved. Gives the line to show when the save
 *  failed. */
async function saveTerminalRun(
  args: TerminalSessionArgs,
  phase: DriverPhase,
): Promise<ShownLine[]> {
  const record = recordOf(phase);
  const run = savedRun(phase);
  if (record === null || run === null || record.turns === 0) {
    return [];
  }
  const saved = await saveRun({ dir: args.dir, record, run, holder: args.holder });
  if (!saved.success) {
    return [{ kind: "warning", text: `Could not save the session: ${saved.error}` }];
  }
  args.onSaved?.(record.id);
  return [];
}

/** Does what one thing the driver reports needs, without the shell, and
 *  gives the lines to show for it. The shell is called only after this:
 *  when Esc cancels the shell run, the shell can't run anything, and a
 *  dropped turn's jobs must still be stopped. */
async function actOn(args: TerminalSessionArgs, happened: Happened): Promise<ShownLine[]> {
  switch (happened.type) {
    case "settled":
      return [settledLine(happened.interrupt, happened.response)];
    case "legFailed":
    case "startFailed":
      return [{ kind: "error", text: happened.error }];
    case "turnJobsDropped":
      await stopDroppedJobs(args.host, happened.jobs);
      return [];
    case "forked": {
      const copied = await copyCarriedPolicy({
        home: args.home,
        from: happened.from,
        to: happened.to,
      });
      return copied.success ? [] : [{ kind: "warning", text: copied.error }];
    }
    default:
      return [];
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

/** Runs one leg, and gives the action that finishes it and the lines to
 *  show. It calls nothing of the shell's after the leg: the caller applies
 *  the action first, so a shell that fails while showing a line never
 *  leaves a finished leg unapplied. The policy read before the leg settles
 *  the new pause's approvals; no answer was given during the leg. */
async function runLeg(
  args: TerminalSessionArgs,
  leg: Leg,
  shell: TerminalShell,
  abortSignal: AbortSignal | undefined,
): Promise<{ action: DriverAction; usage: RunUsage | null; shown: ShownLine[] }> {
  const reported: Reported[] = [];
  const policy = await shell.policy();
  const outcome: LegOutcome = await resumeRun({
    agent: args.agent,
    callbacks: callbacksFor(reported),
    policy,
    interrupts: leg.interrupts,
    responses: leg.responses,
    abortSignal,
  });
  return {
    action: {
      type: "legFinished",
      result: outcome.result,
      settle: settleUnder(policy, args.host),
      startedJobs: outcome.startedJobs,
    },
    usage: outcome.usage,
    shown: linesToShow(reported, outcome.result),
  };
}

/** The action that leaves a turn an error interrupted: a turn waiting on
 *  an approval is dropped, as Esc drops it, and one whose leg was not
 *  applied fails. Null when no turn is in progress. */
function actionAfterError(phase: DriverPhase, error: unknown): DriverAction | null {
  if (phase.kind === "approving") {
    return { type: "approvalCancelled" };
  }
  if (phase.kind === "working" || phase.kind === "answering") {
    const message = error instanceof Error ? error.message : String(error);
    return { type: "legFinished", result: failure(message), settle: () => null };
  }
  return null;
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

  /** Moves to the phase `action` leads to, with no side effect, and gives
   *  what happened on the way. */
  const advance = (action: DriverAction): Happened[] => {
    const next = reduceDriver(phase, action);
    phase = next.phase;
    return next.happened;
  };

  /** Acts on what happened and saves, then shows `first` (a leg's lines)
   *  and what happened, and tells the shell of a fork. Nothing calls the
   *  shell until the jobs are stopped and the session is saved. */
  const afterwards = async (
    happened: Happened[],
    shell: TerminalShell,
    first: ShownLine[] = [],
  ): Promise<void> => {
    const lines = [...first];
    for (const each of happened) {
      lines.push(...(await actOn(args, each)));
    }
    if (phase.kind === "waitingForUser" || phase.kind === "approving") {
      // run-read-ok: the save takes the record's lock on the host of whatever run is current, or on the process's lock host. One terminal session saves one step at a time, so the lock never contends.
      lines.push(...(await saveTerminalRun(args, phase)));
    }
    for (const line of lines) {
      await shell.show(line);
    }
    for (const each of happened) {
      if (each.type === "forked") {
        await shell.forked?.(each.from, each.to);
      }
    }
  };

  const apply = async (action: DriverAction, shell: TerminalShell): Promise<void> => {
    await afterwards(advance(action), shell);
  };

  /** After an error in the middle of a turn: the session goes back to
   *  waiting for a message, so it never stays stuck in a turn that refuses
   *  every later line. The turn's jobs are stopped. What the shell could
   *  not show is not tried again. */
  const recover = async (error: unknown): Promise<void> => {
    const action = actionAfterError(phase, error);
    if (action === null) {
      return;
    }
    for (const each of advance(action)) {
      if (each.type === "turnJobsDropped") {
        await stopDroppedJobs(args.host, each.jobs);
      }
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
      await afterwards(advance(leg.action), shell, leg.shown);
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
    try {
      while (await step(shell, abortSignal)) {
        // Each step changed the phase; go on until there is nothing to do.
      }
    } catch (error) {
      await recover(error);
      throw error;
    }
  };

  return {
    async start(shell) {
      const policy = await shell.policy();
      const reported: Reported[] = [];
      const outcome = await startRun({
        agent: args.agent,
        callbacks: callbacksFor(reported),
        policy,
      });
      usage = outcome.usage ?? usage;
      const happened = advance({
        type: "legFinished",
        result: outcome.result,
        settle: settleUnder(policy, args.host),
      });
      await afterwards(happened, shell, linesToShow(reported, outcome.result));
      return endedReason();
    },

    async resume(id, shell) {
      const run = await readSavedRun(args.dir, id);
      if (run === null) {
        return `The file for session ${id} is missing or is not a saved session.`;
      }
      // A session this build can't run is refused before taking hold, so
      // the front-end that has it open keeps it.
      if (canResume(run) !== "yes") {
        phase = restoredPhase(run).phase;
        return endedReason();
      }
      // run-read-ok: takeHold locks the record as a save does (see `apply`), before this session has run any leg.
      const held = await takeHold({ dir: args.dir, id, holder: args.holder });
      if (!held.success) {
        return held.error;
      }
      const restored = restoredPhase(run, { settle: settleUnder(await shell.policy(), args.host) });
      phase = restored.phase;
      for (const happened of restored.happened) {
        for (const line of await actOn(args, happened)) {
          await shell.show(line);
        }
      }
      if (endedReason() === "") {
        await drive(shell);
      }
      return endedReason();
    },

    async send(answer, shell, abortSignal) {
      if (phase.kind !== "waitingForUser") {
        const why = endedReason() || "The session is not waiting for a message.";
        await shell.show({ kind: "warning", text: why });
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
