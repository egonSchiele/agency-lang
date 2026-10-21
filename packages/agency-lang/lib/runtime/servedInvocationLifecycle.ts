// Shared lifecycle tail for the outcome-producing run cores (runNode /
// runExportedFunction / respondToInterrupts). Kept in its own module so both
// node.ts and interrupts.ts can use it without a circular import.

import type { RuntimeContext } from "./state/context.js";
import type { GraphState } from "./types.js";
import type { ServedInvocationOutcome } from "./invocationUsage.js";
import { releaseDebugRun } from "./debugRun.js";
import { hasInterrupts } from "./interrupts.js";
import { isPaused } from "./pause.js";

/** A bare value-or-error, before the usage snapshot is attached. */
export type RawOutcome<T> = { status: "returned"; value: T } | { status: "threw"; error: unknown };

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
  if (runEnded(outcome)) {
    releaseDebugRun(execCtx);
  }
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
  return {
    ...finalOutcome,
    usage: execCtx.invocationUsage.snapshot(),
    traceId: execCtx.getRunId(),
  };
}

/** Whether `outcome` is the end of the run rather than a pause: a value
 *  or a throw, not the program's own interrupts and not a paused
 *  checkpoint. A node's value is `{ data }`; an exported function's is
 *  bare. */
function runEnded<T>(outcome: RawOutcome<T>): boolean {
  if (outcome.status === "threw") {
    return true;
  }
  const value: unknown = outcome.value;
  const data =
    typeof value === "object" && value !== null && "data" in value
      ? (value as { data: unknown }).data
      : value;
  return !hasInterrupts(data) && !isPaused(data);
}
