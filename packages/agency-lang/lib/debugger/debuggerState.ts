import { defaultHost } from "#default-host";
// lib/debugger/types.ts
import { Checkpoint, CheckpointStore, RuntimeContext } from "@/index.js";
import { CheckpointArgs, SourceLocationOpts } from "@/runtime/state/checkpointStore.js";
import { color } from "@/utils/termcolors.js";
import type { AttachedDebugger } from "@/runtime/attachedDebugger.js";

export class DebuggerState {
  private mode: "stepping" | "running" = "stepping";
  /** Set when this debugger was installed on a program something else is
   *  running. The runtime's public entry points hand it every batch of
   *  debug stops (`settleStops`), so the caller never sees one. */
  attached?: AttachedDebugger;
  public checkpoints: CheckpointStore;
  /** The depth of the step the debugger is stopped at: how many Agency
   *  calls deep it is, with the node's statements at 0. The driver sets it
   *  from the stop it shows (`DebugStopData.depth`); the stepping commands
   *  set their targets from it. */
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

  /** The rolling window, or with `runId`, that run's checkpoints in it. */
  getCheckpoints(runId?: string) {
    return this.checkpoints.getSorted(runId);
  }

  findCheckpoint(location: SourceLocationOpts) {
    return this.checkpoints.findCheckpoint(location);
  }

  findBefore(beforeId: number, location: SourceLocationOpts, runId?: string) {
    return this.checkpoints.findBefore(beforeId, location, runId);
  }

  prettyPrint(): string {
    return this.checkpoints.prettyPrint();
  }

  deleteAfterCheckpoint(checkpointId: number) {
    this.checkpoints.deleteAfterCheckpoint(checkpointId);
  }
}
