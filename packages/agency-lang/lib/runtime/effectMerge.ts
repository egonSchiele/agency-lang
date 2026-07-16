/**
 * How two approvals of the same interrupt combine.
 *
 * When several handlers in a chain approve one interrupt, their approval
 * values have to become one value. Historically that was "the outermost
 * approval overwrites" — which was never designed, it just fell out of the
 * chain loop, and it breaks the first time an approval carries data that
 * should accumulate (a guard trip's budget grants). The merge is now a
 * per-effect definition, looked up here.
 *
 * The table is TOTAL: every effect has a merge, and the default IS the
 * historical behavior, so effects without an entry are byte-compatible
 * with the old chain. `inner` is always the approval from the handler
 * closer to the interrupt; merges need not be commutative (message
 * concatenation is not).
 *
 * This is deliberately a CONSTANT, not a registration surface. A runtime
 * registry would be per-run state in a module global (banned), it would
 * silently diverge across the subprocess boundary (child registers a
 * merge, parent does not → the same interrupt merges differently in-process
 * and over IPC), and user-supplied merge closures would sit on the
 * function-refs-across-checkpoints problem surface (#513/#544). A user
 * registration surface arrives with typed interrupt payloads (#555).
 */

export type ApprovalMerge = (inner: any, outer: any) => any;

/** In-process default: the outer approval overwrites, INCLUDING an outer
 *  approve() with no value overwriting an inner value with undefined.
 *  That is the documented historical chain behavior. */
const DEFAULT_MERGE: ApprovalMerge = (_inner, outer) => outer;

/** Cross-process default: the outer approval wins, but a VALUELESS outer
 *  approval defers to the inner value. Weaker than the in-process rule on
 *  purpose and from before this module existed: the outcome travels as
 *  JSON, which cannot distinguish "no value" from an explicit undefined,
 *  so a valueless parent approve must not clobber a child's value. */
const DEFAULT_MERGE_IPC: ApprovalMerge = (inner, outer) => outer ?? inner;

function sumOrUndefined(a?: number, b?: number): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}

function unionOrUndefined(a?: string[], b?: string[]): string[] | undefined {
  if (a === undefined && b === undefined) return undefined;
  const merged: string[] = [...(a ?? [])];
  for (const item of b ?? []) {
    if (!merged.includes(item)) merged.push(item);
  }
  return merged;
}

function joinOrUndefined(
  a: string | undefined,
  b: string | undefined,
  sep: string,
): string | undefined {
  if (a === undefined && b === undefined) return undefined;
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a + sep + b;
}

/** std::guard approvals accumulate: budget grants add, disarm lists
 *  union, messages concatenate in inner-to-outer order. Two handlers
 *  each granting $0.50 means $1.00 of new budget, not a coin flip over
 *  which fifty cents survives.
 *
 *  Shape note for consumers: every key of the merged payload is
 *  OPTIONAL. `approvals.reduce(merge)` never calls the merge for a lone
 *  approval, so one handler's `{maxCost: 0.5}` arrives as-is, while two
 *  handlers' arrive as the full four-key shape with the untouched keys
 *  explicitly undefined. Read keys defensively
 *  (`payload.maxCost !== undefined`), never by presence (`"maxTime" in
 *  payload`).
 *
 *  Future improvement (owner): let users define an effect's merge as
 *  AGENCY code — arrives with the typed-payloads work (#555), which
 *  also owns the serialization story a user-supplied merge needs. */
const mergeGuardApprovals: ApprovalMerge = (a, b) => ({
  maxCost: sumOrUndefined(a?.maxCost, b?.maxCost),
  maxTime: sumOrUndefined(a?.maxTime, b?.maxTime),
  disarm: unionOrUndefined(a?.disarm, b?.disarm),
  message: joinOrUndefined(a?.message, b?.message, "\n"),
});

const MERGES: Record<string, ApprovalMerge> = {
  "std::guard": mergeGuardApprovals,
};

/** The merge for an effect's approvals within one process's chain. */
export function mergeFor(effect: string): ApprovalMerge {
  return MERGES[effect] ?? DEFAULT_MERGE;
}

/** The merge for combining a child process's approval with the parent's
 *  (mergeChainOutcomes). Same table; only the DEFAULT differs — see the
 *  two default constants above for why. */
export function mergeForIpc(effect: string): ApprovalMerge {
  return MERGES[effect] ?? DEFAULT_MERGE_IPC;
}
