import { isAborted } from "./abortedResult.js";
import type { RuntimeContext } from "./state/context.js";
import type { GraphState } from "./types.js";

/**
 * Turn an abort that reached the end of a run back into an exception.
 *
 * Inside compiled code an abort travels as a value; everything above
 * compiled code expects an exception. Codegen emits a conversion after each
 * call, but only where the result is bound to a local — a tail-position
 * `return foo()` binds nothing and gets none, so the aborted value arrives
 * here intact (issue #243).
 *
 * Every `graph.run(...)` → `createReturnObject(...)` boundary must call this
 * first. Two reasons it cannot be folded into `createReturnObject`: that
 * function JSON round-trips the value, which strips the prototype `isAborted`
 * tests for, and only the caller knows whether it owns the end of the run.
 *
 * `endsRun` closes the trace writer, matching what the same call site does on
 * its success path. The rewind loop has no end-of-run tail of its own, so it
 * passes false.
 */
export async function throwIfNodeResultAborted(
  result: unknown,
  execCtx: RuntimeContext<GraphState>,
  { endsRun }: { endsRun: boolean },
): Promise<void> {
  const data = (result as { data?: unknown } | undefined)?.data;
  if (!isAborted(data)) {
    return;
  }
  // Drop the partial the same way the fork boundary does, so the salvage
  // trail says where it went and the abortUnwind span is ended.
  const settled = data.atNodeBoundary();
  if (endsRun) {
    await execCtx.closeTraceWriter();
  }
  throw settled.toError();
}
