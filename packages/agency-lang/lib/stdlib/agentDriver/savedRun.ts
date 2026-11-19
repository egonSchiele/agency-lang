// Saving a session run and loading it back, and which front-end holds it.
// The files are written and read by agentSessions.ts. See
// docs/dev/agents/session-driver.md.
import { currentHost } from "../../runtime/currentHost.js";
import type { Policy } from "../../runtime/policy.js";
import { processSlot } from "../../runtime/processSlot.js";
import { failure, success, type Result } from "../../types/result.js";
import {
  _readSessionRecord,
  _saveSession,
  _saveSessionRecord,
  _withRecordLock,
  canResume,
  type SavedRun,
  type SessionHolder,
  type SessionRecord,
} from "../agentSessions.js";
import type { Settle } from "./approvals.js";
import { droppedOf, reduceDriver, type DriverPhase, type DriverStep } from "./machine.js";
import type { AgentStep } from "./run.js";

/** The front-end that has a session open: its name, such as `terminal`,
 *  its process id, and `thisProcessId()`. */
export type Holder = SessionHolder;

export const CANNOT_CONTINUE =
  "This session was saved by another version of the agent and can't continue.";

export const PROGRAM_NOT_LOADED =
  "This session's program is not loaded. Load the session program before loading the session.";

const processId = processSlot<string>("agency.sessionHolderId", () => currentHost().random.id());

/** A random id for this process, made on the first call. A front-end puts
 *  it in its `Holder`. */
export function thisProcessId(): string {
  return processId.get();
}

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
      return { version: 1, pause: phase.pause, ...droppedOf(phase), turn: null };
    case "working":
      return {
        version: 1,
        pause: phase.pause,
        ...droppedOf(phase),
        turn: { text: phase.text, approvals: null },
      };
    case "approving":
      return {
        version: 1,
        pause: phase.pause,
        ...droppedOf(phase),
        turn: { text: phase.text, approvals: phase.queue.interrupts },
      };
  }
}

// With no `settle` given, a loaded session's approvals are all asked again.
const asksAll: Settle = () => null;

/** The phase to go on from.
 *
 *  - Waiting for a message: where it was.
 *  - Waiting on approvals: each goes through `settle`, as a new pause's
 *    do. With none given, every one is asked again.
 *  - A turn that was running (the process stopped mid-turn): back to the
 *    turn's start, as if the person had cancelled it.
 *  - Saved by code that differs from the code loaded now: ended. It takes
 *    nothing.
 *  - Saved by a module that is not loaded: ended, with `PROGRAM_NOT_LOADED`.
 *    The front-end loads the session program before it loads a session.
 *
 *  The two turn cases go through `reduceDriver`, so they behave as the live
 *  ones do.
 *
 *  `carried` is the session's own policy (`readCarriedPolicy`). When there
 *  is one, `happened` starts with `carriedPolicy`, so the front-end shows
 *  the person what that policy approves before the session runs. */
export function restoredPhase(
  run: SavedRun,
  options: { settle?: Settle; carried?: Policy | null } = {},
): DriverStep {
  const restored = restoredStep(run, options.settle ?? asksAll);
  const carried = options.carried ?? null;
  if (carried === null || restored.phase.kind === "ended") {
    return restored;
  }
  return {
    phase: restored.phase,
    happened: [{ type: "carriedPolicy", policy: carried }, ...restored.happened],
  };
}

function restoredStep(run: SavedRun, settle: Settle): DriverStep {
  const { pause, turn } = run;
  const dropped = droppedOf(run);
  switch (canResume(run)) {
    case "changed":
      return { phase: { kind: "ended", reason: CANNOT_CONTINUE }, happened: [] };
    case "notLoaded":
      return { phase: { kind: "ended", reason: PROGRAM_NOT_LOADED }, happened: [] };
    case "yes":
      break;
  }
  if (turn === null) {
    return { phase: { kind: "waitingForUser", pause, ...dropped }, happened: [] };
  }
  const running: DriverPhase = {
    kind: "working",
    pause,
    text: turn.text,
    ...dropped,
    leg: { interrupts: pause, responses: [] },
  };
  const step: AgentStep =
    turn.approvals === null
      ? { kind: "cancelled" }
      : { kind: "needsApproval", interrupts: turn.approvals };
  return reduceDriver(running, {
    type: "legFinished",
    result: success(step),
    settle,
  });
}

/** Writes the run, then its record, which says the file holds a saved run
 *  and who holds the session. Fails, and writes nothing, when the record
 *  names another holder: that front-end took the session, and this save
 *  would overwrite its work. A session with no record yet may be saved.
 *  The check and the write are made under the record's lock. */
export async function saveRun(args: {
  dir: string;
  record: SessionRecord;
  run: SavedRun;
  holder: Holder;
}): Promise<Result<null>> {
  const { dir, run, holder } = args;
  const record: SessionRecord = { ...args.record, runFormat: "savedRun", heldBy: holder };
  const failed = `Could not save session ${record.id}`;
  return underRecordLock({ dir, id: record.id, failed }, async () => {
    const heldBy = (await _readSessionRecord(dir, record.id))?.heldBy;
    if (heldBy != null && !sameHolder(heldBy, holder)) {
      return failure(`${failed}: ${heldByText(heldBy)}.`);
    }
    const problem = await _saveSession(dir, record, run);
    if (problem !== "") {
      return failure(`${failed}: ${problem}`);
    }
    return success(null);
  });
}

/** Runs `work` under the record's lock. A lock that can't be taken, as on
 *  a sessions folder that is a file, fails with `failed` and the reason. */
async function underRecordLock(
  where: { dir: string; id: string; failed: string },
  work: () => Promise<Result<null>>,
): Promise<Result<null>> {
  try {
    return await _withRecordLock(where.dir, where.id, work);
  } catch (error) {
    return failure(`${where.failed}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function heldByText(holder: Holder): string {
  return `held by ${holder.frontEnd} (process ${holder.pid})`;
}

/** Marks the session as held by `holder`, on its record alone. A
 *  front-end calls it when it resumes a session, before its first leg, so
 *  the front-end that had it open sees at once that it moved. Fails when
 *  there is no such session or its record can't be written. The read and
 *  the write are made under the record's lock. */
export async function takeHold(args: {
  dir: string;
  id: string;
  holder: Holder;
}): Promise<Result<null>> {
  const { dir, id, holder } = args;
  const failed = `Could not take hold of session ${id}`;
  return underRecordLock({ dir, id, failed }, async () => {
    const record = await _readSessionRecord(dir, id);
    if (record === null) {
      return failure(`${failed}: it has no record in ${dir}.`);
    }
    const problem = await _saveSessionRecord(dir, { ...record, heldBy: holder });
    if (problem !== "") {
      return failure(`${failed}: ${problem}`);
    }
    return success(null);
  });
}

function sameHolder(left: Holder, right: Holder): boolean {
  return left.frontEnd === right.frontEnd && left.processId === right.processId;
}

/** False when another front-end has taken the session since: its record
 *  names another holder. A session with no record yet, or one no one has
 *  taken hold of, is still this front-end's. */
export async function stillHeld(args: {
  dir: string;
  id: string;
  holder: Holder;
}): Promise<boolean> {
  const record = await _readSessionRecord(args.dir, args.id);
  const heldBy = record?.heldBy;
  return heldBy == null || sameHolder(heldBy, args.holder);
}
