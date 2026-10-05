import { currentRun } from "../runtime/asyncContext.js";
import { agency } from "../runtime/agency.js";
import { __call } from "../runtime/call.js";

export async function _withLock(
  name: string,
  timeoutMs: number | null,
  warnAfterMs: number | null,
  block: unknown,
): Promise<unknown> {
  const run = currentRun();
  return agency.withLock(name, () => __call(run, block, { type: "positional", args: [] }), {
    ...(timeoutMs !== null ? { timeoutMs } : {}),
    ...(warnAfterMs !== null ? { warnAfterMs } : {}),
  });
}
