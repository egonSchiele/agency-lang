// Checkpoint format, version 4. Internal: the shape of a serialized
// session changes with the runtime, and nothing outside this package
// may depend on it.
export type Checkpoint = {
  formatVersion: 4;
  stack: unknown[];
  locals: Record<string, unknown>;
};

export function saveCheckpoint(stack: unknown[], locals: Record<string, unknown>): Checkpoint {
  return { formatVersion: 4, stack, locals };
}

export function resumeCheckpoint(checkpoint: Checkpoint): void {
  if (checkpoint.formatVersion !== 4) {
    throw new Error(`cannot resume a v${checkpoint.formatVersion} checkpoint with a v4 runtime`);
  }
}
