// traceSummaries.ts
// One record per trace, for the trace picker. Pure over the forest.
import { userMessageOf } from "../statelog/wireAccessors.js";
import { buildTreeIndex, walkNodes } from "./forest.js";
import { classifyTool, toolEvidence, type ToolStatus } from "./story.js";
import { roundsOf } from "./timeline/rounds.js";
import { traceTimes } from "./timeline/turns.js";
import type { TreeNode } from "./types.js";

export type TraceSummary = {
  traceId: string;
  startedAt: number | undefined;
  /** Working time: the waits for the person between turns are left out. */
  durationMs: number | undefined;
  rounds: number;
  tokens: number;
  costUsd: number;
  ask: string | undefined;
  annotation: string | undefined;
  hasError: boolean;
  agentName: string | undefined;
} & ToolCounts;

/** How the trace's tool calls ended. A call awaiting approval or completed
 *  is in `toolCalls` only. */
export type ToolCounts = {
  toolCalls: number;
  toolsFailed: number;
  toolsRejected: number;
  toolsUnfinished: number;
  /** `error` events that no tool call owns, such as a run that crashed. A
   *  failed tool call always logs an error inside its own span, so those
   *  are left out here. */
  errorsOutsideTools: number;
};

export type ToolTrouble = {
  status: ToolStatus;
  field: "toolsFailed" | "toolsRejected" | "toolsUnfinished";
  word: string;
};

/** The tool statuses a summary counts as trouble, in the order the CLI
 *  lists them. A new counted status is one new row. */
export const TOOL_TROUBLE: ToolTrouble[] = [
  { status: "failed", field: "toolsFailed", word: "failed" },
  { status: "rejected", field: "toolsRejected", word: "rejected" },
  { status: "unfinished", field: "toolsUnfinished", word: "unfinished" },
];

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
    durationMs: root.duration === undefined ? undefined : traceTimes(root).workingMs,
    rounds: rounds.length,
    tokens: root.tokens ?? 0,
    costUsd: root.cost ?? 0,
    ask: askText ?? undefined,
    annotation,
    hasError: walkNodes(root).some((node) => node.event?.data.type === "error"),
    agentName: root.agentName,
    ...toolCountsOf(root),
  };
}

/**
 * Each tool call's status, read from its own span the way the viewer's tool
 * rows read it (`classifyTool(toolEvidence(...))`), so the counts and the
 * rows agree. It does not build the story outline, which would compare
 * every LLM call's messages and lay out every row, for every trace a log
 * holds.
 */
export function toolCountsOf(root: TreeNode): ToolCounts {
  const index = buildTreeIndex(root);
  const nodes = walkNodes(root);
  const evidence = nodes
    .filter((node) => node.label === "toolExecution")
    .map((node) => toolEvidence(node, index));
  const statuses = evidence.map((tool) => classifyTool(tool).status);
  const counts: ToolCounts = {
    toolCalls: evidence.length,
    toolsFailed: 0,
    toolsRejected: 0,
    toolsUnfinished: 0,
    errorsOutsideTools: 0,
  };
  for (const trouble of TOOL_TROUBLE) {
    counts[trouble.field] = statuses.filter((status) => status === trouble.status).length;
  }
  // `toolEvidence` leaves out a nested tool's nodes, so no error is owned
  // twice.
  const ownedErrors = evidence.reduce((sum, tool) => sum + tool.errors.length, 0);
  const errors = nodes.filter((node) => node.event?.data.type === "error").length;
  counts.errorsOutsideTools = errors - ownedErrors;
  return counts;
}
