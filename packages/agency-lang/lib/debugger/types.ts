import type { GuardTripData } from "./guardAnswer.js";
import type { InterruptResponse } from "../runtime/interrupts.js";
import type { DebugStopData } from "../runtime/debugger.js";
import type { Checkpoint } from "../runtime/state/checkpointStore.js";
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
  | { type: "approve" }
  | { type: "reject"; value?: unknown }
  | { type: "resolve"; value: unknown }
  | { type: "modify"; overrides: Record<string, unknown> }
  | { type: "stepBack"; preserveOverrides: boolean }
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

export type DebuggerIO = {
  /** A line for the activity log. */
  log(line: string): void;
  setMode(mode: DebuggerMode): void;
  /** The overrides a `set` has queued for the next resume, for the
   *  locals pane to show beside the current values. */
  setOverrides(overrides: Record<string, unknown>): void;
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
