import { fmtTokens, fmtUsd } from "./format.js";
import { walkNodes } from "./forest.js";
import { fmtDuration } from "./spanText.js";
import { groupSpans } from "./timeline/groups.js";
import { roundsOf, type Round, type ThreadKey } from "./timeline/rounds.js";
import { ADMIN_KINDS, hasRunningWork, spanExtent, timelineSpans } from "./timeline/spans.js";
import type { TreeNode } from "./types.js";

export type TimeBar = {
  key: string;
  label: string;
  selfMs: number;
  calls: number;
  share: number;
  isLlm: boolean;
};
export type Callout = {
  label: "slowest" | "priciest" | "biggest";
  round: Round;
  value: string;
};
export type RunCounts = { toolCalls: number; approved: number; rejected: number; errors: number };
export type OverviewData = {
  models: string[];
  running: boolean;
  elapsedMs: number;
  costUsd: number;
  rounds: Round[];
  threads: ThreadKey[];
  contextWindow: number | undefined;
  timeBars: TimeBar[];
  callouts: Callout[];
  counts: RunCounts;
};

const MAX_NAMED_GROUPS = 6;

export function overviewData(
  trace: TreeNode,
  contextWindowOf: (model: string) => number | undefined,
): OverviewData {
  const rounds = roundsOf(trace);
  const spans = timelineSpans(trace, { hideKinds: ADMIN_KINDS });
  const groups = groupSpans(spans, trace);
  const nodes = walkNodes(trace);
  const models = unique(rounds.map((round) => round.model).filter((model) => model !== ""));
  const latestModel = rounds.at(-1)?.model;
  return {
    models,
    running: hasRunningWork(trace),
    elapsedMs: traceElapsedMs(trace),
    costUsd: rounds.reduce((total, round) => total + round.costUsd, 0),
    rounds,
    threads: uniqueBy(
      rounds.map((round) => round.thread),
      threadIdentity,
    ),
    contextWindow: latestModel === undefined ? undefined : contextWindowOf(latestModel),
    timeBars: timeBars(groups),
    callouts: callouts(rounds),
    counts: {
      toolCalls: nodes.filter((node) => node.nodeKind === "span" && node.label === "toolExecution")
        .length,
      approved: eventCount(nodes, "interruptResolved", "approved"),
      rejected: eventCount(nodes, "interruptResolved", "rejected"),
      errors: nodes.filter((node) => node.event?.data.type === "error").length,
    },
  };
}

function traceElapsedMs(trace: TreeNode): number {
  const extent = spanExtent(trace);
  return extent === undefined ? 0 : extent.end - extent.start;
}

function timeBars(groups: ReturnType<typeof groupSpans>): TimeBar[] {
  const named = groups.slice(0, MAX_NAMED_GROUPS).map(toTimeBar);
  const rest = groups.slice(MAX_NAMED_GROUPS);
  if (rest.length === 0) {
    return named;
  }
  named.push({
    key: "other",
    label: "other",
    selfMs: rest.reduce((total, group) => total + group.totalSelfMs, 0),
    calls: rest.reduce((total, group) => total + group.count, 0),
    share: rest.reduce((total, group) => total + group.share, 0),
    isLlm: false,
  });
  return named;
}

function toTimeBar(group: ReturnType<typeof groupSpans>[number]): TimeBar {
  return {
    key: group.key,
    label: group.key,
    selfMs: group.totalSelfMs,
    calls: group.count,
    share: group.share,
    isLlm: group.key.startsWith("llm("),
  };
}

function callouts(rounds: Round[]): Callout[] {
  if (rounds.length === 0) {
    return [];
  }
  const slowest = maximum(rounds, (round) => round.durationMs);
  const priciest = maximum(rounds, (round) => round.costUsd);
  const biggest = maximum(rounds, (round) => round.contextTokens);
  return [
    { label: "slowest", round: slowest, value: fmtDuration(slowest.durationMs) },
    { label: "priciest", round: priciest, value: fmtUsd(priciest.costUsd) },
    { label: "biggest", round: biggest, value: `${fmtTokens(biggest.contextTokens)} ctx` },
  ];
}

function maximum(items: Round[], valueOf: (round: Round) => number): Round {
  return items.reduce((best, item) => (valueOf(item) > valueOf(best) ? item : best));
}

function eventCount(nodes: TreeNode[], type: string, outcome: string): number {
  return nodes.filter(
    (node) => node.event?.data.type === type && node.event.data.outcome === outcome,
  ).length;
}

function threadIdentity(thread: ThreadKey): string {
  return `${thread.kind}:${thread.id}`;
}

function unique(values: string[]): string[] {
  return values.filter((value, position) => values.indexOf(value) === position);
}

function uniqueBy<T>(values: T[], keyOf: (value: T) => string): T[] {
  return values.filter(
    (value, position) =>
      values.findIndex((candidate) => keyOf(candidate) === keyOf(value)) === position,
  );
}
