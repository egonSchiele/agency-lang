// Shared lifecycle tail for the outcome-producing run cores (runNode /
// runExportedFunction / respondToInterrupts). Kept in its own module so both
// node.ts and interrupts.ts can use it without a circular import.

import type { RuntimeContext } from "./state/context.js";
import type { GraphState } from "./types.js";
import type { ServedInvocationOutcome } from "./invocationUsage.js";

/** A bare value-or-error, before the usage snapshot is attached. */
export type RawOutcome<T> =
  | { status: "returned"; value: T }
  | { status: "threw"; error: unknown };

/**
 * Close a served invocation's lifecycle: run cleanup, then snapshot the meter.
 *
 * - The FIRST execution error wins as the outcome error. A later cleanup error
 *   is logged, not substituted, so the real cause is never hidden.
 * - If execution SUCCEEDED but cleanup failed, the cleanup error becomes the
 *   outcome (a failed teardown is a real failure).
 * - The meter snapshot is taken AFTER cleanup, so paid work incurred during
 *   cleanup (e.g. memory persistence) is counted.
 */
export async function finishServedInvocation<T>(
  execCtx: RuntimeContext<GraphState>,
  outcome: RawOutcome<T>,
  cleanup: () => Promise<void>,
): Promise<ServedInvocationOutcome<T>> {
  let finalOutcome = outcome;
  try {
    await cleanup();
  } catch (cleanupError) {
    if (finalOutcome.status === "returned") {
      finalOutcome = { status: "threw", error: cleanupError };
    } else {
      const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`[invocation] cleanup failed after an execution error: ${detail}`);
    }
  }
  return { ...finalOutcome, ...execCtx.invocationUsage.snapshot() };
}
