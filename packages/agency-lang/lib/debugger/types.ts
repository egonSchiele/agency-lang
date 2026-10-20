import type { GuardTripData } from "./guardAnswer.js";
import type { InterruptResponse } from "../runtime/interrupts.js";
import type { DebugStopData } from "../runtime/debugger.js";
import type { Checkpoint } from "../runtime/state/checkpointStore.js";
import type { FunctionParameter } from "../types.js";
import type { UIState } from "./uiState.js";

export type DebuggerCommand =
  | { type: "step" }
  | { type: "next" }
  | { type: "stepIn" }
  | { type: "stepOut" }
  | { type: "continue" }
  | { type: "rewind" }
  | { type: "checkpoint"; label?: string }
  | { type: "set"; varName: string; value: unknown }
  | { type: "print"; varName: string }
  | { type: "approve" }
  | { type: "reject"; value?: unknown }
  | { type: "resolve"; value: unknown }
  | { type: "modify"; overrides: Record<string, unknown> }
  | { type: "stepBack"; preserveOverrides: boolean }
  | { type: "showCheckpoints" }
  | { type: "save"; path: string }
  | { type: "load"; path: string }
  | { type: "quit" };

export type DebuggerIO = {
  state: UIState;
  /** Show `checkpoint`, at `stop` when the stop happened somewhere other
   *  than the checkpoint's own location (a stop inside a tool call, whose
   *  checkpoint is the shared one stamped at the join). */
  render(checkpoint?: Checkpoint, stop?: DebugStopData): Promise<void>;
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
