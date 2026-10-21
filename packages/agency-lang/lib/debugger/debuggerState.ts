import { defaultHost } from "#default-host";
// lib/debugger/types.ts
// From the runtime, not "@/index.js": the Node platform file imports the
// driver, and the whole compiler must not load with every program.
import { Checkpoint, CheckpointStore } from "@/runtime/state/checkpointStore.js";
import type { RuntimeContext } from "@/runtime/state/context.js";
import { CheckpointArgs, SourceLocationOpts } from "@/runtime/state/checkpointStore.js";
import { color } from "@/utils/termcolors.js";
import type { AttachedDebugger } from "@/runtime/attachedDebugger.js";

export class DebuggerState {
  private mode: "stepping" | "running" = "stepping";
  /** Set when this debugger was installed on a program something else is
   *  running. The runtime's public entry points hand it every batch of
   *  debug stops (`settleStops`), so the caller never sees one. */
  attached?: AttachedDebugger;
  /** Attached: the key of the run being debugged (`debugRun.ts`), or
   *  null when none has stopped yet. A step in any other run is let
   *  through. */
  ownedRun: string | null = null;

  /** The key of the run debugged last, so a new owner is told from the
   *  same run taking the debugger again after a stop. */
  private lastOwner: string | null = null;

  /** Whether a step in the run `key` is this debugger's to stop at.
   *  Not attached, every run is; attached, the first run to ask claims
   *  the debugger. A context with no key is treated as the run's own. A
   *  run other than the last one starts clean: the rolling window and
   *  the step target were the last run's, and a step back from the new
   *  run's first stop must not land in the old run's state. The last
   *  run's own continuation is not another run: a caller's resume of it
   *  carries a new key and the one it came from (`resumedFrom`), and
   *  keeps the window, so a step back reaches before the interrupt the
   *  caller answered. */
  owns(key: string | undefined, resumedFrom?: string): boolean {
    if (this.attached === undefined || key === undefined) {
      return true;
    }
    if (this.ownedRun === null) {
      this.ownedRun = key;
      const continues =
        this.lastOwner === key || (resumedFrom !== undefined && this.lastOwner === resumedFrom);
      this.lastOwner = key;
      if (!continues) {
        this.checkpoints = new CheckpointStore(100, this.rewindSize);
        // The mode stays: a `continue` the person gave holds across a
        // caller's resume, which is a new owner too.
        this.stepTarget = null;
        this.stopDepth = 0;
        this.attached.ownerChanged?.();
      }
      return true;
    }
    return this.ownedRun === key;
  }
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

  private readonly rewindSize: number;

  constructor(rewindSize: number) {
    this.rewindSize = rewindSize;
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
