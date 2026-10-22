import type { GuardTripData } from "./guardAnswer.js";
import type { InterruptResponse } from "../runtime/interrupts.js";
import type { BusyEntry, DebugStopData } from "../runtime/debugger.js";

export type { BusyEntry } from "../runtime/debugger.js";
import type { Checkpoint } from "../runtime/state/checkpointStore.js";
import type { CheckpointEdit } from "../runtime/state/checkpointPatch/index.js";
import type { PendingPreview } from "./edits/rows.js";
import type { FunctionParameter } from "../types.js";

export type DebuggerCommand =
  | { type: "step" }
  | { type: "next" }
  | { type: "stepIn" }
  | { type: "stepOut" }
  | { type: "continue" }
  | { type: "rewind" }
  | { type: "checkpoint"; label?: string }
  | { type: "set"; varName: string; value: unknown }
  | { type: "edit"; edits: CheckpointEdit[] }
  | { type: "dropEdits" }
  | { type: "approve" }
  | { type: "reject"; value?: unknown }
  | { type: "resolve"; value: unknown }
  | { type: "modify"; overrides: Record<string, unknown> }
  | { type: "stepBack" }
  | { type: "showCheckpoints" }
  | { type: "save"; path: string }
  | { type: "load"; path: string }
  | { type: "quit" };

/** `print` is answered by the UI from the frame it is showing, which the
 *  user changes with `b`, so it never reaches the driver. The parser
 *  returns it with the driver's commands and the UI keeps it. */
export type PrintCommand = { type: "print"; varName: string };
export type UiCommand = DebuggerCommand | PrintCommand;

export type DebuggerMode = "stepping" | "running";

/** Thrown by a `DebuggerIO` whose other side has gone away: the person
 *  quit, or their process died. An attached driver treats it as
 *  `continue` and detaches, so the program is never left waiting on a
 *  debugger that is not there. */
export class DebuggerDetached extends Error {
  constructor() {
    super("the debugger detached");
    this.name = "DebuggerDetached";
  }
}

/** Thrown out of a `DebuggerIO` read that another party answered first:
 *  attached, a person and an agent can both be on one run, and the
 *  request this read was for is no longer pending. The read's caller
 *  sends no reply; the next request finds a UI waiting for nothing. */
export class RequestWithdrawn extends Error {
  constructor() {
    super("another party answered first");
    this.name = "RequestWithdrawn";
  }
}

/** Who is on a run beside this debugger. */
export type Parties = { terminal: boolean; cli: boolean };

export type DebuggerIO = {
  /** A line for the activity log. */
  log(line: string): void;
  /** Who is on the run, each time it changes. Attached only. */
  setParties?(parties: Parties): void;
  /** Stop the read in progress, because another party answered the
   *  request it was for: the read rejects with `RequestWithdrawn`. A UI
   *  with no read in progress does nothing. */
  withdraw?(): void;
  setMode(mode: DebuggerMode): void;
  /** The overrides a `set` has queued for the next resume, for the
   *  locals pane to show beside the current values. */
  /** The edits queued at the stop, with the driver's line for each; the
   *  UI draws the preview from them. An empty list clears it. */
  setPending(preview: PendingPreview): void;
  /** What the program is waiting on, a model request or a tool call,
   *  the whole list each time it changes; empty when nothing is open.
   *  Shown while the program runs (`waits.ts`). */
  setBusy(entries: BusyEntry[]): void;
  /** `listener` is called when the person asks the running program to
   *  stop at its next statement (`s` or `n` while it runs). Registered
   *  once by the driver; nothing is sent back. */
  onPause(listener: () => void): void;
  /** Show `checkpoint`, at `stop` when the stop happened somewhere other
   *  than the checkpoint's own location (a stop inside a tool call, whose
   *  checkpoint is the shared one stamped at the join). */
  render(checkpoint?: Checkpoint, stop?: DebugStopData, interruptId?: string): Promise<void>;
  waitForCommand(): Promise<DebuggerCommand>;
  showRewindSelector(checkpoints: Checkpoint[]): Promise<number | null>;
  /** Ask how to answer a guard trip; see `showGuardTripForm`. */
  answerGuardTrip(data: GuardTripData): Promise<InterruptResponse>;
  showCheckpointsPanel(checkpoints: Checkpoint[]): Promise<void>;
  promptForNodeArgs(parameters: FunctionParameter[]): Promise<unknown[]>;
  promptForInput(prompt: string): Promise<string>;
  appendStdout(text: string): void;
  renderActivityOnly(): void;
  startSpinner(): void;
  stopSpinner(): void;
  destroy(): void;
};
