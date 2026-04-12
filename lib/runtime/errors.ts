import type { Checkpoint } from "./state/checkpointStore.js";
import type { MessageJSON } from "smoltalk";

export type RestoreOptions = {
  messages?: MessageJSON[];
  args?: any[];
  globals?: Record<string, Record<string, any>>;
};

export class CheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckpointError";
  }
}

export class RestoreSignal extends Error {
  checkpoint: Checkpoint;
  options?: RestoreOptions;

  constructor(checkpoint: Checkpoint, options?: RestoreOptions) {
    super(`Restoring to checkpoint ${checkpoint.id}`);
    this.name = "RestoreSignal";
    this.checkpoint = checkpoint;
    this.options = options;
  }
}

export class ConcurrentInterruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConcurrentInterruptError";
  }
}