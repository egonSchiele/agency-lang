// lib/debugger/types.ts
import { Checkpoint, CheckpointStore, RuntimeContext } from "@/index.js";
import { CheckpointArgs, SourceLocationOpts } from "@/runtime/state/checkpointStore.js";

export class DebuggerState {
  private mode: "stepping" | "running" = "stepping";
  private checkpoints: CheckpointStore;
  private callDepth = 0;
  private stepTarget: {
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

  isAtTargetDepth() {
    if (!this.stepTarget) return true;
    return this.callDepth === this.stepTarget.targetDepth;
  }

  enterCall() {
    this.callDepth++;
  }

  exitCall() {
    if (this.callDepth > 0) {
      this.callDepth--;
    }
  }

  resetCallDepth() {
    this.callDepth = 0;
  }

  reset() {
    this.resetCallDepth();
    this.stepping();
  }

  getMode(): "stepping" | "running" {
    return this.mode;
  }

  stepIn() {
    this.stepping();
    this.stepTarget = {
      type: "stepIn",
      targetDepth: this.callDepth + 1,
    };
  }

  stepNext() {
    this.stepping();
    this.stepTarget = {
      type: "next",
      targetDepth: this.callDepth,
    };
  }

  stepOut() {
    this.stepping();
    this.stepTarget = {
      type: "stepOut",
      targetDepth: this.callDepth - 1,
    };
  }

  loadCheckpoints(checkpoints: Checkpoint[]) {
    for (const cp of checkpoints) {
      this.checkpoints.cloneCheckpoint(cp);
    }
  }

  pinCheckpoint(checkpointId: number, label?: string) {
    this.checkpoints.pin(checkpointId, label);
  }

  cloneCheckpoint(
    checkpoint: Checkpoint,
    opts: Partial<CheckpointArgs> = {},
  ): number {
    return this.checkpoints.cloneCheckpoint(checkpoint, opts);
  }

  createRollingCheckpoint(
    ctx: RuntimeContext<any>,
    opts: SourceLocationOpts,
  ): number {
    return this.checkpoints.createRolling(ctx, opts);
  }

  createPinnedCheckpoint(
    ctx: RuntimeContext<any>,
    opts: SourceLocationOpts & { label: string | null },
  ): number {
    return this.checkpoints.createPinned(ctx, opts);
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

  findBefore(checkpoint: Checkpoint) {
    return this.checkpoints.findBefore(checkpoint);
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
