import { agency } from "../runtime/agency.js";
import { __call } from "../runtime/call.js";

export async function _withLock(
  name: string,
  timeoutMs: number | null,
  warnAfterMs: number | null,
  block: unknown,
): Promise<unknown> {
  return agency.withLock(
    name,
    () => __call(block, { type: "positional", args: [] }),
    {
      ...(timeoutMs !== null ? { timeoutMs } : {}),
      ...(warnAfterMs !== null ? { warnAfterMs } : {}),
    },
  );
}
