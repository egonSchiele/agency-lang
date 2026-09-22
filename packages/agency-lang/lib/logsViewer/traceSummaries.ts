// traceSummaries.ts
// One record per trace, for the trace picker. Pure over the forest.
import { userMessageOf } from "../statelog/wireAccessors.js";
import { walkNodes } from "./forest.js";
import { roundsOf } from "./timeline/rounds.js";
import type { TreeNode } from "./types.js";

export type TraceSummary = {
  traceId: string;
  startedAt: number | undefined;
  durationMs: number | undefined;
  rounds: number;
  tokens: number;
  costUsd: number;
  ask: string | undefined;
  annotation: string | undefined;
  hasError: boolean;
};

export function traceSummaries(
  roots: TreeNode[],
  annotations: Record<string, string>,
): TraceSummary[] {
  return roots.map((root) =>
    summarize(
      root,
      Object.hasOwn(annotations, root.traceId) ? annotations[root.traceId] : undefined,
    ),
  );
}

function summarize(root: TreeNode, annotation: string | undefined): TraceSummary {
  const rounds = roundsOf(root);
  const firstEvent = rounds[0]?.node.event;
  const askText = firstEvent === undefined ? null : userMessageOf(firstEvent);
  return {
    traceId: root.traceId,
    startedAt: root.firstTs,
    durationMs: root.duration,
    rounds: rounds.length,
    tokens: root.tokens ?? 0,
    costUsd: root.cost ?? 0,
    ask: askText ?? undefined,
    annotation,
    hasError: walkNodes(root).some((node) => node.event?.data.type === "error"),
  };
}
