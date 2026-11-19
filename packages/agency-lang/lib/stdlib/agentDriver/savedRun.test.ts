import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import type { Interrupt } from "../../runtime/interrupts.js";
import { reject } from "../../runtime/interruptResponse.js";
import { failure, success } from "../../types/result.js";
import { safeDeleteDirectoryWithin } from "../../utils.js";
import {
  _listSessions,
  _saveSession,
  readSavedRun,
  type SavedRun,
  type SessionRecord,
} from "../agentSessions.js";
import type { Settle } from "./approvals.js";
import { POLICY_UNREADABLE } from "./interface.js";
import type { DriverPhase } from "./machine.js";
import {
  CANNOT_CONTINUE,
  restoredPhase,
  saveRun,
  savedRun,
  stillHeld,
  takeHold,
} from "./savedRun.js";

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const base = fs.mkdtempSync(path.join(process.cwd(), ".driver-test-"));
  try {
    await fn(path.join(base, "sessions"));
  } finally {
    expect(safeDeleteDirectoryWithin(process.cwd(), base).success).toBe(true);
  }
}

function waitingOn(effect: string, id: string, checkpoint: object = {}): Interrupt {
  return {
    type: "interrupt",
    effect,
    message: "",
    origin: "test",
    interruptId: id,
    data: {},
    runId: "run",
    checkpoint: checkpoint as Interrupt["checkpoint"],
  };
}

const PAUSE = [waitingOn("agent::sessionInput", "p1")];
const BASH = waitingOn("std::bash", "b1");

function run(turn: SavedRun["turn"]): SavedRun {
  return { version: 1, pause: PAUSE, cancelledTexts: ["earlier"], turn };
}

const RECORD: SessionRecord = {
  id: "s1",
  cwd: "/work",
  brain: "coder",
  created: 1,
  lastActive: 2,
  turns: 0,
  title: "a session",
};

const TERMINAL = { frontEnd: "terminal", pid: 10 };
const PERRY = { frontEnd: "perry", pid: 20 };

describe("savedRun", () => {
  it("is null before the first pause and after the run ended", () => {
    expect(savedRun({ kind: "starting" })).toBeNull();
    expect(savedRun({ kind: "ended", reason: "done" })).toBeNull();
  });

  it("saves a settings change on its way in as waiting for a message", () => {
    const phase: DriverPhase = {
      kind: "answering",
      pause: PAUSE,
      cancelledTexts: ["earlier"],
      answer: { kind: "effort", effort: "high" },
      leg: { interrupts: PAUSE, responses: [] },
    };
    expect(savedRun(phase)).toEqual(run(null));
  });

  it("saves a running turn's text, and a paused turn's approvals", () => {
    const leg = { interrupts: PAUSE, responses: [] };
    const working: DriverPhase = {
      kind: "working",
      pause: PAUSE,
      text: "do it",
      cancelledTexts: ["earlier"],
      leg,
    };
    expect(savedRun(working)).toEqual(run({ text: "do it", approvals: null }));
    const approving: DriverPhase = {
      kind: "approving",
      pause: PAUSE,
      text: "do it",
      cancelledTexts: ["earlier"],
      queue: { interrupts: [BASH], responses: [] },
    };
    expect(savedRun(approving)).toEqual(run({ text: "do it", approvals: [BASH] }));
  });
});

describe("restoredPhase", () => {
  it("picks up a session waiting for a message where it was", () => {
    expect(restoredPhase(run(null))).toEqual({
      phase: { kind: "waitingForUser", pause: PAUSE, cancelledTexts: ["earlier"] },
      happened: [],
    });
  });

  it("takes a turn that was running back to its start, as a cancel", () => {
    expect(restoredPhase(run({ text: "do it", approvals: null }))).toEqual({
      phase: { kind: "waitingForUser", pause: PAUSE, cancelledTexts: ["earlier", "do it"] },
      happened: [{ type: "turnCancelled" }],
    });
  });

  it("asks every approval of a paused turn again", () => {
    const { phase, happened } = restoredPhase(run({ text: "do it", approvals: [BASH] }));
    expect(phase).toEqual({
      kind: "approving",
      pause: PAUSE,
      text: "do it",
      cancelledTexts: ["earlier"],
      queue: { interrupts: [BASH], responses: [] },
    });
    expect(happened).toEqual([]);
  });

  // A front-end that can't ask for a typed value declines it in `settle`.
  it("passes a paused turn's approvals through the settle it is given", () => {
    const question: Interrupt = { ...waitingOn("std::question", "q1"), expectsValue: true };
    const declinesQuestions: Settle = (interrupt) =>
      interrupt.expectsValue === true ? { response: reject("can't answer"), by: "rule" } : null;
    const { phase, happened } = restoredPhase(
      run({ text: "do it", approvals: [question, BASH] }),
      declinesQuestions,
    );
    expect(phase).toEqual({
      kind: "approving",
      pause: PAUSE,
      text: "do it",
      cancelledTexts: ["earlier"],
      queue: { interrupts: [question, BASH], responses: [reject("can't answer")] },
    });
    expect(happened).toEqual([
      { type: "settled", interrupt: question, response: reject("can't answer"), by: "rule" },
    ]);
  });

  it("ends a session saved by code that is not loaded now", () => {
    const fingerprints = { moduleFingerprints: { "gone.agency": { hash: "0000" } } };
    const old: SavedRun = {
      ...run(null),
      pause: [waitingOn("agent::sessionInput", "p1", fingerprints)],
    };
    expect(restoredPhase(old)).toEqual({
      phase: { kind: "ended", reason: CANNOT_CONTINUE },
      happened: [],
    });
  });

  // Run under a front-end's saved policy instead, it could approve what
  // the session's own policy asks about.
  it("ends a session whose own policy can't be read", () => {
    const pause = { ...waitingOn("agent::sessionInput", "p1"), data: { policy: [1] } };
    expect(restoredPhase({ ...run(null), pause: [pause] })).toEqual({
      phase: { kind: "ended", reason: POLICY_UNREADABLE },
      happened: [],
    });
  });
});

