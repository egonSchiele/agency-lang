import { AsyncLocalStorage } from "node:async_hooks";
import { CallDepthExceededError } from "./errors.js";

/**
 * Default ceiling on logical function-call nesting depth. Sits well above any
 * realistic call nesting (deep tree walks, recursive descent) yet far below
 * where an unbounded async recursion would OOM the process — the failure this
 * guard exists to turn into an actionable error. Overridable per program via
 * the `maxCallDepth` config option.
 *
 * Why a logical counter rather than V8's native stack limit: most Agency
 * functions are async (they `await`), so each call flattens V8's frame and an
 * infinite async cycle never throws `RangeError` — it just grows the promise
 * chain until the heap is exhausted, minutes later, with no diagnostic. We
 * track the LOGICAL depth of the async call tree instead.
 */
export const DEFAULT_MAX_CALL_DEPTH = 2048;

/** A node in the active async lineage's call chain. Linked (not an array) so
 *  entering a call is O(1) with a single small allocation — the frame names
 *  are only walked on the cold overflow path. */
type CallFrame = {
  readonly name: string;
  readonly depth: number;
  readonly parent: CallFrame | null;
};

/**
 * Current call frame for the active async lineage.
 *
 * Depth is a property of the async call TREE, not a global count — storing it
 * in AsyncLocalStorage (rather than a counter on `ctx`) means concurrent
 * siblings (a `parallel`/`fork` fan-out, or an LLM firing many tool calls in
 * one round) each inherit the SAME parent depth and independently descend one
 * level. Their breadth never accumulates, so a wide fan-out is not mistaken for
 * deep recursion; only a call whose own body calls further descends inside this
 * scope and climbs the depth. Mirrors `handlerChainDepthALS` in interrupts.ts.
 *
 * ALS is never serialized, so there is nothing to reset across checkpoints or
 * resumes — each frame unwinds automatically when its call returns or throws.
 */
const callDepthALS = new AsyncLocalStorage<CallFrame>();

/** How many of the most-recent frame names to surface in the overflow error. */
const RECENT_FRAMES = 8;

function collectRecentFrames(parent: CallFrame | null, name: string): string[] {
  const names: string[] = [name];
  let frame = parent;
  while (frame && names.length < RECENT_FRAMES) {
    names.push(frame.name);
    frame = frame.parent;
  }
  // Oldest-of-window first so the chain reads in call order.
  return names.reverse();
}

/** Logical call depth of the active async lineage (0 at the top level). */
export function currentCallDepth(): number {
  return callDepthALS.getStore()?.depth ?? 0;
}

/**
 * Run `fn` one level deeper in the call-depth lineage. Throws
 * `CallDepthExceededError` (an `AgencyAbort`) if entering this call would push
 * the logical depth past `limit`, instead of letting an unbounded recursion run
 * until the process OOMs. `name` labels the call for the overflow diagnostic.
 */
export function withCallDepth<T>(name: string, limit: number, fn: () => T): T {
  const parent = callDepthALS.getStore() ?? null;
  const depth = (parent?.depth ?? 0) + 1;
  if (depth > limit) {
    throw new CallDepthExceededError(
      limit,
      depth,
      collectRecentFrames(parent, name),
    );
  }
  const frame: CallFrame = { name, depth, parent };
  return callDepthALS.run(frame, fn);
}
