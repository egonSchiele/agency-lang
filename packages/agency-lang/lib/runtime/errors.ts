import type { Checkpoint } from "./state/checkpointStore.js";
import type { MessageJSON } from "smoltalk";

export type RestoreOptions = {
  messages?: MessageJSON[];
  args?: Record<string, any>;
  /** Override global variables on restore. Applied to the checkpoint's module.
   * Only affects globals defined in the same file as the checkpoint.
   * Globals in other imported files are restored from checkpoint state. */
  globals?: Record<string, any>;
  /** Maximum number of times this checkpoint's source location may be restored.
   * Once the limit is reached, the restore is skipped (returns instead of throwing).
   * The count is keyed by the checkpoint's source location (moduleId:scopeName#stepPath),
   * so it persists across checkpoint ID changes caused by restore cycles. */
  maxRestores?: number;
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

export class AgencyCancelledError extends Error {
  constructor(reason?: string) {
    super(reason ?? "Agent execution was cancelled");
    this.name = "AgencyCancelledError";
  }
}

/** Thrown by `runHandlerChain` (lib/runtime/interrupts.ts) when nested
 *  handler-chain dispatch depth exceeds `MAX_HANDLER_CHAIN_DEPTH`. Almost
 *  always indicates a handler raised an interrupt that re-enters the same
 *  handler (directly or via the chain dispatcher visiting every handler).
 *  Carries the interrupt effect that tripped the limit so the diagnostic
 *  points at the right place. */
export class HandlerRecursionError extends Error {
  readonly effect: string;
  readonly depth: number;
  constructor(effect: string, depth: number) {
    super(
      `Handler chain dispatch nested ${depth} levels deep while handling ` +
        `interrupt of effect "${effect}". This usually means a handler raised an ` +
        `interrupt that re-entered itself (the chain dispatcher visits every ` +
        `handler, even after one approves). Check whether the handler's body ` +
        `calls anything that raises an interrupt (\`with approve\`, file I/O, ` +
        `\`input()\`, etc.) and guard against re-entry — e.g. flip a sentinel ` +
        `flag BEFORE the call, not after.`,
    );
    this.name = "HandlerRecursionError";
    this.effect = effect;
    this.depth = depth;
  }
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof AgencyCancelledError) return true;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error && error.name === "AbortError") return true;
  return false;
}