// One run at a time is debugged while a debugger is attached. Every run
// gets a key of its own, minted when its execution context is set up and
// kept in the root stack's `other` bag, which a checkpoint carries, so a
// resume and a rewind keep it. The trace id would not do: a caller can pass
// one, `AGENCY_TRACE_ID` gives a whole process tree one, and two runs with
// one id would look like one run. The first run to reach a debug step while
// the debugger is attached owns it until that run ends with a value, or
// throws, or the debugger is detached; a step in any other run neither
// stops nor records a checkpoint, so the window and every per-stop field
// on the driver belong to one run.
import { nanoid } from "nanoid";

import type { RuntimeContext } from "./state/context.js";
import type { GraphState } from "./types.js";

const KEY = "debugRun";

/** Give a fresh execution context its run key. */
export function mintDebugRun(execCtx: RuntimeContext<GraphState>): void {
  execCtx.stateStack.other[KEY] = nanoid();
}

/** The key of the run `execCtx` belongs to, or undefined for a context
 *  built by hand with no root stack of its own. */
export function debugRunOf(execCtx: RuntimeContext<any>): string | undefined {
  const key: unknown = execCtx.stateStack?.other?.[KEY];
  return typeof key === "string" ? key : undefined;
}

/** The run ended: with a value, or by throwing. A pause by the caller's
 *  signal and a stop on the program's own interrupt are not the end, and
 *  keep the ownership. */
export function releaseDebugRun(execCtx: RuntimeContext<any>): void {
  const state = execCtx.debuggerState;
  if (state?.attached === undefined) {
    return;
  }
  const key = debugRunOf(execCtx);
  if (key !== undefined && state.ownedRun === key) {
    state.ownedRun = null;
  }
}
