import { appendDurably } from "./durableWrite.js";

import type { RunDirectoryPaths } from "./runDir.js";
import type { Trace } from "./traces.js";

/**
 * Merging statelogs into a run directory, by trace id.
 *
 * `planStatelogMerge` is pure and judges the whole incoming set at once: a
 * trace whose id is absent is added; one whose id is present with an equal
 * digest is skipped; one whose id is present with a different digest is
 * refused, because two event streams claiming one id would make every workdir
 * and annotation keyed on that id ambiguous. Any refusal fails the whole plan
 * — nothing is written — so a directory never ends up half-merged.
 */
export type StatelogMergePlan = {
  add: Trace[];
  skipped: string[];
  refused: { traceId: string; reason: "conflicting-digest" }[];
};

export function planStatelogMerge(
  existing: readonly Trace[],
  incoming: readonly Trace[],
): StatelogMergePlan {
  const digestById: Record<string, string> = Object.create(null);
  for (const trace of existing) digestById[trace.traceId] = trace.digest;

  const plan: StatelogMergePlan = { add: [], skipped: [], refused: [] };
  for (const trace of incoming) {
    const known = digestById[trace.traceId];
    if (known === undefined) {
      plan.add.push(trace);
      digestById[trace.traceId] = trace.digest;
    } else if (known === trace.digest) {
      plan.skipped.push(trace.traceId);
    } else {
      plan.refused.push({ traceId: trace.traceId, reason: "conflicting-digest" });
    }
  }
  return plan;
}

/** @internal Writes a plan that has no refusals. Caller holds the lock. */
export function applyStatelogMerge(paths: RunDirectoryPaths, plan: StatelogMergePlan): void {
  if (plan.refused.length > 0) {
    throw new Error("applyStatelogMerge: refusing to apply a plan with conflicts");
  }
  if (plan.add.length === 0) return;
  const text = plan.add.map((trace) => trace.lines.join("\n") + "\n").join("");
  appendDurably(paths.statelog, text);
}
