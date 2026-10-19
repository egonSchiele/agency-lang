import { defaultHost } from "#default-host";
// lib/debugger/types.ts
import { Checkpoint, CheckpointStore, RuntimeContext } from "@/index.js";
import { CheckpointArgs, SourceLocationOpts } from "@/runtime/state/checkpointStore.js";
import { color } from "@/utils/termcolors.js";

export class DebuggerState {
  private mode: "stepping" | "running" = "stepping";
  public checkpoints: CheckpointStore;
  /** The depth of the step the debugger last stopped at. The runtime
   *  reads a step's depth from its stack (`StateStack.stepDepth`) and
   *  reports it through `stoppedAt`; the stepping commands set their
   *  targets from it. */
  public stopDepth = 0;
  public stepTarget: {
    type: "stepIn" | "stepOut" | "next";
    targetDepth: number;
  } | null = null;

  constructor(rewindSize: number) {
    this.checkpoints = new CheckpointStore(100, rewindSize);
  }

  stepping() {
    this.mode = "stepping";
    this.stepTarget = null;
  }

  running() {
    this.mode = "running";
    this.stepTarget = null;
  }

  isStepping() {
    return this.mode === "stepping";
  }

  isRunning() {
    return this.mode === "running";
  }

  /** Whether a step at `depth` is one the current command stops at: any
   *  step when the command set no target (`step`), else a step no deeper
   *  than the target. A deeper step is inside a call the command runs
   *  over. */
  shouldStopAt(depth: number): boolean {
    if (!this.stepTarget) return true;
    return depth <= this.stepTarget.targetDepth;
  }

  /** Record the depth of the step the debugger is stopping at. */
  stoppedAt(depth: number) {
    this.stopDepth = depth;
  }

  reset() {
    this.stopDepth = 0;
    this.stepping();
  }

  getMode(): "stepping" | "running" {
    return this.mode;
  }

  stepIn() {
    this.stepping();
    this.stepTarget = {
      type: "stepIn",
      targetDepth: this.stopDepth + 1,
    };
  }

  stepNext() {
    this.stepping();
    this.stepTarget = {
      type: "next",
      targetDepth: this.stopDepth,
    };
  }

  stepOut() {
    this.stepping();
    this.stepTarget = {
      type: "stepOut",
      targetDepth: this.stopDepth - 1,
    };
  }

  loadCheckpoints(checkpoints: Checkpoint[]) {
    for (const cp of checkpoints) {
      this.checkpoints.add(cp);
    }
  }

  // The debugger runs in the CLI's process, on the platform's default
  // host; a re-signed checkpoint takes its key from there.
  pinCheckpoint(checkpointId: number, label?: string) {
    this.checkpoints.pin(checkpointId, label, defaultHost().settings);
  }

  cloneCheckpoint(checkpoint: Checkpoint, opts: Partial<CheckpointArgs> = {}): number {
    return this.checkpoints.cloneCheckpoint(checkpoint, opts, defaultHost().settings);
  }

  createRollingCheckpoint(ctx: RuntimeContext<any>, opts: SourceLocationOpts): number {
    return this.checkpoints.createRolling(ctx, opts);
  }

  createPinnedCheckpoint(
    ctx: RuntimeContext<any>,
    opts: SourceLocationOpts & { label: string | null },
  ): number {
    return this.checkpoints.createPinned(ctx.stateStack, ctx, opts);
  }

  getCheckpoint(id: number) {
    return this.checkpoints.get(id);
  }

  getCheckpoints() {
    return this.checkpoints.getSorted();
  }

  findCheckpoint(location: SourceLocationOpts) {
    return this.checkpoints.findCheckpoint(location);
  }

  findBefore(beforeId: number, location: SourceLocationOpts) {
    return this.checkpoints.findBefore(beforeId, location);
  }

  prettyPrint(): string {
    return this.checkpoints.prettyPrint();
  }

  deleteAfterCheckpoint(checkpointId: number) {
    this.checkpoints.deleteAfterCheckpoint(checkpointId);
  }
}

export type DebuggerUIState = {
  callStack: { functionName: string; moduleId: string; line: number }[];
  activityLog: string[];
  pendingOverrides: Record<string, unknown>;
  mode: "stepping" | "running";
};