describe("saving and holding a session", () => {
  it("saves the run and a record that says it is a saved run and who holds it", () =>
    withDir(async (dir) => {
      const saved = await saveRun({ dir, record: RECORD, run: run(null), holder: TERMINAL });
      expect(saved).toEqual({ success: true, value: null });
      expect(await readSavedRun(dir, "s1")).toEqual(run(null));
      const [record] = await _listSessions(dir);
      expect(record).toEqual({ ...RECORD, runFormat: "savedRun", heldBy: TERMINAL });
    }));

  it("says why a save failed", () =>
    withDir(async (dir) => {
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      fs.writeFileSync(dir, "a file where the folder should be");
      const saved = await saveRun({ dir, record: RECORD, run: run(null), holder: TERMINAL });
      expect(saved.success).toBe(false);
      expect(saved.success ? "" : saved.error).toContain("Could not save session s1");
    }));

  // The second front-end takes the session at once, before it has saved
  // anything, and the first sees it at its next check.
  it("is no longer held once another front-end takes hold, before it saves", () =>
    withDir(async (dir) => {
      await saveRun({ dir, record: RECORD, run: run(null), holder: TERMINAL });
      expect(await stillHeld({ dir, id: "s1", holder: TERMINAL })).toBe(true);
      expect(await takeHold({ dir, id: "s1", holder: PERRY })).toEqual(success(null));
      expect(await stillHeld({ dir, id: "s1", holder: TERMINAL })).toBe(false);
      expect(await stillHeld({ dir, id: "s1", holder: PERRY })).toBe(true);
    }));

  it("refuses to save over a session another front-end has taken", () =>
    withDir(async (dir) => {
      await saveRun({ dir, record: RECORD, run: run(null), holder: TERMINAL });
      await takeHold({ dir, id: "s1", holder: PERRY });
      const newer = run({ text: "perry's turn", approvals: null });
      await saveRun({ dir, record: RECORD, run: newer, holder: PERRY });
      const saved = await saveRun({ dir, record: RECORD, run: run(null), holder: TERMINAL });
      expect(saved).toEqual(failure("Could not save session s1: held by perry (process 20)."));
      expect(await readSavedRun(dir, "s1")).toEqual(newer);
      const [record] = await _listSessions(dir);
      expect(record.heldBy).toEqual(PERRY);
    }));

  it("saves over a session it holds, or one no one holds", () =>
    withDir(async (dir) => {
      expect(await _saveSession(dir, RECORD, run(null))).toBe("");
      const later = run({ text: "next", approvals: null });
      expect(await saveRun({ dir, record: RECORD, run: later, holder: TERMINAL })).toEqual(
        success(null),
      );
      expect(await saveRun({ dir, record: RECORD, run: run(null), holder: TERMINAL })).toEqual(
        success(null),
      );
      expect(await readSavedRun(dir, "s1")).toEqual(run(null));
    }));

  it("takes hold on the record alone", () =>
    withDir(async (dir) => {
      await saveRun({ dir, record: RECORD, run: run(null), holder: TERMINAL });
      await takeHold({ dir, id: "s1", holder: PERRY });
      expect(await readSavedRun(dir, "s1")).toEqual(run(null));
      const [record] = await _listSessions(dir);
      expect(record).toEqual({ ...RECORD, runFormat: "savedRun", heldBy: PERRY });
    }));

  it("counts the same front-end in another process as another holder", () =>
    withDir(async (dir) => {
      await saveRun({ dir, record: RECORD, run: run(null), holder: TERMINAL });
      await takeHold({ dir, id: "s1", holder: { frontEnd: "terminal", pid: 11 } });
      expect(await stillHeld({ dir, id: "s1", holder: TERMINAL })).toBe(false);
    }));

  it("holds a session no one has taken hold of, or not yet saved", () =>
    withDir(async (dir) => {
      expect(await stillHeld({ dir, id: "s1", holder: TERMINAL })).toBe(true);
      expect(await _saveSession(dir, RECORD, run(null))).toBe("");
      expect(await stillHeld({ dir, id: "s1", holder: TERMINAL })).toBe(true);
    }));

  it("refuses to take hold of a session with no record", () =>
    withDir(async (dir) => {
      const taken = await takeHold({ dir, id: "missing", holder: PERRY });
      expect(taken.success).toBe(false);
      expect(taken.success ? "" : taken.error).toContain("Could not take hold of session missing");
    }));
});
