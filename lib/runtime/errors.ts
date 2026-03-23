import type { Checkpoint } from "./state/checkpointStore.js";
import type { MessageJSON } from "smoltalk";

export type RestoreOptions = {
  messages?: MessageJSON[];
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

export class InterruptBatchSignal extends Error {
  constructor() {
    super("InterruptBatchSignal");
    this.name = "InterruptBatchSignal";
  }
}

export class ToolCallError extends Error {
  retryable: boolean;
  originalError: unknown;

  constructor(error: unknown, opts: { retryable: boolean }) {
    super(error instanceof Error ? error.message : String(error));
    this.originalError = error;
    this.retryable = opts.retryable;
    if (error instanceof Error && error.stack) {
      this.stack = error.stack;
    }
  }
}
