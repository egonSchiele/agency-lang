import type { StateStack } from "./state/stateStack.js";
import type { ResultValue } from "./result.js";
import { deepClone } from "./utils.js";
import { isFailure, success } from "./result.js";
import { hasInterrupts } from "./interrupts.js";

/** A saved best-so-far value. Wrapped so a stored `null`/`undefined` value is
 *  distinct from "no draft for this frame". */
type DraftRecord = { value: any };

// Branch-local, serialized store: frame depth -> its latest draft. Lives in
// `StateStack.other` (NOT on `State`) because frames are popped by the unwind
// before a guard boundary reads them — `other` outlives frame pops. Depth
// arithmetic is centralized here so no caller ever touches a stack index. See
// docs/superpowers/specs/2026-07-14-save-draft-guards-design.md.

/** The draft map on this stack, or undefined if none written yet. `other` is
 *  already typed `Record<string, any>`, so no cast is needed. */
function peekDrafts(stack: StateStack): Record<number, DraftRecord> | undefined {
  return stack.other.drafts as Record<number, DraftRecord> | undefined;
}

function ensureDrafts(stack: StateStack): Record<number, DraftRecord> {
  if (!stack.other.drafts) stack.other.drafts = {};
  return stack.other.drafts as Record<number, DraftRecord>;
}

/** Depth of the frame that CALLED the current TS helper — the Agency scope
 *  whose draft this is. Mirrors `StateStack.callerFrame()` (one frame below the
 *  helper's own top frame). -1 when there is no caller (module-init/global). */
function callerDepth(stack: StateStack): number {
  return stack.stack.length - 2;
}

/** Low-level depth-keyed write (used by writeCallerDraft and unit tests). The
 *  value is DEEP-CLONED so a later mutation of the saved object can't change the
 *  salvage, and so a live-trip salvage matches a post-resume salvage (which
 *  reads the checkpoint's clone). Matches Agency's value semantics. */
export function writeDraft(stack: StateStack, depth: number, value: unknown): void {
  ensureDrafts(stack)[depth] = { value: deepClone(value) };
}

/** Record the caller frame's best-so-far draft (last call wins). */
export function writeCallerDraft(stack: StateStack, value: unknown): void {
  const depth = callerDepth(stack);
  if (depth < 0) return; // no caller: harmless no-op
  writeDraft(stack, depth, value);
}

function ensureRegions(stack: StateStack): Record<string, number> {
  if (!stack.other.draftRegions) stack.other.draftRegions = {};
  return stack.other.draftRegions as Record<string, number>;
}

/** The region marker for a guard scope, memoized under `key` (the guard's
 *  id-set). Drafts saved under the guard sit at depth >= this marker. Memoized
 *  in serialized `other` because re-capturing `stack.stack.length` on resume
 *  shifts by the restored block frame — the marker must be resume-stable, like
 *  the guard's own `ids`. Cleared by `clearDraftRegion` on guard exit. */
export function draftRegionStart(stack: StateStack, key: string): number {
  const regions = ensureRegions(stack);
  if (regions[key] === undefined) regions[key] = stack.stack.length;
  return regions[key];
}

function clearDraftRegion(stack: StateStack, key: string): void {
  const regions = stack.other.draftRegions as Record<string, number> | undefined;
  if (regions) delete regions[key];
}

/** The outermost draft under a guard: the shallowest depth >= `region`, or
 *  undefined. Outermost (not deepest) is the type-closest choice — see spec. */
export function readOutermostDraft(
  stack: StateStack,
  region: number,
): DraftRecord | undefined {
  const drafts = peekDrafts(stack);
  if (!drafts) return undefined;
  const depths = Object.keys(drafts)
    .map(Number)
    .filter((d) => d >= region);
  return depths.length === 0 ? undefined : drafts[Math.min(...depths)];
}

/** Delete every draft at depth >= `region`. */
export function sweepDrafts(stack: StateStack, region: number): void {
  const drafts = peekDrafts(stack);
  if (!drafts) return;
  for (const d of Object.keys(drafts).map(Number)) {
    if (d >= region) delete drafts[d];
  }
}

/** Turn a guarded block's settled result into the guard's final result:
 *   1. a PAUSED block (interrupts) passes through untouched — no sweep, its
 *      drafts must survive resume;
 *   2. on THIS guard's OWN trip (failure whose `guardId` is in `ids`), salvage
 *      the outermost draft in the region;
 *   3. otherwise return the result unchanged;
 *   then sweep the region on any settled exit. */
export function salvageOwnTrip(
  stack: StateStack,
  region: number,
  ids: string[],
  result: ResultValue | unknown,
  key: string,
): ResultValue | unknown {
  if (hasInterrupts(result)) return result;
  let out = result;
  const guardId = (
    isFailure(result) ? (result.error as { guardId?: string }) : undefined
  )?.guardId;
  if (guardId !== undefined && ids.includes(guardId)) {
    const draft = readOutermostDraft(stack, region);
    if (draft !== undefined) out = success(draft.value);
  }
  sweepDrafts(stack, region);
  clearDraftRegion(stack, key);
  return out;
}

/** Clear the CURRENT top frame's draft. Called from generated code (def
 *  `finally` on `__functionCompleted`; block try-body on `!runner.halted`), so a
 *  frame unwinding on an abort/interrupt keeps its draft for the boundary. */
export function __clearTopFrameDraft(stack: StateStack | undefined): void {
  if (!stack) return;
  const drafts = peekDrafts(stack);
  if (!drafts) return;
  delete drafts[stack.stack.length - 1];
}
