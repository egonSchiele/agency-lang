import { AsyncLocalStorage } from "node:async_hooks";
import { agencyStore } from "./asyncContext.js";
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
 *
 * Budget accuracy caveat: EVERY Agency call — including the stdlib higher-order
 * functions `map`/`filter`/`reduce`/`flatMap` — consumes one depth level, and a
 * HOF also dispatches its callback through another call. So recursion written as
 * `walk(n) { children.map(walk) }` burns ~2 levels per user level (more when
 * HOFs nest), i.e. the effective budget is roughly halved versus the same walk
 * written with a `for` loop, which costs 1 level per user level. The default is
 * generous enough that this rarely matters; raise `maxCallDepth` for very deep
 * HOF-style recursion. (Counting is by call, not by heap growth, so a bounded
 * fire-and-forget spawn like `async produce(n-1)` also climbs the depth and can
 * trip even though it holds only a bounded promise queue — a conservative false
 * positive, acceptable for a safety net.)
 */
export const DEFAULT_MAX_CALL_DEPTH = 2048;

/** A node in the active async lineage's call chain. Linked (not an array) so
 *  entering a call is O(1) with a single small allocation — the frame names
 *  are only walked on the cold overflow path. `limit` is resolved once at the
 *  root of the lineage and carried down, so nested calls never re-read it. */
type CallFrame = {
  readonly name: string;
  readonly depth: number;
  readonly limit: number;
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

/**
 * Run `fn` one level deeper in the call-depth lineage. Throws
 * `CallDepthExceededError` (an `AgencyAbort`) if entering this call would push
 * the logical depth past the active limit, instead of letting an unbounded
 * recursion run until the process OOMs. `name` labels the call for the overflow
 * diagnostic. The limit is read from the active execution context's
 * `maxCallDepth` once at the root of each lineage and inherited by nested calls
 * (so a deep recursion pays a single `agencyStore` lookup, not one per frame).
 */
export function withCallDepth<T>(name: string, fn: () => T): T {
  const parent = callDepthALS.getStore();
  const limit = parent
    ? parent.limit
    : agencyStore.getStore()?.ctx?.maxCallDepth ?? DEFAULT_MAX_CALL_DEPTH;
  const depth = (parent?.depth ?? 0) + 1;
  if (depth > limit) {
    throw new CallDepthExceededError(
      limit,
      depth,
      collectRecentFrames(parent ?? null, name),
    );
  }
  return callDepthALS.run({ name, depth, limit, parent: parent ?? null }, fn);
}
