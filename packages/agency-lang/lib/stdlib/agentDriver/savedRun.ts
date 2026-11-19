// Saving a session run and loading it back, and which front-end holds it.
// The files are written and read by agentSessions.ts. See
// docs/dev/agents/session-driver.md.
import { failure, success, type Result } from "../../types/result.js";
import {
  _listSessions,
  _saveSession,
  _saveSessionRecord,
  canResume,
  type SavedRun,
  type SessionRecord,
} from "../agentSessions.js";
import { reduceDriver, type DriverPhase, type DriverStep } from "./machine.js";
import type { AgentStep } from "./run.js";

/** The front-end that has a session open: its name, such as `terminal`,
 *  and its process id. */
export type Holder = NonNullable<SessionRecord["heldBy"]>;

export const CANNOT_CONTINUE =
  "This session was saved by another version of the agent and can't continue.";

/** The run to save for a phase, or null when there is nothing to go on
 *  with: the run has not reached its first pause, or it ended. */
export function savedRun(phase: DriverPhase): SavedRun | null {
  switch (phase.kind) {
    case "starting":
    case "ended":
      return null;
    // A settings change on its way in is not saved: the session comes back
    // waiting for a message, with the settings it had.
    case "waitingForUser":
    case "answering":
      return { version: 1, pause: phase.pause, cancelledTexts: phase.cancelledTexts, turn: null };
    case "working":
      return {
        version: 1,
        pause: phase.pause,
        cancelledTexts: phase.cancelledTexts,
        turn: { text: phase.text, approvals: null },
      };
    case "approving":
      return {
        version: 1,
        pause: phase.pause,
        cancelledTexts: phase.cancelledTexts,
        turn: { text: phase.text, approvals: phase.queue.interrupts },
      };
  }
}

// A loaded session's approvals are all asked again: nothing settles them.
const asksAll = (): null => null;

/** The phase to go on from.
 *
 *  - Waiting for a message: where it was.
 *  - Waiting on approvals: every one is asked again.
 *  - A turn that was running (the process stopped mid-turn): back to the
 *    turn's start, as if the person had cancelled it.
 *  - Saved by code that is not loaded now: ended. It takes nothing.
 *
 *  The two turn cases go through `reduceDriver`, so they behave as the live
 *  ones do. */
export function restoredPhase(run: SavedRun): DriverStep {
  const { pause, cancelledTexts, turn } = run;
  if (!canResume(run)) {
    return { phase: { kind: "ended", reason: CANNOT_CONTINUE }, happened: [] };
  }
  if (turn === null) {
    return { phase: { kind: "waitingForUser", pause, cancelledTexts }, happened: [] };
  }
  const running: DriverPhase = {
    kind: "working",
    pause,
    text: turn.text,
    cancelledTexts,
    leg: { interrupts: pause, responses: [] },
  };
  const step: AgentStep =
    turn.approvals === null
      ? { kind: "cancelled" }
      : { kind: "needsApproval", interrupts: turn.approvals };
  return reduceDriver(running, {
    type: "legFinished",
    result: success(step),
    settle: asksAll,
  });
}

/** Writes the run, then its record, which says the file holds a saved run
 *  and who holds the session. */
export async function saveRun(args: {
  dir: string;
  record: SessionRecord;
  run: SavedRun;
  holder: Holder;
}): Promise<Result<null>> {
  const { dir, run, holder } = args;
  const record: SessionRecord = { ...args.record, runFormat: "savedRun", heldBy: holder };
  const problem = await _saveSession(dir, record, run);
  if (problem !== "") {
    return failure(`Could not save session ${record.id}: ${problem}`);
  }
  return success(null);
}

async function recordOf(dir: string, id: string): Promise<SessionRecord | null> {
  const records = await _listSessions(dir);
  return records.find((record) => record.id === id) ?? null;
}

/** Marks the session as held by `holder`, on its record alone. A
 *  front-end calls it when it resumes a session, before its first leg, so
 *  the front-end that had it open sees at once that it moved. Throws when
 *  there is no such session or its record can't be written. */
export async function takeHold(args: { dir: string; id: string; holder: Holder }): Promise<void> {
  const { dir, id, holder } = args;
  const record = await recordOf(dir, id);
  if (record === null) {
    throw new Error(`Could not take hold of session ${id}: it has no record in ${dir}.`);
  }
  const problem = await _saveSessionRecord(dir, { ...record, heldBy: holder });
  if (problem !== "") {
    throw new Error(`Could not take hold of session ${id}: ${problem}`);
  }
}

function sameHolder(left: Holder, right: Holder): boolean {
  return left.frontEnd === right.frontEnd && left.pid === right.pid;
}

/** False when another front-end has taken the session since: its record
 *  names another holder. A session with no record yet, or one no one has
 *  taken hold of, is still this front-end's. */
export async function stillHeld(args: {
  dir: string;
  id: string;
  holder: Holder;
}): Promise<boolean> {
  const record = await recordOf(args.dir, args.id);
  const heldBy = record?.heldBy;
  return heldBy == null || sameHolder(heldBy, args.holder);
}
