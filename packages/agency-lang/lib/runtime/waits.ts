// What a running program is waiting on, for the debugger to show while
// the program runs: a model request or a tool call the model made. The
// open waits of a module's runs live on the module's debug slot, with or
// without a debugger installed, so a debugger installed in the middle of
// a long call is told about it at once. Nothing here pauses the program:
// a wait is news, not a stop, and it reaches the driver through a plain
// call on the debugger's state, never as an interrupt.
import type { DebugSlot } from "./state/context.js";

/** Where in the program something is, as a stop and a wait both say it:
 *  the module, the scope, the step path, the branch, and the call depth.
 *  A `DebugStopData` is one of these plus the stop's own fields. */
export type StopLocation = {
  moduleId: string;
  scopeName: string;
  stepPath: string;
  /** Branch keys from the root down to the stack the step ran on. */
  branchPath: string[];
  /** How many Agency calls deep the step is: the node's statements are
   *  at 0, a called function's or a tool's at one more than its caller. */
  depth: number;
};

/** `model` for a request to the model, `tool` for a call it made. */
export type BusyKind = "model" | "tool";

/** One open wait as the debugger is told of it. */
export type BusyEntry = {
  /** Tells one wait from another; a number the run hands out, never
   *  derived from the step key, which a rewind that replays the same
   *  step would repeat. */
  token: number;
  kind: BusyKind;
  /** The `llm()` statement, as a loop stop locates it: the statement's
   *  step path plus the loop's key, on the branch the call runs on. */
  location: StopLocation;
  /** The loop's own words for the step: `round 2`, or the tool call with
   *  its arguments cut short, as the stop before it is labelled. */
  label: string;
  /** For a tool wait, the round of the tool loop the call is in, counted
   *  as the person counts: the first request's calls are round 1. */
  round?: number;
  /** The run's key (`debugRun.ts`), so a UI never shows another run's
   *  wait. */
  debugRun: string;
  /** How long the wait has been open when the record was sent, so a UI
   *  that joins late can backdate its clock. */
  elapsedMs: number;
};

/** A wait as the slot keeps it. */
export type OpenWait = Omit<BusyEntry, "elapsedMs"> & { startedAt: number };

/** Whether `value` is a `BusyEntry`, for the UI side of the attach
 *  channel, which takes the list as sent: the fields the UI reads are
 *  checked, so one bad entry is dropped instead of ending the debugger. */
export function isBusyEntry(value: unknown): value is BusyEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const location = record.location as Record<string, unknown> | null | undefined;
  return (
    typeof record.token === "number" &&
    (record.kind === "model" || record.kind === "tool") &&
    typeof record.label === "string" &&
    typeof record.debugRun === "string" &&
    typeof record.elapsedMs === "number" &&
    typeof location === "object" &&
    location !== null &&
    typeof location.moduleId === "string" &&
    typeof location.scopeName === "string" &&
    typeof location.stepPath === "string" &&
    Array.isArray(location.branchPath) &&
    typeof location.depth === "number"
  );
}

/** Tell the debugger installed on `slot`, if any, what is waiting: the
 *  slot's open waits that the debugger shows (`DebuggerState.showsRun`),
 *  the whole list each time, so the UI never has to apply an enter and
 *  a leave in order. Nothing happens without a debugger or a listener. */
export function reportWaits(slot: DebugSlot, now: number = Date.now()): void {
  const dbg = slot.state;
  if (dbg === null || dbg.onWait === undefined) {
    return;
  }
  const shown = slot.waits.filter((wait) => dbg.showsRun(wait.debugRun));
  // The same waits as last time is no news: a debugger installed while
  // nothing is open, or a run taking the debugger, is told nothing.
  const tokens = shown.map((wait) => wait.token);
  if (tokens.join(",") === dbg.reportedWaits.join(",")) {
    return;
  }
  dbg.reportedWaits = tokens;
  dbg.onWait(shown.map((wait) => toEntry(wait, now)));
}

function toEntry(wait: OpenWait, now: number): BusyEntry {
  const { startedAt, ...rest } = wait;
  return { ...rest, elapsedMs: Math.max(0, now - startedAt) };
}
