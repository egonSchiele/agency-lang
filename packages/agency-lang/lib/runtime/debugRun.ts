// One run at a time is debugged while a debugger is attached. The rule:
// the debugger owns a run from its first stop until the leg goes back to
// anyone outside the debugger, whether the caller gets a value, the
// program's own interrupt, a paused checkpoint, or a throw. A run that
// comes back from outside, through a caller's resume, gets a fresh key, so
// two resumes of one checkpoint are two runs. The key is minted when an
// execution context is set up and kept in the root stack's `other` bag,
// which a checkpoint carries, so the debugger's own resumes and rewinds
// keep it. The trace id would not do: a caller can pass one, and
// `AGENCY_TRACE_ID` gives a whole process tree one. A step in any run the
// debugger does not own neither stops nor records a checkpoint, so that
// run goes on as if no debugger were attached.
import { nanoid } from "nanoid";

import type { RawOutcome } from "./servedInvocationLifecycle.js";
import { hasInterrupts, isDebugger, type Interrupt } from "./interrupts.js";
import { Checkpoint } from "./state/checkpointStore.js";
import type { RuntimeContext } from "./state/context.js";
import type { GraphState } from "./types.js";
import { reportWaits } from "./waits.js";

const KEY = "debugRun";
/** The key the run was resumed from, when a caller's resume minted it a
 *  new one. A resumed run keeps the rewind window of the run it came
 *  from: a step back from its first stop reaches before the interrupt
 *  the caller answered. */
const FROM_KEY = "debugRunFrom";

/** The metadata key an attached debugger sets on the resumes and rewinds
 *  it issues itself, so the public entry points return those as they are
 *  instead of handing their stops back to the debugger that is already
 *  handling them, and so the run keeps its key. A key on the call, not a
 *  flag on the debugger: only the call knows whose resume it is. */
export const ATTACHED_RESUME = "attachedResume";

export function isAttachedResume(metadata: Record<string, unknown> | undefined): boolean {
  return metadata?.[ATTACHED_RESUME] === true;
}

/** Give an execution context a run key of its own: a fresh run, or a
 *  resume the debugger did not issue, which remembers the key the
 *  checkpoint carried. */
export function mintDebugRun(execCtx: RuntimeContext<GraphState>): void {
  const previous = debugRunOf(execCtx);
  if (previous !== undefined) {
    execCtx.stateStack.other[FROM_KEY] = previous;
  }
  execCtx.stateStack.other[KEY] = nanoid();
}

/** The key of the run `execCtx` was resumed from by a caller, or
 *  undefined for a fresh run. */
export function debugRunResumedFrom(execCtx: RuntimeContext<any>): string | undefined {
  const key: unknown = execCtx.stateStack?.other?.[FROM_KEY];
  return typeof key === "string" ? key : undefined;
}

/** A copy of `checkpoint` that is the run `key`'s, whichever run recorded
 *  it. The attached debugger rewinds the stopped run to the copy, of a
 *  file saved in an earlier session for one: the key is the one thing
 *  the debugger tells runs apart by, and the replay installs the handlers
 *  and the policy as any resume does, so nothing else about the rewind
 *  changes. The checkpoint itself is left as it was: one the program
 *  pinned stays in the store, with the signature it was given, for a
 *  later resume. The restore re-signs its own copy. */
export function stampDebugRun(checkpoint: Checkpoint, key: string): Checkpoint {
  const stamped = Checkpoint.fromJSON(checkpoint.toJSON());
  if (stamped === null) {
    throw new Error("a checkpoint the debugger holds could not be copied");
  }
  stamped.stack.other = { ...stamped.stack.other, [KEY]: key };
  return stamped;
}

/** The run `key` lets go of the debugger with no outcome to judge: its
 *  leg failed before one existed, in the debugger's own rewind whose
 *  restore threw, or in the debugger itself at a stop. */
export function letGoOfDebugRun(execCtx: RuntimeContext<any>, key: string | undefined): void {
  const state = execCtx.debuggerState;
  if (state?.attached !== undefined && key !== undefined && state.ownedRun === key) {
    state.ownedRun = null;
    // The debugger is nobody's again, so the waits of the other runs,
    // hidden while this one was debugged, are shown at once.
    reportWaits(execCtx.debugSlot);
  }
}

/** The key of the run `execCtx` belongs to, or undefined for a context
 *  built by hand with no root stack of its own. */
export function debugRunOf(execCtx: RuntimeContext<any>): string | undefined {
  return debugRunOfStack(execCtx.stateStack);
}

/** The key in a root stack, live or as a checkpoint holds it. */
export function debugRunOfStack(
  stack: { other?: Record<string, unknown> } | undefined,
): string | undefined {
  const key: unknown = stack?.other?.[KEY];
  return typeof key === "string" ? key : undefined;
}

/** The leg is over. Unless it paused on nothing but debug stops, which
 *  only the attached debugger sees and resumes itself, it goes back to
 *  someone outside the debugger, and the run no longer owns it. Returns
 *  whether the run owned the debugger, which is what `settleStops` needs
 *  to report the end to the person: a run the debugger ignored ending
 *  is not news. */
export function releaseDebugRunAfter(
  execCtx: RuntimeContext<any>,
  outcome: RawOutcome<unknown>,
): boolean {
  const state = execCtx.debuggerState;
  if (state?.attached === undefined) {
    return false;
  }
  const key = debugRunOf(execCtx);
  const owned = key !== undefined && state.ownedRun === key;
  if (owned && !staysWithDebugger(outcome)) {
    state.ownedRun = null;
  }
  return owned;
}

function staysWithDebugger(outcome: RawOutcome<unknown>): boolean {
  if (outcome.status === "threw") {
    return false;
  }
  const value: unknown = outcome.value;
  const data =
    typeof value === "object" && value !== null && "data" in value
      ? (value as { data: unknown }).data
      : value;
  return hasInterrupts(data) && data.every((interrupt: Interrupt) => isDebugger(interrupt));
}
