import { AgencyCancelledError } from "../runtime/errors.js";

/** Throw the branch signal's abort reason UNCHANGED (identity preserved — a
 *  string/object/null reason can matter to cancellation handling). Only
 *  synthesize an error when the reason is genuinely `undefined` (an explicit
 *  `null` is a valid reason and is preserved). */
export function throwAbortReason(signal: AbortSignal): never {
  if (signal.reason !== undefined) {
    throw signal.reason;
  }
  throw new AgencyCancelledError("operation cancelled");
}
